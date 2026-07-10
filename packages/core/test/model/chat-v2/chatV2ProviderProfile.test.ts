import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveChatV2Credential } from '../../../src/model/chat-v2/chatV2ProviderProfile.js';

const context = (settings: Record<string, unknown>, pluginValues: Record<string, string> = {}) =>
  ({
    settings,
    getPluginConfig: (key: string) => pluginValues[key],
  }) as any;

describe('resolveChatV2Credential', () => {
  it('uses the input key before configured provider credentials', () => {
    const result = resolveChatV2Credential({
      provider: 'openai',
      context: context({ openAiApiKey: 'configured-key' }),
      apiKeySource: 'input',
      inputs: { apiKey: { type: 'string', value: 'input-key' } } as any,
    });

    assert.equal(result.value, 'input-key');
    assert.deepEqual(result.reference, { source: 'input' });
  });

  it('keeps custom credential precedence explicit and reports only its reference', () => {
    const result = resolveChatV2Credential({
      provider: 'custom',
      context: context({
        cerebrasApiKey: 'programmatic-secret',
        customAiApiKey: 'shared-secret',
        pluginEnv: { CEREBRAS_API_KEY: 'environment-secret' },
      }),
      customProgrammaticName: 'cerebrasApiKey',
      customEnvironmentName: 'CEREBRAS_API_KEY',
    });

    assert.equal(result.value, 'programmatic-secret');
    assert.deepEqual(result.reference, { source: 'programmatic', name: 'cerebrasApiKey' });
    assert.doesNotMatch(JSON.stringify(result.reference), /secret/);
  });

  it('falls back from settings to legacy plugin credentials for built-in providers', () => {
    const result = resolveChatV2Credential({
      provider: 'anthropic',
      context: context({}, { anthropicApiKey: 'plugin-key' }),
    });

    assert.equal(result.value, 'plugin-key');
    assert.deepEqual(result.reference, { source: 'plugin' });
  });
});
