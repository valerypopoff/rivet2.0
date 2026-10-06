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
import { mockHostedEditorBootstrap, authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

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
  try {
    const fixture = projectBundleFixture();
    await fs.writeFile(path.join(api.root, 'workflows', 'root.rivet-project'), fixture.root.projectContents);
    await fs.writeFile(path.join(api.root, 'workflows', 'child.rivet-project'), fixture.child.projectContents);
    const project = {
      id: fixture.root.project.metadata.id,
      name: 'Scheduled fixture',
      fileName: 'root.rivet-project',
      relativePath: 'root.rivet-project',
      absolutePath: path.join(api.root, 'workflows', 'root.rivet-project'),
      updatedAt: new Date().toISOString(),
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    };
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
              projects: [project],
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
    await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
    const modal = page.getByTestId('scheduled-runs-modal');
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Add scheduled run', exact: true }).click();
    await modal.getByLabel('Name', { exact: true }).fill('Useful work');
    await modal.getByLabel('Time zone').fill('UTC');
    await modal.getByLabel('Input JSON object (optional)').fill('{"score":0.5}');
    await modal.getByRole('button', { name: 'Preview next runs' }).click();
    await expect(modal.getByRole('list', { name: 'Next runs' }).getByRole('listitem')).toHaveCount(5);
    await page.screenshot({ path: test.info().outputPath('scheduled-run-form.png') });
    await modal.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(modal.getByRole('heading', { name: 'Useful work Enabled' })).toBeVisible();
    expect((await read()).schedules).toHaveLength(1);
    expect((await read()).schedules[0]?.input).toEqual({ score: 0.5 });
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    await modal.getByLabel('Input JSON object (optional)').fill('[]');
    await modal.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('JSON object');
    await modal.getByLabel('Input JSON object (optional)').fill('');
    await modal.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    expect((await read()).schedules[0]?.input).toBeUndefined();
    await modal.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByRole('button', { name: 'Run now', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Open recording', exact: true })).toBeVisible();
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
    // A stale editor must not overwrite another client's change.
    await modal.getByRole('button', { name: 'Edit', exact: true }).click();
    const current = (await read()).schedules[0]!;
    const changed = await fetch(api.baseUrl + base + '/' + current.id, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: current.revision, draft: { ...current, name: 'Changed elsewhere' } }),
    });
    expect(changed.ok).toBe(true);
    await modal.getByLabel('Name', { exact: true }).fill('Stale edit');
    await modal.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('another window');
    expect((await read()).schedules[0]?.name).toBe('Changed elsewhere');
    await modal.getByRole('button', { name: 'Cancel editing', exact: true }).click();
    await expect(modal.getByRole('heading', { name: 'Changed elsewhere Paused' })).toBeVisible();

    // Removing an owned child fixture makes the real runner fail; Retry must
    // remain idempotent even when its successful acknowledgement is lost.
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
    await modal.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(modal.getByText('No scheduled runs yet.')).toBeVisible();
    expect((await read()).history.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath('scheduled-runs.png') });
  } finally {
    waiting.closeAllConnections();
    await new Promise<void>((resolve, reject) => waiting.close((error) => (error ? reject(error) : resolve())));
    await api.close();
  }
});
