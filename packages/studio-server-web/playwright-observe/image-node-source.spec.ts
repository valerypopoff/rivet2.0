import { expect, test } from '@playwright/test';
import { ImageNodeImpl, type DataId } from '@valerypopoff/rivet2-core';

import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Image node switches between binary and base64 sources with distinct input ports', async ({ page }) => {
  const nodeData = ImageNodeImpl.create();
  nodeData.visualData = { ...nodeData.visualData, x: 180, y: 160, width: 320 };
  nodeData.data.data = { refId: 'selected-image' as DataId };
  nodeData.data.base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 400;
    canvas.getContext('2d')!.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });

  await seedHostedEditorProject(page, {
    graph: { nodes: [nodeData] },
    graphId: 'image-source-graph',
    loaded: true,
    projectId: 'image-source-project',
    projectPath: '/workflows/Image Source.rivet-project',
    title: 'Image Source',
  });
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'image-source-fixture', revision: 0 },
        folders: [],
        projects: [
          {
            id: 'image-source-project',
            name: 'Image Source',
            fileName: 'Image Source.rivet-project',
            relativePath: 'Image Source.rivet-project',
            absolutePath: '/workflows/Image Source.rivet-project',
            updatedAt: '2026-09-22T00:00:00.000Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          },
        ],
      },
    }),
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const node = editor.locator(`.node[data-nodeid="${nodeData.id}"]`);
  await expect(node).toBeVisible({ timeout: 60_000 });
  await node.hover();
  await node.locator('.edit-button').click();

  const source = editor.getByRole('group', { name: 'Image source' });
  const binary = source.getByRole('button', { name: 'Binary data' });
  const base64 = source.getByRole('button', { name: 'Base64' });
  await expect(binary).toHaveAttribute('aria-pressed', 'true');
  await expect(node.locator('.node-body')).toContainText('Image source: Binary data');
  await expect(node.locator('.node-body')).toContainText('Image: File selected');
  await expect(node.locator('.node-body')).toContainText('Media Type: PNG');
  await expect(node.locator('.node-body img')).toHaveCount(0);
  await expect(editor.getByText('Image selected', { exact: true })).toBeVisible();
  await expect(editor.locator('.row.imageBrowser img')).toHaveCount(0);

  const binaryInputToggle = editor.getByRole('button', { name: 'Use an input port for Image' });
  await binaryInputToggle.click();
  await expect(node.locator('.input-port[data-portid="data"]')).toBeVisible();

  await base64.click();
  await expect(base64).toHaveAttribute('aria-pressed', 'true');
  await expect(binaryInputToggle).toHaveCount(0);
  await expect(node.locator('.input-port[data-portid="data"]')).toHaveCount(0);
  await expect(editor.getByText('Raw base64-encoded image bytes.', { exact: false })).toBeVisible();
  await expect(node.locator('.node-body')).toContainText('Image source: Base64');
  await expect(node.locator('.node-body')).toContainText('Base64: Entered');
  await expect(node.locator('.node-body img')).toHaveCount(0);

  const base64InputToggle = editor.getByRole('button', { name: 'Use an input port for Base64' });
  await base64InputToggle.click();
  await expect(node.locator('.input-port[data-portid="base64"]')).toBeVisible();
  await expect(node.locator('.node-body')).toContainText('Base64: From input');
  await expect(node.locator('.node-body img')).toHaveCount(0);

  await binary.click();
  await expect(binary).toHaveAttribute('aria-pressed', 'true');
  await expect(node.locator('.input-port[data-portid="data"]')).toBeVisible();
  await expect(node.locator('.input-port[data-portid="base64"]')).toHaveCount(0);
  await expect(node.locator('.node-body')).toContainText('Image: From input');

  await base64.click();
  await base64InputToggle.click();
  await expect(node.locator('.node-body')).toContainText('Base64: Entered');
  await editor.locator('.more-menu').click();
  await editor.getByRole('group', { name: 'Executor mode' }).getByRole('button', { name: 'Browser' }).click();
  await editor.locator('.more-menu').click();
  await editor.getByRole('button', { name: 'Run project' }).click();

  const outputImage = node.locator('.node-output img');
  await expect(outputImage).toBeVisible({ timeout: 30_000 });
  await expect(node.locator('.node-body img')).toHaveCount(0);
  const outputSize = await outputImage.evaluate((image) => {
    const rect = image.getBoundingClientRect();
    const parentRect = image.parentElement!.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      availableWidth: parentRect.width,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
  expect(outputSize.naturalWidth).toBe(600);
  expect(outputSize.naturalHeight).toBe(400);
  expect(outputSize.width).toBeLessThan(outputSize.naturalWidth);
  expect(outputSize.height).toBeLessThan(outputSize.naturalHeight);
  expect(outputSize.width).toBeLessThanOrEqual(outputSize.availableWidth);
  expect(outputSize.height).toBeLessThanOrEqual(200);
});
