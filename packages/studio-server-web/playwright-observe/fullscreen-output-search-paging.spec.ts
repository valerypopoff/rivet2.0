import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { serializeProject } from '@valerypopoff/rivet2-core';

type EditorRoot = Page | FrameLocator;

async function openSeededProject(page: Page) {
  // These checks exercise output, not recovery of legacy localStorage fragments.
  await page.route('**/api/projects/load', async (route) => {
    const fixture = await page.evaluate(() => JSON.parse(localStorage.getItem('project')!));
    await route.fulfill({
      json: { contents: serializeProject(fixture.projectState), datasetsContents: null, revisionId: null },
    });
  });
  await page.getByRole('button', { name: 'Menu', exact: true }).waitFor();
  await page.evaluate(() => {
    const fixture = JSON.parse(localStorage.getItem('project')!);
    window.postMessage(
      {
        type: 'open-project',
        path: fixture.loadedProjectState.path,
        expectedProjectId: fixture.projectState.metadata.id,
        preferredGraphId: fixture.projectState.metadata.mainGraphId,
        replaceCurrent: false,
      },
      location.origin,
    );
  });
}

test('fullscreen output resizes independently from both edges and retains bounds across node types', async ({
  page,
}) => {
  await seedHostedEditorProject(page, {
    graphId: 'fullscreen-output-resize-graph',
    projectId: 'fullscreen-output-resize-project',
    projectPath: '/workflows/Fullscreen output resize.rivet-project',
    title: 'Fullscreen output resize',
    loaded: true,
    graph: {
      nodes: [
        {
          id: 'resize-text',
          title: 'Resize Text',
          type: 'text',
          data: { text: 'Resize this output' },
          visualData: { x: 120, y: 160, width: 260 },
        },
        {
          id: 'resize-object',
          title: 'Resize Object',
          type: 'object',
          data: { jsonTemplate: '{"value":"Resize this output"}' },
          visualData: { x: 460, y: 160, width: 260 },
        },
      ],
    },
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      'recoil-persist',
      JSON.stringify({
        defaultExecutor: 'browser',
        recordExecutions: false,
      }),
    ),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/**', (route) =>
    ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort(),
  );
  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await openSeededProject(page);
  const editor = await getEditorRoot(page);
  const textNode = editor.locator('.node[data-nodeid="resize-text"]');
  await expect(textNode).toBeVisible();
  await editor.locator('.run-button button').first().click();
  await expect(textNode).toHaveClass(/success/);
  await textNode.locator('.node-output').hover();
  await textNode.locator('.node-output .expand-button').click();
  const modal = editor.getByTestId('fullscreen-output-modal');
  await expect(modal).toBeVisible();
  const bounds = () =>
    modal.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
  const initial = await bounds();
  const dragEdge = async (edge: 'left' | 'right', delta: number, button: 'left' | 'right' = 'left') => {
    const handle = modal.getByRole('separator', { name: `Resize fullscreen output modal from the ${edge} edge` });
    const box = await handle.boundingBox();
    expect(box).toBeTruthy();
    // Start inside the shell: half of the handle deliberately extends outside it.
    const x = box!.x + (edge === 'left' ? 12 : 4);
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x + delta, y, { steps: 8 });
    await page.mouse.up({ button });
  };
  await dragEdge('left', 100, 'right');
  expect(Math.abs((await bounds()).left - initial.left), 'Right-click dragging does not resize').toBeLessThan(2);

  const leftHandle = modal.getByRole('separator', { name: 'Resize fullscreen output modal from the left edge' });
  const bodyStyles = () =>
    editor.locator('body').evaluate((body) => ({
      cursor: body.style.cursor,
      userSelect: body.style.userSelect,
    }));
  const initialBodyStyles = await bodyStyles();
  await leftHandle.evaluate((handle) => {
    handle.addEventListener(
      'pointerdown',
      (event) => {
        handle.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
      },
      { once: true },
    );
  });
  const handleBox = (await leftHandle.boundingBox())!;
  const pointerX = handleBox.x + 12;
  const pointerY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(pointerX, pointerY);
  await page.mouse.down();
  await expect(leftHandle).toHaveClass(/resizing/);
  await leftHandle.dispatchEvent('pointermove', { pointerId: 999, isPrimary: false, clientX: initial.left + 200 });
  expect(Math.abs((await bounds()).left - initial.left), 'A second pointer cannot move the active edge').toBeLessThan(
    2,
  );
  await leftHandle.dispatchEvent('pointercancel', { pointerId: 999, isPrimary: false });
  await expect(leftHandle).toHaveClass(/resizing/);
  await leftHandle.evaluate((handle) =>
    handle.releasePointerCapture(Number(handle.getAttribute('data-test-pointer-id'))),
  );
  // Lost capture must stop resizing even if the mouse button is still down.
  await page.mouse.move(pointerX + 100, pointerY);
  await expect(leftHandle).not.toHaveClass(/resizing/);
  expect(Math.abs((await bounds()).left - initial.left)).toBeLessThan(2);
  await page.mouse.up();
  expect(await bodyStyles()).toEqual(initialBodyStyles);

  await dragEdge('left', 100);
  await expect.poll(async () => (await bounds()).left - initial.left).toBeGreaterThan(90);
  const afterLeft = await bounds();
  expect(Math.abs(afterLeft.right - initial.right)).toBeLessThan(2);
  expect(initial.width - afterLeft.width).toBeGreaterThan(90);

  await dragEdge('right', -100);
  await expect.poll(async () => afterLeft.right - (await bounds()).right).toBeGreaterThan(90);
  const afterRight = await bounds();
  expect(Math.abs(afterRight.left - afterLeft.left)).toBeLessThan(2);
  expect(afterLeft.width - afterRight.width).toBeGreaterThan(90);
  await dragEdge('left', -100);
  await expect.poll(async () => afterRight.left - (await bounds()).left).toBeGreaterThan(90);
  const expandedLeft = await bounds();
  expect(Math.abs(expandedLeft.right - afterRight.right)).toBeLessThan(2);
  await dragEdge('right', 100);
  await expect.poll(async () => (await bounds()).right - expandedLeft.right).toBeGreaterThan(90);
  const resized = await bounds();
  expect(Math.abs(resized.left - expandedLeft.left)).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  const objectNode = editor.locator('.node[data-nodeid="resize-object"]');
  await expect(objectNode).toHaveClass(/success/);
  await objectNode.locator('.node-output').hover();
  await objectNode.locator('.node-output .expand-button').click();
  await expect(modal).toBeVisible();
  await expect.poll(async () => Math.abs((await bounds()).width - resized.width)).toBeLessThan(2);
  expect(Math.abs((await bounds()).left - resized.left)).toBeLessThan(2);

  // A narrow saved width must remain usable when the browser window shrinks,
  // without replacing the user's preferred bounds for a larger viewport.
  await dragEdge('left', 500);
  const preferred = await bounds();
  await page.setViewportSize({ width: 500, height: 1000 });
  await expect.poll(async () => (await bounds()).width).toBeGreaterThanOrEqual(359);
  await page.setViewportSize({ width: 320, height: 1000 });
  await expect.poll(async () => Math.abs((await bounds()).width - 320)).toBeLessThan(2);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect.poll(async () => Math.abs((await bounds()).width - preferred.width)).toBeLessThan(2);
  expect(Math.abs((await bounds()).left - preferred.left)).toBeLessThan(2);

  // Closing during a captured drag must restore document styles and not leave
  // an active gesture behind when the same output is reopened.
  const closingHandleBox = (await leftHandle.boundingBox())!;
  await page.mouse.move(closingHandleBox.x + 12, closingHandleBox.y + closingHandleBox.height / 2);
  await page.mouse.down();
  await expect(leftHandle).toHaveClass(/resizing/);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await page.mouse.up();
  expect(await bodyStyles()).toEqual(initialBodyStyles);
  await objectNode.locator('.node-output').hover();
  await objectNode.locator('.node-output .expand-button').click();
  await expect(modal).toBeVisible();
  await expect(leftHandle).not.toHaveClass(/resizing/);
  await expect.poll(async () => Math.abs((await bounds()).width - preferred.width)).toBeLessThan(2);
});

test('fullscreen search keeps the match highlighted after opening a paged JSON chunk', async ({ page }) => {
  const marker = 'paged-json-search-marker-4e0cf9f5';
  const graphId = 'fullscreen-output-search-paging-graph';
  const largeValue = `${'a'.repeat(110_000)}${marker}`;

  await seedHostedEditorProject(page, {
    graphId,
    graph: {
      nodes: [
        {
          data: {
            jsonTemplate: JSON.stringify({ requestId: largeValue }),
          },
          id: 'large-object-output',
          title: 'Large Object Output',
          type: 'object',
          visualData: { width: 300, x: 120, y: 160 },
        },
      ],
    },
    loaded: true,
    projectId: 'fullscreen-output-search-paging-project',
    projectPath: '/workflows/Fullscreen output search paging.rivet-project',
    title: 'Fullscreen output search paging',
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      'recoil-persist',
      JSON.stringify({
        defaultExecutor: 'browser',
        recordExecutions: false,
      }),
    ),
  );
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/**', (route) =>
    ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort(),
  );

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await openSeededProject(page);
  const editor = await getEditorRoot(page);
  const node = editor.locator('.node[data-nodeid="large-object-output"]');
  await expect(node).toBeVisible({ timeout: 60_000 });

  await editor.locator('.run-button button').first().click();
  await expect(node).toHaveClass(/success/, { timeout: 30_000 });

  const nodeOutput = node.locator('.node-output');
  await nodeOutput.hover();
  await nodeOutput.locator('.expand-button').click();

  const modal = editor.getByTestId('fullscreen-output-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Load Full Value' })).toBeVisible();

  await modal.locator('.search-input').fill(marker);
  await expect(modal.locator('.search-count')).toHaveText('1 / 1');
  const chunkPagers = modal.locator('.chunk-pager');
  await expect(chunkPagers).toHaveCount(2);
  for (const pager of [chunkPagers.nth(0), chunkPagers.nth(1)]) {
    await expect(pager).toBeVisible();
    await expect(pager).not.toContainText('1 / 1');
  }
  const firstPager = chunkPagers.first();
  const pageCountText = (await firstPager.locator('span').textContent())?.split('/').at(-1)?.trim();
  expect(pageCountText).toBeTruthy();
  const pageCount = pageCountText!;
  expect(Number(pageCount)).toBeGreaterThan(1);

  await firstPager.getByRole('button', { name: '<' }).click({ modifiers: ['Control'] });
  await expect(firstPager).toContainText(`1 / ${pageCount}`);
  await chunkPagers
    .last()
    .getByRole('button', { name: '>' })
    .click({ modifiers: ['Control'] });
  await expect(firstPager).toContainText(`${pageCount} / ${pageCount}`);

  const colorizedPreview = modal.locator('.json-preview-content pre');
  await expect(colorizedPreview).toContainText(marker);
  await expect
    .poll(async () => (await colorizedPreview.locator('span[style]').count()) > 0, {
      message: 'Monaco colorization completed before asserting the persisted search mark',
    })
    .toBe(true);
  const activeMatch = colorizedPreview.locator('.fullscreen-output-search-match-active');
  await expect(activeMatch).not.toHaveCount(0);
  await expect.poll(async () => (await activeMatch.allTextContents()).join('')).toBe(marker);

  await modal.locator('.search-input').fill('');
  await expect(activeMatch).toHaveCount(0);
});

async function getEditorRoot(page: Page): Promise<EditorRoot> {
  const editorFrame = page.locator('iframe.dashboard-editor-frame');
  await expect
    .poll(async () => (await editorFrame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
      message: 'Hosted editor mounts in iframe or direct mode',
      timeout: 60_000,
    })
    .toBe(true);
  return (await editorFrame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
}
