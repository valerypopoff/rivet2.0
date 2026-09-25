import { expect, test } from '@playwright/test';
import { PromptNodeImpl, TextNodeImpl } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Prompt colors Markdown and interpolation like Text without rendering Markdown', async ({ page }) => {
  const source = '# Heading\n\nUse **bold**, `code`, and {{name}}.';
  const textNode = TextNodeImpl.create();
  textNode.data.text = source;
  textNode.visualData = { ...textNode.visualData, x: 100, y: 150, width: 350 };
  const promptNode = PromptNodeImpl.create();
  promptNode.data.promptText = source;
  promptNode.visualData = { ...promptNode.visualData, x: 510, y: 150, width: 350 };

  await seedHostedEditorProject(page, {
    graph: { nodes: [textNode, promptNode] },
    graphId: 'prompt-colorization-graph',
    loaded: true,
    projectId: 'prompt-colorization-project',
    projectPath: '/workflows/Prompt Colorization.rivet-project',
    title: 'Prompt Colorization',
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const textPre = editor.locator(`.node[data-nodeid="${textNode.id}"] pre[data-lang="prompt-interpolation-markdown"]`);
  const promptCard = editor.locator(`.node[data-nodeid="${promptNode.id}"]`);
  const promptPre = promptCard.locator('pre[data-lang="prompt-interpolation-markdown"]');

  await expect(promptCard.locator('.prompt-node-role')).toHaveText('User');
  await expect(promptPre).toContainText('# Heading');
  await expect(promptPre).toContainText('Use **bold**, `code`, and {{name}}.');
  await expect(promptCard.locator('h1, strong, code')).toHaveCount(0);
  await expect.poll(() => promptPre.locator('span[style*="color"]').count()).toBeGreaterThan(0);
  await expect.poll(() => textPre.locator('span[style*="color"]').count()).toBeGreaterThan(0);
  expect(await promptPre.innerHTML()).toBe(await textPre.innerHTML());
});
