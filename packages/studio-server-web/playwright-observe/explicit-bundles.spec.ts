import { test, expect } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowFolderItem } from '../dashboard/types';
import { serializeProject, type ProjectId } from '@valerypopoff/rivet2-core';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';

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

test('explicit bundle creation, reviewed duplication and conversion preserve the tree', async ({ page }) => {
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
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/workflows/tree')
        return route.fulfill({
          json: { root: '/managed/workflows', capabilities: { explicitBundles: true }, folders, projects: [] },
        });
      if (path.startsWith('/api/workflows/bundles')) {
        expect(route.request().headers()['x-rivet-bundle-intent']).toBe('1');
        const body = route.request().postDataJSON();
        if (path.endsWith('/preview'))
          return route.fulfill({
            json: {
              bundleId,
              name: 'Feature',
              relativePath: 'Feature',
              fingerprint: 'f'.repeat(64),
              version: body.version,
              members: [
                {
                  projectId: 'one',
                  relativePath: 'Feature/One.rivet-project',
                  revisionId: 'revision',
                  selectedVersion: 'latest',
                },
              ],
              externalProjectIds: ['shared-classifier'],
              warnings: [],
            },
          });
        if (path.endsWith('/duplicate')) {
          duplicateAttempts++;
          expect(body.fingerprint).toBe('f'.repeat(64));
          if (duplicateAttempts === 1)
            return route.fulfill({ status: 409, json: { error: 'The bundle changed. Review a fresh preview.' } });
          const copy = folder(body.name, '85019223-bd4e-49c3-a042-321215efaa35');
          folders.push(copy);
          return route.fulfill({ status: 201, json: { folder: copy } });
        }
        if (path.endsWith('/kind')) {
          folders[0]!.bundleId = body.enabled ? bundleId : null;
          return route.fulfill({ json: { folder: folders[0] } });
        }
        const created = folder(body.name, bundleId);
        folders.push(created);
        return route.fulfill({ status: 201, json: { folder: created } });
      }
      if (path.includes('local-upgrade')) return route.fulfill({ json: { available: false } });
      return route.fulfill({ status: 503, json: { error: 'No ambient API in bundle fixture' } });
    },
  );
  await mockHostedEditorBootstrap(page);
  await page.goto('/');
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: '+ New bundle', exact: true }).click();
  let modal = page.getByRole('dialog', { name: 'New bundle', exact: true });
  await modal.getByLabel('Bundle name').fill('Feature');
  await modal.getByRole('button', { name: 'Create bundle', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const row = page.getByRole('button', { name: 'Expand Feature bundle', exact: true });
  // A newly created group is expanded, unlike the pre-existing library folders.
  await page.getByRole('button', { name: 'Collapse Feature bundle', exact: true }).click();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New bundle', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Duplicate bundle', exact: true }).click();
  modal = page.getByRole('dialog', { name: 'Duplicate bundle', exact: true });
  await expect(modal).toContainText('shared-classifier');
  await modal.getByRole('button', { name: 'Published', exact: true }).click();
  await expect(modal).toContainText('(no publication)');
  await modal.getByRole('button', { name: 'Duplicate bundle', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('bundle changed');
  await expect(modal.getByRole('button', { name: 'Duplicate bundle', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(modal.getByRole('button', { name: 'Duplicate bundle', exact: true })).toBeEnabled();
  await modal.getByRole('button', { name: 'Duplicate bundle', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Collapse Feature copy bundle', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to ordinary folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand Feature', exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: '+ New bundle', exact: true })).toBeVisible();
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
  test(`bundle duplication protects unsaved edits with ${editCheck}`, async ({ page }) => {
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
        if (path.endsWith('/preview'))
          return route.fulfill({
            json: {
              bundleId,
              name: 'Feature',
              relativePath: 'Feature',
              fingerprint: 'a'.repeat(64),
              version: 'latest',
              members: [
                { projectId: 'one', relativePath: member.relativePath, revisionId: 'one', selectedVersion: 'latest' },
              ],
              externalProjectIds: [],
              warnings: [],
            },
          });
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
    const modal = page.getByRole('dialog', { name: 'Duplicate bundle', exact: true });
    await expect(modal).toContainText(
      editCheck === 'complete' ? 'These opened members have unsaved edits' : 'Open edits could not be fully checked.',
    );
    await expect(modal.getByRole('button', { name: 'Duplicate bundle', exact: true })).toBeDisabled();
    await modal
      .getByRole('checkbox', {
        name:
          editCheck === 'complete'
            ? 'Copy saved versions without these unsaved edits'
            : 'Copy saved versions without checking open edits',
      })
      .check();
    await expect(modal.getByRole('button', { name: 'Duplicate bundle', exact: true })).toBeEnabled();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(tab).toHaveClass(/has-unsaved-changes/);
    expect(saves).toBe(0);
  });
}
