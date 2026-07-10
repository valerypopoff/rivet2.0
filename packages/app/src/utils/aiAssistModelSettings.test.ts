import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAiAssistModelOptionForProvider,
  getAiAssistModelOptionsForProvider,
  getAiAssistProviderFromModel,
  getDefaultAiAssistModelForProvider,
  includeCurrentAiAssistModelOption,
  resolveAiAssistModelSettings,
} from './aiAssistModelSettings.js';

test('AI assist provider/model helpers split the stored model value for settings UI', () => {
  assert.equal(getAiAssistProviderFromModel('openai:gpt-4.1'), 'openai');
  assert.equal(getAiAssistProviderFromModel('anthropic:claude-sonnet-4-20250514'), 'anthropic');
  assert.equal(getAiAssistProviderFromModel('google:gemini-2.5-flash'), 'google');
  assert.equal(getAiAssistProviderFromModel('custom'), 'custom');
  assert.equal(getAiAssistProviderFromModel('unknown-model'), 'anthropic');

  assert.equal(getDefaultAiAssistModelForProvider('openai'), 'openai:gpt-5');
  assert.equal(getDefaultAiAssistModelForProvider('anthropic'), 'anthropic:claude-sonnet-4-20250514');
  assert.equal(getDefaultAiAssistModelForProvider('google'), 'google:gemini-2.5-flash');
  assert.equal(getDefaultAiAssistModelForProvider('custom'), 'custom');
});

test('AI assist model picker filters labels by selected provider', () => {
  const openAiOptions = getAiAssistModelOptionsForProvider('openai');
  const anthropicOptions = getAiAssistModelOptionsForProvider('anthropic');
  const googleOptions = getAiAssistModelOptionsForProvider('google');

  assert.ok(openAiOptions.some((option) => option.value === 'openai:gpt-5'));
  assert.ok(openAiOptions.some((option) => option.value === 'openai:o4-mini'));
  assert.ok(openAiOptions.some((option) => option.value === 'openai:local-model'));
  assert.equal(openAiOptions.find((option) => option.value === 'openai:gpt-4.1')?.label, 'GPT-4.1');
  assert.equal(
    anthropicOptions.find((option) => option.value === 'anthropic:claude-sonnet-4-20250514')?.label,
    'Claude Sonnet 4',
  );
  assert.equal(googleOptions.find((option) => option.value === 'google:gemini-2.5-flash')?.label, 'Gemini 2.5 Flash');
  assert.deepEqual(getAiAssistModelOptionsForProvider('custom'), []);
  assert.equal(
    getAiAssistModelOptionForProvider('openai:o4-mini', 'anthropic')?.value,
    'anthropic:claude-sonnet-4-20250514',
  );
});

test('AI assist model picker keeps old or manually entered current models visible', () => {
  assert.deepEqual(
    includeCurrentAiAssistModelOption([{ value: 'openai:gpt-5', label: 'GPT-5' }], 'openai:old-custom-model', 'openai'),
    [
      { value: 'openai:old-custom-model', label: 'old-custom-model (Current)' },
      { value: 'openai:gpt-5', label: 'GPT-5' },
    ],
  );
});

test('AI assist custom provider resolves through the Vercel custom provider path', () => {
  const resolved = resolveAiAssistModelSettings({
    customModel: 'deepseek-ai/DeepSeek-V4-Flash',
    customProviderBaseURL: 'https://inference.example.com/v1',
    selectedModel: 'custom',
  });

  assert.equal(resolved.generatorBranch, 'openai');
  assert.equal(resolved.provider, 'custom');
  assert.equal(resolved.model, 'deepseek-ai/DeepSeek-V4-Flash');
  assert.equal(resolved.displayName, 'Custom: deepseek-ai/DeepSeek-V4-Flash');
  assert.equal(resolved.customProviderBaseURL, 'https://inference.example.com/v1');
});

test('AI assist built-in provider keeps fetched or unknown selected model visible in the modal', () => {
  const resolved = resolveAiAssistModelSettings({
    customModel: '',
    customProviderBaseURL: '',
    selectedModel: 'openai:gpt-new-from-provider-catalog',
  });

  assert.equal(resolved.generatorBranch, 'openai');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'gpt-new-from-provider-catalog');
  assert.equal(resolved.displayName, 'gpt-new-from-provider-catalog');
});

test('AI assist custom provider reports missing URL or model configuration', () => {
  assert.equal(
    resolveAiAssistModelSettings({
      customModel: 'model',
      customProviderBaseURL: '',
      selectedModel: 'custom',
    }).missingConfiguration,
    'Set the custom provider API URL in Settings > LLM.',
  );
  assert.equal(
    resolveAiAssistModelSettings({
      customModel: '',
      customProviderBaseURL: 'https://example.com/v1',
      selectedModel: 'custom',
    }).missingConfiguration,
    'Set the custom provider model in Settings > LLM.',
  );
});
