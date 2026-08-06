import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LLMChatV2NodeImpl, LLMProfileNodeImpl, type LLMChatV2Node, type LLMProfileNode } from '../../../src/index.js';
import { llmChatV2ProfileDataKeys } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import {
  llmProfileBooleanDataKeys,
  llmProfileOptionalNumberDataKeys,
  llmProfileRequiredNumberDataKeys,
  llmProfileResolvedInputToggleDataKeys,
  llmProfileStringDataKeys,
} from '../../../src/model/chat-v2/llmProfileFieldRegistry.js';
import { normalizeLLMProfileValue } from '../../../src/model/chat-v2/llmProfile.js';
import { getLLMProfileBodySections } from '../../../src/model/chat-v2/llmProfileBody.js';
import { llmProfileInputIds } from '../../../src/model/chat-v2/llmProfileTypes.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';

function getMarkdownBodyText(node: LLMProfileNodeImpl): string {
  const body = node.getBody();
  assert.equal(typeof body, 'object');
  assert.equal(body.type, 'markdown');
  return body.text;
}

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
    assert.equal(node.data.customProviderApi, 'completions');
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

  it('renders every configured profile setting and parameter in its canvas body', () => {
    const body = getMarkdownBodyText(
      createProfileNode({
        provider: 'custom',
        customProviderApi: 'responses',
        model: 'custom-model',
        apiKeySource: 'input',
        customProviderBaseURL: 'https://example.test/v1/responses',
        useCustomProviderBaseURLInput: true,
        useModelInput: true,
        useTemperatureInput: true,
        useMaxTokensInput: true,
        topP: 0.75,
        topK: 42,
        presencePenalty: 0.2,
        frequencyPenalty: -0.1,
        stopSequences: ['END', 'STOP'],
        seed: 123,
        headers: [{ key: 'x-project', value: 'alpha' }],
        extraProviderOptions: '{"reasoning_effort":"high"}',
      }),
    );

    for (const expectedLine of [
      'Provider:</span> Custom Responses',
      'Base URL:</span> \\(Using Input\\)',
      'Model:</span> \\(Using Input\\)',
      'API key source:</span> Input port',
      'Temperature:</span> \\(Using Input\\)',
      'Max output tokens:</span> \\(Using Input\\)',
      'Top P:</span> 0\\.75',
      'Top K:</span> 42',
      'Presence penalty:</span> 0\\.2',
      'Frequency penalty:</span> \\-0\\.1',
      'Stop sequences:</span> &quot;END&quot;, &quot;STOP&quot;',
      'Seed:</span> 123',
      'Headers:</span> x\\-project: alpha',
    ]) {
      assert.ok(body.includes(expectedLine), `Missing profile body line: ${expectedLine}`);
    }
    assert.ok(body.includes('Extra provider options:</span> '));
    assert.ok(body.includes('\\{&quot;reasoning\\_effort&quot;:&quot;high&quot;\\}'));
  });

  it('keeps configured extra provider options as an unmodified body snippet', () => {
    const options = '{\n  "foo": "bar"\n}';
    const sections = getLLMProfileBodySections(
      createProfileNode({
        provider: 'custom',
        extraProviderOptions: options,
      }).data,
    );

    const advancedSection = sections.find((section) => section.id === 'advanced');
    assert.equal(advancedSection?.snippet?.label, 'Extra provider options');
    assert.equal(advancedSection?.snippet?.text, options);
  });

  it('renders enabled provider-native settings in its canvas body', () => {
    const body = getMarkdownBodyText(
      createProfileNode({
        provider: 'openai',
        openAIPreviousResponseId: 'resp_123',
        openAIReasoningEffort: 'high',
        openAIReasoningSummary: 'detailed',
        enableOpenAIWebSearch: true,
        openAIWebSearchContextSize: 'high',
        enableOpenAICodeInterpreter: true,
      }),
    );

    for (const expectedLine of [
      'Previous response ID:</span> resp\\_123',
      'Reasoning effort:</span> High',
      'Reasoning summary:</span> detailed',
      'Web search:</span> Enabled \\(High\\)',
      'Code interpreter:</span> Enabled',
    ]) {
      assert.ok(body.includes(expectedLine), `Missing profile body line: ${expectedLine}`);
    }
  });

  it('renders configured Anthropic and Google capability settings in its canvas body', () => {
    const anthropicBody = getMarkdownBodyText(
      createProfileNode({
        provider: 'anthropic',
        anthropicThinkingMode: 'enabled',
        anthropicEffort: 'max',
        anthropicThinkingBudget: 4096,
        anthropicCacheControlTtl: '1h',
      }),
    );
    const googleBody = getMarkdownBodyText(
      createProfileNode({
        provider: 'google',
        googleThinkingLevel: 'high',
        useGoogleThinkingBudgetInput: true,
        googleIncludeThoughts: true,
        enableGoogleSearchGrounding: true,
        enableGoogleUrlContext: true,
      }),
    );

    for (const expectedLine of [
      'Thinking mode:</span> Enabled',
      'Effort:</span> Max',
      'Thinking budget:</span> 4096',
      'Cache breakpoint TTL:</span> 1 hour',
    ]) {
      assert.ok(anthropicBody.includes(expectedLine), `Missing Anthropic profile body line: ${expectedLine}`);
    }
    for (const expectedLine of [
      'Thinking level:</span> High',
      'Thinking budget:</span> \\(Using Input\\)',
      'Include thoughts:</span> Enabled',
      'Google search grounding:</span> Enabled',
      'URL context:</span> Enabled',
    ]) {
      assert.ok(googleBody.includes(expectedLine), `Missing Google profile body line: ${expectedLine}`);
    }
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

  it('keeps profile validation categories within the canonical profile-field contract', () => {
    const profileFields = new Set(llmChatV2ProfileDataKeys);
    const validationFields = [
      ...llmProfileStringDataKeys,
      ...llmProfileBooleanDataKeys,
      ...llmProfileRequiredNumberDataKeys,
      ...llmProfileOptionalNumberDataKeys,
      ...llmProfileResolvedInputToggleDataKeys,
    ];

    assert.ok(validationFields.every((field) => profileFields.has(field)));
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
    delete legacyData.customProviderApi;
    const node = new LLMProfileNodeImpl({
      ...legacyNode,
      data: legacyData as LLMProfileNode['data'],
    });

    const result = await node.process({}, createRuntimeContext());
    const profile = normalizeLLMProfileValue(result.profile?.value);

    assert.equal(profile.configuration.openAIPreviousResponseId, '');
    assert.equal(profile.configuration.useOpenAIPreviousResponseIdInput, false);
    assert.equal(profile.configuration.customProviderApi, 'completions');
  });

  it('rejects a corrupt Custom API mode at the profile node boundary', async () => {
    const node = createProfileNode({
      provider: 'custom',
      customProviderApi: 'response' as any,
    });

    assert.ok(getMarkdownBodyText(node).includes('Provider:</span> Custom \\(response\\)'));
    await assert.rejects(() => node.process({}, createRuntimeContext()), /Unsupported Custom provider API: response/);
  });

  it('keeps the canvas body renderable for malformed legacy optional values', () => {
    const node = createProfileNode({
      provider: 'custom',
      headers: undefined as any,
      stopSequences: [42] as any,
      extraProviderOptions: { malformed: true } as any,
    });

    assert.doesNotThrow(() => getMarkdownBodyText(node));
  });

  it('resolves input-driven settings and embeds the resolved API key in the profile value', async () => {
    const node = createProfileNode({
      provider: 'custom',
      customProviderApi: 'responses',
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
    assert.equal(profile.configuration.customProviderApi, 'responses');
    assert.deepEqual(profile.configuration.headers, [{ key: 'x-runtime', value: 'enabled' }]);
    assert.deepEqual(JSON.parse(profile.configuration.extraProviderOptions), {
      custom: { mode: 'fast' },
    });
    assert.equal(profile.configuration.useModelInput, false);
    assert.equal(profile.configuration.useTemperatureInput, false);
    assert.equal(profile.configuration.useHeadersInput, false);
  });

  it('represents intentional keyless and header-authenticated Custom profiles without inventing credentials', async () => {
    const common = {
      provider: 'custom' as const,
      customProviderApi: 'responses' as const,
      model: 'local-model',
      customProviderBaseURL: 'https://local.example.test/v1/responses?route=local',
      customProviderApiKeyProgrammaticName: '',
      customProviderApiKeyEnvVarName: '',
    };
    const keylessResult = await createProfileNode(common).process({}, createRuntimeContext());
    const headerResult = await createProfileNode({
      ...common,
      headers: [{ key: 'Authorization', value: 'Token explicit-secret' }],
    }).process({}, createRuntimeContext());
    const keyless = normalizeLLMProfileValue(keylessResult.profile?.value);
    const headerAuthenticated = normalizeLLMProfileValue(headerResult.profile?.value);

    assert.deepEqual(keyless.credential, { reference: { source: 'none' } });
    assert.equal(keyless.configuration.customProviderApi, 'responses');
    assert.equal(headerAuthenticated.credential.value, undefined);
    assert.deepEqual(headerAuthenticated.configuration.headers, [
      { key: 'Authorization', value: 'Token explicit-secret' },
    ]);
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
    // The profile enables OpenAI web search, so legacy editor replay is unsafe
    // even though the Chat node itself still has its old cache flag enabled.
    assert.equal(runtime.cacheKey, undefined);
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
