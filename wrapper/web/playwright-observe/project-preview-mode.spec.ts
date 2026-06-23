import { expect, type Locator, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

function createPreviewProjectFile(projectName: string): string {
  const projectId = `${projectName}-project-id`;
  const graphId = `${projectName}-main-graph`;

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(projectId)}`,
    `    title: ${JSON.stringify(projectName)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes:',
    `        '[${projectName}-node]:text "Preview Node"':`,
    '          visualData: 520/300/260/null//',
    '          data:',
    `            text: ${projectName}`,
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

function createPreviewProject(projectName: string): WorkflowProjectItem {
  return {
    id: `${projectName}-project-id`,
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: `/workflows/${projectName}.rivet-project`,
    updatedAt: '2026-06-22T10:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: '',
      lastPublishedAt: null,
    },
  };
}

async function expectProjectTabPreview(tab: Locator, expectedPreview: boolean): Promise<void> {
  if (expectedPreview) {
    await expect(tab).toHaveClass(/\bpreview\b/);
    await expect(tab.locator('.project-name span')).toHaveCSS('font-style', 'italic');
    return;
  }

  await expect(tab).not.toHaveClass(/\bpreview\b/);
  await expect(tab.locator('.project-name span')).toHaveCSS('font-style', 'normal');
}

test('single-click project opens as a replaceable editor preview tab', async ({ page }) => {
  const firstProject = createPreviewProject('codex-preview-first');
  const secondProject = createPreviewProject('codex-preview-second');
  const thirdProject = createPreviewProject('codex-preview-third');
  const contentsByPath = new Map([
    [firstProject.absolutePath, createPreviewProjectFile(firstProject.name)],
    [secondProject.absolutePath, createPreviewProjectFile(secondProject.name)],
    [thirdProject.absolutePath, createPreviewProjectFile(thirdProject.name)],
  ]);
  let releaseFirstProjectLoad: (() => void) | null = null;
  let firstProjectLoadStartedResolve: (() => void) | null = null;
  const firstProjectLoadStarted = new Promise<void>((resolve) => {
    firstProjectLoadStartedResolve = resolve;
  });
  let firstProjectLoadShouldWait = true;

  await page.route('**/api/workflows/tree', async (route) => {
    const tree: WorkflowTreeResponse = {
      root: '/workflows',
      folders: [],
      projects: [firstProject, secondProject, thirdProject],
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });

  await page.route('**/api/projects/load', async (route) => {
    const body = route.request().postDataJSON() as { path?: string };
    const contents = body.path ? contentsByPath.get(body.path) : undefined;

    if (body.path === firstProject.absolutePath && firstProjectLoadShouldWait) {
      firstProjectLoadShouldWait = false;
      firstProjectLoadStartedResolve?.();
      await new Promise<void>((resolve) => {
        releaseFirstProjectLoad = resolve;
      });
    }

    await route.fulfill({
      status: contents ? 200 : 404,
      contentType: 'application/json',
      body: contents
        ? JSON.stringify({
            contents,
            datasetsContents: null,
            revisionId: null,
          })
        : JSON.stringify({ error: 'Unknown project path' }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const editorTabs = frame.locator('.projects-container .project');
  const firstEditorTab = editorTabs.filter({ hasText: firstProject.name });
  const firstOpeningEditorTab = frame.locator('.projects-container .project.opening', { hasText: firstProject.name });
  const secondEditorTab = editorTabs.filter({ hasText: secondProject.name });
  const thirdEditorTab = editorTabs.filter({ hasText: thirdProject.name });
  const firstActiveEditorTab = frame.locator('.projects-container .project.active', { hasText: firstProject.name });
  const firstRow = page.locator('.project-row', { hasText: firstProject.name });
  const secondRow = page.locator('.project-row', { hasText: secondProject.name });
  const thirdRow = page.locator('.project-row', { hasText: thirdProject.name });

  await firstRow.click();
  await firstProjectLoadStarted;
  await expect(firstOpeningEditorTab).toBeVisible();
  await expect(firstOpeningEditorTab).toHaveClass(/\bpreview\b/);
  await expect(firstOpeningEditorTab.locator('.opening-project-spinner')).toBeVisible();
  await expect(frame.locator('.opening-project-placeholder-title')).toContainText('Opening project...');
  releaseFirstProjectLoad?.();
  await expect(frame.locator('.node-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(firstEditorTab).toBeVisible();
  await expectProjectTabPreview(firstEditorTab, true);
  await expect(editorTabs).toHaveCount(1);
  await expect(page.locator('.active-project-actions-row button').nth(0)).toHaveText('Settings');
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  await page.locator('.workflow-library-panel .body').evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await expect(page.locator('.active-project-placeholder')).toContainText('Select a project');
  await expect(page.locator('.active-project-save-button')).toHaveCount(0);
  await expect(firstEditorTab).toBeVisible();
  await expect(editorTabs).toHaveCount(1);

  await secondRow.click();
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(firstEditorTab).toHaveCount(0);
  await expect(editorTabs).toHaveCount(1);

  await firstRow.dblclick();
  await expect(firstActiveEditorTab).toBeVisible();
  await expectProjectTabPreview(firstActiveEditorTab, false);
  await expect(secondEditorTab).toHaveCount(0);
  await expect(editorTabs).toHaveCount(1);

  await secondRow.click();
  await expect(firstEditorTab).toBeVisible();
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(firstEditorTab, false);
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(editorTabs).toHaveCount(2);

  await firstRow.click();
  await expect(firstActiveEditorTab).toBeVisible();
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(firstActiveEditorTab, false);
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(editorTabs).toHaveCount(2);

  await page.evaluate(() => {
    const activeRowChanges: string[] = [];
    const observer = new MutationObserver(() => {
      const activeLabel = document.querySelector('.workflow-library-panel .project-row.active .label')?.textContent;
      if (activeLabel) {
        activeRowChanges.push(activeLabel);
      }
    });

    for (const row of document.querySelectorAll('.workflow-library-panel .project-row')) {
      observer.observe(row, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    const typedWindow = window as Window & {
      __previewActiveRowChanges?: string[];
      __previewActiveRowObserver?: MutationObserver;
    };
    typedWindow.__previewActiveRowChanges = activeRowChanges;
    typedWindow.__previewActiveRowObserver = observer;
  });

  await thirdRow.click();
  await expect(firstEditorTab).toBeVisible();
  await expect(thirdEditorTab).toBeVisible();
  await expectProjectTabPreview(firstEditorTab, false);
  await expectProjectTabPreview(thirdEditorTab, true);
  await expect(secondEditorTab).toHaveCount(0);
  await expect(editorTabs).toHaveCount(2);
  const activeRowChanges = await page.evaluate(() => {
    const typedWindow = window as Window & {
      __previewActiveRowChanges?: string[];
      __previewActiveRowObserver?: MutationObserver;
    };
    typedWindow.__previewActiveRowObserver?.disconnect();
    return typedWindow.__previewActiveRowChanges ?? [];
  });
  expect(activeRowChanges).not.toContain(firstProject.name);
});
