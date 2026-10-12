import { expect, test } from '@playwright/test';
import { CodeNodeImpl, serializeProject, type Project } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('an unsuccessful editor run shows an error toast and returns its run controls to idle', async ({ page }) => {
  const errorMessage = 'Editor execution failure must be visible';
  const item = {
    id: 'execution-toast-fixture',
    projectMetadataId: 'execution-toast-fixture',
    name: 'Execution error toast',
    fileName: 'execution-error-toast.rivet-project',
    relativePath: 'execution-error-toast.rivet-project',
    absolutePath: '/workflows/execution-error-toast.rivet-project',
    updatedAt: '2026-10-09T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  const node = CodeNodeImpl.create();
  node.data = { ...node.data, inputNames: '', code: `throw new Error(${JSON.stringify(errorMessage)});` };
  const contents = serializeProject({
    metadata: { id: item.id, title: item.name, description: '', mainGraphId: 'main' },
    plugins: [],
    graphs: {
      main: {
        metadata: { id: 'main', name: 'Main Graph', description: '' },
        connections: [],
        nodes: [{ ...node, id: 'failure-node', visualData: { x: 80, y: 100, width: 320 } }],
      },
    },
  } as unknown as Project);
  await page.addInitScript(() => {
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
  });
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: { root: '/workflows', sync: { epoch: 'execution-toast', revision: 0 }, folders: [], projects: [item] },
    }),
  );
  await page.route('**/api/projects/load', (route) =>
    route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } }),
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: item.name }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const card = editor.locator('.node[data-nodeid="failure-node"]');
  await expect(card).toBeVisible({ timeout: 120_000 });
  const runButton = editor.locator('.run-button button').first();
  await expect(runButton).toBeEnabled();
  await runButton.click();
  // Node failures produce a root summary naming the failed nodes; the original
  // cause remains on the node. Preflight failures retain their exact root text.
  const errorToast = editor.locator('.Toastify__toast--error', { hasText: 'Graph execution error:' });
  await expect(errorToast).toBeVisible();
  await expect(errorToast).toHaveCount(1);
  await expect(errorToast).toContainText('failed to process due to errors in nodes');
  await expect(errorToast).toContainText('failure-node');
  await expect(card).toContainText(errorMessage);
  await expect(runButton).toBeEnabled();
  await expect(runButton).not.toContainText('Abort');
});
