import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowTreeResponse,
} from '../../studio-server-shared/workflow-types';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

function createProjectContents({
  graphFolderName,
  graphName,
  projectName,
  uiGraphName,
}: {
  graphFolderName: string;
  graphName: string;
  projectName: string;
  uiGraphName?: string;
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
    ...(uiGraphName
      ? [
          '  uiGraphs:',
          '    sidebar-name-wrapping-web-app:',
          '      components: []',
          '      id: sidebar-name-wrapping-web-app',
          `      name: ${JSON.stringify(uiGraphName)}`,
        ]
      : []),
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

async function expectFirstLineMarkAlignment(mark: Locator, label: Locator, description: string): Promise<void> {
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
  expect(Math.abs(markCenter - firstLineCenter), description).toBeLessThan(labelMetrics.lineHeight / 2);
}

async function installWrappingFixture(page: Page, tree: WorkflowTreeResponse, projectContents: string): Promise<void> {
  await mockHostedEditorBootstrap(page);
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
  const uiGraphName = `web-app-${'unbroken-name-'.repeat(14)}`;
  const project: WorkflowProjectItem = {
    id: 'sidebar-name-wrapping-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${serverFolderName}/${projectName}.rivet-project`,
    absolutePath: `/workflows/${serverFolderName}/${projectName}.rivet-project`,
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

  await installWrappingFixture(
    page,
    tree,
    createProjectContents({ graphFolderName, graphName, projectName, uiGraphName }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const serverFolderRow = page.locator('.workflow-library-panel .folder-row', { hasText: serverFolderName });
  const serverFolderLabel = serverFolderRow.locator('.label');
  await expectWrappedLabel(serverFolderLabel);
  await expectFirstLineMarkAlignment(
    serverFolderRow.locator('.folder-project-count'),
    serverFolderLabel,
    'Server folder count aligns with its first label line',
  );
  await serverFolderRow.click();

  const serverProjectRow = page.locator('.workflow-library-panel .project-row', { hasText: projectName });
  const serverProjectLabel = serverProjectRow.locator('.label');
  await expectWrappedLabel(serverProjectLabel);
  await expectFirstLineMarkAlignment(
    serverProjectRow.locator('.project-status-dot'),
    serverProjectLabel,
    'Server project status aligns with its first label line',
  );
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
  await expectFirstLineMarkAlignment(
    editor.locator('.folder-graph-item .graph-folder-count'),
    editorFolderLabel,
    'Editor folder count aligns with its first label line',
  );

  const editorGraphLabel = editor.locator('.graph-item:not(.folder-graph-item) .graph-item-name-text', {
    hasText: graphName,
  });
  await expectWrappedLabel(editorGraphLabel);
  await expectFirstLineMarkAlignment(
    editor.locator('.graph-item[data-graphid="main"] .graph-main-icon'),
    editorGraphLabel,
    'Editor graph icon aligns with its first label line',
  );
  await expectWrappedLabel(editor.locator('.ui-graph-entry-name', { hasText: uiGraphName }));
});

test('F2 renames only the item in the sidebar that owns focus', async ({ page }) => {
  const projectName = 'focus-owned-project';
  const graphFolderName = 'Focus folder';
  const graphName = 'Focus graph';
  const project: WorkflowProjectItem = {
    id: 'focus-owned-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: `/workflows/${projectName}.rivet-project`,
    updatedAt: '2026-09-19T00:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
  };
  const tree: WorkflowTreeResponse = {
    root: '/workflows',
    sync: { epoch: 'focus-owned-sidebar', revision: 0 },
    folders: [],
    projects: [project],
  };

  await installWrappingFixture(page, tree, createProjectContents({ graphFolderName, graphName, projectName }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const serverProjectRow = page.locator('.workflow-library-panel .project-row', { hasText: projectName });
  await serverProjectRow.click();
  await serverProjectRow.press('F2');
  const serverRenameInput = page.getByRole('textbox', { name: `Rename ${projectName}` });
  await expect(serverRenameInput).toBeFocused();
  await serverRenameInput.press('Escape');

  await serverProjectRow.dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const editorGraphRow = editor.locator('.graph-item[data-graphid="main"] .graph-item-select');
  const editorGraphList = editor.locator('.graph-list-container');
  await expect(editorGraphRow).toBeVisible({ timeout: 90_000 });
  await editorGraphRow.click();
  await expect(editorGraphList).toBeFocused();
  await editorGraphList.press('F2');

  const editorRenameInput = editor.locator('.graph-item[data-graphid="main"] input');
  await expect(editorRenameInput).toBeFocused();
  await expect(page.getByRole('textbox', { name: `Rename ${projectName}` })).toHaveCount(0);
  await editorRenameInput.press('Escape');
});

test('Ctrl/Cmd-click toggles all Server folders together', async ({ page }) => {
  const project = (id: string, name: string, relativePath: string): WorkflowProjectItem => ({
    id,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${relativePath}/${name}.rivet-project`,
    absolutePath: `/workflows/${relativePath}/${name}.rivet-project`,
    updatedAt: '2026-09-19T00:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      publishedWebApps: [],
    },
  });
  const nestedFolder: WorkflowFolderItem = {
    id: 'modifier-click-nested-folder',
    name: 'Nested folder',
    relativePath: 'Parent folder/Nested folder',
    absolutePath: '/workflows/Parent folder/Nested folder',
    updatedAt: '2026-09-19T00:00:00.000Z',
    folders: [],
    projects: [project('nested-project', 'Nested project', 'Parent folder/Nested folder')],
  };
  const parentFolder: WorkflowFolderItem = {
    id: 'modifier-click-parent-folder',
    name: 'Parent folder',
    relativePath: 'Parent folder',
    absolutePath: '/workflows/Parent folder',
    updatedAt: '2026-09-19T00:00:00.000Z',
    folders: [nestedFolder],
    projects: [project('parent-project', 'Parent project', 'Parent folder')],
  };
  const siblingFolder: WorkflowFolderItem = {
    id: 'modifier-click-sibling-folder',
    name: 'Sibling folder',
    relativePath: 'Sibling folder',
    absolutePath: '/workflows/Sibling folder',
    updatedAt: '2026-09-19T00:00:00.000Z',
    folders: [],
    projects: [project('sibling-project', 'Sibling project', 'Sibling folder')],
  };
  const tree: WorkflowTreeResponse = {
    root: '/workflows',
    sync: { epoch: 'modifier-click-folders', revision: 0 },
    folders: [parentFolder, siblingFolder],
    projects: [],
  };

  await installWrappingFixture(
    page,
    tree,
    createProjectContents({
      graphFolderName: 'Graph folder',
      graphName: 'Graph',
      projectName: 'Parent project',
    }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const parentRow = page.locator('.workflow-library-panel .folder-row', { hasText: 'Parent folder' });
  const siblingRow = page.locator('.workflow-library-panel .folder-row', { hasText: 'Sibling folder' });
  const nestedRow = page.locator('.workflow-library-panel .folder-row', { hasText: 'Nested folder' });

  await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedRow).toHaveCount(0);

  await parentRow.click({ modifiers: ['Control'] });
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedRow).toBeVisible();
  await expect(nestedRow).toHaveAttribute('aria-expanded', 'true');

  await siblingRow.click();
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedRow).toHaveAttribute('aria-expanded', 'true');

  await siblingRow.click({ modifiers: ['Meta'] });
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedRow).toHaveAttribute('aria-expanded', 'true');

  await parentRow.click();
  await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedRow).toHaveCount(0);

  await siblingRow.click({ modifiers: ['Meta'] });
  await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedRow).toHaveCount(0);

  await parentRow.click();
  await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
  await expect(siblingRow).toHaveAttribute('aria-expanded', 'false');
  await expect(nestedRow).toHaveAttribute('aria-expanded', 'false');
});
