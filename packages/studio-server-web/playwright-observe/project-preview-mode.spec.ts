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
      publishedWebApps: [],
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
  const additionalProjects = Array.from({ length: 7 }, (_, index) =>
    createPreviewProject(`codex-crowded-tab-${index + 1}`),
  );
  const contentsByPath = new Map([
    [firstProject.absolutePath, createPreviewProjectFile(firstProject.name)],
    [secondProject.absolutePath, createPreviewProjectFile(secondProject.name)],
    [thirdProject.absolutePath, createPreviewProjectFile(thirdProject.name)],
    ...additionalProjects.map((project) => [project.absolutePath, createPreviewProjectFile(project.name)] as const),
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
      sync: { epoch: 'playwright-fixture', revision: 0 },
      folders: [],
      projects: [firstProject, secondProject, thirdProject, ...additionalProjects],
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
  await expect(frame.getByRole('status', { name: 'Opening project' })).toBeVisible();
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
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(editorTabs).toHaveCount(2);

  for (const project of additionalProjects) {
    await page.locator('.project-row', { hasText: project.name }).dblclick();
    await expect(editorTabs.filter({ hasText: project.name })).toBeVisible();
  }
  await firstRow.click();
  await expect(firstActiveEditorTab).toBeVisible();
  await secondEditorTab.hover();
  const inactiveHoveredTabSpacing = await secondEditorTab.evaluate((tab) => {
    const wrapper = tab.closest<HTMLElement>('.draggableProject');
    const tabBounds = tab.getBoundingClientRect();
    const wrapperBounds = wrapper?.getBoundingClientRect();

    return {
      bottomGap: wrapperBounds ? Math.round(wrapperBounds.bottom - tabBounds.bottom) : null,
      marginBottom: getComputedStyle(tab).marginBottom,
    };
  });
  expect(inactiveHoveredTabSpacing).toEqual({ bottomGap: 5, marginBottom: '5px' });

  const tabWidthsBeforeSwitch = await editorTabs.evaluateAll((tabs) =>
    tabs.map((tab) => tab.getBoundingClientRect().width),
  );
  await frame.locator('.projects-container').evaluate((container) => {
    const samples: unknown[] = [];
    const runtime = window as Window & {
      __projectTabMotionDone?: Promise<void>;
      __projectTabMotionSamples?: unknown[];
    };
    runtime.__projectTabMotionSamples = samples;
    const capture = () => {
      samples.push(
        [...container.querySelectorAll<HTMLElement>('.draggableProject')].map((wrapper) => {
          const tab = wrapper.querySelector<HTMLElement>('.project');
          const projectName = tab?.querySelector<HTMLElement>('.project-name');
          const bounds = wrapper.getBoundingClientRect();
          return {
            label: projectName?.textContent ?? '',
            left: bounds.left,
            top: bounds.top,
            transform: getComputedStyle(wrapper).transform,
            height: bounds.height,
            width: bounds.width,
          };
        }),
      );
    };
    const observer = new MutationObserver(capture);
    observer.observe(container, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      characterData: true,
      childList: true,
      subtree: true,
    });
    let framesRemaining = 90;
    runtime.__projectTabMotionDone = new Promise<void>((resolve) => {
      const sampleFrame = () => {
        capture();
        framesRemaining -= 1;
        if (framesRemaining > 0) {
          requestAnimationFrame(sampleFrame);
          return;
        }
        observer.disconnect();
        resolve();
      };
      capture();
      requestAnimationFrame(sampleFrame);
    });
  });

  await secondEditorTab.click();
  await expect(firstEditorTab).toBeVisible();
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(firstEditorTab, false);
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(editorTabs).toHaveCount(2 + additionalProjects.length);
  await expect
    .poll(() => editorTabs.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width)))
    .toEqual(tabWidthsBeforeSwitch);
  const tabMotionSamples = (await frame.locator('.projects-container').evaluate(async () => {
    const runtime = window as Window & {
      __projectTabMotionDone?: Promise<void>;
      __projectTabMotionSamples?: unknown[];
    };
    await runtime.__projectTabMotionDone;
    return runtime.__projectTabMotionSamples ?? [];
  })) as Array<
    Array<{
      height: number;
      label: string;
      left: number;
      top: number;
      transform: string;
      width: number;
    }>
  >;
  expect(tabMotionSamples.length).toBeGreaterThan(0);
  const baselineGeometry = tabMotionSamples[0]!.map(({ height, label, left, top, transform, width }) => ({
    height,
    label,
    left,
    top,
    transform,
    width,
  }));
  for (const sample of tabMotionSamples) {
    expect(new Set(sample.map(({ label }) => label)).size).toBe(sample.length);
    const geometry = sample.map(({ height, label, left, top, transform, width }) => ({
      height,
      label,
      left,
      top,
      transform,
      width,
    }));
    if (JSON.stringify(geometry) !== JSON.stringify(baselineGeometry)) {
      throw new Error(`Project tab identity or geometry changed during selection:\n${JSON.stringify(sample, null, 2)}`);
    }
  }

  await page.mouse.move(1, 1);
  const selectedTabDecoration = await secondEditorTab.evaluate((tab) => {
    const wrapper = tab.closest<HTMLElement>('.draggableProject');
    const previousWrapper = wrapper?.previousElementSibling as HTMLElement | null;

    return {
      activeDivider: wrapper ? getComputedStyle(wrapper, '::after').display : 'missing',
      leftDivider: previousWrapper ? getComputedStyle(previousWrapper, '::after').display : null,
      leftShoulder: getComputedStyle(tab, '::before').display,
      rightShoulder: getComputedStyle(tab, '::after').display,
    };
  });
  expect(selectedTabDecoration).toEqual({
    activeDivider: 'none',
    leftDivider: null,
    leftShoulder: 'block',
    rightShoulder: 'block',
  });

  for (const project of additionalProjects) {
    const tab = editorTabs.filter({ hasText: project.name });
    await tab.hover();
    await tab.getByRole('button', { name: `Close ${project.name}` }).click();
    await expect(tab).toHaveCount(0);
  }
  await expect(editorTabs).toHaveCount(2);

  await firstRow.click();
  await expect(firstActiveEditorTab).toBeVisible();
  await expect(firstRow).toHaveClass(/\bactive\b/);
  await expect(secondEditorTab).toBeVisible();
  await expectProjectTabPreview(firstActiveEditorTab, false);
  await expectProjectTabPreview(secondEditorTab, true);
  await expect(editorTabs).toHaveCount(2);

  await page.mouse.move(1, 1);
  const interiorSelectedTabDecoration = await firstEditorTab.evaluate((tab) => {
    const wrapper = tab.closest<HTMLElement>('.draggableProject');
    const previousWrapper = wrapper?.previousElementSibling as HTMLElement | null;

    return {
      activeDivider: wrapper ? getComputedStyle(wrapper, '::after').display : 'missing',
      leftDivider: previousWrapper ? getComputedStyle(previousWrapper, '::after').display : 'missing',
      leftShoulder: getComputedStyle(tab, '::before').display,
      rightShoulder: getComputedStyle(tab, '::after').display,
    };
  });
  expect(interiorSelectedTabDecoration).toEqual({
    activeDivider: 'none',
    leftDivider: 'none',
    leftShoulder: 'block',
    rightShoulder: 'block',
  });

  await page.evaluate(() => {
    const activeRowChanges: string[] = [];
    let scheduled = false;
    const sampleActiveRowOnFrame = () => {
      if (scheduled) {
        return;
      }

      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        const activeLabel = document.querySelector('.workflow-library-panel .project-row.active .label')?.textContent;
        if (activeLabel) {
          activeRowChanges.push(activeLabel);
        }
      });
    };
    const observer = new MutationObserver(() => {
      sampleActiveRowOnFrame();
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
