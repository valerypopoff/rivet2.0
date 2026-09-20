import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Passthrough displays the connected output name on both sides of its slot', async ({ page }) => {
  const suffix = String(Date.now());
  const sourceId = `passthrough-source-${suffix}`;
  const firstId = `passthrough-first-${suffix}`;
  const secondId = `passthrough-second-${suffix}`;

  await seedHostedEditorProject(page, {
    graphId: `passthrough-labels-${suffix}-graph`,
    loaded: true,
    projectId: `passthrough-labels-${suffix}-project`,
    projectPath: `/workflows/Passthrough labels ${suffix}.rivet-project`,
    title: `Passthrough labels ${suffix}`,
    graph: {
      nodes: [
        {
          id: sourceId,
          type: 'number',
          title: 'Number',
          data: { value: 42, round: false, roundTo: 0 },
          visualData: { x: 100, y: 180, width: 200 },
        },
        {
          id: firstId,
          type: 'passthrough',
          title: 'First Passthrough',
          data: {},
          visualData: { x: 440, y: 180, width: 220 },
        },
        {
          id: secondId,
          type: 'passthrough',
          title: 'Second Passthrough',
          data: {},
          visualData: { x: 780, y: 180, width: 220 },
        },
      ],
      connections: [
        { outputNodeId: sourceId, outputId: 'value', inputNodeId: firstId, inputId: 'input1' },
        { outputNodeId: firstId, outputId: 'output1', inputNodeId: secondId, inputId: 'input1' },
      ],
    },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });

  for (const nodeId of [firstId, secondId]) {
    const passthrough = editor.locator(`.node[data-nodeid="${nodeId}"]`);
    await expect(passthrough).toBeVisible();
    await expect(passthrough.locator('.input-ports .port-label', { hasText: /^Value$/ })).toHaveCount(1);
    await expect(passthrough.locator('.output-ports .port-label', { hasText: /^Value$/ })).toHaveCount(1);
    await expect(passthrough.locator('.input-ports .port-label', { hasText: /^Input 2$/ })).toHaveCount(1);
    await expect(passthrough.locator('.port-label', { hasText: /^(Input|Output) 1$/ })).toHaveCount(0);
  }
});

test('Passthrough carries a connected name through a linked Passthrough', async ({ page }) => {
  const suffix = String(Date.now());
  const sourceId = `passthrough-linked-source-${suffix}`;
  const linkedId = `passthrough-linked-instance-${suffix}`;
  const finalId = `passthrough-linked-final-${suffix}`;
  const prefabId = `passthrough-prefab-${suffix}`;

  await seedHostedEditorProject(page, {
    graphId: `passthrough-linked-${suffix}-graph`,
    loaded: true,
    projectId: `passthrough-linked-${suffix}-project`,
    projectPath: `/workflows/Passthrough linked ${suffix}.rivet-project`,
    title: `Passthrough linked ${suffix}`,
    nodePrefabs: {
      [prefabId]: {
        id: prefabId,
        sourceNode: {
          id: `passthrough-prefab-source-${suffix}`,
          type: 'passthrough',
          title: 'Library Passthrough',
          data: {},
          visualData: { x: 0, y: 0, width: 220 },
        },
      },
    },
    graph: {
      nodes: [
        {
          id: sourceId,
          type: 'number',
          title: 'Number',
          data: { value: 42, round: false, roundTo: 0 },
          visualData: { x: 100, y: 180, width: 200 },
        },
        {
          id: linkedId,
          type: 'nodePrefabInstance',
          title: 'Linked Passthrough',
          data: { prefabId },
          visualData: { x: 440, y: 180, width: 220 },
        },
        {
          id: finalId,
          type: 'passthrough',
          title: 'Final Passthrough',
          data: {},
          visualData: { x: 780, y: 180, width: 220 },
        },
      ],
      connections: [
        { outputNodeId: sourceId, outputId: 'value', inputNodeId: linkedId, inputId: 'input1' },
        { outputNodeId: linkedId, outputId: 'output1', inputNodeId: finalId, inputId: 'input1' },
      ],
    },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const passthrough = editor.locator(`.node[data-nodeid="${finalId}"]`);
  await expect(passthrough).toBeVisible({ timeout: 60_000 });
  await expect(passthrough.locator('.input-ports .port-label', { hasText: /^Value$/ })).toHaveCount(1);
  await expect(passthrough.locator('.output-ports .port-label', { hasText: /^Value$/ })).toHaveCount(1);
});

test('a newly added Passthrough starts 15px wider', async ({ page }) => {
  const suffix = String(Date.now());
  await seedHostedEditorProject(page, {
    graphId: `passthrough-width-${suffix}-graph`,
    loaded: true,
    projectId: `passthrough-width-${suffix}-project`,
    projectPath: `/workflows/Passthrough width ${suffix}.rivet-project`,
    title: `Passthrough width ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const canvas = editor.locator('.node-canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await canvas.click({ button: 'right', position: { x: 320, y: 260 } });
  const search = editor.getByPlaceholder('Type in node name...');
  await expect(search).toBeVisible();
  await search.fill('Passthrough');
  await editor.locator('.context-menu-items .context-menu-label-text', { hasText: /^Passthrough$/ }).click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Passthrough$/ }),
  });
  await expect(node).toHaveCount(1);
  await expect(node).toHaveCSS('width', '220px');
});
