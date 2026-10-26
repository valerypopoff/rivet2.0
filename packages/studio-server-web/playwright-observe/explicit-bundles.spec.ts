import { test, expect } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowFolderItem } from '../dashboard/types';
import { serializeProject, type ProjectId } from '@valerypopoff/rivet2-core';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';

for (const outcome of ['success', 'blocked', 'lost response', 'refresh failure', 'managed unknown'] as const) {
  test(`non-empty bundle deletion requires a copyable exact name (${outcome})`, async ({ page }, testInfo) => {
    const project = projectBundleFixture().child.project;
    project.metadata.title = 'Member';
    const bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
    const member = {
      id: 'member',
      projectMetadataId: project.metadata.id,
      name: 'Member',
      bundleId,
      fileName: 'Member.rivet-project',
      relativePath: 'Feature/Member.rivet-project',
      absolutePath: '/managed/workflows/Feature/Member.rivet-project',
      updatedAt: '',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    };
    const folder = {
      id: 'Feature',
      name: 'Feature',
      relativePath: 'Feature',
      absolutePath: '/managed/workflows/Feature',
      updatedAt: '',
      bundleId,
      folders: [],
      projects: [member],
      ...(outcome === 'managed unknown' ? { namespaceId: '103632af-089c-4a0e-aa80-ed96dd1d5dbb' } : {}),
    };
    const ordinary = {
      ...folder,
      id: 'Ordinary',
      name: 'Ordinary',
      relativePath: 'Ordinary',
      absolutePath: '/managed/workflows/Ordinary',
      bundleId: null,
      ...(outcome === 'managed unknown' ? { namespaceId: 'd92b7e7d-84fc-43ee-af26-3ee63e0f0a86' } : {}),
      projects: [
        {
          ...member,
          id: 'ordinary-member',
          projectMetadataId: 'ordinary-project',
          bundleId: null,
          relativePath: 'Ordinary/Other.rivet-project',
          absolutePath: '/managed/workflows/Ordinary/Other.rivet-project',
        },
      ],
    };
    let removed = false,
      requests = 0,
      failedRefreshes = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.addInitScript(() =>
      document.addEventListener('copy', (event) => {
        Object.assign(window, {
          __bundleCopiedName: window.getSelection()?.toString(),
          __bundleCopyPrevented: event.defaultPrevented,
        });
      }),
    );
    await page.route('**/api/workflows/tree', (route) => {
      if (removed && outcome === 'refresh failure') {
        failedRefreshes++;
        return route.fulfill({ status: 503, json: { error: 'Tree unavailable' } });
      }
      return route.fulfill({
        json: {
          root: '/managed/workflows',
          capabilities: { explicitBundles: true, namespaceMutations: outcome === 'managed unknown' },
          folders: removed ? [ordinary] : [folder, ordinary],
          projects: [],
        },
      });
    });
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({ json: { contents: serializeProject(project), datasetsContents: null, revisionId: null } }),
    );
    await page.route(`**/api/workflows/bundles/${bundleId}/delete`, async (route) => {
      requests++;
      expect(route.request().postDataJSON()).toMatchObject({ name: 'Feature', relativePath: 'Feature' });
      if (outcome === 'managed unknown')
        expect(route.request().postDataJSON().mutation.expectedSource).toEqual({ id: folder.namespaceId });
      expect(route.request().headers()['x-rivet-bundle-intent']).toBe('1');
      await ready;
      if (outcome === 'blocked')
        return route.fulfill({
          status: 409,
          json: { error: 'Unpublish the workflow endpoint and web apps before deleting the project: Member' },
        });
      if (outcome === 'lost response') return route.abort('failed');
      removed = true;
      if (outcome === 'managed unknown') return route.abort('failed');
      return route.fulfill({
        json: { deleted: true, deletedProjects: [{ path: member.absolutePath, projectId: project.metadata.id }] },
      });
    });
    let receiptLookups = 0;
    await page.route('**/api/workflows/namespace/receipt', (route) => {
      receiptLookups++;
      return route.fulfill({ json: { state: 'unknown' } });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Expand Ordinary', exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Delete folder', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
    const row = page.getByRole('button', { name: 'Expand Feature bundle', exact: true });
    await row.click();
    await expect(page.locator('.project-row').filter({ hasText: 'Member' }).first()).toBeEnabled();
    await page.locator('.project-row').filter({ hasText: 'Member' }).first().dblclick();
    const editorTab = page
      .frameLocator('iframe.dashboard-editor-frame')
      .locator('.projects-container .project:not(.opening)')
      .filter({ hasText: 'Member' });
    await expect(editorTab).toBeVisible();
    const openDelete = async () => {
      await page.getByRole('button', { name: 'Collapse Feature bundle', exact: true }).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Delete folder', exact: true })).toHaveCount(0);
      await page.getByRole('menuitem', { name: 'Delete bundle', exact: true }).click();
    };
    await openDelete();
    const modal = page.getByRole('dialog', { name: 'Delete bundle', exact: true });
    const submit = modal.getByRole('button', { name: 'Delete bundle', exact: true });
    const input = modal.getByRole('textbox', { name: 'Bundle name', exact: true });
    await expect(page.getByTestId('workflow-bundle-delete-modal--blanket')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0.56)',
    );
    await expect(page.getByTestId('workflow-bundle-delete-modal--blanket')).toHaveCSS('backdrop-filter', 'blur(2px)');
    await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
    await expect(page.getByTestId('workflow-bundle-delete-modal--body')).toHaveCSS('padding', '0px');
    await expect(modal.locator('label, .workflow-project-bundle-card')).toHaveCount(0);
    await expect(input).toHaveCSS('height', '38px');
    expect((await input.boundingBox())!.width).toBeGreaterThan((await modal.boundingBox())!.width - 40);
    expect((await modal.boundingBox())!.height).toBeLessThanOrEqual(340);
    if (outcome === 'success')
      await page.screenshot({ path: testInfo.outputPath('bundle-delete-compact.png'), animations: 'disabled' });
    await expect(page.getByRole('separator', { name: 'Resize folders pane' })).toHaveAttribute('aria-disabled', 'true');
    await expect(submit).toBeDisabled();
    await input.fill('feature');
    await expect(submit).toBeDisabled();
    await input.fill('Feature ');
    await expect(submit).toBeDisabled();
    const name = modal.getByTestId('bundle-delete-name');
    await expect(name).toHaveCSS('user-select', 'text');
    // Click within the name, not the surrounding confirmation sentence.
    await name.dblclick({ position: { x: 12, y: (await name.boundingBox())!.height / 2 } });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Feature');
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => (window as any).__bundleCopiedName)).toBe('Feature');
    expect(await page.evaluate(() => (window as any).__bundleCopyPrevented)).toBe(false);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(requests).toBe(0);
    await expect(editorTab).toBeVisible();
    await openDelete();
    await expect(input).toHaveValue('');
    await input.fill('Feature');
    await expect(submit).toBeEnabled();
    await submit.click();
    try {
      await expect.poll(() => requests).toBe(1);
      await expect(modal.getByRole('button', { name: 'Deleting…', exact: true })).toBeDisabled();
      await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(modal).toBeVisible();
    } finally {
      release();
    }
    if (outcome === 'blocked' || outcome === 'lost response' || outcome === 'managed unknown') {
      await expect(modal.getByRole('alert')).toContainText(
        outcome === 'blocked' ? 'Unpublish' : 'refresh the project tree before retrying',
      );
      await expect(editorTab).toBeVisible();
      await expect(submit).toBeEnabled();
      if (outcome === 'managed unknown') {
        await expect(page.getByRole('button', { name: 'Collapse Feature bundle', exact: true })).toHaveCount(0);
        expect(receiptLookups).toBe(1);
        expect(requests).toBe(1);
      }
    } else {
      await expect(modal).toHaveCount(0);
      await expect(editorTab).toHaveCount(0);
      if (outcome === 'refresh failure') {
        // Closing the last member tab also schedules editor reconciliation.
        // A superseded refresh must not become a green success notification.
        await expect(page.locator('.Toastify__toast--warning')).toContainText('Bundle deleted');
        await expect(page.locator('.Toastify__toast--success')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Collapse Feature bundle', exact: true })).toBeVisible();
        expect(failedRefreshes).toBeGreaterThan(0);
      } else {
        await expect(page.getByRole('button', { name: 'Collapse Feature bundle', exact: true })).toHaveCount(0);
      }
    }
    expect(requests).toBe(1);
  });
}

test('compact bundle deletion stays usable with a long name on a narrow short viewport', async ({ page }) => {
  // Open through the tree at a height that fits its context menu, then resize
  // the modal itself: this fixture owns dialog layout, not menu placement.
  await page.setViewportSize({ width: 360, height: 1000 });
  const name = `Long bundle ${'very-long-name-'.repeat(12)}`;
  const folder = {
    id: 'long',
    name,
    relativePath: name,
    absolutePath: `/workflows/${name}`,
    updatedAt: '',
    bundleId: '58019223-bd4e-49c3-a042-321215efaa35',
    folders: [],
    projects: [],
  };
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        capabilities: { explicitBundles: true },
        folders: [folder],
        projects: [],
      },
    }),
  );
  let deletions = 0;
  await page.route('**/api/workflows/bundles/*/delete', (route) => {
    deletions++;
    return route.abort();
  });
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page
    .getByRole('button', { name: `Expand ${name} bundle`, exact: true })
    .click({ button: 'right', position: { x: 20, y: 10 } });
  await page.getByRole('menuitem', { name: 'Delete bundle', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 430 });
  const modal = page.getByRole('dialog', { name: 'Delete bundle', exact: true });
  await expect(modal.getByRole('button', { name: 'Close bundle deletion' })).toBeInViewport();
  await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  const input = modal.getByRole('textbox', { name: 'Bundle name', exact: true });
  await input.fill(name);
  await expect(input).toBeInViewport();
  await expect(modal.getByRole('button', { name: 'Delete bundle', exact: true })).toBeEnabled();
  expect(await modal.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(deletions).toBe(0);
});

test('opening a moved folder member uses its new bundle even when the tree refresh fails', async ({ page }) => {
  const bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
  const project = projectBundleFixture().child.project;
  project.metadata.title = 'Moved project';
  const source: WorkflowFolderItem = {
    id: 'Source',
    name: 'Source',
    relativePath: 'Source',
    absolutePath: '/workflows/Source',
    updatedAt: '',
    bundleId: null,
    folders: [],
    projects: [
      {
        id: 'member',
        projectMetadataId: project.metadata.id,
        name: 'Moved project',
        fileName: 'Moved project.rivet-project',
        relativePath: 'Source/Moved project.rivet-project',
        absolutePath: '/workflows/Source/Moved project.rivet-project',
        updatedAt: '',
        bundleId: null,
        settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
      },
    ],
  };
  const destination: WorkflowFolderItem = {
    id: 'Feature',
    name: 'Feature',
    relativePath: 'Feature',
    absolutePath: '/workflows/Feature',
    updatedAt: '',
    bundleId,
    folders: [],
    projects: [],
  };
  let moved = false,
    failedRefreshes = 0;
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'open-project') (window.top as any).__bundleMoveOpenCommand = event.data;
    });
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/workflows/tree') {
        if (moved) {
          failedRefreshes++;
          return route.fulfill({ status: 503, json: { error: 'Fixture tree temporarily unavailable' } });
        }
        return route.fulfill({
          json: {
            root: '/workflows',
            capabilities: { explicitBundles: true },
            folders: [source, destination],
            projects: [],
          },
        });
      }
      if (path === '/api/workflows/move') {
        expect(route.request().postDataJSON()).toEqual({
          itemType: 'folder',
          sourceRelativePath: 'Source',
          destinationFolderRelativePath: 'Feature',
        });
        moved = true;
        return route.fulfill({
          json: {
            folder: {
              ...source,
              id: 'Feature/Source',
              relativePath: 'Feature/Source',
              absolutePath: '/workflows/Feature/Source',
              projects: [],
              folders: [],
            },
            movedProjectPaths: [
              {
                fromAbsolutePath: source.projects[0]!.absolutePath,
                toAbsolutePath: '/workflows/Feature/Source/Moved project.rivet-project',
              },
            ],
          },
        });
      }
      if (path === '/api/projects/load')
        return route.fulfill({
          json: {
            contents: serializeProject(project),
            datasetsContents: null,
            revisionId: null,
          },
        });
      return route.fulfill({ status: 503, json: { error: 'No ambient API in fixture' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  page.on('dialog', (dialog) => void dialog.accept());
  await expect(page.getByRole('button', { name: 'Expand Source', exact: true })).toHaveAttribute('draggable', 'true');
  await page
    .getByRole('button', { name: 'Expand Source', exact: true })
    .dragTo(page.getByRole('button', { name: 'Expand Feature bundle', exact: true }));
  await expect.poll(() => moved).toBe(true);
  await expect.poll(() => failedRefreshes).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Expand Feature bundle', exact: true }).click();
  await page.locator('.project-row').filter({ hasText: 'Moved project' }).dblclick();
  await expect.poll(() => page.evaluate(() => (window as any).__bundleMoveOpenCommand?.bundleId)).toBe(bundleId);
  await expect(
    page
      .frameLocator('iframe.dashboard-editor-frame')
      .locator('.projects-container .project')
      .filter({ hasText: 'Moved project' }),
  ).toBeVisible();
});

test('folder conversion and one-click duplication preserve the tree without a modal', async ({ page }) => {
  const folders: WorkflowFolderItem[] = [];
  const bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
  const folder = (name: string, id: string | null): WorkflowFolderItem => ({
    id: name,
    name,
    bundleId: id,
    relativePath: name,
    absolutePath: `/managed/workflows/${name}`,
    updatedAt: '',
    folders: [],
    projects: [],
  });
  let duplicateAttempts = 0;
  let directCreations = 0;
  let previews = 0;
  let releaseCopy!: () => void;
  const copyReady = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/workflows/tree')
        return route.fulfill({
          json: { root: '/managed/workflows', capabilities: { explicitBundles: true }, folders, projects: [] },
        });
      if (path === '/api/workflows/folders' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        expect(body).toEqual({ name: 'Feature' });
        const created = folder(body.name, null);
        folders.push(created);
        return route.fulfill({ status: 201, json: { folder: created } });
      }
      if (path.startsWith('/api/workflows/bundles')) {
        expect(route.request().headers()['x-rivet-bundle-intent']).toBe('1');
        const body = route.request().postDataJSON();
        if (path.endsWith('/preview')) {
          previews++;
          return route.fulfill({ status: 503, json: { error: 'No preview dialog is needed' } });
        }
        if (path.endsWith('/duplicate')) {
          duplicateAttempts++;
          expect(body).toEqual({
            automatic: true,
            receipt: { operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), expiresAt: expect.any(String) },
          });
          if (duplicateAttempts === 1)
            return route.fulfill({ status: 409, json: { error: 'The bundle changed. Try duplicating it again.' } });
          await copyReady;
          const copy = folder('Feature copy', '85019223-bd4e-49c3-a042-321215efaa35');
          folders.push(copy);
          return route.fulfill({ status: 201, json: { folder: copy } });
        }
        if (path.endsWith('/kind')) {
          folders[0]!.bundleId = body.enabled ? bundleId : null;
          return route.fulfill({ json: { folder: folders[0] } });
        }
        directCreations++;
        return route.fulfill({ status: 503, json: { error: 'Direct bundle creation must not be used' } });
      }
      if (path.includes('local-upgrade')) return route.fulfill({ json: { available: false } });
      return route.fulfill({ status: 503, json: { error: 'No ambient API in bundle fixture' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.getByRole('button', { name: '+ New bundle', exact: true })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept('Feature'));
  await page.getByRole('button', { name: '+ New folder', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Expand Feature', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New bundle', exact: true })).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('menuitem', { name: 'Convert to bundle', exact: true }).click();
  const row = page.getByRole('button', { name: 'Expand Feature bundle', exact: true });
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New bundle', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Duplicate bundle', exact: true })).toHaveCount(0);
  await expect(page.locator('.Toastify__toast--error')).toContainText('The bundle changed');
  expect(duplicateAttempts).toBe(1); // A failed or lost response is never automatically retried.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Duplicating Feature from saved versions' })).toBeVisible();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true })).toBeDisabled();
  expect(duplicateAttempts).toBe(2);
  await page.keyboard.press('Escape');
  releaseCopy();
  await expect(page.getByRole('button', { name: 'Collapse Feature copy bundle', exact: true })).toBeVisible();
  await expect(page.locator('.Toastify__toast--success')).toContainText('duplicated from saved versions');
  page.once('dialog', (dialog) => dialog.accept());
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to ordinary folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Feature', exact: true })).toBeVisible();
  expect(directCreations).toBe(0);
  expect(previews).toBe(0);
});

for (const failure of ['tree refresh', 'lost response'] as const) {
  test(`one-click duplicate handles ${failure} without hiding the source or retrying`, async ({ page }) => {
    const name = failure === 'lost response' ? 'B'.repeat(245) : 'Feature';
    const source: WorkflowFolderItem = {
      id: name,
      name,
      relativePath: name,
      absolutePath: `/workflows/${name}`,
      bundleId: '58019223-bd4e-49c3-a042-321215efaa35',
      updatedAt: '',
      folders: [],
      projects: [],
    };
    let committed = false;
    let attempts = 0;
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workflows/tree', (route) =>
      committed
        ? route.fulfill({ status: 503, json: { error: 'Tree refresh unavailable' } })
        : route.fulfill({
            json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [source], projects: [] },
          }),
    );
    await page.route('**/api/workflows/bundles/*/duplicate', async (route) => {
      attempts++;
      await responseReady;
      if (failure === 'lost response') return route.abort('failed');
      committed = true;
      return route.fulfill({ status: 201, json: { folder: { ...source, id: 'copy', name: 'Feature copy' } } });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.getByRole('button', { name: `Expand ${name} bundle`, exact: true });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
    try {
      await expect(page.getByRole('status').filter({ hasText: `Duplicating ${name}` })).toBeVisible();
      if (failure === 'lost response') {
        const body = page.locator('.workflow-library-panel .body');
        expect(await body.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await expect(page.getByRole('button', { name: '+ New folder', exact: true })).toBeInViewport();
      }
    } finally {
      release();
    }
    if (failure === 'tree refresh') {
      await expect(page.locator('.Toastify__toast--warning')).toContainText('copy was created');
      await expect(page.locator('.Toastify__toast--warning')).toContainText('Refresh the tree');
    } else await expect(page.locator('.Toastify__toast--error')).toContainText('Refresh the tree before retrying');
    await expect(row).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: `Duplicating ${name}` })).toHaveCount(0);
    await row.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true })).toBeEnabled();
    expect(attempts).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Duplicate bundle', exact: true })).toHaveCount(0);
  });
}

for (const enabled of [true, false]) {
  test(`successful conversion ${enabled ? 'to bundle' : 'to folder'} survives a failed tree refresh`, async ({
    page,
  }) => {
    const bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
    const source: WorkflowFolderItem = {
      id: 'Feature',
      name: 'Feature',
      relativePath: 'Feature',
      absolutePath: '/workflows/Feature',
      updatedAt: '',
      bundleId: enabled ? null : bundleId,
      folders: [],
      projects: [],
    };
    let converted = false;
    let attempts = 0;
    await page.route('**/api/workflows/tree', (route) =>
      converted
        ? route.fulfill({ status: 503, json: { error: 'Tree refresh unavailable' } })
        : route.fulfill({
            json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [source], projects: [] },
          }),
    );
    await page.route('**/api/workflows/bundles/kind', (route) => {
      attempts++;
      expect(route.request().postDataJSON()).toEqual({ relativePath: 'Feature', enabled });
      converted = true;
      return route.fulfill({ json: { folder: { ...source, bundleId: enabled ? bundleId : null } } });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.getByRole('button', { name: `Expand Feature${enabled ? '' : ' bundle'}`, exact: true });
    await row.click({ button: 'right' });
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('menuitem', { name: enabled ? 'Convert to bundle' : 'Convert to ordinary folder', exact: true })
      .click();
    const notification = page.locator('.Toastify__toast--warning');
    await expect(notification).toContainText('Conversion completed');
    await expect(notification).toContainText('Refresh the tree');
    await expect(row).toBeVisible(); // The last authoritative tree remains visible, without pretending it refreshed.
    await expect(page.getByRole('status').filter({ hasText: 'Converting Feature' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /Could not (create|convert) bundle/ })).toHaveCount(0);
    expect(attempts).toBe(1);
    await row.click({ button: 'right' });
    await expect(
      page.getByRole('menuitem', { name: enabled ? 'Convert to bundle' : 'Convert to ordinary folder', exact: true }),
    ).toBeEnabled();
  });
}

for (const pending of ['conversion', 'duplication'] as const) {
  test(`bundle menus reflect the shared guard during ${pending}`, async ({ page }) => {
    const source: WorkflowFolderItem = {
      id: 'Source',
      name: 'Source',
      relativePath: 'Source',
      absolutePath: '/workflows/Source',
      updatedAt: '',
      bundleId: pending === 'duplication' ? '58019223-bd4e-49c3-a042-321215efaa35' : null,
      folders: [],
      projects: [],
    };
    const other: WorkflowFolderItem = {
      ...source,
      id: 'Other',
      name: 'Other',
      relativePath: 'Other',
      bundleId: '85019223-bd4e-49c3-a042-321215efaa35',
    };
    let requests = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [source, other], projects: [] },
      }),
    );
    await page.route('**/api/workflows/bundles/**', async (route) => {
      requests++;
      await ready;
      source.bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
      return route.fulfill({ status: pending === 'conversion' ? 200 : 201, json: { folder: source } });
    });
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page
      .getByRole('button', { name: `Expand Source${source.bundleId ? ' bundle' : ''}`, exact: true })
      .click({ button: 'right' });
    if (pending === 'conversion') page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('menuitem', { name: pending === 'conversion' ? 'Convert to bundle' : 'Duplicate bundle', exact: true })
      .click();
    try {
      await expect.poll(() => requests).toBe(1);
      await page.getByRole('button', { name: 'Expand Other bundle', exact: true }).click({ button: 'right' });
      expect(await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).isEnabled()).toBe(false);
      expect(await page.getByRole('menuitem', { name: 'Convert to ordinary folder', exact: true }).isEnabled()).toBe(
        false,
      );
      expect(requests).toBe(1);
    } finally {
      release();
    }
    await expect(page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: 'Convert to ordinary folder', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
  });
}

test('large bundle definition warnings stay concise on a short screen', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 430 });
  const source = {
    id: 'Feature',
    name: 'Feature',
    relativePath: 'Feature',
    absolutePath: '/workflows/Feature',
    updatedAt: '',
    bundleId: '58019223-bd4e-49c3-a042-321215efaa35',
    folders: [],
    projects: [],
  };
  const warnings = Array.from(
    { length: 256 },
    (_, index) => `Member ${index}: unresolved saved graph definition. ${'Diagnostic detail. '.repeat(25)}`,
  );
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [source], projects: [] },
    }),
  );
  await page.route('**/api/workflows/bundles/*/duplicate', (route) =>
    route.fulfill({ status: 201, json: { folder: { ...source, id: 'copy', name: 'Feature copy' }, warnings } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'Expand Feature bundle', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
  const notice = page.locator('.Toastify__toast--warning');
  await expect(notice).toBeVisible();
  expect((await notice.innerText()).length).toBeLessThan(1000);
  await expect(notice).toContainText('256');
  await expect(notice).toContainText('Member 0');
  expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(414);
  await expect(notice).toBeInViewport();
});

test('old servers do not advertise explicit bundle actions', async ({ page }) => {
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({ json: { root: '/workflows', folders: [], projects: [] } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.getByRole('button', { name: '+ New bundle', exact: true })).toHaveCount(0);
});

test('rejected cross-bundle conversion opens an actionable modal and leaves an ordinary folder', async ({
  page,
}, testInfo) => {
  const folder = {
    id: 'Feature',
    name: 'Feature',
    relativePath: 'Feature',
    absolutePath: '/workflows/Feature',
    updatedAt: '',
    bundleId: null,
    folders: [],
    projects: [],
  };
  let attempts = 0;
  const error =
    'Cannot convert to bundle: Feature/Caller.rivet-project (saved draft) references Other/Target.rivet-project in another bundle (Other). Retarget it to a project in this folder or to an ordinary project, then retry. Nothing was changed.';
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [folder], projects: [] },
    }),
  );
  await page.route('**/api/workflows/bundles/kind', (route) => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ relativePath: 'Feature', enabled: true });
    return route.fulfill({ status: 409, json: { error, code: 'bundle_cross_bundle_reference' } });
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  page.on('dialog', (dialog) => void dialog.accept());
  const row = page.getByRole('button', { name: 'Expand Feature', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to bundle', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Could not create bundle', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('alert')).toHaveText(error);
  await expect(modal.getByRole('heading', { name: 'What to do next' })).toBeVisible();
  await expect(modal).toContainText('republish the affected workflow endpoint or web app');
  await expect(page.locator('.Toastify__toast').filter({ hasText: error })).toHaveCount(0);
  await expect(modal).toHaveCSS('background-color', 'rgb(31, 31, 34)');
  await page.screenshot({ path: testInfo.outputPath('bundle-conversion-error.png') });
  expect(attempts).toBe(1);
  await expect(row).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand Feature bundle', exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Download bundle', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Convert to bundle', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Convert to bundle', exact: true }).click();
  await expect(modal).toBeVisible();
  expect(attempts).toBe(2); // Closing never retries the write.
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('uncertain conversion failure shows connection guidance without claiming nothing changed', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 430 });
  const folder = {
    id: 'Feature',
    name: 'Feature',
    relativePath: 'Feature',
    absolutePath: '/workflows/Feature',
    updatedAt: '',
    bundleId: null,
    folders: [],
    projects: [],
  };
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [folder], projects: [] },
    }),
  );
  await page.route('**/api/workflows/bundles/kind', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Connection unavailable. ' + 'Long diagnostic detail. '.repeat(120) },
    }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Expand Feature', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to bundle', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Could not create bundle', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('check whether the conversion completed before retrying');
  await expect(modal).not.toContainText('The folder has not been converted.');
  const close = modal.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeInViewport();
  const box = await modal.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(430);
  await close.click();
  await expect(modal).toHaveCount(0);
});

test('folder menus offer conversion, never nested creation or bundle upload', async ({ page }) => {
  const folder = (name: string, relativePath: string, bundleId: string | null): WorkflowFolderItem => ({
    id: relativePath,
    name,
    relativePath,
    absolutePath: `/workflows/${relativePath}`,
    bundleId,
    updatedAt: '',
    folders: [],
    projects: [],
  });
  const parent = folder('Parent', 'Parent', null);
  const bundle = folder('Feature', 'Parent/Feature', '58019223-bd4e-49c3-a042-321215efaa35');
  bundle.folders.push(folder('Nested', 'Parent/Feature/Nested', null));
  parent.folders.push(bundle, folder('Feature sibling', 'Parent/Feature sibling', null));
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [parent], projects: [] },
    }),
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await expect(page.getByRole('button', { name: '+ New bundle', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand Parent', exact: true }).click();
  const bundlePath = await page.getByRole('img', { name: 'Bundle', exact: true }).locator('path').getAttribute('d');
  for (const name of ['Parent', 'Feature sibling']) {
    await page
      .getByRole('button', { name: `${name === 'Parent' ? 'Collapse' : 'Expand'} ${name}`, exact: true })
      .click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'New bundle', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Upload bundle', exact: true })).toBeVisible();
    if (name === 'Feature sibling') {
      const convert = page.getByRole('menuitem', { name: 'Convert to bundle', exact: true });
      await expect(convert).toBeVisible();
      await expect(convert.locator('svg path')).toHaveAttribute('d', bundlePath!);
    }
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Expand Feature bundle', exact: true }).click();
  for (const name of ['Collapse Feature bundle', 'Expand Nested']) {
    await page.getByRole('button', { name, exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'New bundle', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Upload bundle', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Upload project', exact: true })).toBeVisible();
    if (name === 'Expand Nested')
      await expect(page.getByRole('menuitem', { name: 'Convert to bundle', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

for (const editCheck of ['complete', 'predecessor editor', 'saving project'] as const) {
  test(`one-click bundle duplication leaves unsaved edits untouched with ${editCheck}`, async ({ page }) => {
    if (editCheck !== 'complete')
      await page.addInitScript((mode) => {
        window.addEventListener(
          'message',
          (event) => {
            if (event.data?.type !== 'workflow-project-reconciliation-captured') return;
            const context = event.data.context;
            if (mode === 'saving project') {
              context.editCheckComplete = false;
              context.projects = [];
            } else {
              delete context.editCheckComplete;
              for (const project of context.projects) delete project.hasUnsavedChanges;
            }
          },
          true,
        );
      }, editCheck);
    const project = projectBundleFixture().child.project;
    project.metadata.id = 'one' as ProjectId;
    project.metadata.title = 'Member';
    const bundleId = '58019223-bd4e-49c3-a042-321215efaa35';
    const member = {
      id: 'one',
      projectMetadataId: 'one',
      bundleId,
      name: 'Member',
      fileName: 'Member.rivet-project',
      relativePath: 'Feature/Member.rivet-project',
      absolutePath: '/managed/workflows/Feature/Member.rivet-project',
      updatedAt: '',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    };
    const folder = {
      id: 'Feature',
      name: 'Feature',
      relativePath: 'Feature',
      absolutePath: '/managed/workflows/Feature',
      bundleId,
      updatedAt: '',
      folders: [],
      projects: [member],
    };
    let saves = 0;
    let duplicates = 0;
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/workflows/tree')
          return route.fulfill({
            json: {
              root: '/managed/workflows',
              capabilities: { explicitBundles: true },
              folders: [folder],
              projects: [],
            },
          });
        if (path === '/api/projects/load')
          return route.fulfill({
            json: { contents: serializeProject(project), datasetsContents: null, revisionId: null },
          });
        if (path === '/api/projects/save') saves++;
        if (path.endsWith('/duplicate')) {
          duplicates++;
          expect(route.request().postDataJSON()).toEqual({
            automatic: true,
            receipt: { operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), expiresAt: expect.any(String) },
          });
          return route.fulfill({
            status: 201,
            json: {
              folder: { ...folder, id: 'copy', name: 'Feature copy' },
              warnings: editCheck === 'predecessor editor' ? ['Member: unresolved saved graph definition.'] : [],
            },
          });
        }
        return route.fulfill({ status: 503, json: { error: 'No ambient API in fixture' } });
      },
    );
    await mockHostedEditorBootstrap(page);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Expand Feature bundle', exact: true }).click();
    await page.locator('.project-row').filter({ hasText: 'Member' }).dblclick();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const tab = editor.locator('.projects-container .project:not(.opening)').filter({ hasText: 'Member' });
    const title = editor.locator(`.node[data-nodeid="${Object.values(project.graphs)[0]!.nodes[0]!.id}"] .node-title`);
    await expect(title).toBeVisible();
    const box = (await title.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await expect(tab).toHaveClass(/has-unsaved-changes/);
    await page.getByRole('button', { name: 'Collapse Feature bundle', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
    const notification = page.locator(
      editCheck === 'predecessor editor' ? '.Toastify__toast--warning' : '.Toastify__toast--success',
    );
    await expect(notification).toContainText('Unsaved edits were not copied');
    if (editCheck === 'predecessor editor')
      await expect(notification).toContainText('unresolved saved graph definition');
    await expect(page.getByRole('dialog', { name: 'Duplicate bundle', exact: true })).toHaveCount(0);
    await expect(tab).toHaveClass(/has-unsaved-changes/);
    expect(duplicates).toBe(1);
    expect(saves).toBe(0);
  });
}
