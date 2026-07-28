import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LLMChatV2NodeImpl, LLMProfileNodeImpl, type LLMChatV2Node, type LLMProfileNode } from '../../../src/index.js';
import { llmChatV2ProfileDataKeys } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import { normalizeLLMProfileValue } from '../../../src/model/chat-v2/llmProfile.js';
import { llmProfileInputIds } from '../../../src/model/chat-v2/llmProfileTypes.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';

function createProfileNode(data: Partial<LLMProfileNode['data']> = {}) {
  const node = LLMProfileNodeImpl.create();
  return new LLMProfileNodeImpl({
    ...node,
    data: {
      ...node.data,
      ...data,
    },
  });
}

function createChatNode(data: Partial<LLMChatV2Node['data']> = {}) {
  const node = LLMChatV2NodeImpl.create();
  return new LLMChatV2NodeImpl({
    ...node,
    data: {
      ...node.data,
      ...data,
    },
  });
}

function createRuntimeContext() {
  return {
    settings: {
      openAiKey: 'configured-openai-key',
      openAiEndpoint: 'https://api.openai.test/v1/responses',
      openAiOrganization: '',
      chatNodeHeaders: {},
    },
    getPluginConfig: () => '',
    editorExecutionCache: new Map<string, unknown>(),
  } as any;
}

describe('LLMProfileNodeImpl', () => {
  it('creates a reusable typed LLM profile node', () => {
    const node = LLMProfileNodeImpl.create();

    assert.equal(node.type, 'llmProfile');
    assert.equal(node.title, 'LLM Profile');
    assert.equal(node.data.provider, 'openai');
    assert.equal(node.data.model, 'gpt-5');
    assert.deepEqual(new LLMProfileNodeImpl(node).getOutputDefinitions(), [
      {
        id: 'profile',
        title: 'Profile',
        dataType: 'llm-config',
      },
    ]);
  });

  it('exposes only the dynamic provider and generation inputs enabled by the profile', () => {
    const node = createProfileNode({
      provider: 'custom',
      useModelInput: true,
      apiKeySource: 'input',
      useCustomProviderBaseURLInput: true,
      useTemperatureInput: true,
      useHeadersInput: true,
      useExtraProviderOptionsInput: true,
    });

    assert.deepEqual(
      node.getInputDefinitions().map((input) => input.id),
      ['model', 'apiKey', 'customProviderBaseURL', 'temperature', 'headers', 'extraProviderOptions'],
    );
  });

  it('keeps the full recoverable Profile input contract aligned with runtime ports', () => {
    const commonDynamicInputs = {
      useModelInput: true,
      apiKeySource: 'input' as const,
      useTemperatureInput: true,
      useMaxTokensInput: true,
      useTopPInput: true,
      useTopKInput: true,
      usePresencePenaltyInput: true,
      useFrequencyPenaltyInput: true,
      useStopSequencesInput: true,
      useSeedInput: true,
      useHeadersInput: true,
      useExtraProviderOptionsInput: true,
    };
    const profileInputIds = new Set(
      (['openai', 'anthropic', 'google', 'custom'] as const).flatMap((provider) =>
        createProfileNode({
          ...commonDynamicInputs,
          provider,
          useCustomProviderBaseURLInput: provider === 'custom',
          useOpenAIPreviousResponseIdInput: provider === 'openai',
          useAnthropicThinkingBudgetInput: provider === 'anthropic',
          useGoogleThinkingBudgetInput: provider === 'google',
        })
          .getInputDefinitions()
          .map((input) => input.id),
      ),
    );

    assert.deepEqual([...profileInputIds].sort(), [...llmProfileInputIds].sort());
  });

  it('exposes and resolves an input-driven OpenAI Previous Response ID in the profile', async () => {
    const node = createProfileNode({
      provider: 'openai',
      useOpenAIPreviousResponseIdInput: true,
    });

    assert.ok(node.getInputDefinitions().some((input) => input.id === 'previousResponseId'));

    const result = await node.process(
      {
        previousResponseId: { type: 'string', value: 'response-from-profile-input' },
      } as any,
      createRuntimeContext(),
    );
    const profile = normalizeLLMProfileValue(result.profile?.value);

    assert.equal(profile.configuration.openAIPreviousResponseId, 'response-from-profile-input');
    assert.equal(profile.configuration.useOpenAIPreviousResponseIdInput, false);
  });

  it('normalizes legacy profile nodes that predate Previous Response ID ownership', async () => {
    const legacyNode = LLMProfileNodeImpl.create();
    const legacyData = structuredClone(legacyNode.data) as Record<string, unknown>;
    delete legacyData.openAIPreviousResponseId;
    delete legacyData.useOpenAIPreviousResponseIdInput;
    const node = new LLMProfileNodeImpl({
      ...legacyNode,
      data: legacyData as LLMProfileNode['data'],
    });

    const result = await node.process({}, createRuntimeContext());
    const profile = normalizeLLMProfileValue(result.profile?.value);

    assert.equal(profile.configuration.openAIPreviousResponseId, '');
    assert.equal(profile.configuration.useOpenAIPreviousResponseIdInput, false);
  });

  it('resolves input-driven settings and embeds the resolved API key in the profile value', async () => {
    const node = createProfileNode({
      provider: 'custom',
      model: 'stale-model',
      useModelInput: true,
      apiKeySource: 'input',
      customProviderBaseURL: 'https://stale.example/v1',
      useCustomProviderBaseURLInput: true,
      useTemperatureInput: true,
      headers: [{ key: 'x-static', value: 'stale' }],
      useHeadersInput: true,
      extraProviderOptions: '',
      useExtraProviderOptionsInput: true,
    });

    const result = await node.process(
      {
        model: { type: 'string', value: 'runtime-model' },
        apiKey: { type: 'string', value: 'profile-secret' },
        customProviderBaseURL: { type: 'string', value: 'https://runtime.example/v1/chat/completions' },
        temperature: { type: 'number', value: 0.2 },
        headers: { type: 'object', value: { 'x-runtime': 'enabled' } },
        extraProviderOptions: { type: 'object', value: { custom: { mode: 'fast' } } },
      } as any,
      createRuntimeContext(),
    );
    const profile = normalizeLLMProfileValue(result.profile?.value);

    assert.equal(profile.credential.value, 'profile-secret');
    assert.deepEqual(profile.credential.reference, { source: 'input' });
    assert.equal(profile.configuration.model, 'runtime-model');
    assert.equal(profile.configuration.temperature, 0.2);
    assert.equal(profile.configuration.customProviderBaseURL, 'https://runtime.example/v1/chat/completions');
    assert.deepEqual(profile.configuration.headers, [{ key: 'x-runtime', value: 'enabled' }]);
    assert.deepEqual(JSON.parse(profile.configuration.extraProviderOptions), {
      custom: { mode: 'fast' },
    });
    assert.equal(profile.configuration.useModelInput, false);
    assert.equal(profile.configuration.useTemperatureInput, false);
    assert.equal(profile.configuration.useHeadersInput, false);
  });

  it('embeds configured credentials and rejects malformed externally constructed profiles', async () => {
    const profileNode = createProfileNode({
      provider: 'openai',
      apiKeySource: 'environment',
    });
    const output = await profileNode.process({}, createRuntimeContext());
    const profile = normalizeLLMProfileValue(output.profile?.value);

    assert.equal(profile.credential.value, 'configured-openai-key');
    assert.deepEqual(profile.credential.reference, { source: 'settings' });
    assert.throws(
      () =>
        normalizeLLMProfileValue({
          ...profile,
          configuration: {
            ...profile.configuration,
            temperature: 'hot',
          },
        }),
      /temperature must be a finite number/,
    );
    assert.throws(
      () =>
        normalizeLLMProfileValue({
          ...profile,
          configuration: {
            ...profile.configuration,
            headers: [{ key: 'authorization', value: 123 }],
          },
        }),
      /headers must contain string key\/value pairs/,
    );
  });

  it('normalizes externally constructed profiles into self-contained configuration values', async () => {
    const profileNode = createProfileNode({
      provider: 'openai',
      model: 'profile-model',
      apiKeySource: 'environment',
    });
    const output = await profileNode.process({}, createRuntimeContext());
    const profile = normalizeLLMProfileValue(output.profile?.value);
    const externallyDynamicProfile = normalizeLLMProfileValue({
      ...profile,
      configuration: {
        ...profile.configuration,
        useModelInput: true,
        useTemperatureInput: true,
        useHeadersInput: true,
      },
    });
    const chatNode = createChatNode({ configurationMode: 'profile' });
    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: chatNode.data,
      nodeId: chatNode.chartNode.id,
      inputs: {
        llmProfile: { type: 'llm-config', value: externallyDynamicProfile },
        model: { type: 'string', value: 'stale-hidden-model-input' },
        temperature: { type: 'number', value: 1.9 },
        headers: { type: 'object', value: { 'x-stale': 'header' } },
        prompt: { type: 'string', value: 'Hello' },
      } as any,
      context: createRuntimeContext(),
    });

    assert.equal(externallyDynamicProfile.configuration.useModelInput, false);
    assert.equal(externallyDynamicProfile.configuration.useTemperatureInput, false);
    assert.equal(externallyDynamicProfile.configuration.useHeadersInput, false);
    assert.equal(runtime.runOptions.modelId, 'profile-model');
    assert.equal(runtime.runOptions.temperature, profile.configuration.temperature);
    assert.equal(runtime.providerProfile.hasCustomHeaders, false);
  });

  it('keeps profile-owned settings on LLM Profile and invocation-owned settings on LLM Chat', async () => {
    const profileEditors = await createProfileNode().getEditors({} as any);
    const profileGroups = profileEditors
      .filter((editor): editor is Extract<typeof editor, { type: 'group' }> => editor.type === 'group')
      .map((editor) => editor.label);
    assert.deepEqual(profileGroups, [
      'Model',
      'OpenAI',
      'Anthropic',
      'Google',
      'Parameters',
      'Reasoning',
      'Provider Advanced',
    ]);
    const profileDataKeys = new Set<string>(llmChatV2ProfileDataKeys);
    const openAIGroup = profileEditors.find((editor) => editor.type === 'group' && editor.label === 'OpenAI') as any;
    const previousResponseIdEditor = openAIGroup.editors.find(
      (editor: any) => editor.dataKey === 'openAIPreviousResponseId',
    );
    assert.equal(previousResponseIdEditor?.label, 'Previous Response ID');
    assert.equal(previousResponseIdEditor?.helperMessage, undefined);
    const visitProfileEditors = (editors: typeof profileEditors): void => {
      for (const editor of editors) {
        if ('dataKey' in editor && editor.dataKey != null) {
          assert.ok(
            profileDataKeys.has(String(editor.dataKey)),
            `Unexpected LLM Profile data key: ${String(editor.dataKey)}`,
          );
        }
        if ('useInputToggleDataKey' in editor && editor.useInputToggleDataKey != null) {
          assert.ok(
            profileDataKeys.has(String(editor.useInputToggleDataKey)),
            `Unexpected LLM Profile input-toggle key: ${String(editor.useInputToggleDataKey)}`,
          );
        }
        if (editor.type === 'group') {
          visitProfileEditors(editor.editors as typeof profileEditors);
        }
      }
    };
    visitProfileEditors(profileEditors);

    const chatEditors = await createChatNode({ configurationMode: 'profile' }).getEditors({} as any);
    const chatGroups = chatEditors
      .filter((editor): editor is Extract<typeof editor, { type: 'group' }> => editor.type === 'group')
      .map((editor) => editor.label);
    assert.deepEqual(chatGroups, ['Response format', 'Tools', 'Outputs', 'Error behavior']);
  });

  it('does not render an empty Reasoning group for Custom provider profiles', async () => {
    const profileEditors = await createProfileNode({ provider: 'custom' }).getEditors({} as any);

    assert.ok(
      !profileEditors.some((editor) => editor.type === 'group' && editor.label === 'Reasoning'),
      'Custom profiles have no provider-specific reasoning controls.',
    );

    const chatEditors = await createChatNode({ configurationMode: 'profile', provider: 'custom' }).getEditors(
      {} as any,
    );
    const outputsGroup = chatEditors.find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;
    assert.equal(
      outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputReasoning')?.label,
      'Output reasoning',
    );
  });

  it('keeps inline LLM Chat behavior unchanged and replaces only inference configuration in profile mode', async () => {
    const profileNode = createProfileNode({
      provider: 'openai',
      model: 'gpt-profile',
      apiKeySource: 'input',
      temperature: 0.15,
      maxTokens: 777,
      openAIPreviousResponseId: 'response-from-profile',
      enableOpenAIWebSearch: true,
    });
    const profileOutput = await profileNode.process(
      {
        apiKey: { type: 'string', value: 'profile-openai-secret' },
      } as any,
      createRuntimeContext(),
    );
    const chatNode = createChatNode({
      configurationMode: 'profile',
      provider: 'custom',
      model: 'stale-inline-model',
      temperature: 1.9,
      maxTokens: 12,
      openAIPreviousResponseId: 'response-from-chat',
      outputReasoning: true,
      cache: true,
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: chatNode.data,
      nodeId: chatNode.chartNode.id,
      inputs: {
        llmProfile: profileOutput.profile!,
        prompt: { type: 'string', value: 'Hello' },
      } as any,
      context: createRuntimeContext(),
    });

    assert.equal(runtime.runOptions.provider, 'openai');
    assert.equal(runtime.runOptions.modelId, 'gpt-profile');
    assert.equal(runtime.runOptions.temperature, 0.15);
    assert.equal(runtime.runOptions.maxTokens, 777);
    assert.equal(runtime.runOptions.outputReasoning, true);
    assert.equal(runtime.runOptions.includeFunctionCalls, false);
    assert.match(JSON.stringify(runtime.runOptions.providerOptions), /response-from-profile/);
    assert.doesNotMatch(JSON.stringify(runtime.runOptions.providerOptions), /response-from-chat/);
    assert.doesNotMatch(runtime.cacheKey!, /profile-openai-secret/);
    assert.doesNotMatch(runtime.cacheKey!, /stale-inline-model/);
  });

  it('does not add Tool Calls output when From profile mode has Tool use off', async () => {
    const profileNode = createProfileNode({
      provider: 'openai',
      model: 'gpt-profile',
      apiKeySource: 'input',
    });
    const profileOutput = await profileNode.process(
      {
        apiKey: { type: 'string', value: 'profile-openai-secret' },
      } as any,
      createRuntimeContext(),
    );
    const chatNode = createChatNode({
      configurationMode: 'profile',
      useToolCalling: false,
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: chatNode.data,
      nodeId: chatNode.chartNode.id,
      inputs: {
        llmProfile: profileOutput.profile!,
        prompt: { type: 'string', value: 'Hello' },
      } as any,
      context: createRuntimeContext(),
    });

    assert.equal(runtime.runOptions.includeFunctionCalls, false);
    assert.ok(!chatNode.getOutputDefinitions().some((output) => output.id === ('function-calls' as any)));
  });

  it('requires a valid profile input and removes stale inline configuration ports', async () => {
    const chatNode = createChatNode({
      configurationMode: 'profile',
      provider: 'custom',
      apiKeySource: 'input',
      useModelInput: true,
      useTemperatureInput: true,
      useCustomProviderBaseURLInput: true,
      useHeadersInput: true,
      useExtraProviderOptionsInput: true,
      useOpenAIPreviousResponseIdInput: true,
    });
    const inputIds = chatNode.getInputDefinitions().map((input) => input.id);

    assert.equal(inputIds[0], 'llmProfile');
    for (const stalePort of [
      'model',
      'temperature',
      'apiKey',
      'customProviderBaseURL',
      'headers',
      'extraProviderOptions',
      'previousResponseId',
    ]) {
      assert.ok(!inputIds.includes(stalePort as any));
    }
    assert.ok(!chatNode.getOutputDefinitions().some((output) => output.id === ('function-calls' as any)));

    await assert.rejects(
      resolveLLMChatV2RuntimeConfig({
        data: chatNode.data,
        nodeId: chatNode.chartNode.id,
        inputs: {
          prompt: { type: 'string', value: 'Hello' },
        } as any,
        context: createRuntimeContext(),
      }),
      /LLM Profile input is required/,
    );
  });
});
