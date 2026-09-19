import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowTreeResponse,
} from '../../studio-server-shared/workflow-types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

function createProjectContents({
  graphFolderName,
  graphName,
  projectName,
}: {
  graphFolderName: string;
  graphName: string;
  projectName: string;
}): string {
  return [
    'version: 4',
    'data:',
    '  metadata:',
    '    id: "sidebar-name-wrapping-project"',
    `    title: ${JSON.stringify(projectName)}`,
    '    description: ""',
    '    mainGraphId: "main"',
    '  graphs:',
    '    main:',
    '      metadata:',
    '        id: "main"',
    `        name: ${JSON.stringify(`${graphFolderName}/${graphName}`)}`,
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

async function expectWrappedLabel(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const metrics = await locator.evaluate((element) => {
    const styles = getComputedStyle(element);
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      height: bounds.height,
      lineHeight,
      overflowWrap: styles.overflowWrap,
      scrollWidth: element.scrollWidth,
      textOverflow: styles.textOverflow,
      whiteSpace: styles.whiteSpace,
    };
  });

  expect(metrics.whiteSpace).toBe('normal');
  expect(metrics.overflowWrap).toBe('anywhere');
  expect(metrics.textOverflow).toBe('clip');
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5);
}

async function expectFirstLineMarkAlignment(mark: Locator, label: Locator): Promise<void> {
  await expect(mark).toBeVisible();
  const [markBox, labelMetrics] = await Promise.all([
    mark.boundingBox(),
    label.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        top: bounds.top,
      };
    }),
  ]);

  expect(markBox).not.toBeNull();
  const markCenter = markBox!.y + markBox!.height / 2;
  const firstLineCenter = labelMetrics.top + labelMetrics.lineHeight / 2;
  expect(Math.abs(markCenter - firstLineCenter)).toBeLessThanOrEqual(3);
}

async function installWrappingFixture(page: Page, tree: WorkflowTreeResponse, projectContents: string): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });
  await page.route('**/api/projects/load', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ contents: projectContents, datasetsContents: null, revisionId: null }),
    });
  });
  await page.route('**/api/workflows/projects/web-apps**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/workflows/projects/web-apps') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ webApps: [] }),
    });
  });
}

test('wraps long project, graph, and folder names in the server and editor sidebars', async ({ page }) => {
  const projectName = `project-${'unbroken-name-'.repeat(14)}`;
  const serverFolderName = `server-folder-${'unbroken-name-'.repeat(12)}`;
  const graphFolderName = `editor-folder-${'unbroken-name-'.repeat(12)}`;
  const graphName = `graph-${'unbroken-name-'.repeat(14)}`;
  const project: WorkflowProjectItem = {
    id: 'sidebar-name-wrapping-project',
    name: projectName,
    fileName: 'sidebar-name-wrapping-project.rivet-project',
    relativePath: `${serverFolderName}/sidebar-name-wrapping-project.rivet-project`,
    absolutePath: `/workflows/${serverFolderName}/sidebar-name-wrapping-project.rivet-project`,
    updatedAt: '2026-09-19T00:00:00.000Z',
    settings: {
      status: 'published',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
  const folder: WorkflowFolderItem = {
    id: 'sidebar-name-wrapping-folder',
    name: serverFolderName,
    relativePath: serverFolderName,
    absolutePath: `/workflows/${serverFolderName}`,
    updatedAt: project.updatedAt,
    folders: [],
    projects: [project],
  };
  const tree: WorkflowTreeResponse = {
    root: '/workflows',
    sync: { epoch: 'sidebar-name-wrapping', revision: 0 },
    folders: [folder],
    projects: [],
  };

  await installWrappingFixture(page, tree, createProjectContents({ graphFolderName, graphName, projectName }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const serverFolderRow = page.locator('.workflow-library-panel .folder-row', { hasText: serverFolderName });
  const serverFolderLabel = serverFolderRow.locator('.label');
  await expectWrappedLabel(serverFolderLabel);
  await expectFirstLineMarkAlignment(serverFolderRow.locator('.folder-project-count'), serverFolderLabel);
  await serverFolderRow.click();

  const serverProjectRow = page.locator('.workflow-library-panel .project-row', { hasText: projectName });
  const serverProjectLabel = serverProjectRow.locator('.label');
  await expectWrappedLabel(serverProjectLabel);
  await expectFirstLineMarkAlignment(serverProjectRow.locator('.project-status-dot'), serverProjectLabel);
  await serverProjectRow.dblclick();

  const activeProjectName = page.locator('.workflow-library-panel .active-project-name');
  await expectWrappedLabel(activeProjectName);
  const activeProjectCard = page.locator('.workflow-library-panel .active-project-section');
  const activeProjectCardBox = await activeProjectCard.boundingBox();
  expect(activeProjectCardBox).not.toBeNull();
  expect(activeProjectCardBox?.height).toBeGreaterThan(166);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('#graph-tree-sidebar')).toBeVisible({ timeout: 90_000 });
  await expectWrappedLabel(editor.locator('.project-tree-header-title'));
  const editorFolderLabel = editor.locator('.folder-graph-item .graph-item-name-text', { hasText: graphFolderName });
  await expectWrappedLabel(editorFolderLabel);
  await expectFirstLineMarkAlignment(editor.locator('.folder-graph-item .graph-folder-count'), editorFolderLabel);

  const editorGraphLabel = editor.locator('.graph-item:not(.folder-graph-item) .graph-item-name-text', {
    hasText: graphName,
  });
  await expectWrappedLabel(editorGraphLabel);
  await expectFirstLineMarkAlignment(
    editor.locator('.graph-item[data-graphid="main"] .graph-main-icon'),
    editorGraphLabel,
  );
});
