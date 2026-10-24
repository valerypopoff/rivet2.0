import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test.beforeEach(async ({ page }) => {
  await mockHostedEditorBootstrap(page);
});

async function openEmptyProject(page: Page, suffix: string): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `llm-credentials-${suffix}-graph`,
    loaded: true,
    projectId: `llm-credentials-${suffix}-project`,
    projectPath: `/workflows/LLM Credentials ${suffix}.rivet-project`,
    title: `LLM Credentials ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  return editor;
}

async function addNode(editor: FrameLocator, nodeName: string, position = { x: 640, y: 420 }): Promise<void> {
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position });

  const search = editor.getByPlaceholder('Type in node name...');
  await expect(search).toBeVisible();
  await search.fill(nodeName);

  const result = editor.locator('.context-menu-items .context-menu-label-text', { hasText: nodeName }).first();
  await expect(result).toHaveText(nodeName);
  await result.click();
}

async function expectOpenAiCredentialDefaults(editor: FrameLocator): Promise<void> {
  const programmaticName = editor.getByLabel('Programmatic API key name');
  const environmentVariableName = editor.getByLabel('API key environment variable');

  await expect(programmaticName).toBeVisible({ timeout: 30_000 });
  await expect(programmaticName).toHaveValue('openAiApiKey');
  await expect(environmentVariableName).toHaveValue('OPENAI_API_KEY');
}

test('new Decision AI run and LLM Chat nodes share the default header color', async ({ page }) => {
  const editor = await openEmptyProject(page, 'default-model-colors');
  await addNode(editor, 'Decision AI run');
  const classifier = editor.locator('.node', {
    has: editor.locator('.node-title', { hasText: /^Decision AI run$/ }),
  });
  await expect(classifier).toBeVisible();
  expect(await classifier.evaluate((node) => (node as HTMLElement).style.getPropertyValue('--node-bg'))).toBe(
    'var(--node-color-6)',
  );
  await page.keyboard.press('Escape');
  await addNode(editor, 'LLM Chat', { x: 840, y: 200 });
  const llm = editor.locator('.node', { has: editor.locator('.node-title', { hasText: /^LLM Chat$/ }) });
  await expect(llm).toBeVisible();
  expect(await llm.evaluate((node) => (node as HTMLElement).style.getPropertyValue('--node-bg'))).toBe(
    await classifier.evaluate((node) => (node as HTMLElement).style.getPropertyValue('--node-bg')),
  );
});

async function selectProvider(editor: FrameLocator, provider: string): Promise<void> {
  const providerInput = editor.getByRole('combobox', { name: 'Provider', exact: true });
  await providerInput.click();
  await providerInput.fill(provider);
  await expect(providerInput).toHaveAttribute('aria-expanded', 'true');
  await providerInput.press('Enter');
  await expect(providerInput).toHaveAttribute('aria-expanded', 'false');
}

for (const nodeName of ['LLM Chat', 'LLM Profile']) {
  test(`${nodeName} supports OpenRouter credentials, discovery and reasoning without foreign provider controls`, async ({
    page,
  }) => {
    const editor = await openEmptyProject(page, `OpenRouter-${nodeName.replaceAll(' ', '-')}`);
    await page.route('https://openrouter.ai/api/v1/models', (route) =>
      route.fulfill({
        json: {
          data: [{ id: 'test/router-model', name: 'Router Test', architecture: { output_modalities: ['text'] } }],
        },
      }),
    );
    await addNode(editor, nodeName);
    await expectOpenAiCredentialDefaults(editor);
    await selectProvider(editor, 'OpenRouter');
    await expect(editor.getByLabel('Programmatic API key name')).toHaveValue('openRouterApiKey');
    await expect(editor.getByLabel('API key environment variable')).toHaveValue('OPENROUTER_API_KEY');
    await expect(editor.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeVisible();
    await expect(editor.getByLabel('Previous Response ID', { exact: true })).toBeHidden();
    await expect(editor.getByText('Enable Web Search', { exact: true })).toBeHidden();
    await editor.getByRole('group', { name: 'API key source' }).getByRole('button', { name: 'Input port' }).click();
    await editor.getByRole('button', { name: 'Re-fetch Model List' }).click();
    await expect(editor.getByText('Loaded 2 models from openrouter.')).toBeVisible();
    const model = editor.getByRole('combobox', { name: 'Model', exact: true });
    await model.click();
    await model.fill('Router Test');
    await model.press('Enter');
    await expect(editor.getByText('Router Test', { exact: true })).toBeVisible();
  });
}

test('LLM Chat exposes editable built-in-provider credential names', async ({ page }) => {
  const editor = await openEmptyProject(page, 'Chat');

  await addNode(editor, 'LLM Chat');
  await expectOpenAiCredentialDefaults(editor);

  const programmaticName = editor.getByLabel('Programmatic API key name');
  const environmentVariableName = editor.getByLabel('API key environment variable');
  await programmaticName.fill('');
  await environmentVariableName.fill('   ');
  await expect(programmaticName).toHaveValue('openAiApiKey');
  await expect(environmentVariableName).toHaveValue('OPENAI_API_KEY');

  await environmentVariableName.fill('1INVALID');
  await expect(editor.getByText('Use a portable environment-variable name:')).toBeVisible();

  await programmaticName.fill('  billingOpenAiKey  ');
  await environmentVariableName.fill('  BILLING_OPENAI_KEY  ');
  await expect(programmaticName).toHaveValue('billingOpenAiKey');
  await expect(environmentVariableName).toHaveValue('BILLING_OPENAI_KEY');

  const apiKeySource = editor.getByRole('group', { name: 'API key source' });
  await apiKeySource.getByRole('button', { name: 'Input port' }).click();
  await expect(programmaticName).toBeHidden();
  await apiKeySource.getByRole('button', { name: 'Configured key' }).click();
  await expect(programmaticName).toHaveValue('billingOpenAiKey');
  await expect(environmentVariableName).toHaveValue('BILLING_OPENAI_KEY');

  await selectProvider(editor, 'Anthropic');
  await expect(programmaticName).toHaveValue('anthropicApiKey');
  await expect(environmentVariableName).toHaveValue('ANTHROPIC_API_KEY');
  await programmaticName.fill('supportAnthropicKey');
  await environmentVariableName.fill('SUPPORT_ANTHROPIC_KEY');

  await selectProvider(editor, 'Google');
  await expect(programmaticName).toHaveValue('googleApiKey');
  await expect(environmentVariableName).toHaveValue('GOOGLE_GENERATIVE_AI_API_KEY');

  await selectProvider(editor, 'OpenAI');
  await expect(programmaticName).toHaveValue('billingOpenAiKey');
  await expect(environmentVariableName).toHaveValue('BILLING_OPENAI_KEY');

  await selectProvider(editor, 'Anthropic');
  await expect(programmaticName).toHaveValue('supportAnthropicKey');
  await expect(environmentVariableName).toHaveValue('SUPPORT_ANTHROPIC_KEY');
});

test('previously saved Chat Loop nodes remain loadable after its legacy-label change', async ({ page }) => {
  const graphId = 'legacy-chat-loop-graph';
  await seedHostedEditorProject(page, {
    graph: {
      nodes: [
        {
          data: {},
          id: 'legacy-chat-loop',
          title: 'Chat Loop',
          type: 'chatLoop',
          visualData: { width: 280, x: 120, y: 180 },
        },
      ],
    },
    graphId,
    loaded: true,
    projectId: 'legacy-chat-loop-project',
    projectPath: '/workflows/Legacy Chat Loop.rivet-project',
    title: 'Legacy Chat Loop',
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });

  // A title stored by an older project remains untouched; palette availability is
  // separate from loading and rendering registered compatibility node types.
  await expect(editor.locator('.node[data-nodeid="legacy-chat-loop"] .node-title')).toHaveText('Chat Loop');
});

test('Add node menu groups Code nodes and keeps retired nodes out of new-node creation', async ({ page }) => {
  const editor = await openEmptyProject(page, 'Add-Node-Menu');
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 640, y: 420 } });

  const addNodeItem = editor.locator('.context-menu-label-text', { hasText: 'Add node' });
  await expect(addNodeItem).toHaveText('Add node');
  await addNodeItem.hover();

  const codeGroup = editor.getByText('Code', { exact: true });
  await expect(codeGroup).toHaveText('Code');
  await codeGroup.hover();

  const codeItems = editor.getByText('Code', { exact: true });
  await expect(codeItems).toHaveCount(2);
  await expect(codeItems.last()).toHaveText('Code');
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Expression' })).toHaveText('Expression');
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Convenience' })).toHaveCount(0);
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Chat (Legacy)' })).toHaveCount(0);
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Loop Controller (legacy)' })).toHaveCount(0);

  const codeItem = codeItems.last();
  await codeItem.hover();
  const infoBox = editor.getByRole('heading', { name: 'Code Node' }).locator('..');
  await expect(infoBox).toBeVisible();
  await expect(infoBox.locator('img')).toHaveCount(0);
});

test('LLM Profile exposes the same built-in-provider credential contract', async ({ page }) => {
  const editor = await openEmptyProject(page, 'Profile');

  await addNode(editor, 'LLM Profile');
  await expectOpenAiCredentialDefaults(editor);
});
