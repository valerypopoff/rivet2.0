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
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

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
  let loseAcknowledgement = false;
  let failPreparation = false;
  let statusReads = 0;
  const rootProject = {
    id: fixture.root.project.metadata.id,
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
        const source = failPreparation
          ? {
              ...fixture.source,
              root: async () => {
                throw new Error('Owned fixture read failed');
              },
            }
          : fixture.source;
        const status = await jobs.start(source, 'latest', body.requestId);
        if (loseAcknowledgement) return route.abort('failed');
        await acknowledgement;
        return route.fulfill({ status: 202, json: status });
      }
      const match = /^\/api\/workflows\/project-bundles\/([^/]+)(\/download)?$/.exec(url.pathname);
      if (match) {
        if (request.method() === 'DELETE') {
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
    await waitForDashboardReady(page);
    const row = page.locator('.project-row').filter({ hasText: 'Portable root' });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Download with dependencies', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Download with dependencies' })).toBeVisible();
    await expect(page.getByTestId('workflow-project-bundle-modal')).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await expect(page.getByTestId('workflow-project-bundle-modal--body')).toHaveCSS('padding', '0px');
    await page.getByLabel('Bundle root version').selectOption('live');
    await page.getByRole('button', { name: 'Prepare bundle', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Download with dependencies' }).getByRole('status')).toContainText(
      'Export:',
    );
    await page.getByRole('button', { name: 'Close bundle download' }).click();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Download with dependencies', exact: true }).click();
    const link = page.getByRole('link', { name: 'Download bundle', exact: true });
    await expect(link).toBeVisible();
    releaseAcknowledgement();
    await expect(page.getByRole('button', { name: 'Prepare another bundle' })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: 'Download with dependencies' }).getByRole('status')).toContainText(
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
    await expect(page.getByRole('dialog', { name: 'Download with dependencies' }).getByRole('alert')).toHaveCount(0);
    // A real preparation failure must not strand the dialog or require reloading
    // the workspace. Disposal/reset followed by preparation uses a fresh job.
    loseAcknowledgement = false;
    await page.getByRole('button', { name: 'Prepare another bundle' }).click();
    failPreparation = true;
    await page.getByRole('button', { name: 'Prepare bundle', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Download with dependencies' });
    await expect(modal.getByRole('status')).toContainText('Export: failed.');
    await expect(modal.getByRole('alert')).toContainText('Could not prepare the bundle.');
    await expect(link).toHaveCount(0);
    failPreparation = false;
    await page.getByRole('button', { name: 'Retry export', exact: true }).click();
    await expect(link).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(row).toBeVisible();
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
