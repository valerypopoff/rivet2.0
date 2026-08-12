import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getLLMChatV2ApiKeyEnvVarNames } from './chatV2ProviderEnv';

describe('getLLMChatV2ApiKeyEnvVarNames', () => {
  it('collects selected configured-key env vars from built-in and Custom LLM nodes', () => {
    const project = {
      graphs: {
        main: {
          nodes: [
            {
              type: 'llmChatV2',
              data: {
                provider: 'custom',
                apiKeySource: 'environment',
                customProviderApiKeyEnvVarName: ' CEREBRAS_API_KEY ',
              },
            },
            {
              type: 'llmProfile',
              data: {
                provider: 'anthropic',
                apiKeySource: 'environment',
                providerApiKeyNames: {
                  openai: {
                    programmaticName: 'unusedOpenAiKey',
                    environmentVariableName: 'UNUSED_OPENAI_KEY',
                  },
                  anthropic: {
                    programmaticName: 'profileAnthropicKey',
                    environmentVariableName: ' PROFILE_API_KEY ',
                  },
                },
              },
            },
            {
              type: 'llmChatV2',
              data: {
                provider: 'custom',
                apiKeySource: 'environment',
                customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
              },
            },
            {
              type: 'llmChatV2',
              data: {
                provider: 'custom',
                apiKeySource: 'input',
                customProviderApiKeyEnvVarName: 'INPUT_PORT_KEY',
              },
            },
            {
              type: 'llmChatV2',
              data: {
                provider: 'openai',
                apiKeySource: 'environment',
                providerApiKeyNames: {
                  openai: {
                    programmaticName: 'billingOpenAiKey',
                    environmentVariableName: 'BILLING_OPENAI_KEY',
                  },
                },
              },
            },
            {
              type: 'llmChatV2',
              data: {
                provider: 'google',
                apiKeySource: 'environment',
                providerApiKeyNames: {
                  google: {
                    programmaticName: 'googleKey',
                    environmentVariableName: 'NOT-PORTABLE',
                  },
                },
              },
            },
          ],
          connections: [],
        },
      },
      nodePrefabs: {
        reusableProfile: {
          sourceNode: {
            type: 'llmProfile',
            data: {
              provider: 'google',
              apiKeySource: 'environment',
              providerApiKeyNames: {
                google: {
                  programmaticName: 'prefabGoogleKey',
                  environmentVariableName: 'PREFAB_GOOGLE_KEY',
                },
              },
            },
          },
        },
      },
    } as any;

    assert.deepEqual(getLLMChatV2ApiKeyEnvVarNames(project), [
      'CEREBRAS_API_KEY',
      'PROFILE_API_KEY',
      'BILLING_OPENAI_KEY',
      'PREFAB_GOOGLE_KEY',
    ]);
  });
});
