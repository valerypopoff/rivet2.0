import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getLLMChatV2CustomProviderApiKeyEnvVarNames } from './chatV2CustomProviderEnv';

describe('getLLMChatV2CustomProviderApiKeyEnvVarNames', () => {
  it('collects unique configured-key env vars from custom LLM Chat and LLM Profile nodes', () => {
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
                provider: 'custom',
                apiKeySource: 'environment',
                customProviderApiKeyEnvVarName: ' PROFILE_API_KEY ',
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
                customProviderApiKeyEnvVarName: 'OPENAI_SHOULD_NOT_COUNT',
              },
            },
          ],
          connections: [],
        },
      },
    } as any;

    assert.deepEqual(getLLMChatV2CustomProviderApiKeyEnvVarNames(project), ['CEREBRAS_API_KEY', 'PROFILE_API_KEY']);
  });
});
