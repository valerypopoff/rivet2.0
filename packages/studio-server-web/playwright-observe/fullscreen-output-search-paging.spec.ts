import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

type EditorRoot = Page | FrameLocator;

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
