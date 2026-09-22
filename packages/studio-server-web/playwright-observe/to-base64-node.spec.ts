import { expect, test } from '@playwright/test';
import { TextNodeImpl, ToBase64NodeImpl, type NodeConnection, type PortId } from '@valerypopoff/rivet2-core';

import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('To Base64 encodes a connected value in the browser executor', async ({ page }) => {
  const text = TextNodeImpl.create();
  text.data.text = 'hello 🌍';
  text.visualData = { ...text.visualData, x: 120, y: 160 };
  const encoder = ToBase64NodeImpl.create();
  encoder.visualData = { ...encoder.visualData, x: 520, y: 160 };
  const connection: NodeConnection = {
    outputNodeId: text.id,
    outputId: 'output' as PortId,
    inputNodeId: encoder.id,
    inputId: 'data' as PortId,
  };

  await seedHostedEditorProject(page, {
    graph: { nodes: [text, encoder], connections: [connection] },
    graphId: 'to-base64-graph',
    loaded: true,
    projectId: 'to-base64-project',
    projectPath: '/workflows/To Base64.rivet-project',
    title: 'To Base64',
  });
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'to-base64-fixture', revision: 0 },
        folders: [],
        projects: [
          {
            id: 'to-base64-project',
            name: 'To Base64',
            fileName: 'To Base64.rivet-project',
            relativePath: 'To Base64.rivet-project',
            absolutePath: '/workflows/To Base64.rivet-project',
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
  const node = editor.locator(`.node[data-nodeid="${encoder.id}"]`);
  await expect(node).toBeVisible({ timeout: 60_000 });
  await expect(node.locator('.input-port[data-portid="data"]')).toBeVisible();
  await expect(node.locator('.output-port[data-portid="base64"]')).toBeVisible();
  await editor.locator('.more-menu').click();
  await editor.getByRole('group', { name: 'Executor mode' }).getByRole('button', { name: 'Browser' }).click();
  await editor.locator('.more-menu').click();
  await editor.getByRole('button', { name: 'Run project' }).click();

  await expect(node.locator('.node-output')).toContainText(Buffer.from('hello 🌍', 'utf8').toString('base64'), {
    timeout: 30_000,
  });
});
