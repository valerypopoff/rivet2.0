import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

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

async function addNode(editor: FrameLocator, nodeName: string): Promise<void> {
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 640, y: 420 } });

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

async function selectProvider(editor: FrameLocator, provider: string): Promise<void> {
  const providerInput = editor.getByRole('combobox', { name: 'Provider', exact: true });
  await providerInput.click();
  await providerInput.fill(provider);
  await expect(providerInput).toHaveAttribute('aria-expanded', 'true');
  await providerInput.press('Enter');
  await expect(providerInput).toHaveAttribute('aria-expanded', 'false');
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

test('LLM Profile exposes the same built-in-provider credential contract', async ({ page }) => {
  const editor = await openEmptyProject(page, 'Profile');

  await addNode(editor, 'LLM Profile');
  await expectOpenAiCredentialDefaults(editor);
});
