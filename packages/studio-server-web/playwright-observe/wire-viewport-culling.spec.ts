import { expect, test, type Page } from '@playwright/test';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function settleCanvas(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function pan(page: Page, dy: number, dx = 0) {
  const y = dy < 0 ? 850 : 350;
  await page.mouse.move(800, y);
  await page.mouse.down();
  await page.mouse.move(800 + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await settleCanvas(page);
}

async function expectVisibleWires(page: Page, count: number) {
  const paths = page.locator('.node-canvas path.wire');
  await expect(paths).toHaveCount(count);
  await expect
    .poll(() =>
      paths.evaluateAll((elements) =>
        elements.some((element) => {
          const path = element as SVGPathElement;
          const matrix = path.getScreenCTM();
          if (!matrix) return false;
          const rect = path.closest('.node-canvas')!.getBoundingClientRect();
          const length = path.getTotalLength();
          for (let i = 0; i <= 200; i++) {
            const p = path.getPointAtLength((length * i) / 200).matrixTransform(matrix);
            if (p.x > rect.left && p.x < rect.right && p.y > rect.top && p.y < rect.bottom) return true;
          }
          return false;
        }),
      ),
    )
    .toBe(true);
}

for (const mode of ['crossing', 'backwards-curve', 'bend'] as const) {
  test(`visible ${mode} connections survive pan, zoom and resize while remote wires are culled`, async ({ page }) => {
    const source = mode === 'backwards-curve' ? { x: -340, y: 0 } : { x: -2200, y: 300 };
    const target =
      mode === 'backwards-curve' ? { x: -200, y: 800 } : mode === 'bend' ? { x: -2200, y: 700 } : { x: 3300, y: 300 };
    await seedHostedEditorProject(page, {
      projectId: 'wire-viewport',
      graphId: 'main',
      loaded: true,
      projectPath: '/workflows/Wire viewport.rivet-project',
      title: 'Wire viewport',
      graph: {
        nodes: [
          {
            id: 'source',
            type: 'text',
            title: 'Source',
            data: { text: 'test' },
            visualData: { ...source, width: 240 },
          },
          {
            id: 'target',
            type: 'graphOutput',
            title: 'Target',
            data: { id: 'result', dataType: 'string' },
            visualData: { ...target, width: 240 },
          },
          {
            id: 'anchor',
            type: 'text',
            title: 'Anchor',
            data: { text: 'Viewport fixture' },
            visualData: { x: 1000, y: 100, width: 240 },
          },
        ],
        connections: [
          {
            outputNodeId: 'source',
            outputId: 'output',
            inputNodeId: 'target',
            inputId: 'value',
            ...(mode === 'bend' ? { bendPoint: { x: 500, y: 500 } } : {}),
          },
        ],
      },
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        'graphBuilder',
        JSON.stringify({
          lastCanvasPositionByGraph: { main: { x: 0, y: 0, zoom: 1, fromSaved: true } },
        }),
      ),
    );
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 503, json: { error: 'No live API in canvas fixture' } }),
    );
    await mockHostedEditorBootstrap(page);
    await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.node[data-nodeid="anchor"]')).toBeVisible();
    const paths = page.locator('.node-canvas path.wire');
    const count = mode === 'bend' ? 2 : 1;
    await expect(paths).toHaveCount(count);
    // Both connected ports are off screen, although a different port on the
    // backwards target can be visible. Visibility belongs to the route.
    for (const [id, portId] of [
      ['source', 'output'],
      ['target', 'value'],
    ]) {
      const port = page.locator(`.node[data-nodeid="${id}"] .port-circle[data-portid="${portId}"]`);
      if (await port.count()) {
        const box = await port.boundingBox();
        expect(box!.x + box!.width <= 0 || box!.x >= 1600).toBe(true);
      }
    }
    await expectVisibleWires(page, count);
    for (const delta of [120, 120, 120, -120]) {
      const previous = await page.locator('.canvas-node-contents').getAttribute('style');
      await page.mouse.move(800, 550);
      await page.mouse.wheel(0, delta);
      await expect(page.locator('.canvas-node-contents')).not.toHaveAttribute('style', previous!);
      await settleCanvas(page);
      await expectVisibleWires(page, count);
    }
    await pan(page, 40, 80);
    await expectVisibleWires(page, count);
    await pan(page, -40, -80);
    await expectVisibleWires(page, count);
    for (let i = 0; i < 6; i++) await pan(page, -500);
    await expect(paths).toHaveCount(0);
    for (let i = 0; i < 6; i++) await pan(page, 500);
    await expectVisibleWires(page, count);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expectVisibleWires(page, count);
  });
}
