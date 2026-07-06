import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { getPluginConfig, plugins } from '../../src/index.js';

describe('getPluginConfig', () => {
  it('uses explicit plugin settings before shared LLM settings', () => {
    assert.equal(
      getPluginConfig(
        plugins.anthropic,
        {
          anthropicApiKey: 'shared-anthropic-key',
          pluginSettings: {
            anthropic: {
              anthropicApiKey: 'plugin-anthropic-key',
            },
          },
        },
        'anthropicApiKey',
      ),
      'plugin-anthropic-key',
    );
  });

  it('falls back to shared LLM settings for legacy Anthropic and Google plugin nodes', () => {
    assert.equal(
      getPluginConfig(plugins.anthropic, { anthropicApiKey: 'shared-anthropic-key' }, 'anthropicApiKey'),
      'shared-anthropic-key',
    );
    assert.equal(
      getPluginConfig(plugins.google, { googleApiKey: 'shared-google-key' }, 'googleApiKey'),
      'shared-google-key',
    );
  });

  it('does not let missing or blank plugin values block shared LLM settings', () => {
    assert.equal(
      getPluginConfig(
        plugins.anthropic,
        {
          anthropicApiKey: 'shared-anthropic-key',
          pluginSettings: {
            anthropic: {
              anthropicApiEndpoint: 'https://example.test/v1',
            },
          },
        },
        'anthropicApiKey',
      ),
      'shared-anthropic-key',
    );
    assert.equal(
      getPluginConfig(
        plugins.google,
        {
          googleApiKey: 'shared-google-key',
          pluginSettings: {
            google: {
              googleApiKey: '',
            },
          },
        },
        'googleApiKey',
      ),
      'shared-google-key',
    );
  });

  it('keeps environment fallbacks when no shared LLM setting is configured', () => {
    assert.equal(
      getPluginConfig(plugins.anthropic, { pluginEnv: { ANTHROPIC_API_KEY: 'env-anthropic-key' } }, 'anthropicApiKey'),
      'env-anthropic-key',
    );
  });

  it('does not let unrelated plugin settings block environment fallbacks', () => {
    assert.equal(
      getPluginConfig(
        plugins.anthropic,
        {
          pluginEnv: { ANTHROPIC_API_KEY: 'env-anthropic-key' },
          pluginSettings: {
            anthropic: {
              anthropicApiEndpoint: 'https://example.test/v1',
            },
          },
        },
        'anthropicApiKey',
      ),
      'env-anthropic-key',
    );
  });
});
