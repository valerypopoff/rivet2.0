import { expect, test } from '@playwright/test';
import {
  authenticateIfNeeded,
  findBlankCanvasPoint,
  getVisibleNodeCenters,
  saveStepScreenshot,
  waitForDashboardReady,
  waitForFocusTag,
  waitForNodeCountDecrease,
  waitForNodeCountIncrease,
} from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

function createClipboardProjectFile(projectName: string): string {
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
    '        \'[clipboard-node-1]:text "Clipboard Node 1"\':',
    '          visualData: 520/300/260/null//',
    '          data:',
    '            text: first',
    '        \'[clipboard-node-2]:text "Clipboard Node 2"\':',
    '          visualData: 860/300/260/null//',
    '          data:',
    '            text: second',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

test.describe('Observable hosted editor flow', () => {
  test('shows focus handoff and clipboard recovery in real time', async ({ page }, testInfo) => {
    test.slow();

    const projectName = 'codex-clipboard-fixture';
    const projectPath = `/workflows/${projectName}.rivet-project`;
    const projectContents = createClipboardProjectFile(projectName);
    const project: WorkflowProjectItem = {
      id: `${projectName}-project-id`,
      name: projectName,
      fileName: `${projectName}.rivet-project`,
      relativePath: `${projectName}.rivet-project`,
      absolutePath: projectPath,
      updatedAt: '2026-05-21T10:00:00.000Z',
      settings: {
        status: 'unpublished',
        endpointName: '',
        lastPublishedAt: null,
      },
    };
    let unexpectedSaveRequests = 0;

    await page.route('**/api/workflows/tree', async (route) => {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        folders: [],
        projects: [project],
      };

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
        body: JSON.stringify({
          contents: projectContents,
          datasetsContents: null,
          revisionId: null,
        }),
      });
    });

    await page.route('**/api/projects/save', async (route) => {
      unexpectedSaveRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Hosted editor observable spec should not persist project changes.' }),
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await saveStepScreenshot(page, testInfo, '01-dashboard-ready.png');

    const iframe = page.locator('iframe.dashboard-editor-frame');
    const frameLocator = page.frameLocator('iframe.dashboard-editor-frame');
    const canvas = frameLocator.locator('.node-canvas');
    const nodes = frameLocator.locator('.node');
    const openedProjectRow = page.locator('.project-row', { hasText: projectName });

    await test.step('Open a mocked project with visible nodes', async () => {
      await expect(openedProjectRow, 'Need the fixture workflow project row to open in the observable flow').toBeVisible({
        timeout: 30_000,
      });
      await openedProjectRow.scrollIntoViewIfNeeded();
      await openedProjectRow.dblclick();

      await expect(iframe).toBeVisible({ timeout: 30_000 });
      await expect(canvas).toBeVisible({ timeout: 30_000 });
      await expect(nodes.first()).toBeVisible({ timeout: 30_000 });
    });

    await expect(iframe).toBeVisible({ timeout: 120_000 });
    await expect(canvas).toBeVisible({ timeout: 120_000 });
    await expect(nodes.first()).toBeVisible({ timeout: 120_000 });

    const focusAfterOpen = await waitForFocusTag(page, 'IFRAME', 'project open');
    const iframeStyles = await iframe.evaluate((node) => {
      const styles = getComputedStyle(node);
      return {
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        outlineColor: styles.outlineColor,
        boxShadow: styles.boxShadow,
        borderTopStyle: styles.borderTopStyle,
        borderTopWidth: styles.borderTopWidth,
      };
    });

    expect(focusAfterOpen.tag).toBe('IFRAME');
    expect(iframeStyles.outlineWidth).toBe('0px');
    expect(iframeStyles.boxShadow).toBe('none');
    expect(iframeStyles.borderTopWidth).toBe('0px');
    await saveStepScreenshot(page, testInfo, '02-editor-opened.png');

    const sidebarBox = await page.locator('.dashboard-sidebar').boundingBox();
    expect(sidebarBox).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const minVisibleX = sidebarBox!.x + sidebarBox!.width;
    const maxVisibleX = viewport!.width;
    const maxVisibleY = viewport!.height;
    const visibleNodeCenters = await getVisibleNodeCenters(nodes, minVisibleX, maxVisibleX, maxVisibleY);
    expect(visibleNodeCenters.length).toBeGreaterThanOrEqual(2);

    await test.step('Return focus to the sidebar and recover it with Shift+click node selection', async () => {
      await page.mouse.click(visibleNodeCenters[0]!.x, visibleNodeCenters[0]!.y);
      await openedProjectRow.click();
      await waitForFocusTag(page, 'BUTTON', 'sidebar refocus');
      await saveStepScreenshot(page, testInfo, '03-sidebar-refocus.png');

      await page.keyboard.down('Shift');
      await page.mouse.click(visibleNodeCenters[1]!.x, visibleNodeCenters[1]!.y);
      await page.keyboard.up('Shift');
    });

    const focusAfterShiftClick = await waitForFocusTag(page, 'IFRAME', 'shift-click recovery');
    expect(focusAfterShiftClick.tag).toBe('IFRAME');

    const nodeCountBeforeFirstPaste = await nodes.count();
    await page.keyboard.press(`${shortcutModifier}+C`);
    await page.keyboard.press(`${shortcutModifier}+V`);
    const nodeCountAfterFirstPaste = await waitForNodeCountIncrease(nodes, nodeCountBeforeFirstPaste, 'shift-click paste');
    expect(nodeCountAfterFirstPaste).toBeGreaterThan(nodeCountBeforeFirstPaste);
    await saveStepScreenshot(page, testInfo, '04-after-shift-paste.png');

    await page.keyboard.press(`${shortcutModifier}+X`);
    const nodeCountAfterCut = await waitForNodeCountDecrease(nodes, nodeCountAfterFirstPaste, 'shift-click cut');
    expect(nodeCountAfterCut).toBeLessThan(nodeCountAfterFirstPaste);
    await saveStepScreenshot(page, testInfo, '05-after-shift-cut.png');

    await test.step('Return focus to the sidebar again and recover it with a blank-canvas click', async () => {
      await openedProjectRow.click();
      await waitForFocusTag(page, 'BUTTON', 'sidebar refocus before blank canvas');

      const blankPoint = await findBlankCanvasPoint(canvas, nodes, minVisibleX, maxVisibleX, maxVisibleY);
      expect(blankPoint, 'Need a visible blank point on the node canvas for the observable blank-canvas recovery step').not.toBeNull();
      await page.mouse.click(blankPoint!.x, blankPoint!.y);
    });

    const focusAfterBlankCanvasClick = await waitForFocusTag(page, 'IFRAME', 'blank-canvas recovery');
    expect(focusAfterBlankCanvasClick.tag).toBe('IFRAME');

    const nodeCountBeforeSecondPaste = await nodes.count();
    await page.keyboard.press(`${shortcutModifier}+V`);
    const nodeCountAfterSecondPaste = await waitForNodeCountIncrease(nodes, nodeCountBeforeSecondPaste, 'blank-canvas paste');
    expect(nodeCountAfterSecondPaste).toBeGreaterThan(nodeCountBeforeSecondPaste);
    await saveStepScreenshot(page, testInfo, '06-after-blank-canvas-paste.png');
    expect(unexpectedSaveRequests).toBe(0);
  });
});
