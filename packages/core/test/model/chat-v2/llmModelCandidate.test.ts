import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildLLMInvocationPlan } from '../../../src/model/chat-v2/llmInvocationPlan.js';
import { resolveLLMModelCandidate } from '../../../src/model/chat-v2/llmModelCandidate.js';
import { createDefaultLLMProfileValue } from '../../../src/model/chat-v2/llmProfile.js';
import { createLLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';

describe('LLM model candidate', () => {
  it('rebuilds provider-specific structured output when a fallback candidate changes provider', async () => {
    const data = {
      ...createLLMChatV2NodeData(),
      configurationMode: 'profile' as const,
      responseFormat: 'json' as const,
    };
    const profile = createDefaultLLMProfileValue();
    profile.configuration = {
      ...profile.configuration,
      provider: 'custom',
      model: 'backup-model',
      customProviderBaseURL: 'https://backup.example.test/v1',
    };
    profile.credential = { value: 'backup-key', reference: { source: 'input' } };
    const plan = buildLLMInvocationPlan({
      data,
      inputs: { prompt: { type: 'string', value: 'Hello' } } as any,
      context: { settings: {}, getPluginConfig: () => '' } as any,
    });

    const candidate = await resolveLLMModelCandidate({ plan, profile });

    assert.equal(candidate.runOptions.provider, 'custom');
    assert.equal(candidate.runOptions.responseOutput, undefined);
    assert.deepEqual(candidate.runOptions.providerOptions, {
      custom: { response_format: { type: 'json_object' } },
    });
  });

  it('rebuilds Custom Responses candidates with the Responses adapter contract', async () => {
    const data = {
      ...createLLMChatV2NodeData(),
      configurationMode: 'profile' as const,
      responseFormat: 'json' as const,
    };
    const profile = createDefaultLLMProfileValue();
    profile.configuration = {
      ...profile.configuration,
      provider: 'custom',
      model: 'responses-backup',
      customProviderApi: 'responses',
      customProviderBaseURL: 'https://backup.example.test/v1/responses',
      extraProviderOptions: '{ "store": false }',
    };
    profile.credential = { value: 'backup-key', reference: { source: 'input' } };
    const plan = buildLLMInvocationPlan({
      data,
      inputs: { prompt: { type: 'string', value: 'Hello' } } as any,
      context: { settings: {}, getPluginConfig: () => '' } as any,
    });

    const candidate = await resolveLLMModelCandidate({ plan, profile });

    assert.equal((candidate.runOptions.model as { provider?: string }).provider, 'custom.responses');
    assert.ok(candidate.runOptions.responseOutput);
    assert.equal(candidate.runOptions.providerOptions, undefined);
    assert.deepEqual(candidate.requestBodyOverlay, { store: false });
  });
});
