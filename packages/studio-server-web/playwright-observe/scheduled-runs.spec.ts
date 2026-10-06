import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { HttpCallNodeImpl, serializeProject } from '@valerypopoff/rivet2-core';
import {
  startAsyncWorkflowProcess,
  withAsyncDeadline,
} from '../../studio-server-api/src/tests/helpers/workflow-async-process';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import type { ScheduledRunList } from '../../studio-server-shared/scheduled-run-types';
import type { WorkflowTreeResponse } from '../../studio-server-shared/workflow-types';
import { mockHostedEditorBootstrap, authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { expectStudioModalSizing } from './helpers/modalSizing';

test('scheduled UI uses authenticated real API, survives lost acknowledgements and executes recorded cross-project work', async ({
  page,
}) => {
  let api = await startAsyncWorkflowProcess();
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const waiting = createServer(() => received());
  waiting.listen(0, '127.0.0.1');
  await once(waiting, 'listening');
  const base = '/api/workflows/scheduled-runs';
  const token = (suffix: string) => createHash('sha256').update(`async-fixture-key:${suffix}`).digest('hex');
  const headers = { 'x-rivet-proxy-auth': token('proxy-auth'), cookie: `rivet_ui_token=${token('ui-session')}` };
  const read = async (): Promise<ScheduledRunList> => {
    const response = await fetch(api.baseUrl + base, { headers });
    expect(response.status).toBe(200);
    return response.json();
  };
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let holdPreview = false;
  let hideRootProject = false;
  try {
    const fixture = projectBundleFixture();
    await fs.writeFile(path.join(api.root, 'workflows', 'root.rivet-project'), fixture.root.projectContents);
    await fs.writeFile(path.join(api.root, 'workflows', 'child.rivet-project'), fixture.child.projectContents);
    // Use the real local tree contract: row IDs are paths, not runtime IDs.
    // The former fixture used metadata IDs for both and masked failed saves.
    const treeResponse = await fetch(api.baseUrl + '/api/workflows/tree', { headers });
    expect(treeResponse.status).toBe(200);
    const tree = (await treeResponse.json()) as WorkflowTreeResponse;
    const project = {
      ...tree.projects.find((item) => item.relativePath === 'root.rivet-project')!,
      name: 'Scheduled fixture',
    };
    expect(project.projectMetadataId).toBe(fixture.root.project.metadata.id);
    expect(project.id).not.toBe(project.projectMetadataId);
    expect((await fetch(api.baseUrl + base)).status).toBe(403);
    let loseCreateResponse = true,
      loseRunResponse = true,
      loseRetryResponse = true,
      listUnavailable = false;
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === base || url.pathname.startsWith(base + '/')) {
          if (listUnavailable && route.request().method() === 'GET')
            return route.fulfill({ status: 503, json: { error: 'Fixture temporary outage' } });
          const response = await route.fetch({
            url: api.baseUrl + url.pathname + url.search,
            headers: { ...route.request().headers(), ...headers },
          });
          if (url.pathname.endsWith('/preview') && holdPreview) await previewGate;
          if (response.ok() && route.request().method() === 'POST' && url.pathname === base && loseCreateResponse) {
            loseCreateResponse = false;
            return route.abort('failed');
          }
          if (response.ok() && url.pathname.endsWith('/run') && loseRunResponse) {
            loseRunResponse = false;
            return route.abort('failed');
          }
          if (response.ok() && url.pathname.endsWith('/retry') && loseRetryResponse) {
            loseRetryResponse = false;
            return route.abort('failed');
          }
          return route.fulfill({ response });
        }
        if (url.pathname === '/api/workflows/tree')
          return route.fulfill({
            json: {
              root: '/workflows',
              folders: [],
              projects: [
                ...(hideRootProject ? [] : [project]),
                {
                  ...project,
                  id: 'folder-project',
                  projectMetadataId: 'folder-project-metadata',
                  name: 'Scheduled fixture',
                  relativePath: 'Useful/Nested/job.rivet-project',
                },
                {
                  ...project,
                  id: 'other-project',
                  projectMetadataId: 'other-project-metadata',
                  name: 'Other work',
                  relativePath: 'Other/job.rivet-project',
                },
              ],
              sync: { epoch: 'scheduled-fixture', revision: 0 },
            },
          });
        if (url.pathname === '/api/app-settings/local-upgrade/status')
          return route.fulfill({ json: { available: false } });
        if (url.pathname === '/api/app-settings/local-upgrade/setup')
          return route.fulfill({ json: { eligible: false } });
        return route.fulfill({ status: 503, json: { error: 'No ambient fixture API allowed' } });
      },
    );
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const sidebarLinks = page.locator('.panel-bottom-actions > button, .panel-bottom-actions > div > button');
    await expect(sidebarLinks).toHaveText([
      'Run recordings',
      'Run statistics',
      'Published',
      'Scheduled runs',
      'Settings',
    ]);
    await expect(page.getByRole('button', { name: 'Scheduled runs', exact: true }).locator('svg')).toHaveCount(1);
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    const modal = page.getByTestId('scheduled-runs-modal');
    const editor = page.getByTestId('scheduled-run-editor-modal');
    await expect(modal).toBeVisible();
    const history = modal.locator('.scheduled-run-history');
    const historyToggle = history.locator('summary');
    await expect(historyToggle).toHaveText('Recent runs (0)');
    await expect(history).not.toHaveAttribute('open');
    await expectStudioModalSizing(modal);
    await expect(page.getByTestId('scheduled-runs-modal--blanket')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0.56)',
    );
    await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await modal.getByRole('button', { name: 'Add scheduled run', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('Draft retained');
    const save = editor.getByRole('button', { name: 'Save', exact: true });
    const preview = editor.getByRole('button', { name: 'Preview next runs', exact: true });
    await expect(editor.getByRole('button', { name: /Cancel/ })).toHaveCount(0);
    await expect(save).toHaveCSS('background-color', 'rgb(12, 102, 228)');
    await expect(editor.getByLabel('Maximum run duration (minutes)', { exact: true })).toHaveValue('60');
    expect(
      await editor
        .locator('.scheduled-run-fields')
        .first()
        .evaluate((section) => {
          const project = section.querySelector('label[for="scheduled-run-project"]')!.getBoundingClientRect();
          const version = section.querySelector('label[for="scheduled-run-version"]')!.getBoundingClientRect();
          return Math.abs(project.top - version.top) < 1 && version.left > project.left;
        }),
    ).toBe(true);
    const expectFixedFooter = async () => {
      const footer = editor.locator('.scheduled-run-footer');
      await page.evaluate(() => document.fonts.ready);
      expect(await footer.evaluate((element) => element.parentElement?.classList.contains('scheduled-run-form'))).toBe(
        true,
      );
      // Layout coordinates exclude the modal's entrance translation animation.
      const top = await footer.evaluate((element) => (element as HTMLElement).offsetTop);
      await editor.locator('.scheduled-runs-content').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(save).toBeInViewport();
      await expect(preview).toBeInViewport();
      // Fractional flex sizes can round to adjacent CSS pixels during layout.
      // This tolerance is not a scroll tolerance: both controls remain visible
      // and the footer must live outside the scrolling content region.
      expect(
        Math.abs((await footer.evaluate((element) => (element as HTMLElement).offsetTop)) - top),
      ).toBeLessThanOrEqual(1);
      expect(await save.evaluate((element) => element.getBoundingClientRect().left)).toBeGreaterThan(
        await preview.evaluate((element) => element.getBoundingClientRect().right),
      );
      await editor.locator('.scheduled-runs-content').evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(save).toBeInViewport();
    };
    await expectFixedFooter();
    await editor.getByLabel('Name', { exact: true }).fill('');
    await save.click();
    await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
    expect((await read()).schedules).toHaveLength(0);
    await editor.getByLabel('Name', { exact: true }).fill('Draft retained');
    await expectStudioModalSizing(editor);
    await expect(editor.locator('select')).toHaveCount(0);
    await expect(editor.getByRole('checkbox', { name: 'Enabled', exact: true })).toHaveCount(0);
    await expect(
      editor.getByText('Browse by folder, or search by project name or path. The main graph runs.'),
    ).toHaveCount(0);
    await expect(editor.getByText(/Enable or pause this schedule|New schedules start enabled/)).toHaveCount(0);
    const sections = editor.locator('.scheduled-run-fields');
    await expect(sections).toHaveCount(3);
    for (const section of await sections.all()) {
      await expect(section).toHaveCSS('border-top-width', '1px');
      await expect(section).toHaveCSS('border-radius', '12px');
      await expect(section).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.03)');
    }
    await expect(editor.locator('form')).toHaveCSS('border-top-width', '0px');
    const picker = editor.getByLabel('Project', { exact: true });
    await expect(picker).not.toHaveAttribute('aria-describedby');
    await picker.click();
    await expect(editor).toBeVisible();
    await expect(modal.locator('form')).toHaveCount(0);
    await expect(editor).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    const folderOption = (name: string) =>
      editor.locator('.scheduled-select__option').filter({
        has: page.locator('.scheduled-project-name').filter({ hasText: new RegExp('^' + name + '$') }),
      });
    await expect(folderOption('Nested')).toHaveCount(0);
    await folderOption('Useful').click();
    await expect(picker).toBeFocused();
    await folderOption('Nested').click();
    await expect(
      editor.locator('.scheduled-select__option').filter({ hasText: 'Useful/Nested/job.rivet-project' }),
    ).toBeVisible();
    await expect(picker).toHaveAttribute('aria-expanded', 'true');
    await folderOption('Useful').click();
    await expect(folderOption('Nested')).toHaveCount(0);
    await expect(editor.getByRole('heading', { name: 'Add scheduled run', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('scheduled-project-picker.png') });
    await picker.fill('There is no such project');
    await expect(editor.getByText('No matching projects', { exact: true })).toBeVisible();
    await picker.press('Escape');
    await expect(modal).toBeVisible();
    await expect(editor.locator('.scheduled-select__menu')).toHaveCount(0);
    await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Draft retained');
    await editor.getByLabel('Name', { exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Add scheduled run', exact: true })).toBeFocused();
    expect((await read()).schedules).toHaveLength(0);
    await modal.getByRole('button', { name: 'Add scheduled run', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('Draft retained');
    await picker.fill('Useful/Nested');
    await expect(editor.locator('.scheduled-select__option')).toHaveCount(3);
    await editor.locator('.scheduled-select__option').filter({ hasText: 'Useful/Nested/job.rivet-project' }).click();
    await expect(
      editor.locator('.scheduled-select__single-value').filter({ hasText: 'Useful/Nested/job.rivet-project' }),
    ).toBeVisible();
    await picker.fill('root.rivet-project');
    await picker.press('ArrowDown');
    await picker.press('Enter');
    const choose = async (label: string, option: string) => {
      await editor.getByLabel(label, { exact: true }).press('ArrowDown');
      await editor
        .locator('.scheduled-select__option')
        .filter({ hasText: new RegExp(`^${option}$`) })
        .click();
    };
    expect((await read()).schedules).toHaveLength(0);
    await editor.locator('label[for="scheduled-run-kind"]').click();
    await expect(editor.getByLabel('Schedule', { exact: true })).toBeFocused();
    const timingNotes = editor.locator('[aria-labelledby="scheduled-run-timing-heading"] .scheduled-run-timing-notes');
    const noOverlap = 'A run is skipped if a previous run from this schedule is still pending or running.';
    const daylightSaving = 'Missing daylight-saving times are skipped; repeated times run once.';
    await expect(timingNotes).toHaveText(`${daylightSaving} ${noOverlap}`);
    await choose('Schedule', 'Weekly');
    await expect(timingNotes).toHaveText(`${daylightSaving} ${noOverlap}`);
    await editor.getByRole('checkbox', { name: 'Wed', exact: true }).check();
    await expect(editor.getByRole('checkbox', { name: 'Wed', exact: true })).toBeChecked();
    await choose('Schedule', 'Monthly');
    await expect(timingNotes).toHaveText(`${daylightSaving} ${noOverlap}`);
    await choose('Day of month', '31');
    await expect(timingNotes).toHaveText(`${daylightSaving} Months without the selected day are skipped. ${noOverlap}`);
    await choose('Day of month', 'Last day');
    await expect(timingNotes).toHaveText(`${daylightSaving} ${noOverlap}`);
    await choose('Schedule', 'Interval');
    await expect(timingNotes).toHaveText(noOverlap);
    await expect(editor.getByLabel('Every (minutes)', { exact: true })).toHaveValue('60');
    await choose('Schedule', 'Once');
    await expect(timingNotes).toHaveText(noOverlap);
    await expect(editor.getByLabel('Date and time', { exact: true })).toBeVisible();
    await choose('Schedule', 'Daily');
    await expect(timingNotes).toHaveText(`${daylightSaving} ${noOverlap}`);
    await choose('Version', 'Published');
    await choose('Version', 'Saved latest');
    await choose('Missed runs', 'Catch up latest only');
    await choose('Missed runs', 'Skip missed runs');
    const recording = editor.getByRole('checkbox', {
      name: 'Record these runs (requires server recording setting)',
      exact: true,
    });
    await recording.uncheck();
    await expect(recording).not.toBeChecked();
    await recording.check();
    await page.setViewportSize({ width: 540, height: 740 });
    await expectFixedFooter();
    await expectStudioModalSizing(editor);
    await expect
      .poll(async () =>
        editor
          .locator('.scheduled-run-fields')
          .first()
          .evaluate((element) => {
            const labels = element.querySelectorAll(':scope > :is(label, .scheduled-run-field)');
            return Math.abs(labels[0]!.getBoundingClientRect().left - labels[1]!.getBoundingClientRect().left) < 1;
          }),
      )
      .toBe(true);
    expect(
      await editor.locator('.scheduled-runs-content').evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath('scheduled-run-mobile.png') });
    await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await editor.getByLabel('Name', { exact: true }).fill('Useful work');
    await editor.getByLabel('Time zone').fill('UTC');
    await editor.getByLabel('Input JSON object (optional)').fill('{"score":0.5}');
    holdPreview = true;
    listUnavailable = true;
    await editor.getByRole('button', { name: 'Preview next runs' }).click();
    await expect(editor.locator('.scheduled-runs')).toHaveAttribute('aria-busy', 'true');
    for (const label of ['Name', 'Project', 'Version', 'Schedule', 'Time zone'])
      await expect(editor.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(recording).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    releasePreview();
    holdPreview = false;
    await expect(editor.getByRole('list', { name: 'Next runs' }).getByRole('listitem')).toHaveCount(5);
    await expect(editor.locator('.scheduled-runs')).toHaveAttribute('aria-busy', 'false');
    await expect(editor.getByRole('alert')).toHaveCount(0);
    listUnavailable = false;
    await page.screenshot({ path: test.info().outputPath('scheduled-run-form.png') });
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('alert')).toBeVisible();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal.getByRole('heading', { name: 'Useful work Enabled' })).toBeVisible();
    const card = modal.locator('.scheduled-run-card').first();
    const deleteSchedule = modal.getByRole('button', { name: 'Delete schedule Useful work', exact: true });
    await expect(deleteSchedule.locator('svg')).toHaveCount(1);
    await expect(card.locator('.scheduled-run-buttons')).toHaveCSS('border-top-width', '0px');
    await expect(card.locator('p').first()).toHaveCSS('margin-bottom', '6px');
    expect(
      await card.locator('.scheduled-run-header').evaluate((header) => {
        const heading = header.querySelector('h3')!.getBoundingClientRect();
        const pill = header.querySelector('small')!.getBoundingClientRect();
        const trash = header.querySelector('button')!.getBoundingClientRect();
        return pill.top >= heading.top && pill.bottom <= heading.bottom && trash.left > heading.right;
      }),
    ).toBe(true);
    await expect(editor).toHaveCount(0);
    expect((await read()).schedules).toHaveLength(1);
    expect((await read()).schedules[0]?.projectId).toBe(project.projectMetadataId);
    expect((await read()).schedules[0]?.input).toEqual({ score: 0.5 });
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByLabel('Input JSON object (optional)').fill('[]');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('JSON object');
    await expect(editor.getByRole('alert')).toBeInViewport();
    await editor.getByLabel('Input JSON object (optional)').fill('');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    expect((await read()).schedules[0]?.input).toBeUndefined();
    await modal.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor.getByRole('checkbox', { name: 'Enabled', exact: true })).toHaveCount(0);
    await expect(
      editor.locator('.scheduled-select__single-value').filter({ hasText: 'root.rivet-project' }),
    ).toBeVisible();
    await editor.getByLabel('Description (optional)').fill('Editing does not re-enable a paused schedule.');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect((await read()).schedules[0]?.enabled).toBe(false);
    await expect(modal.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(historyToggle).toHaveText('Recent runs (1)');
    await expect(history).not.toHaveAttribute('open');
    await expect(modal.getByRole('link', { name: 'Open recording', exact: true })).not.toBeVisible();
    await historyToggle.focus();
    await historyToggle.press('Enter');
    await expect(modal.getByRole('link', { name: 'Open recording', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('scheduled-runs-expanded.png') });
    await historyToggle.press('Space');
    await expect(history).not.toHaveAttribute('open');
    const state = await read();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.status).toBe('succeeded');
    const recordings = await api.command<{
      runs: { executionIdentity?: { surface?: string; correlationId?: string; occurrenceId?: string } }[];
    }>('scheduled-recordings');
    expect(recordings.runs).toHaveLength(2);
    expect(
      recordings.runs.some(
        (r) =>
          r.executionIdentity?.surface === 'scheduled' && r.executionIdentity.occurrenceId === state.history[0]?.id,
      ),
    ).toBe(true);
    expect(
      recordings.runs.some(
        (r) =>
          r.executionIdentity?.surface === 'subgraph_project' &&
          r.executionIdentity.correlationId === state.history[0]?.id,
      ),
    ).toBe(true);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    api = await api.restart();
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    expect((await read()).schedules).toHaveLength(1);
    expect((await read()).history[0]?.id).toBe(state.history[0]?.id);
    // A missing saved target remains visible; opening its editor cannot
    // silently replace it with the first surviving project.
    hideRootProject = true;
    await page.reload();
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(
      editor.locator('.scheduled-select__single-value').filter({ hasText: 'Unavailable project' }),
    ).toContainText('Missing');
    expect((await read()).schedules[0]?.projectId).toBe(project.projectMetadataId);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    hideRootProject = false;
    await page.reload();
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    // A stale editor must not overwrite another client's change.
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    const current = (await read()).schedules[0]!;
    const changed = await fetch(api.baseUrl + base + '/' + current.id, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: current.revision, draft: { ...current, name: 'Changed elsewhere' } }),
    });
    expect(changed.ok).toBe(true);
    await editor.getByLabel('Name', { exact: true }).fill('Stale edit');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('another window');
    expect((await read()).schedules[0]?.name).toBe('Changed elsewhere');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(modal.getByRole('heading', { name: 'Changed elsewhere Paused' })).toBeVisible();

    // Removing an owned child fixture makes the real runner fail; Retry must
    // remain idempotent even when its successful acknowledgement is lost.
    await expect(history).not.toHaveAttribute('open');
    await historyToggle.click();
    await fs.unlink(path.join(api.root, 'workflows', 'child.rivet-project'));
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Retry run', exact: true })).toHaveCount(1);
    await fs.writeFile(path.join(api.root, 'workflows', 'child.rivet-project'), fixture.child.projectContents);
    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Retry run', exact: true }).click();
    await expect(modal.getByRole('alert')).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Retry run', exact: true }).click();
    await expect.poll(async () => (await read()).history.filter((r) => r.status === 'succeeded').length).toBe(2);
    expect((await read()).history).toHaveLength(3);

    const blocked = structuredClone(fixture.root.project);
    const http = HttpCallNodeImpl.create();
    http.data.url = `http://127.0.0.1:${(waiting.address() as AddressInfo).port}/waiting`;
    blocked.graphs[blocked.metadata.mainGraphId!]!.nodes = [http];
    blocked.graphs[blocked.metadata.mainGraphId!]!.connections = [];
    await fs.writeFile(path.join(api.root, 'workflows', 'root.rivet-project'), serializeProject(blocked) as string);
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await withAsyncDeadline(requestReceived, 'scheduled HTTP node to start', 15_000);
    await expect(modal.getByRole('button', { name: 'Cancel run', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Cancel run', exact: true }).click();
    await expect
      .poll(async () => (await read()).history.some((r) => r.status === 'interrupted'), { timeout: 15_000 })
      .toBe(true);
    await expect(modal.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0);
    await fs.writeFile(path.join(api.root, 'workflows', 'root.rivet-project'), fixture.root.projectContents);
    expect((await read()).history).toHaveLength(4);

    // Accepted mutation + a failed list refresh is not a failed mutation.
    listUnavailable = true;
    await modal.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('action was accepted');
    expect((await read()).schedules[0]?.enabled).toBe(true);
    listUnavailable = false;
    await expect(modal.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Delete schedule Changed elsewhere', exact: true }).click();
    await expect(modal.getByText('No scheduled runs yet.')).toBeVisible();
    expect((await read()).history.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    await modal.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    await expect(modal.getByText('No scheduled runs yet.')).toBeVisible();
    await expect(historyToggle).toHaveText('Recent runs (4)');
    await expect(history).not.toHaveAttribute('open');
    await page.screenshot({ path: test.info().outputPath('scheduled-runs.png') });
  } finally {
    releasePreview();
    waiting.closeAllConnections();
    await new Promise<void>((resolve, reject) => waiting.close((error) => (error ? reject(error) : resolve())));
    await api.close();
  }
});
