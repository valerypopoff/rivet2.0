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

for (const nodeName of ['LLM Profile', 'Decision AI Profile', 'LLM Chat', 'Decision AI run']) {
  test(`${nodeName} shows system pricing and preserves explicit custom rates`, async ({ page }, testInfo) => {
    const editor = await openEmptyProject(page, `pricing-${nodeName.replaceAll(' ', '-')}`);
    await addNode(editor, nodeName);
    const pricing = editor.getByRole('region', { name: 'Token pricing', exact: true });
    const pricingSection = editor
      .getByRole('button', { name: 'Token pricing', exact: true })
      .and(editor.locator('button'));
    await expect(pricingSection).toHaveAttribute('aria-expanded', 'false');
    await expect(pricing).toBeHidden();
    await pricingSection.click();
    await expect(pricing).toBeVisible();
    const contentId = await pricingSection.getAttribute('aria-controls');
    expect(contentId).toBeTruthy();
    await expect(pricing).toHaveAttribute('id', contentId!);
    const labelledBy = await pricing.getAttribute('aria-labelledby');
    await expect(editor.locator(`[id="${labelledBy}"]`)).toHaveCount(1);
    await expect(pricing.getByLabel('Default token prices')).toContainText('Default rates: Input: $');
    await expect(pricing).toContainText('Price overrides are optional.');
    const usageNotice = pricing.getByText(/This model reports aggregate input\/output tokens only/);
    if (nodeName.startsWith('Decision AI')) await expect(usageNotice).toBeVisible();
    else await expect(usageNotice).toHaveCount(0);
    await expect(pricing).not.toContainText('Rivet rates');
    const toggle = pricing.getByRole('checkbox', { name: 'Override token prices', exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    const input = pricing.getByLabel('Input USD / 1M tokens', { exact: true });
    const output = pricing.getByLabel('Output USD / 1M tokens', { exact: true });
    await expect(input).not.toHaveValue('');
    await input.fill('2.5');
    await output.fill('0');
    await pricing.getByLabel('Cached input (read) USD / 1M tokens', { exact: true }).fill('0.25');
    await pricing.getByLabel('Cache write USD / 1M tokens', { exact: true }).fill('3');
    await expect(pricing.getByRole('alert')).toHaveCount(0);
    await pricingSection.click();
    await expect(pricing).toBeHidden();
    await pricingSection.click();
    await expect(input).toHaveValue('2.5');
    await expect(output).toHaveValue('0');
    const fieldsFit = await pricing.evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('input[type="number"]')].every((input) => {
        const field = input.getBoundingClientRect();
        return field.width > 60 && field.left >= bounds.left - 1 && field.right <= bounds.right + 1;
      });
    });
    expect(fieldsFit, 'price inputs must fit inside the panel without horizontal overflow').toBe(true);
    await pricing.screenshot({ path: testInfo.outputPath('profile-pricing.png') });
    await page.keyboard.press('Escape');
    await editor
      .locator('.node', { has: editor.locator('.node-title', { hasText: new RegExp(`^${nodeName}$`) }) })
      .dblclick();
    await expect(input).toHaveValue('2.5');
    await expect(output).toHaveValue('0');
    await expect(pricing.getByLabel('Cached input (read) USD / 1M tokens', { exact: true })).toHaveValue('0.25');
    await expect(pricing.getByLabel('Cache write USD / 1M tokens', { exact: true })).toHaveValue('3');
    // Compose edits in a single browser task, without allowing a React render
    // to make a stale nested-object snapshot appear correct.
    await pricing.evaluate((panel) => {
      const fields = [...panel.querySelectorAll<HTMLInputElement>('input[type="number"]')];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      for (const [index, value] of ['3.5', '7', '', ''].entries()) {
        setter.call(fields[index], value);
        fields[index]!.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.keyboard.press('Escape');
    await editor
      .locator('.node', { has: editor.locator('.node-title', { hasText: new RegExp(`^${nodeName}$`) }) })
      .dblclick();
    await expect(input).toHaveValue('3.5');
    await expect(output).toHaveValue('7');
    await expect(pricing.getByLabel('Cached input (read) USD / 1M tokens', { exact: true })).toHaveValue('');
    await expect(pricing.getByLabel('Cache write USD / 1M tokens', { exact: true })).toHaveValue('');
    await expect(pricing.getByRole('alert')).toHaveCount(0);
    await pricing.getByRole('button', { name: 'Use default rates' }).click();
    await expect(input).not.toHaveValue('3.5');
    await pricing.evaluate((panel) => {
      const oldInput = panel.querySelector<HTMLInputElement>('input[type="number"]')!;
      panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(oldInput, '99');
      oldInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(toggle).not.toBeChecked();
    await expect(input).toHaveCount(0);
    if (nodeName === 'LLM Profile' || nodeName === 'LLM Chat') {
      await selectProvider(editor, 'Custom');
      await expect(pricing.getByLabel('Default token prices')).toContainText('Input: unknown');
      await toggle.check();
      await expect(pricing.getByRole('button', { name: 'Use default rates' })).toBeDisabled();
      await expect(pricing.getByRole('alert')).toContainText('inputPerMillionTokens');
      await input.fill('0');
      await output.fill('0');
      await expect(pricing.getByRole('alert')).toHaveCount(0);
    }
    if (nodeName === 'LLM Chat' || nodeName === 'Decision AI run') {
      await toggle.check();
      await input.fill('6');
      await output.fill('9');
      const label = nodeName === 'LLM Chat' ? 'LLM' : 'Decision AI';
      const source = editor.getByRole('group', { name: `${label} configuration source`, exact: true });
      await source.getByRole('button', { name: 'From profile', exact: true }).click();
      await expect(pricing).toHaveCount(0);
      await source.getByRole('button', { name: 'Inline', exact: true }).click();
      await expect(toggle).toBeChecked();
      await expect(input).toHaveValue('6');
      await expect(output).toHaveValue('9');
      await editor.getByRole('button', { name: `Export ${label} settings to profile node`, exact: true }).click();
      await expect(source.getByRole('button', { name: 'From profile', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.keyboard.press('Escape');
      const profileName = `${label} Profile`;
      await editor
        .locator('.node', { has: editor.locator('.node-title', { hasText: new RegExp(`^${profileName}$`) }) })
        .dblclick();
      if ((await pricingSection.getAttribute('aria-expanded')) === 'false') await pricingSection.click();
      await expect(toggle).toBeChecked();
      await expect(input).toHaveValue('6');
      await expect(output).toHaveValue('9');
    }
  });
}

for (const nodeName of ['Decision AI run', 'Decision AI Profile']) {
  test(`${nodeName} scopes the aggregate usage notice to verified static models`, async ({ page }) => {
    const editor = await openEmptyProject(page, `usage-notice-${nodeName.replaceAll(' ', '-')}`);
    await addNode(editor, nodeName);
    await editor.getByRole('button', { name: 'Token pricing', exact: true }).and(editor.locator('button')).click();
    const pricing = editor.getByRole('region', { name: 'Token pricing', exact: true });
    const usageNotice = pricing.getByText(/This model reports aggregate input\/output tokens only/);
    await expect(usageNotice).toBeVisible(); // An unset model resolves to Jev's default.
    for (const [providerName, modelLabel, showNotice] of [
      ['Jev', 'jev-1.13.0', true],
      ['Liquid AI', 'd1.1', true],
      ['OpenRouter', 'Microsoft Decision-1 (9b)', true],
      ['OpenAI', 'gpt-6-luna', false],
      ['Perplexity', 'pplx-decider-v1.1 (27b)', true],
      ['SubQ', 'subq-snap-1.1', true],
      ['Baseten', 'Joey-1 (2b)', true],
    ] as const) {
      await selectProvider(editor, providerName);
      const model = editor.getByRole('combobox', { name: 'Model', exact: true });
      await model.fill(modelLabel);
      await model.press('Enter');
      if (showNotice) await expect(usageNotice).toBeVisible();
      else await expect(usageNotice).toHaveCount(0);
      if (providerName === 'OpenAI') {
        await expect(pricing.getByLabel('Default token prices')).toContainText('Cached input (read): $0.01');
        await expect(pricing.getByLabel('Default token prices')).toContainText('Cache write: $0.125');
        await expect(pricing).toContainText('Cached input (read) $0.02. Cache write $0.25.');
        const toggle = pricing.getByRole('checkbox', { name: 'Override token prices', exact: true });
        await toggle.check();
        const read = pricing.getByLabel('Cached input (read) USD / 1M tokens', { exact: true });
        const write = pricing.getByLabel('Cache write USD / 1M tokens', { exact: true });
        await expect(read).toHaveValue('0.01');
        await expect(write).toHaveValue('0.125');
        await read.fill('0.5');
        await write.fill('3');
        await pricing.getByRole('button', { name: 'Use default rates', exact: true }).click();
        await expect(read).toHaveValue('0.01');
        await expect(write).toHaveValue('0.125');
        await toggle.uncheck();
      }
    }
    const inputToggle = editor.getByRole('button', { name: 'Use an input port for Model', exact: true });
    await inputToggle.click();
    await expect(usageNotice).toHaveCount(0);
    await inputToggle.click();
    await expect(usageNotice).toBeVisible();
    const model = editor.getByRole('combobox', { name: 'Model', exact: true });
    await model.fill('Custom model…');
    await model.press('Enter');
    const custom = editor.getByRole('textbox', { name: 'Custom model', exact: true });
    await custom.fill('unverified-future-model');
    await expect(usageNotice).toHaveCount(0);
    await custom.fill('');
    await expect(usageNotice).toBeVisible(); // Clearing returns to the provider default.
  });
}
