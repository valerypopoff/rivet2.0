import { expect, test, type Page } from '@playwright/test';
import {
  createBuiltInRegistry,
  deserializeProject,
  serializeProject,
  type Project,
  type ProjectId,
  type GraphId,
} from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

const reference = {
  sourceGraphId: 'caller-graph',
  sourceGraphName: 'Folder/Caller graph',
  nodeId: 'call',
  nodeTitle: 'Use reusable graph',
  targetProjectId: 'target',
  targetGraphId: 'child',
  targetVersion: 'latest',
  projectId: 'closed-caller',
  projectName: 'Closed caller',
  relativePath: 'Folder/closed-caller.rivet-project',
  source: { kind: 'saved-latest' },
};
async function setup(page: Page, includeCaller = false) {
  const registry = createBuiltInRegistry();
  const node = registry.createDynamic('text');
  node.id = 'root-text' as typeof node.id;
  node.visualData = { x: 100, y: 150, width: 200 };
  const target: Project = {
    metadata: { id: 'target' as ProjectId, title: 'Target project', description: '', mainGraphId: 'main' as GraphId },
    graphs: {
      main: { metadata: { id: 'main' as GraphId, name: 'Main' }, nodes: [node], connections: [] },
      child: { metadata: { id: 'child' as GraphId, name: 'Group/Child' }, nodes: [], connections: [] },
      other: { metadata: { id: 'other' as GraphId, name: 'Group/Other' }, nodes: [], connections: [] },
    },
  };
  const call = registry.createDynamic('subGraph');
  call.id = 'caller-node' as typeof call.id;
  call.title = 'Unsaved caller';
  call.visualData = { x: 120, y: 150, width: 220 };
  call.data = {
    graphId: 'child',
    targetProjectId: 'target',
    targetVersion: 'latest',
    targetBoundary: { inputs: [], outputs: [] },
  };
  const editable = registry.createDynamic('text');
  editable.id = 'caller-edit-text' as typeof editable.id;
  editable.visualData = { x: 150, y: 450, width: 220 };
  const missingLibrary = {
    ...editable,
    id: 'missing-library' as typeof editable.id,
    type: 'nodePrefabInstance',
    data: { prefabId: 'missing' },
    visualData: { x: 600, y: 450, width: 220 },
  };
  const caller: Project = {
    metadata: {
      id: 'open-caller' as ProjectId,
      title: 'Open caller',
      description: '',
      mainGraphId: 'caller' as GraphId,
    },
    graphs: {
      caller: {
        metadata: { id: 'caller' as GraphId, name: 'Caller graph' },
        nodes: [missingLibrary, call, editable],
        connections: [],
      },
    },
  };
  const projects = includeCaller ? [target, caller] : [target];
  const saved = new Map(projects.map((project) => [`/workflows/${project.metadata.id}.rivet-project`, project]));
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 503, json: { error: 'Unmocked fixture route' } }),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        folders: [],
        projects: projects.map((project) => ({
          id: project.metadata.id,
          projectMetadataId: project.metadata.id,
          name: project.metadata.title,
          fileName: `${project.metadata.id}.rivet-project`,
          relativePath: `${project.metadata.id}.rivet-project`,
          absolutePath: `/workflows/${project.metadata.id}.rivet-project`,
          updatedAt: '2026-10-19T08:00:00Z',
          settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
        })),
      },
    }),
  );
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({
      json: {
        contents: serializeProject(saved.get(route.request().postDataJSON().path)!),
        datasetsContents: null,
        revisionId: null,
      },
    }),
  );
  await page.route('**/api/projects/save', (route) => {
    const body = route.request().postDataJSON();
    saved.set(body.path, deserializeProject(body.contents)[0]);
    return route.fulfill({ json: { path: body.path, revisionId: 'saved-after-delete' } });
  });
  await page.route('**/api/workflows/subgraph-projects/target/preview?**', (route) =>
    route.fulfill({ json: { project: target } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: 'Target project' }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('[data-graphid="main"]')).toBeVisible();
  if (!(await editor.locator('[data-graphid="child"]').isVisible())) {
    await editor.locator('[data-folderpath="Group"]').first().click();
  }
  await expect(editor.locator('[data-graphid="child"]')).toBeVisible();
  const open = async (folder = false) => {
    await editor
      .locator(folder ? '[data-folderpath="Group"]' : '[data-graphid="child"]')
      .first()
      .click({ button: 'right' });
    await editor.locator('.graph-item-context-menu').getByRole('button', { name: 'Delete', exact: true }).click();
    return editor.getByRole('dialog');
  };
  return { editor, open, saved };
}

test('closed-project callers warn with version semantics before cancel or deliberate graph deletion', async ({
  page,
}) => {
  let requested: string[] = [];
  const fixture = await setup(page);
  await page.route('**/api/workflows/projects/references', (route) => {
    const query = route.request().postDataJSON();
    requested = query.graphIds;
    expect(query.projectId).toBe('target');
    return route.fulfill({
      json: {
        projectId: 'target',
        complete: true,
        graphReferences: [
          reference,
          { ...reference, targetVersion: 'published', source: { kind: 'published-endpoint', label: 'live-caller' } },
        ],
      },
    });
  });
  let dialog = await fixture.open();
  await expect(dialog).toContainText('Closed caller');
  await expect(dialog).toContainText('Folder/Caller graph');
  await expect(dialog).toContainText('Use reusable graph');
  await expect(dialog).toContainText('target: Saved latest');
  await expect(dialog).toContainText('target: Published');
  await expect(dialog).toContainText('until the target publication changes');
  const warning = dialog.getByRole('region', { name: 'Graph deletion warning', exact: true });
  await expect(warning).toHaveCSS('background-color', 'rgb(192, 57, 43)');
  await expect(warning).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(warning.locator('li').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(warning).not.toContainText('This cannot be undone');
  await expect(warning).not.toContainText('This is a point-in-time warning');
  await dialog.screenshot({ path: test.info().outputPath('graph-deletion-warning.png') });
  expect(requested).toEqual(['child']);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fixture.editor.locator('[data-graphid="child"]')).toBeVisible();
  dialog = await fixture.open();
  await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).click();
  await expect(fixture.editor.locator('[data-graphid="child"]')).toHaveCount(0);
  await fixture.editor.locator('.node-canvas').press('Control+S');
  await expect.poll(() => fixture.saved.get('/workflows/target.rivet-project')?.graphs.child).toBeUndefined();
});

test('folder deletion surfaces failed and incomplete scans and requires an explicit proceed', async ({ page }) => {
  const fixture = await setup(page);
  let checks = 0;
  await page.route('**/api/workflows/projects/references', (route) => {
    expect(route.request().postDataJSON().graphIds.sort()).toEqual(['child', 'other']);
    return ++checks === 1
      ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : route.fulfill({ json: { projectId: 'target', complete: false, graphReferences: [reference] } });
  });
  const dialog = await fixture.open(true);
  await expect(dialog).toContainText('Could not check incoming graph references');
  await expect(dialog).toContainText('Missing results do not mean deletion is safe');
  const warning = dialog.getByRole('region', { name: 'Graph deletion warning', exact: true });
  await expect(warning).toContainText('Could not check incoming graph references');
  await expect(warning).toContainText('Missing results do not mean deletion is safe');
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog).toContainText('Closed caller');
  await expect(dialog).toContainText('incomplete');
  await expect(warning).toContainText('Closed caller');
  await expect(warning).toHaveCSS('background-color', 'rgb(192, 57, 43)');
  await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).click();
  await expect(fixture.editor.locator('[data-folderpath="Group"]')).toHaveCount(0);
  await expect(fixture.editor.locator('[data-graphid="main"]')).toBeVisible();
});

test('cancel aborts a pending scan and a late response cannot replace a new review', async ({ page }) => {
  const fixture = await setup(page);
  let release: () => void = () => {};
  let checks = 0;
  await page.route('**/api/workflows/projects/references', async (route) => {
    if (++checks === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route
        .fulfill({ json: { projectId: 'target', complete: true, graphReferences: [reference] } })
        .catch(() => {});
    } else await route.fulfill({ json: { projectId: 'target', complete: true, graphReferences: [] } });
  });
  let dialog = await fixture.open();
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await expect.poll(() => checks).toBe(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  dialog = await fixture.open();
  await expect(dialog).toContainText('No incoming cross-project references were found');
  release();
  await expect(dialog).not.toContainText('Closed caller');
  await expect(dialog.getByRole('region', { name: 'Graph deletion warning', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fixture.editor.locator('[data-graphid="child"]')).toBeVisible();
});

test('failed and partial scans retain clean open callers without duplicating a complete result', async ({ page }) => {
  const fixture = await setup(page, true);
  let checks = 0;
  await page.route('**/api/workflows/projects/references', (route) => {
    checks++;
    if (checks === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    return route.fulfill({
      json: {
        projectId: 'target',
        complete: checks > 2,
        graphReferences: checks === 2 ? [] : [{ ...reference, projectId: 'open-caller', projectName: 'open-caller' }],
      },
    });
  });
  await page.locator('.project-row', { hasText: 'Open caller' }).dblclick();
  const callerTab = fixture.editor.locator('.projects-container .project', { hasText: 'open-caller' });
  await expect(callerTab).toBeVisible();
  await expect(callerTab).not.toHaveClass(/has-unsaved-changes/);
  await fixture.editor.locator('.projects-container .project', { hasText: 'target' }).click();
  const dialog = await fixture.open();
  const warning = dialog.getByRole('region', { name: 'Graph deletion warning', exact: true });
  await expect(warning).toContainText('Could not check incoming graph references');
  await expect(warning).toContainText('Open editor');
  await expect(warning).toContainText('open-caller');
  await expect(warning).toContainText('Unsaved caller');
  await expect(warning).toContainText('The reference check is incomplete');
  await expect(dialog.getByRole('button', { name: 'Delete anyway', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect.poll(() => checks).toBe(2);
  await expect(warning).not.toContainText('Could not check incoming graph references');
  await expect(warning).toContainText('The reference check is incomplete');
  await expect(warning).toContainText('Open editor');
  await expect(dialog.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(warning).toContainText('Saved draft');
  await expect(warning).not.toContainText('Open editor');
  await expect(warning).not.toContainText('The reference check is incomplete');
  await expect(warning.locator('li')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fixture.editor.locator('[data-graphid="child"]')).toBeVisible();
});

test('dirty open callers ignore missing library nodes without hiding real references', async ({ page }) => {
  const fixture = await setup(page, true);
  await page.route('**/api/workflows/projects/references', (route) =>
    route.fulfill({ json: { projectId: 'target', complete: true, graphReferences: [] } }),
  );
  await page.locator('.project-row', { hasText: 'Open caller' }).dblclick();
  const node = fixture.editor.locator('.node[data-nodeid="caller-edit-text"]');
  await expect(node).toBeVisible();
  const originalPosition = await node.evaluate((element) => (element as HTMLElement).style.transform);
  const bounds = (await node.locator('.node-title').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => node.evaluate((element) => (element as HTMLElement).style.transform))
    .not.toBe(originalPosition);
  await expect(fixture.editor.locator('.projects-container .project', { hasText: 'open-caller' })).toHaveClass(
    /has-unsaved-changes/,
  );
  await fixture.editor.locator('.projects-container .project', { hasText: 'target' }).click();
  const dialog = await fixture.open();
  await expect(dialog).toContainText('Unsaved open editor');
  await expect(dialog).toContainText('open-caller');
  await expect(dialog).not.toContainText('The reference check is incomplete');
  await expect(dialog.getByRole('button', { name: 'Delete anyway', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});
