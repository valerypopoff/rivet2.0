// test-style: fixture-read: downloads and extracts only a test-owned generated bundle ZIP.
import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadProjectBundle, serializeProject } from '@valerypopoff/rivet2-node';
import { ProjectBundleJobs } from '../../studio-server-api/src/routes/workflows/project-bundle-jobs';
import {
  projectBundleFixture,
  extractProjectBundleFixture,
} from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import {
  openBundleActions,
  authenticateIfNeeded,
  mockHostedEditorBootstrap,
  waitForDashboardReady,
} from './helpers/hostedEditorObserve';
import { expectStudioModalSizing } from './helpers/modalSizing';

const publishedPolicyLabel = 'Published if available (saved latest if no published version)';

async function expectDownloadForm(dialog: Locator) {
  await expect(dialog.getByRole('group', { name: 'Bundle versions', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Prepare|Retry export|Cancel export/ })).toHaveCount(0);
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await expect(dialog.getByText(/^Export:/)).toHaveCount(0);
}

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

function bundleTree(project: ReturnType<typeof bundleProject>) {
  return {
    root: '/workflows',
    sync: { epoch: 'bundle', revision: 0 },
    capabilities: { explicitBundles: true },
    folders: [
      {
        id: 'portable-folder',
        bundleId: project.id,
        name: 'Portable feature',
        relativePath: 'Portable feature',
        absolutePath: '/workflows/Portable feature',
        updatedAt: project.updatedAt,
        folders: [],
        projects: [project],
      },
    ],
    projects: [],
  };
}

async function openFixtureBundleDownload(page: Page, bundleName = 'Portable feature') {
  // Controller-only scenarios still need a real attachment response when ready.
  await page.route('**/api/workflows/project-bundles/*/download', (route) =>
    route.fulfill({
      contentType: 'application/zip',
      headers: { 'Content-Disposition': 'attachment; filename="fixture.zip"' },
      body: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array<number>(18).fill(0)]),
    }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page
    .getByRole('button', { name: `Expand ${bundleName} bundle`, exact: true })
    .or(page.getByRole('button', { name: `Collapse ${bundleName} bundle`, exact: true }))
    .click({ button: 'right' });
  await openBundleActions(page);
  await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
  return page.getByTestId('workflow-project-bundle-modal');
}

test('long bundle names keep the quoted title and footer usable on narrow screens', async ({ page }) => {
  const bundleName = `Feature "${'long bundle name '.repeat(16).trim()}"`;
  const tree = bundleTree(bundleProject('long-bundle-name'));
  tree.folders[0]!.name = bundleName;
  await page.route('**/api/workflows/tree', (route) => route.fulfill({ json: tree }));
  await page.setViewportSize({ width: 390, height: 520 });
  const dialog = await openFixtureBundleDownload(page, bundleName);
  const title = `Download bundle "${bundleName}"`;
  await expect(dialog).toHaveAccessibleName(title);
  await expect(dialog.locator('.workflow-project-bundle-title')).toHaveAttribute('title', title);
  await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close bundle download', exact: true })).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('download dependencies survives closing the dialog and runs the real downloaded bundle locally', async ({
  page,
}) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-browser-bundle-'));
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  const jobs = new ProjectBundleJobs(path.join(temporary, 'jobs'));
  const fixture = projectBundleFixture();
  const publishedFixture = projectBundleFixture();
  const publishedChild = publishedFixture.child.project.graphs[publishedFixture.child.project.metadata.mainGraphId!]!;
  publishedChild.nodes[0]!.data = { ...publishedChild.nodes[0]!.data, text: 'published-child-result' };
  publishedFixture.child.projectContents = serializeProject(publishedFixture.child.project) as string;
  publishedFixture.root.selectedVersion = 'published';
  publishedFixture.child.selectedVersion = 'published';
  let releaseCollection!: () => void;
  const collection = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  const gatedSource = {
    ...fixture.source,
    root: async () => {
      await collection;
      return fixture.source.root();
    },
  };
  let loseAcknowledgement = false;
  let failPreparation = false;
  let cancellationStatus: number | null = null;
  const cancellationMessage = 'Owned cancellation response';
  let statusReads = 0;
  let expectedVersion: 'latest' | 'published' = 'latest';
  const startedIds: string[] = [];
  let holdStatus = false;
  let heldReads = 0;
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => (releaseStatus = resolve));
  const rootProject = bundleProject(fixture.root.project.metadata.id);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.pathname === '/api/workflows/tree')
        return route.fulfill({
          json: bundleTree(rootProject),
        });
      if (url.pathname === '/api/workflows/project-bundles/container' && request.method() === 'POST') {
        const body = request.postDataJSON();
        expect(body.bundleId).toBe(rootProject.id);
        expect(body.version).toBe(expectedVersion);
        startedIds.push(body.requestId);
        const source = failPreparation
          ? {
              ...fixture.source,
              root: async () => {
                throw new Error('Owned fixture read failed');
              },
            }
          : body.version === 'published'
            ? publishedFixture.source
            : gatedSource;
        const status = await jobs.start({ ...source, versionPolicy: body.version }, body.version, body.requestId);
        if (loseAcknowledgement)
          return route.fulfill({ status: 524, contentType: 'text/html', body: '<html>Owned gateway response</html>' });
        return route.fulfill({ status: 202, json: status });
      }
      const match = /^\/api\/workflows\/project-bundles\/([^/]+)(\/download)?$/.exec(url.pathname);
      if (match) {
        if (request.method() === 'DELETE') {
          if (cancellationStatus !== null)
            return route.fulfill({
              status: cancellationStatus,
              ...(cancellationStatus === 202
                ? { json: { accepted: true } }
                : { contentType: 'text/html', body: `<html>${cancellationMessage}</html>` }),
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
          const status = await jobs.status(match[1]!);
          if (holdStatus) {
            heldReads++;
            await statusGate;
          }
          return await route.fulfill({ json: status });
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
    const row = page.getByRole('button', { name: /^(Expand|Collapse) Portable feature bundle$/ });
    await row.click();
    await page.locator('.project-row').filter({ hasText: 'Portable root' }).click({ button: 'right' });
    await openBundleActions(page);
    const downloadProject = page.getByRole('menuitem', { name: 'Download project', exact: true });
    const downloadBundle = page.getByRole('menuitem', { name: 'Download bundle', exact: true });
    await expect(downloadProject).toBeVisible();
    await expect(downloadBundle).toHaveCount(0);
    await page.keyboard.press('Escape');
    await row.click({ button: 'right' });
    await openBundleActions(page);
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
    await expect(dialog).toHaveAccessibleName('Download bundle "Portable feature"');
    await expect(dialog.locator('.project-settings-modal-title')).toHaveText('Download bundle "Portable feature"');
    await expect(dialog.locator('.workflow-project-bundle-card')).toHaveCount(0);
    await expect(dialog.getByRole('heading', { name: 'Portable feature', exact: true })).toHaveCount(0);
    await expect(dialog.locator('.workflow-project-bundle-content > .project-settings-help')).toHaveCount(0);
    await expect(dialog.locator('.workflow-project-bundle-footer-help')).toHaveText(
      'Includes bundle members and dependencies outside the bundle.',
    );
    const spinner = dialog.locator('.workflow-project-bundle-spinner');
    const versions = dialog.getByRole('group', { name: 'Bundle versions' });
    const downloadButton = dialog.getByRole('button', { name: 'Download bundle', exact: true });
    await expectDownloadForm(dialog);
    await expect(versions.getByRole('button')).toHaveText(['Saved latest', publishedPolicyLabel]);
    await expect(versions.getByRole('button', { name: 'Saved latest', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(dialog.locator('.project-settings-help').first()).toHaveCSS('font-size', '14px');
    await expect(dialog.locator('.project-settings-help').first()).toHaveCSS('line-height', '21px');
    await expect(downloadButton).toHaveCSS('background-color', 'rgb(12, 102, 228)');
    for (const width of [1600, 390]) {
      await page.setViewportSize({ width, height: 520 });
      await expectStudioModalSizing(dialog);
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
      await expect(downloadButton).toBeInViewport();
      await expect(versions.getByRole('button', { name: publishedPolicyLabel, exact: true })).toBeInViewport();
      expect(await versions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(
        await versions.evaluate(
          (element) => element.getBoundingClientRect().right - element.lastElementChild!.getBoundingClientRect().right,
        ),
      ).toBeLessThanOrEqual(4);
      await expect(dialog.getByRole('button', { name: 'Close bundle download' })).toBeInViewport();
    }
    await page.screenshot({ path: test.info().outputPath('bundle-modal-narrow.png') });
    await downloadButton.click();
    await expect(downloadButton).toBeDisabled();
    await expect(downloadButton).toHaveAttribute('aria-busy', 'true');
    await expectDownloadForm(dialog);
    await expect(versions.getByRole('button', { name: 'Saved latest', exact: true })).toBeDisabled();
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'workflow-project-bundle-spin');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.screenshot({ path: test.info().outputPath('bundle-modal-downloading.png') });
    await dialog.getByRole('button', { name: 'Close bundle download' }).click();
    await row.click({ button: 'right' });
    await openBundleActions(page);
    await downloadBundle.click();
    await expect(downloadButton).toBeDisabled();
    releaseCollection();
    await expect(downloadButton).toBeEnabled();
    await expect(spinner).toHaveCount(0);
    await expectDownloadForm(dialog);
    expect(downloads).toHaveLength(0); // Reopening never re-arms an automatic download.
    expect(startedIds).toHaveLength(1);
    expect(statusReads).toBeGreaterThan(0);

    const downloadAndRun = async (name: string, expectedResult: string) => {
      const downloadPromise = page.waitForEvent('download');
      await downloadButton.click();
      const download = await downloadPromise;
      const archive = path.join(temporary, `${name}.zip`);
      await download.saveAs(archive);
      expect(await download.failure()).toBeNull();
      const extracted = path.join(temporary, name);
      await extractProjectBundleFixture(await fs.readFile(archive), extracted);
      const bundle = await loadProjectBundle(path.join(extracted, 'rivet-bundle.json'));
      const runner = bundle.createProcessor();
      try {
        expect((await runner.run()).result?.value).toBe(expectedResult);
      } finally {
        runner.dispose();
      }
      await expect(downloadButton).toBeEnabled();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expectDownloadForm(dialog);
    };
    await downloadAndRun('original', 'child-result');
    await dialog.screenshot({ path: test.info().outputPath('bundle-modal-after-download-narrow.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await dialog.screenshot({ path: test.info().outputPath('bundle-modal-after-download.png') });
    const originalId = startedIds.at(-1)!;
    const savedChild = fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!;
    savedChild.nodes[0]!.data = { ...savedChild.nodes[0]!.data, text: 'updated-child-result' };
    fixture.child.projectContents = serializeProject(fixture.child.project) as string;
    for (const status of [200, 202, 524]) {
      cancellationStatus = status;
      await downloadButton.click();
      await expect(dialog.getByRole('alert')).toContainText(
        status === 202 ? 'Could not start the download.' : `HTML instead of JSON (HTTP ${status})`,
      );
      await expect(dialog.getByRole('alert')).not.toContainText(cancellationMessage);
      await expectDownloadForm(dialog);
      expect(
        await page.evaluate((key) => sessionStorage.getItem(key), `rivet-container-bundle:${rootProject.id}`),
      ).toBe(originalId);
      expect(startedIds).toHaveLength(2);
    }
    cancellationStatus = null;
    await downloadAndRun('updated', 'updated-child-result');
    expect(startedIds.at(-1)).not.toBe(originalId);
    await versions.getByRole('button', { name: publishedPolicyLabel, exact: true }).click();
    expectedVersion = 'published';
    await downloadAndRun('published', 'published-child-result');
    expect(downloads).toHaveLength(3);

    await page.reload();
    await waitForDashboardReady(page);
    await row.click({ button: 'right' });
    await openBundleActions(page);
    await downloadBundle.click();
    await expect(downloadButton).toBeEnabled();
    await expect(versions.getByRole('button', { name: publishedPolicyLabel, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(downloads).toHaveLength(3);
    // A delayed read of the previous archive cannot overwrite an edited choice.
    await dialog.getByRole('button', { name: 'Close bundle download' }).click();
    holdStatus = true;
    await row.click({ button: 'right' });
    await openBundleActions(page);
    await downloadBundle.click();
    await expect.poll(() => heldReads).toBe(1);
    await versions.getByRole('button', { name: 'Saved latest', exact: true }).click();
    const delayedStatus = page.waitForResponse((response) =>
      response.url().endsWith(`/project-bundles/${startedIds.at(-1)}`),
    );
    releaseStatus();
    expect(await (await delayedStatus).finished()).toBeNull();
    await expect(versions.getByRole('button', { name: 'Saved latest', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expectedVersion = 'latest';
    loseAcknowledgement = true;
    await downloadAndRun('lost-acknowledgement', 'updated-child-result');
    await expect(versions.getByRole('button', { name: 'Saved latest', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    loseAcknowledgement = false;
    failPreparation = true;
    await downloadButton.click();
    await expect(dialog.getByRole('alert')).toContainText('Could not prepare the bundle.');
    await expect(downloadButton).toBeEnabled();
    await expectDownloadForm(dialog);
    failPreparation = false;
    const childGraphId = fixture.child.project.metadata.mainGraphId!;
    const childGraph = fixture.child.project.graphs[childGraphId]!;
    const childNodes = childGraph.nodes;
    childGraph.nodes = childNodes.filter((node) => node.type !== 'graphOutput');
    fixture.child.projectContents = serializeProject(fixture.child.project) as string;
    const portChangeDownload = page.waitForEvent('download');
    await downloadButton.click();
    expect(await (await portChangeDownload).failure()).toBeNull();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    // Port changes are adopted automatically; a missing graph still needs an
    // actionable location and must recover after the target is restored.
    delete fixture.child.project.graphs[childGraphId];
    fixture.child.projectContents = serializeProject(fixture.child.project) as string;
    await downloadButton.click();
    const targetError = dialog.getByRole('alert');
    await expect(targetError).toContainText('in graph "Main" of project "Root"');
    await expect(targetError).toContainText(`Target: graph "${childGraphId}" in project "子供" (Saved latest)`);
    await expect(targetError).toContainText(`missing graph ${childGraphId}`);
    const call = fixture.root.project.graphs[fixture.root.project.metadata.mainGraphId!]!.nodes.find(
      (node) => node.type === 'subGraph',
    )!;
    await expect(targetError).toContainText(call.id);
    await page.setViewportSize({ width: 390, height: 520 });
    await expectStudioModalSizing(dialog);
    await expect(targetError).toBeVisible();
    await dialog.screenshot({ path: test.info().outputPath('bundle-missing-graph-repair-location.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
    childGraph.nodes = childNodes;
    fixture.child.project.graphs[childGraphId] = childGraph;
    fixture.child.projectContents = serializeProject(fixture.child.project) as string;
    await downloadAndRun('repaired', 'updated-child-result');
    expect(new Set(startedIds).size).toBe(startedIds.length);
    await expect(row).toBeVisible();
  } finally {
    releaseCollection();
    releaseStatus();
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('reopened failed export retries the durable version choice rather than the project default', async ({ page }) => {
  const project = bundleProject('bundle-retry-policy');
  const oldId = 'd16225ba-b6a6-4c02-bd73-67daab3eb5da';
  let posted: { bundleId: string; version: string; requestId: string } | undefined;
  let cleaned = false;
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), {
    key: `rivet-container-bundle:${project.id}`,
    id: oldId,
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (url.pathname === '/api/workflows/project-bundles/container') {
        expect(cleaned).toBe(true);
        posted = route.request().postDataJSON();
        return route.fulfill({
          status: 202,
          json: {
            id: posted!.requestId,
            phase: 'collecting',
            versionPolicy: 'published',
            projects: 0,
            bytes: 0,
            expiresAt: '2099-01-01T00:00:00Z',
          },
        });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        if (route.request().method() === 'DELETE') {
          cleaned = true;
          return route.fulfill({ status: 204 });
        }
        const id = url.pathname.split('/').at(-1);
        return route.fulfill({
          json: {
            id,
            phase: id === oldId ? 'failed' : 'collecting',
            versionPolicy: 'published',
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
  const dialog = await openFixtureBundleDownload(page);
  await expect(dialog.getByRole('alert')).toHaveText('Fixture export failed.');
  await expectDownloadForm(dialog);
  await expect(dialog.getByRole('button', { name: publishedPolicyLabel, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
  await expect.poll(() => posted?.version).toBe('published');
  expect(posted!.bundleId).toBe(project.id);
  expect(posted!.requestId).not.toBe(oldId);
  await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('late bundle admission cannot regress a ready result and duplicate clicks admit only once', async ({ page }) => {
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => (releaseAdmission = resolve));
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => (releaseReady = resolve));
  let posts = 0;
  let reads = 0;
  let id = '';
  const project = bundleProject('bundle-ack-fixture');
  const status = (phase: 'collecting' | 'ready') => ({
    id,
    phase,
    projects: 2,
    bytes: 1024,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (url.pathname === '/api/workflows/project-bundles/container') {
        posts++;
        id = route.request().postDataJSON().requestId;
        await admission;
        return route.fulfill({ status: 202, json: status('collecting') });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        reads++;
        if (reads === 1) return route.fulfill({ status: 404, json: { error: 'Export is not registered yet.' } });
        await ready;
        return route.fulfill({ json: status('ready') });
      }
      return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
    },
  );
  try {
    const dialog = await openFixtureBundleDownload(page);
    const downloadButton = dialog.getByRole('button', { name: 'Download bundle', exact: true });
    await downloadButton.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect.poll(() => reads).toBe(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    const readyResponse = page.waitForResponse(
      (response) => response.url().endsWith(`/project-bundles/${id}`) && response.status() === 200,
    );
    releaseReady();
    await readyResponse;
    await expect(dialog.locator('a[href$="/download"]')).toHaveCount(1);
    await expect(downloadButton).toBeDisabled(); // Original POST is still pending.
    const download = page.waitForEvent('download');
    releaseAdmission();
    expect(await (await download).failure()).toBeNull();
    await expect(downloadButton).toBeEnabled();
    await expectDownloadForm(dialog);
    expect(posts).toBe(1);
    expect(reads).toBe(2); // Terminal status stopped polling; no later read masks regression.
  } finally {
    releaseAdmission();
    releaseReady();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a delayed status failure cannot replace a successful bundle admission', async ({ page }) => {
  const project = bundleProject('bundle-delayed-status');
  let id = '';
  let reads = 0;
  let releaseAdmission!: () => void;
  const admission = new Promise<void>((resolve) => (releaseAdmission = resolve));
  let releaseFailure!: () => void;
  const failure = new Promise<void>((resolve) => (releaseFailure = resolve));
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => (releaseReady = resolve));
  const status = (phase: 'collecting' | 'ready') => ({
    id,
    phase,
    versionPolicy: 'published',
    projects: 1,
    bytes: 1024,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (url.pathname === '/api/workflows/project-bundles/container') {
        id = route.request().postDataJSON().requestId;
        await admission;
        return route.fulfill({ status: 202, json: status('collecting') });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        if (++reads === 1) {
          await failure;
          return route.fulfill({ status: 503, json: { error: 'Obsolete status failure' } });
        }
        await ready;
        return route.fulfill({ json: status('ready') });
      }
      return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
    },
  );
  try {
    const dialog = await openFixtureBundleDownload(page);
    await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
    await expect.poll(() => reads).toBe(1);
    releaseAdmission();
    await expect(dialog.getByRole('button', { name: publishedPolicyLabel, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    releaseFailure();
    await expect.poll(() => reads).toBe(2);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    const download = page.waitForEvent('download');
    releaseReady();
    expect(await (await download).failure()).toBeNull();
    await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeEnabled();
    await expectDownloadForm(dialog);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  } finally {
    releaseAdmission();
    releaseFailure();
    releaseReady();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('invalid export responses retain identity and recover without an automatic new start', async ({ page }) => {
  const project = bundleProject('bundle-invalid-status');
  const endpoint = '/api/workflows/project-bundles';
  let id = '';
  const postedIds: string[] = [];
  let reply: unknown = null;
  let invalidStart = false;
  let firstRead = true;
  let reads = 0;
  let releaseInitialRead!: () => void;
  const initialRead = new Promise<void>((resolve) => (releaseInitialRead = resolve));
  let releaseStartRead!: () => void;
  const startRead = new Promise<void>((resolve) => (releaseStartRead = resolve));
  const status = (phase: 'collecting' | 'ready', projects = 1) => ({
    id,
    phase,
    projects,
    bytes: 1024,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  await page.clock.install();
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (pathname === endpoint + '/container') {
        id = request.postDataJSON().requestId;
        postedIds.push(id);
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(invalidStart ? null : status('collecting')),
        });
      }
      if (pathname.startsWith(endpoint + '/')) {
        if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
        reads++;
        if (firstRead) {
          firstRead = false;
          await initialRead;
        }
        if (invalidStart) {
          await startRead;
          return route.fulfill({ json: status('ready') });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(reply) });
      }
      return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
    },
  );
  try {
    const dialog = await openFixtureBundleDownload(page);
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 60_000);
    await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
    await expect.poll(() => postedIds.length).toBe(1);
    reply = { ...status('collecting', 2), versionPolicy: 'published' };
    releaseInitialRead();
    await expect.poll(() => reads).toBe(1);
    await expect(dialog.getByRole('button', { name: publishedPolicyLabel, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    reply = null;
    await page.clock.fastForward(1000);
    await expect(dialog.getByRole('alert')).toContainText('The server returned invalid export status.');
    const confirmRetainedIdentity = async () => {
      await expectDownloadForm(dialog);
      expect(await page.evaluate((key) => sessionStorage.getItem(key), `rivet-container-bundle:${project.id}`)).toBe(
        id,
      );
    };
    await confirmRetainedIdentity();
    const invalidReplies = [
      { ...status('ready'), id: 'another-job' },
      { ...status('ready'), phase: 'unknown' },
      { ...status('ready'), projects: '1' },
      { ...status('ready'), bytes: -1 },
      { ...status('ready'), expiresAt: 'invalid' },
      { ...status('ready'), versionPolicy: 'unknown' },
      { ...status('ready'), error: { message: 'Do not render this object' } },
      { ...status('ready'), archiveBytes: '1024' },
      { ...status('ready'), archiveHash: {} },
    ];
    for (const [index, invalidReply] of invalidReplies.entries()) {
      reply = status('collecting', index + 3);
      await page.clock.fastForward(5000);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(postedIds).toHaveLength(1);
      reply = invalidReply;
      await page.clock.fastForward(1000);
      await expect(dialog.getByRole('alert')).toContainText('The server returned invalid export status.');
      await confirmRetainedIdentity();
    }
    // Even a previously active job can be retried after a read failure, but
    // only an explicit click and confirmed cleanup may admit its replacement.
    await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeEnabled();
    invalidStart = true;
    await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('The server returned invalid export status.');
    await confirmRetainedIdentity();
    expect(postedIds).toHaveLength(2);
    expect(postedIds[0]).not.toBe(postedIds[1]);
    const download = page.waitForEvent('download');
    releaseStartRead();
    expect(await (await download).failure()).toBeNull();
    await expectDownloadForm(dialog);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(postedIds).toHaveLength(2);
  } finally {
    releaseInitialRead();
    releaseStartRead();
    await page.goto('about:blank');
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('a missing resumed export still displays a genuine status error', async ({ page }) => {
  const project = bundleProject('bundle-missing-resume');
  const id = 'cba5c1c1-b8c8-4d9e-9c9f-553d0a11af6a';
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), {
    key: `rivet-container-bundle:${project.id}`,
    id,
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (url.pathname === `/api/workflows/project-bundles/${id}`)
        return route.fulfill({ status: 404, json: { error: 'Project bundle export not found or expired.' } });
      return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
    },
  );
  const dialog = await openFixtureBundleDownload(page);
  await expect(dialog.getByRole('alert')).toContainText('Project bundle export not found or expired.');
  await expect(dialog.locator('.workflow-project-bundle-spinner')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeEnabled();
  await expectDownloadForm(dialog);
});

test('a rejected bundle start retains its error when status polling finds no job', async ({ page }) => {
  const project = bundleProject('bundle-rejected-start');
  let reads = 0;
  const ids: string[] = [];
  const status = (id: string) => ({
    id,
    phase: 'collecting',
    projects: 0,
    bytes: 0,
    expiresAt: '2099-01-01T00:00:00Z',
  });
  let releaseLastRead!: () => void;
  const lastRead = new Promise<void>((resolve) => (releaseLastRead = resolve));
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: bundleTree(project) });
      if (url.pathname === '/api/workflows/project-bundles/container') {
        ids.push(route.request().postDataJSON().requestId);
        return ids.length === 1
          ? route.fulfill({ status: 403, json: { error: 'Bundle export is not permitted.' } })
          : route.fulfill({ status: 202, json: status(ids.at(-1)!) });
      }
      if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 404 });
        if (url.pathname.endsWith(ids[1] ?? '/no-retry-yet')) return route.fulfill({ json: status(ids[1]!) });
        if (++reads >= 3) await lastRead;
        return route.fulfill({ status: 404, json: { error: 'No job was created.' } });
      }
      return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
    },
  );
  try {
    const dialog = await openFixtureBundleDownload(page);
    await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Bundle export is not permitted.');
    // The third request proves both earlier missing-status responses were handled.
    await expect.poll(() => reads, { timeout: 15000 }).toBe(3);
    await expect(dialog.getByRole('alert')).toContainText('Bundle export is not permitted.');
    await expectDownloadForm(dialog);
    await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
    await expect.poll(() => ids.length).toBe(2);
    expect(ids[1]).not.toBe(ids[0]);
    releaseLastRead();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Download bundle', exact: true })).toBeDisabled();
  } finally {
    releaseLastRead();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const phase of ['ready', 'failed'] as const) {
  test(`switching bundles preserves an unacknowledged export that becomes ${phase}`, async ({ page }) => {
    await page.clock.install();
    const project = bundleProject('bundle-pending-switch');
    const tree = bundleTree(project);
    const alternate = bundleProject('alternate-bundle');
    tree.folders.push({
      ...tree.folders[0]!,
      id: 'alternate-folder',
      bundleId: alternate.id,
      name: 'Alternate feature',
      relativePath: 'Alternate feature',
      absolutePath: '/workflows/Alternate feature',
      projects: [alternate],
    });
    let id = '';
    let posts = 0;
    let reopened = false;
    let reopenedReads = 0;
    let accepted = false;
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => (releaseAdmission = resolve));
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => (releasePoll = resolve));
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/workflows/tree') return route.fulfill({ json: tree });
        if (url.pathname === '/api/workflows/project-bundles/container') {
          posts++;
          id = route.request().postDataJSON().requestId;
          await admission;
          accepted = true;
          return route.fulfill({
            status: 202,
            json: {
              id,
              phase: 'collecting',
              projects: 0,
              bytes: 0,
              expiresAt: '2099-01-01T00:00:00Z',
            },
          });
        }
        if (url.pathname.startsWith('/api/workflows/project-bundles/')) {
          expect(route.request().method()).toBe('GET');
          if (reopened && ++reopenedReads === 2) await pollGate;
          if (!accepted && (!reopened || reopenedReads === 1))
            return route.fulfill({ status: 404, json: { error: 'Export is not registered yet.' } });
          return route.fulfill({
            json: {
              id,
              phase,
              projects: 1,
              bytes: 1024,
              expiresAt: '2099-01-01T00:00:00Z',
              ...(phase === 'failed' ? { error: 'Fixture export failed.' } : {}),
            },
          });
        }
        return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
      },
    );
    try {
      const dialog = await openFixtureBundleDownload(page);
      await dialog.getByRole('button', { name: 'Download bundle', exact: true }).click();
      await expect.poll(() => posts).toBe(1);
      await dialog.getByRole('button', { name: 'Close bundle download' }).click();
      await page
        .getByRole('button', { name: /^(Expand|Collapse) Alternate feature bundle$/ })
        .click({ button: 'right' });
      await openBundleActions(page);
      await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
      await expect(dialog).toHaveAccessibleName('Download bundle "Alternate feature"');
      await expect(dialog.getByRole('group', { name: 'Bundle versions', exact: true })).toBeVisible();
      await expect(dialog.getByRole('status')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close bundle download' }).click();
      reopened = true;
      await page
        .getByRole('button', { name: /^(Expand|Collapse) Portable feature bundle$/ })
        .click({ button: 'right' });
      await openBundleActions(page);
      await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
      const terminalAction = dialog.getByRole('button', { name: 'Download bundle', exact: true });
      await expect(terminalAction).toBeDisabled();
      await expect.poll(() => reopenedReads).toBe(2);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      releasePoll();
      if (phase === 'failed') await expect(dialog.getByRole('alert')).toHaveText('Fixture export failed.');
      else await expect(dialog.locator('a[href$="/download"]')).toHaveCount(1);
      await expectDownloadForm(dialog);
      await expect(terminalAction).toBeDisabled();
      // Terminal status stops polling, but settling the original request must
      // still update this remounted dialog without unrelated periodic renders.
      await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
      releaseAdmission();
      await expect.poll(() => accepted).toBe(true);
      await expect(terminalAction).toBeEnabled();
      if (phase === 'failed') {
        await expect(dialog.getByRole('alert')).toHaveText('Fixture export failed.');
      } else {
        await expect(dialog.getByRole('alert')).toHaveCount(0);
      }
      expect(posts).toBe(1);
    } finally {
      releaseAdmission();
      releasePoll();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

for (const switchBundle of [false, true]) {
  test(`closing during archive cleanup${switchBundle ? ' and switching bundles' : ''} follows the new job without downloading on reopen`, async ({
    page,
  }) => {
    const project = bundleProject('bundle-cleanup-reopen');
    const tree = bundleTree(project);
    tree.folders.push({
      ...tree.folders[0]!,
      id: 'alternate-folder',
      bundleId: 'alternate-bundle',
      name: 'Alternate feature',
      relativePath: 'Alternate feature',
      absolutePath: '/workflows/Alternate feature',
      projects: [],
    });
    const oldId = '4078e10d-1a93-4477-a10d-47147477ee02';
    const ids: string[] = [];
    const downloads: Download[] = [];
    page.on('download', (download) => downloads.push(download));
    let deletes = 0;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve));
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => (releaseAdmission = resolve));
    const status = (id: string, phase = 'ready') => ({
      id,
      phase,
      projects: 1,
      bytes: 1024,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    let newReads = 0;
    let releaseNewStatus!: () => void;
    const newStatus = new Promise<void>((resolve) => (releaseNewStatus = resolve));
    await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), {
      key: `rivet-container-bundle:${project.id}`,
      id: oldId,
    });
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/workflows/tree') return route.fulfill({ json: tree });
        if (pathname === '/api/workflows/project-bundles/container') {
          ids.push(request.postDataJSON().requestId);
          await admission;
          return route.fulfill({ status: 202, json: status(ids.at(-1)!, 'collecting') });
        }
        if (pathname.startsWith('/api/workflows/project-bundles/')) {
          const id = pathname.split('/').at(-1)!;
          if (request.method() === 'DELETE') {
            expect(id).toBe(oldId);
            deletes++;
            await cleanup;
            return route.fulfill({ status: 204 });
          }
          if (id === oldId && deletes)
            return route.fulfill({ status: 404, json: { error: 'Previous archive is already gone.' } });
          if (id !== oldId) {
            if (++newReads === 1)
              return route.fulfill({ status: 404, json: { error: 'Replacement is not registered yet.' } });
            await newStatus;
          }
          return route.fulfill({ json: status(id) });
        }
        return route.fulfill({ status: 503, json: { error: 'Unused fixture route' } });
      },
    );
    try {
      const dialog = await openFixtureBundleDownload(page);
      const downloadButton = dialog.getByRole('button', { name: 'Download bundle', exact: true });
      await expect(downloadButton).toBeEnabled();
      await downloadButton.click();
      await expect.poll(() => deletes).toBe(1);
      await dialog.getByRole('button', { name: 'Close bundle download' }).click();
      if (switchBundle) {
        await page
          .getByRole('button', { name: /^(Expand|Collapse) Alternate feature bundle$/ })
          .click({ button: 'right' });
        await openBundleActions(page);
        await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
        await expect(dialog).toHaveAccessibleName('Download bundle "Alternate feature"');
        await dialog.getByRole('button', { name: 'Close bundle download' }).click();
      }
      await page
        .getByRole('button', { name: /^(Expand|Collapse) Portable feature bundle$/ })
        .click({ button: 'right' });
      await openBundleActions(page);
      await page.getByRole('menuitem', { name: 'Download bundle', exact: true }).click();
      await expect(downloadButton).toBeDisabled();
      await expectDownloadForm(dialog);
      await expect(dialog.getByRole('alert')).toHaveText('Previous archive is already gone.');
      expect(ids).toHaveLength(0);
      releaseCleanup();
      await expect.poll(() => ids.length).toBe(1);
      expect(ids[0]).not.toBe(oldId);
      await expect.poll(() => newReads).toBe(2);
      // The second read proves adoption and the pre-admission 404 completed.
      // Inspect now, before the independently pending POST can time out.
      expect(await dialog.getByRole('alert').allTextContents()).toEqual([]);
      releaseNewStatus();
      await expect(dialog.locator('a[href$="/download"]')).toHaveAttribute(
        'href',
        `/api/workflows/project-bundles/${ids[0]}/download`,
      );
      await expect(downloadButton).toBeDisabled();
      expect(await page.evaluate((key) => sessionStorage.getItem(key), `rivet-container-bundle:${project.id}`)).toBe(
        ids[0],
      );
      releaseAdmission();
      await expect(downloadButton).toBeEnabled();
      await expectDownloadForm(dialog);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(downloads).toHaveLength(0);
      expect(deletes).toBe(1);
      expect(ids).toHaveLength(1);
    } finally {
      releaseCleanup();
      releaseAdmission();
      releaseNewStatus();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
