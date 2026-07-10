import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_CHAT_NODE_TIMEOUT, resolveProcessSettings } from '../../src/index.js';

describe('resolveProcessSettings', () => {
  it('applies the runtime defaults used by graph processors', () => {
    assert.deepEqual(resolveProcessSettings(), {
      openAiApiKey: '',
      openAiKey: '',
      anthropicApiKey: '',
      googleApiKey: '',
      customAiApiKey: '',
      openAiOrganization: '',
      openAiEndpoint: '',
      pluginEnv: {},
      pluginSettings: {},
      recordingPlaybackLatency: 1000,
      defaultNodeColors: false,
      openNodeSettingsOnCreate: true,
      chatNodeHeaders: {},
      chatNodeTimeout: DEFAULT_CHAT_NODE_TIMEOUT,
      throttleChatNode: 100,
    });
  });

  it('prefers explicit settings over host fallbacks', () => {
    assert.equal(resolveProcessSettings({ recordingPlaybackLatency: 250 }).recordingPlaybackLatency, 250);
    assert.equal(
      resolveProcessSettings({ openAiKey: 'explicit', pluginEnv: { A: '1' } }, { openAiKey: 'fallback' }).openAiKey,
      'explicit',
    );
    assert.equal(
      resolveProcessSettings({ openAiApiKey: 'explicit-api-key' }, { openAiKey: 'fallback' }).openAiKey,
      'explicit-api-key',
    );
    assert.equal(
      resolveProcessSettings({ openAiKey: 'legacy' }, { openAiApiKey: 'fallback-api-key' }).openAiApiKey,
      'legacy',
    );
    assert.equal(
      resolveProcessSettings({ openAiApiKey: '', openAiKey: 'legacy' }, { openAiApiKey: 'fallback-api-key' })
        .openAiApiKey,
      'legacy',
    );
    assert.deepEqual(
      resolveProcessSettings({ openAiKey: 'explicit', pluginEnv: { A: '1' } }, { pluginEnv: { B: '2' } }).pluginEnv,
      { A: '1' },
    );
    assert.equal(resolveProcessSettings({ customOne: 'explicit' }, { customOne: 'fallback' }).customOne, 'explicit');
    assert.equal(resolveProcessSettings({ customOne: '' }, { customOne: 'fallback' }).customOne, 'fallback');
    assert.equal(resolveProcessSettings({ customOne: undefined }, { customOne: 'fallback' }).customOne, 'fallback');
  });

  it('uses host fallbacks when explicit settings are missing', () => {
    assert.deepEqual(
      resolveProcessSettings(undefined, {
        openAiApiKey: 'env-key',
        anthropicApiKey: 'anthropic-env-key',
        googleApiKey: 'google-env-key',
        customAiApiKey: 'custom-env-key',
        customOne: 'custom-one-env-key',
        openAiOrganization: 'env-org',
        openAiEndpoint: 'env-endpoint',
        pluginEnv: { API_TOKEN: 'token' },
      }),
      {
        openAiApiKey: 'env-key',
        openAiKey: 'env-key',
        anthropicApiKey: 'anthropic-env-key',
        googleApiKey: 'google-env-key',
        customAiApiKey: 'custom-env-key',
        customOne: 'custom-one-env-key',
        openAiOrganization: 'env-org',
        openAiEndpoint: 'env-endpoint',
        pluginEnv: { API_TOKEN: 'token' },
        pluginSettings: {},
        recordingPlaybackLatency: 1000,
        defaultNodeColors: false,
        openNodeSettingsOnCreate: true,
        chatNodeHeaders: {},
        chatNodeTimeout: DEFAULT_CHAT_NODE_TIMEOUT,
        throttleChatNode: 100,
      },
    );
  });
});
