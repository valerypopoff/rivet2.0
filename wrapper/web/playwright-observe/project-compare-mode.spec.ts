import { expect, test, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type {
  WorkflowProjectItem,
  WorkflowPublishedVersionSummary,
  WorkflowTreeResponse,
} from '../dashboard/types';

function isRouteRequest(routeRequest: { method: () => string; url: () => string }, method: string, pathname: string): boolean {
  const url = new URL(routeRequest.url());

  return routeRequest.method() === method && url.pathname === pathname;
}

function createCompareProjectItem(
  name: string,
  settings: Partial<WorkflowProjectItem['settings']> = {},
): WorkflowProjectItem {
  return {
    id: `compare-${name}-project-id`,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-06-12T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      ...settings,
    },
  };
}

function createCompareProjectFile(options: {
  graphId: string;
  nodeText: string;
  projectId: string;
  secondNode?: boolean;
  title: string;
}): string {
  const secondNodeBlock = options.secondNode
    ? [
        '        \'[compare-node-2]:text "Added Node"\':',
        '          visualData: 860/320/260/null//',
        '          data:',
        '            text: added',
      ]
    : [];

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(options.projectId)}`,
    `    title: ${JSON.stringify(options.title)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(options.graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(options.graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(options.graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    '        \'[compare-node-1]:text "Compared Node"\':',
    '          visualData: 520/320/260/null//',
    '          data:',
    `            text: ${options.nodeText}`,
    ...secondNodeBlock,
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function installCompareModeRoutes(
  page: Page,
  projects: WorkflowProjectItem[],
  projectContentsByPath: Map<string, string>,
): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/tree')) {
      await route.fallback();
      return;
    }

    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      folders: [],
      projects,
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });

  await page.route('**/api/projects/load', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/projects/load')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as { path?: string };
    const contents = requestBody.path ? projectContentsByPath.get(requestBody.path) : null;

    if (!contents) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: `Unknown project path: ${requestBody.path ?? ''}` }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents,
        datasetsContents: null,
        revisionId: null,
      }),
    });
  });

  await page.route('**/api/projects/save', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/projects/save')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Project compare mode spec should not save projects.' }),
    });
  });
}

async function installPublishedVersionRoutes(
  page: Page,
  project: WorkflowProjectItem,
  publishedVersion: WorkflowPublishedVersionSummary,
  publishedContents: string,
): Promise<void> {
  await page.route('**/api/workflows/projects/published-versions**', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/projects/published-versions')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versions: [publishedVersion],
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/preview', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/published-versions/preview')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
      versionId?: string;
    };

    if (requestBody.relativePath !== project.relativePath || requestBody.versionId !== publishedVersion.id) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: publishedContents,
        datasetsContents: null,
      }),
    });
  });
}

test.describe('Project compare mode', () => {
  test('starts compare mode from another project row context menu', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-current');
    const referenceProject = createCompareProjectItem('codex-compare-reference');
    const projectContentsByPath = new Map<string, string>([
      [currentProject.absolutePath, createCompareProjectFile({
        graphId: 'compare-current-graph',
        nodeText: 'current',
        projectId: currentProject.id,
        secondNode: true,
        title: currentProject.name,
      })],
      [referenceProject.absolutePath, createCompareProjectFile({
        graphId: 'compare-current-graph',
        nodeText: 'reference',
        projectId: referenceProject.id,
        title: referenceProject.name,
      })],
    ]);

    await installCompareModeRoutes(page, [currentProject, referenceProject], projectContentsByPath);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const referenceRow = page.locator('.project-row', { hasText: referenceProject.name });
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await currentRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Compare opened project with this one' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await referenceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();

    await expect(
      editorFrame.locator('.project-compare-notice').getByText(
        `Compare mode: ${currentProject.name} against ${referenceProject.name}`,
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(referenceProject.fileName)).toBeVisible({ timeout: 30_000 });
  });

  test('starts compare mode against the current published version from the open project row', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-published', {
      status: 'unpublished_changes',
      endpointName: 'codex-compare-published-endpoint',
      lastPublishedAt: '2026-06-12T09:00:00.000Z',
    });
    const currentPublishedVersion: WorkflowPublishedVersionSummary = {
      id: 'current-published-version-id',
      projectId: currentProject.id,
      projectName: currentProject.name,
      endpointName: currentProject.settings.endpointName,
      publishedAt: currentProject.settings.lastPublishedAt ?? '2026-06-12T09:00:00.000Z',
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    const liveContents = createCompareProjectFile({
      graphId: 'compare-published-graph',
      nodeText: 'unpublished changes',
      projectId: currentProject.id,
      secondNode: true,
      title: currentProject.name,
    });
    const publishedContents = createCompareProjectFile({
      graphId: 'compare-published-graph',
      nodeText: 'published',
      projectId: currentProject.id,
      title: currentProject.name,
    });
    const projectContentsByPath = new Map<string, string>([
      [currentProject.absolutePath, liveContents],
    ]);

    await installCompareModeRoutes(page, [currentProject], projectContentsByPath);
    await installPublishedVersionRoutes(page, currentProject, currentPublishedVersion, publishedContents);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Compare to the published version' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await currentRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare to the published version' }).click();

    await expect(
      editorFrame.locator('.project-compare-notice').getByText('Compare mode: Unpublished against Published'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(`Published version of ${currentProject.fileName}`)).toBeVisible({ timeout: 30_000 });
  });

  test('asks which saved version to compare when the reference project has unpublished changes', async ({ page }) => {
    test.slow();

    const currentProject = createCompareProjectItem('codex-compare-current-for-chooser');
    const referenceProject = createCompareProjectItem('codex-compare-reference-with-changes', {
      status: 'unpublished_changes',
      endpointName: 'codex-compare-reference-endpoint',
      lastPublishedAt: '2026-06-12T09:30:00.000Z',
    });
    const currentPublishedVersion: WorkflowPublishedVersionSummary = {
      id: 'reference-current-published-version-id',
      projectId: referenceProject.id,
      projectName: referenceProject.name,
      endpointName: referenceProject.settings.endpointName,
      publishedAt: referenceProject.settings.lastPublishedAt ?? '2026-06-12T09:30:00.000Z',
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    const currentContents = createCompareProjectFile({
      graphId: 'compare-version-choice-graph',
      nodeText: 'current',
      projectId: currentProject.id,
      secondNode: true,
      title: currentProject.name,
    });
    const referencePublishedContents = createCompareProjectFile({
      graphId: 'compare-version-choice-graph',
      nodeText: 'reference published',
      projectId: referenceProject.id,
      title: referenceProject.name,
    });
    const projectContentsByPath = new Map<string, string>([
      [currentProject.absolutePath, currentContents],
    ]);

    await installCompareModeRoutes(page, [currentProject, referenceProject], projectContentsByPath);
    await installPublishedVersionRoutes(page, referenceProject, currentPublishedVersion, referencePublishedContents);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const currentRow = page.locator('.project-row', { hasText: currentProject.name });
    const referenceRow = page.locator('.project-row', { hasText: referenceProject.name });
    const chooserModal = page.getByTestId('workflow-project-version-modal');
    const editorFrame = page.frameLocator('iframe.dashboard-editor-frame');

    await currentRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(currentProject.name, { timeout: 120_000 });
    await expect(editorFrame.locator('.node-canvas')).toBeVisible({ timeout: 120_000 });

    await referenceRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Compare opened project with this one' }).click();

    await expect(chooserModal).toBeVisible();
    await expect(chooserModal.locator('.project-settings-modal-title')).toHaveText('Compare');
    await expect(page.getByRole('button', { name: 'Compare "Published"' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare "Unpublished changes"' })).toBeVisible();

    await page.getByRole('button', { name: 'Compare "Published"' }).click();

    await expect(
      editorFrame.locator('.project-compare-notice').getByText(
        `Compare mode: ${currentProject.name} against ${referenceProject.name} (Published)`,
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(editorFrame.getByText(`Published version of ${referenceProject.fileName}`)).toBeVisible({ timeout: 30_000 });
  });
});
