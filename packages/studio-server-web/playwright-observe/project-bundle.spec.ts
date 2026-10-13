// test-style: fixture-read: downloads and extracts only a test-owned generated bundle ZIP.
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectBundle } from '@valerypopoff/rivet2-node';
import { ProjectBundleJobs } from '../../studio-server-api/src/routes/workflows/project-bundle-jobs';
import {
  projectBundleFixture,
  extractProjectBundleFixture,
} from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { expectStudioModalSizing } from './helpers/modalSizing';

function bundleProject(id: string) {
  return {
    id,
    name: 'Portable root',
    fileName: 'root.rivet-project',
    relativePath: 'root.rivet-project',
    absolutePath: '/workflows/root.rivet-project',
    updatedAt: '2026-10-05T00:00:00.000Z',
    settings: {
      status: 'unpublished_changes',
      publicationVersion: '1',
      endpointName: 'fixture',
      lastPublishedAt: '2026-10-04T00:00:00.000Z',
      publishedWebApps: [],
    },
  };
}

test('download dependencies survives closing the dialog and runs the real downloaded bundle locally', async ({
  page,
}) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-browser-bundle-'));
  const jobs = new ProjectBundleJobs(path.join(temporary, 'jobs'));
  const fixture = projectBundleFixture();
  let releaseAcknowledgement!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    releaseAcknowledgement = resolve;
  });
  let releaseCollection!: () => void;
  const collection = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  let releasePackaging!: () => void;
  const packaging = new Promise<void>((resolve) => {
    releasePackaging = resolve;
  });
  let rootReads = 0;
  const gatedSource = {
    ...fixture.source,
    root: async () => {
      // Explicit gates keep both active phases observable without timing sleeps.
      await (++rootReads === 1 ? collection : packaging);
      return fixture.source.root();
    },
  };
  let loseAcknowledgement = false;
  let failPreparation = false;
  let refuseCancellation = false;
  let statusReads = 0;
  const rootProject = bundleProject(fixture.root.project.metadata.id);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill({
          json: { root: '/workflows', sync: { epoch: 'bundle', revision: 0 }, folders: [], projects: [rootProject] },
        });
      if (url.pathname === '/api/workflows/project-bundles' && request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.relativePath).toBe('root.rivet-project');
        expect(body.version).toBe('live');
        expect(body.versionPolicy).toBe('latest');
        const source = failPreparation
          ? {
              ...fixture.source,
              root: async () => {
                throw new Error('Owned fixture read failed');
              },
            }
          : gatedSource;
        const status = await jobs.start(source, 'latest', body.requestId);
        if (loseAcknowledgement)
          return route.fulfill({ status: 524, contentType: 'text/html', body: '<html>Owned gateway response</html>' });
        await acknowledgement;
        return route.fulfill({ status: 202, json: status });
      }
      const match = /^\/api\/workflows\/project-bundles\/([^/]+)(\/download)?$/.exec(url.pathname);
      if (match) {
        if (request.method() === 'DELETE') {
          if (refuseCancellation)
            return route.fulfill({
              status: 524,
              contentType: 'text/html',
              body: '<html>Owned cancellation timeout</html>',
            });
          await jobs.cancel(match[1]!);
          return route.fulfill({ status: 204 });
        }
        if (match[2]) {
          const download = await jobs.download(match[1]!);
          try {
            return await route.fulfill({
              contentType: 'application/zip',
              headers: { 'Content-Disposition': 'attachment; filename="portable.zip"' },
              body: await fs.readFile(download.archive),
            });
          } finally {
            download.release();
          }
        }
        statusReads++;
        try {
          return await route.fulfill({ json: await jobs.status(match[1]!) });
        } catch {
          return route.fulfill({ status: 404, json: { error: 'Not accepted yet' } });
        }
      }
      if (url.pathname === '/api/app-settings/local-upgrade/status')
        return route.fulfill({ json: { available: false } });
      if (url.pathname === '/api/app-settings/local-upgrade/setup') return route.fulfill({ json: { eligible: false } });
      return route.fulfill({ status: 503, json: { error: 'Unknown fixture API route' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  try {
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.locator('.project-row').filter({ hasText: 'Portable root' });
    await row.click({ button: 'right' });
    const downloadProject = page.getByRole('menuitem', { name: 'Download project', exact: true });
    const downloadBundle = page.getByRole('menuitem', { name: 'Download bundle', exact: true });
    await expect(downloadProject).toBeVisible();
    await expect(downloadBundle).toBeVisible();
    const bundleIcon = downloadBundle.locator('svg');
    await expect(bundleIcon).toHaveAttribute('aria-hidden', 'true');
    const arrows = bundleIcon.locator('path');
    await expect(arrows).toHaveCount(2);
    const bounds = await arrows.evaluateAll((paths) =>
      paths.map((path) => {
        const { x, y, width, height } = (path as SVGGraphicsElement).getBBox();
        return { x, y, width, height };
      }),
    );
    expect(bounds[1]!.x).toBeGreaterThan(bounds[0]!.x);
    expect(bounds[1]!.y).toBeGreaterThan(bounds[0]!.y);
    expect(bounds[1]!.width).toBe(bounds[0]!.width);
    expect(bounds[1]!.height).toBe(bounds[0]!.height);
    await page.screenshot({ path: test.info().outputPath('project-download-menu.png') });
    await downloadBundle.click();
    await expect(page.getByRole('dialog', { name: 'Download bundle' })).toBeVisible();
    await expect(page.getByTestId('workflow-project-bundle-modal')).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await expect(page.getByTestId('workflow-project-bundle-modal--body')).toHaveCSS('padding', '0px');
    const dialog = page.getByTestId('workflow-project-bundle-modal');
    const spinner = dialog.locator('.workflow-project-bundle-spinner');
    await expect(spinner).toHaveCount(0);
    const rootVersions = dialog.getByRole('group', { name: 'Bundle versions' });
    await expect(dialog.locator('select')).toHaveCount(0);
    await expect(rootVersions.getByRole('button', { name: 'Published', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await rootVersions.getByRole('button', { name: 'Saved latest', exact: true }).click();
    await expect(rootVersions.getByRole('button', { name: 'Saved latest', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.locator('.project-settings-help').first()).toHaveCSS('font-size', '14px');
    await expect(dialog.locator('.project-settings-help').first()).toHaveCSS('line-height', '21px');
    const prepare = dialog.getByRole('button', { name: 'Prepare bundle', exact: true });
    await expect(prepare).toHaveCSS('background-color', 'rgb(12, 102, 228)');
    for (const width of [1600, 390]) {
      await page.setViewportSize({ width, height: 520 });
      await expectStudioModalSizing(dialog);
      const content = dialog.locator('.workflow-project-bundle-content');
      await content.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(
        await dialog.locator('.workflow-project-bundle-footer').evaluate((footer) => {
          const body = footer.closest('[role="dialog"]')!.getBoundingClientRect();
          const box = footer.getBoundingClientRect();
          const heading = footer
            .parentElement!.querySelector('.project-settings-modal-header-row')!
            .getBoundingClientRect();
          return box.bottom <= body.bottom + 1 && box.bottom <= window.innerHeight && heading.top >= body.top;
        }),
      ).toBe(true);
      await expect(prepare).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Close bundle download' })).toBeInViewport();
    }
    await page.screenshot({ path: test.info().outputPath('bundle-modal-narrow.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByRole('button', { name: 'Prepare bundle', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Download bundle' }).getByRole('status')).toContainText(
      'Export: collecting.',
    );
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'workflow-project-bundle-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Close bundle download' }).click();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
    await expect(spinner).toBeVisible();
    refuseCancellation = true;
    await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
    const cancellationError = dialog.getByRole('alert');
    await expect(cancellationError).toContainText('HTML instead of JSON (HTTP 524)');
    await expect(cancellationError).not.toContainText('Owned cancellation timeout');
    const readsAfterCancellation = statusReads;
    await expect.poll(() => statusReads).toBeGreaterThan(readsAfterCancellation);
    await expect(cancellationError).toContainText('HTML instead of JSON (HTTP 524)');
    await expect(spinner).toBeVisible();
    refuseCancellation = false;
    releaseCollection();
    await expect(dialog.getByRole('status')).toContainText('Export: packaging.');
    await expect(spinner).toBeVisible();
    await page.setViewportSize({ width: 390, height: 520 });
    await expect(spinner).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('bundle-modal-preparing.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
    releasePackaging();
    const link = page.getByRole('link', { name: 'Download bundle', exact: true });
    await expect(link).toBeVisible();
    await expect(spinner).toHaveCount(0);
    await expect(link).toHaveCSS('background-color', 'rgb(12, 102, 228)');
    await expect(link).toHaveAttribute('href', /\/api\/workflows\/project-bundles\/[^/]+\/download$/);
    releaseAcknowledgement();
    await expect(page.getByRole('button', { name: 'Prepare another bundle' })).toBeEnabled();
    await expect
      .poll(() =>
        dialog.evaluate((element) => {
          for (let current: Element | null = element; current; current = current.parentElement) {
            if (Number(getComputedStyle(current).opacity) < 1) return false;
          }
          return true;
        }),
      )
      .toBe(true);
    await page.setViewportSize({ width: 390, height: 520 });
    await expectStudioModalSizing(dialog);
    await expect(link).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Prepare another bundle' })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath('bundle-modal-ready-narrow.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.screenshot({ path: test.info().outputPath('bundle-modal-ready.png') });
    await expect(page.getByRole('dialog', { name: 'Download bundle' }).getByRole('status')).toContainText(
      'Export: ready.',
    );
    expect(statusReads).toBeGreaterThan(0);
    const downloadPromise = page.waitForEvent('download');
    await link.click();
    const download = await downloadPromise;
    const archive = path.join(temporary, 'browser.zip');
    await download.saveAs(archive);
    expect(await download.failure()).toBeNull();
    const extracted = path.join(temporary, 'relocated');
    await extractProjectBundleFixture(await fs.readFile(archive), extracted);
    const bundle = await loadProjectBundle(path.join(extracted, 'rivet-bundle.json'));
    const runner = bundle.createProcessor();
    try {
      expect((await runner.run()).result?.value).toBe('child-result');
    } finally {
      runner.dispose();
    }
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: 'Prepare another bundle' }).click();
    loseAcknowledgement = true;
    await page.getByRole('button', { name: 'Prepare bundle', exact: true }).click();
    await expect(link).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Download bundle' }).getByRole('alert')).toHaveCount(0);
    // A real preparation failure must not strand the dialog or require reloading
    // the workspace. Disposal/reset followed by preparation uses a fresh job.
    loseAcknowledgement = false;
    await page.getByRole('button', { name: 'Prepare another bundle' }).click();
    failPreparation = true;
    await page.getByRole('button', { name: 'Prepare bundle', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Download bundle' });
    await expect(modal.getByRole('status')).toContainText('Export: failed.');
    await expect(spinner).toHaveCount(0);
    await expect(modal.getByRole('alert')).toContainText('Could not prepare the bundle.');
    await expect(link).toHaveCount(0);
    failPreparation = false;
    await page.getByRole('button', { name: 'Retry export', exact: true }).click();
    await expect(link).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    releaseCollection();
    releasePackaging();
    releaseAcknowledgement();
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('reopened failed export retries the durable version choice rather than the project default', async ({ page }) => {
  const project = bundleProject('bundle-retry-policy');
  const oldId = 'd16225ba-b6a6-4c02-bd73-67daab3eb5da';
  let posted: { version: string; versionPolicy: string; requestId: string } | undefined;
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), {
    key: `rivet-project-bundle:${project.id}`,
    id: oldId,
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill({ json: { root: '/workflows', folders: [], projects: [project] } });
      if (url.pathname === '/api/workflows/project-bundles') {
        posted = route.request().postDataJSON();
        return route.fulfill({
          status: 202,
          json: {
            id: posted!.requestId,
            phase: 'collecting',
            versionPolicy: 'latest',
            projects: 0,
            bytes: 0,
            expiresAt: '2099-01-01T00:00:00Z',
          },
        });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
        const id = url.pathname.split('/').at(-1);
        return route.fulfill({
          json: {
            id,
            phase: id === oldId ? 'failed' : 'collecting',
            versionPolicy: 'latest',
            projects: 0,
            bytes: 0,
            expiresAt: '2099-01-01T00:00:00Z',
            error: id === oldId ? 'Fixture export failed.' : undefined,
          },
        });
      }
      if (url.pathname === '/api/app-settings/local-upgrade/setup') return route.fulfill({ json: { eligible: false } });
      return route.fulfill({ status: 503, json: { error: 'Unknown fixture API route' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row').filter({ hasText: 'Portable root' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
  const dialog = page.getByTestId('workflow-project-bundle-modal');
  await expect(dialog.getByRole('status')).toContainText('Export: failed.');
  await dialog.getByRole('button', { name: 'Retry export', exact: true }).click();
  await expect.poll(() => posted?.versionPolicy).toBe('latest');
  expect(posted!.version).toBe('live');
  expect(posted!.requestId).not.toBe(oldId);
  await expect(dialog.getByRole('status')).toContainText('Export: collecting.');
});

test('late bundle admission cannot regress packaging and duplicate clicks admit only once', async ({ page }) => {
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let releasePoll!: () => void;
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let posts = 0;
  let reads = 0;
  let id = '';
  const project = bundleProject('bundle-ack-fixture');
  const status = (phase: 'collecting' | 'packaging') => ({
    id,
    phase,
    projects: phase === 'packaging' ? 2 : 0,
    bytes: 1024,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill({ json: { root: '/workflows', folders: [], projects: [project] } });
      if (url.pathname === '/api/workflows/project-bundles') {
        posts++;
        id = route.request().postDataJSON().requestId;
        await admission;
        return route.fulfill({ status: 202, json: status('collecting') });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        if (++reads > 1) await pollGate;
        return route.fulfill({ json: { ...status('packaging'), id: url.pathname.split('/').at(-1) } });
      }
      if (url.pathname === '/api/app-settings/local-upgrade/setup') return route.fulfill({ json: { eligible: false } });
      return route.fulfill({ status: 503, json: { error: 'Unknown fixture API route' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  try {
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.locator('.project-row').filter({ hasText: 'Portable root' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
    const dialog = page.getByTestId('workflow-project-bundle-modal');
    await dialog.getByRole('button', { name: 'Prepare bundle', exact: true }).evaluate((element) => {
      // Dispatch both clicks in the same browser task, before awaiting HTTP.
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(dialog.getByRole('status')).toContainText('Export: packaging. 2 project snapshots');
    // Freeze further GETs so polling cannot conceal a regressed acknowledgement.
    await expect.poll(() => reads).toBeGreaterThan(1);
    releaseAdmission();
    await expect(dialog.getByRole('button', { name: 'Cancel export', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('status')).toContainText('Export: packaging. 2 project snapshots');
    expect(posts).toBe(1);
  } finally {
    releaseAdmission();
    releasePoll();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
