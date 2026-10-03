import { expect, test } from '@playwright/test';
import {
  ClassifierEvaluateNodeImpl,
  LLMChatV2NodeImpl,
  deserializeProject,
  serializeProject,
  type Project,
} from '@valerypopoff/rivet2-core';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

for (const type of ['llmChatV2', 'classifierEvaluate'] as const) {
  test(`${type}: Error behavior switches update ports, body, saved data and reload`, async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const node = type === 'llmChatV2' ? LLMChatV2NodeImpl.create() : ClassifierEvaluateNodeImpl.create();
    const item = {
      id: `error-behavior-${type}`,
      name: `Error behavior ${type}`,
      fileName: `${type}.rivet-project`,
      relativePath: `${type}.rivet-project`,
      absolutePath: `/workflows/${type}.rivet-project`,
      updatedAt: '2026-10-03T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    };
    let contents = serializeProject({
      metadata: { id: item.id, title: item.name, description: '', mainGraphId: 'main' },
      plugins: [],
      graphs: {
        main: {
          metadata: { id: 'main', name: 'Main Graph', description: '' },
          connections: [],
          nodes: [{ ...node, id: 'model', visualData: { x: 80, y: 100, width: 320 } }],
        },
      },
    } as unknown as Project);
    const saved: Project[] = [];
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: { root: '/workflows', sync: { epoch: type, revision: 0 }, folders: [], projects: [item] },
      }),
    );
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } }),
    );
    await page.route('**/api/projects/save', (route) => {
      contents = route.request().postDataJSON().contents;
      saved.push(deserializeProject(contents)[0]);
      return route.fulfill({ json: { path: item.absolutePath, revisionId: `save-${saved.length}` } });
    });
    await page.goto('/');
    await waitForDashboardReady(page);
    await page.locator('.project-row', { hasText: item.name }).dblclick();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const card = editor.locator('.node[data-nodeid="model"]');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await card.locator('.edit-button').dispatchEvent('click');
    const throwToggle = editor.getByRole('checkbox', { name: /^Fail on non-2XX status code/ });
    const catchToggle = editor.getByRole('checkbox', { name: /^Catch all failures/ });
    const errorHeading = editor.getByText('Error behavior', { exact: true });
    await expect(errorHeading).toBeVisible();
    if (
      (await errorHeading.locator('xpath=ancestor::*[@aria-expanded][1]').getAttribute('aria-expanded')) === 'false'
    ) {
      await errorHeading.click();
    }
    await expect(throwToggle).toBeChecked();
    await expect(catchToggle).not.toBeChecked();
    await expect(card).toContainText('Throw on non-2XX: Enabled');
    await expect(card.getByText('Run failed', { exact: true })).toHaveCount(0);

    await editor.getByText('Catch all failures', { exact: true }).click();
    await expect(card).toContainText('Catch all failures: Enabled');
    await expect(card.getByText('Run failed', { exact: true })).toBeVisible();
    await expect(card.getByText('Run error', { exact: true })).toBeVisible();
    await editor.getByText('Fail on non-2XX status code', { exact: true }).click();
    await expect(card).not.toContainText('Throw on non-2XX:');
    await editor.getByText('Catch all failures', { exact: true }).click();
    await expect(card).not.toContainText('Catch all failures:');
    await expect(card.getByText('Run failed', { exact: true })).toBeVisible();
    await editor.getByText('Fail on non-2XX status code', { exact: true }).click();
    await expect(card.getByText('Run failed', { exact: true })).toHaveCount(0);
    await editor.getByText('Catch all failures', { exact: true }).click();
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saved.length).toBe(1);
    await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    expect(Object.values(saved[0]!.graphs)[0]!.nodes[0]!.data).toMatchObject({
      errorOnNon200: true,
      catchRequestFailed: true,
    });
    await page.reload();
    await waitForDashboardReady(page);
    await expect(card).toContainText('Catch all failures: Enabled', { timeout: 120_000 });
    await card.locator('.edit-button').dispatchEvent('click');
    await expect(throwToggle).toBeChecked();
    await expect(catchToggle).toBeChecked();
  });
}
