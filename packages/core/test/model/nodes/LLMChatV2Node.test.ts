import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type LLMChatV2Node, LLMChatV2NodeImpl } from '../../../src/index.js';
import {
  createsLLMChatV2ToolResponseFormatConflictForEdit,
  hasLLMChatV2ToolResponseFormatConflict,
  LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY,
} from '../../../src/model/chat-v2/chatV2FeatureCompatibility.js';
import {
  buildLLMChatV2EditorCacheKey,
  resolveLLMChatV2RuntimeProviderOptions,
} from '../../../src/model/nodes/LLMChatV2Node.js';
import { resolveLLMChatV2ApiKey } from '../../../src/model/chat-v2/chatV2RuntimeOptions.js';
import {
  cloneLLMChatV2EditorCacheOutputs,
  resolveLLMChatV2RuntimeConfig,
} from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';

function createNode(data: Partial<LLMChatV2Node['data']> = {}) {
  return new LLMChatV2NodeImpl({
    ...LLMChatV2NodeImpl.create(),
    data: {
      ...LLMChatV2NodeImpl.create().data,
      ...data,
    },
  });
}

function getMarkdownBody(node: LLMChatV2NodeImpl) {
  const body = node.getBody();
  assert.equal(typeof body, 'object');
  assert.ok(body != null);
  assert.equal(Array.isArray(body), false);
  assert.equal(body.type, 'markdown');
  return body;
}

function getMarkdownBodyText(node: LLMChatV2NodeImpl) {
  const body = getMarkdownBody(node);
  return body.text;
}

function createRuntimeContext(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      openAiKey: 'env-openai-key',
      openAiEndpoint: 'https://api.openai.test/v1/responses',
      openAiOrganization: '',
      chatNodeHeaders: {},
    },
    getPluginConfig: (key: string) => {
      if (key === 'anthropicApiKey') {
        return 'env-anthropic-key';
      }

      if (key === 'googleApiKey') {
        return 'env-google-key';
      }

      return '';
    },
    editorExecutionCache: new Map<string, unknown>(),
    ...overrides,
  } as any;
}

function createRuntimeContextWithPluginEnv(pluginEnv: Record<string, string>) {
  const context = createRuntimeContext();
  return createRuntimeContext({
    settings: {
      ...context.settings,
      pluginEnv,
    },
  });
}

function createPromptInputs(inputs: Record<string, unknown> = {}) {
  return {
    prompt: { type: 'string', value: 'Hello' },
    ...inputs,
  } as any;
}

function getCacheProviderConfig(runtime: Awaited<ReturnType<typeof resolveLLMChatV2RuntimeConfig>>) {
  assert.ok(runtime.cacheKey);
  return JSON.parse(runtime.cacheKey!).providerConfig;
}

describe('LLMChatV2NodeImpl', () => {
  it('creates the unified chat node', () => {
    const node = LLMChatV2NodeImpl.create();

    assert.equal(node.type, 'llmChatV2');
    assert.equal(node.title, 'LLM Chat');
    assert.equal(node.data.provider, 'openai');
    assert.equal(node.data.apiKeySource, 'environment');
    assert.equal(node.data.customProviderApiKeyProgrammaticName, '');
    assert.equal(node.data.customProviderApiKeyEnvVarName, 'CUSTOM_PROVIDER_API_KEY');
    assert.equal(node.data.customProviderBaseURL, '');
    assert.equal(node.data.useCustomProviderBaseURLInput, false);
    assert.equal(node.data.baseURL, '');
    assert.equal(node.data.useBaseURLInput, false);
    assert.equal(node.data.extraProviderOptions, '');
    assert.equal(node.data.useExtraProviderOptionsInput, false);
    assert.equal(node.data.useToolCalling, false);
    assert.equal(node.data.outputReasoning, false);
    assert.equal(node.data.topP, undefined);
    assert.equal(node.data.useTopPInput, false);
    assert.equal(node.data.presencePenalty, undefined);
    assert.equal(node.data.usePresencePenaltyInput, false);
    assert.equal(node.data.frequencyPenalty, undefined);
    assert.equal(node.data.useFrequencyPenaltyInput, false);
    assert.deepEqual(node.data.stopSequences, []);
    assert.equal(node.data.useStopSequencesInput, false);
    assert.equal(node.data.seed, undefined);
    assert.equal(node.data.useSeedInput, false);
    assert.equal(node.data.responseFormat, '');
    assert.equal(node.data.responseSchemaName, '');
    assert.equal(node.data.useResponseSchemaNameInput, false);
    assert.equal(node.data.responseSchemaDescription, '');
    assert.equal(node.data.useResponseSchemaDescriptionInput, false);
    assert.equal(node.data.anthropicThinkingMode, '');
    assert.equal(node.data.anthropicThinkingBudget, undefined);
    assert.equal(node.data.useAnthropicThinkingBudgetInput, false);
    assert.equal(node.data.anthropicEffort, '');
    assert.equal(node.data.googleThinkingBudget, undefined);
    assert.equal(node.data.useGoogleThinkingBudgetInput, false);
    assert.equal(node.data.googleThinkingLevel, '');
    assert.equal(node.data.googleIncludeThoughts, false);
    assert.equal(node.data.toolChoice, '');
    assert.equal(node.data.toolChoiceFunction, '');
    assert.equal(node.data.parallelToolCalls, false);
    assert.equal(node.data.autoContinueToolCalls, false);
    assert.equal(node.data.maxToolRounds, 3);
    assert.equal(node.data.retryOnNon200, false);
    assert.equal(node.data.retryOnNon200RepeatTimes, 1);
    assert.equal(node.data.retryOnNon200CooldownMs, 0);
    assert.equal(node.data.outputRequestStatus, false);
    assert.equal(node.data.outputRequestError, false);
    assert.equal(node.data.outputRequestBody, false);
    assert.equal(node.data.outputResponseBody, false);
  });

  it('uses the dedicated configuration editor so Inline settings can be exported to a profile', async () => {
    const node = createNode();
    const editors = await node.getEditors({});

    assert.deepEqual(editors[0], {
      type: 'custom',
      label: 'Configuration',
      customEditorId: 'LLMChatV2Configuration',
    });
  });

  it('adds an API key input only when the Model section is set to input port', async () => {
    const defaultNode = createNode();
    const inputNode = createNode({
      apiKeySource: 'input',
    });

    const defaultInputs = defaultNode.getInputDefinitions();
    const inputPort = inputNode.getInputDefinitions().find((input) => input.id === 'apiKey');
    const editors = await inputNode.getEditors({});
    const modelGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Model') as any;
    const apiKeySourceEditor = modelGroup.editors.find((editor: any) => editor.dataKey === 'apiKeySource');

    assert.ok(!defaultInputs.some((input) => input.id === 'apiKey'));
    assert.deepEqual(inputPort, {
      id: 'apiKey',
      title: 'API Key',
      dataType: 'string',
      required: false,
    });
    assert.equal(apiKeySourceEditor?.type, 'segmented');
    assert.equal(apiKeySourceEditor?.label, 'API key source');
    assert.deepEqual(apiKeySourceEditor?.options, [
      { value: 'environment', label: 'Configured key' },
      { value: 'input', label: 'Input port' },
    ]);
    assert.equal(typeof apiKeySourceEditor?.helperMessage, 'function');
    assert.equal(
      apiKeySourceEditor.helperMessage(defaultNode.data),
      'Configured key uses Settings > LLM > OpenAI API Key in the Rivet editor, with OPENAI_API_KEY as a desktop/Node fallback. Programmatic runs can pass openAiApiKey or set OPENAI_API_KEY.',
    );
    assert.equal(
      apiKeySourceEditor.helperMessage(inputNode.data),
      'Uses the API Key input port instead of a configured provider key.',
    );
    assert.equal(
      apiKeySourceEditor.helperMessage(createNode({ provider: 'anthropic' }).data),
      'Configured key uses Settings > LLM > Anthropic API Key in the Rivet editor, with ANTHROPIC_API_KEY as a desktop/Node fallback. Programmatic runs can pass anthropicApiKey or set ANTHROPIC_API_KEY.',
    );
  });

  it('exposes Custom provider as an OpenAI-compatible provider mode', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
    });

    const editors = await node.getEditors({
      getChatModelOptions: async () => {
        throw new Error('Custom provider should not request a model catalog.');
      },
    } as any);
    const modelGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Model') as any;
    const providerEditor = modelGroup.editors.find((editor: any) => editor.dataKey === 'provider');
    const modelEditor = modelGroup.editors.find((editor: any) => editor.customEditorId === 'LLMChatV2ModelCatalog');
    const programmaticKeyEditor = modelGroup.editors.find(
      (editor: any) => editor.dataKey === 'customProviderApiKeyProgrammaticName',
    );
    const envVarEditor = modelGroup.editors.find((editor: any) => editor.dataKey === 'customProviderApiKeyEnvVarName');
    const customBaseUrlEditor = modelGroup.editors.find((editor: any) => editor.dataKey === 'customProviderBaseURL');
    const providerAdvancedGroup = editors.find(
      (editor) => editor.type === 'group' && editor.label === 'Provider Advanced',
    ) as any;
    const extraProviderOptionsEditor = providerAdvancedGroup.editors.find(
      (editor: any) => editor.dataKey === 'extraProviderOptions',
    );

    assert.deepEqual(
      modelGroup.editors.map((editor: any) => editor.dataKey ?? editor.customEditorId),
      [
        'provider',
        'customProviderBaseURL',
        'LLMChatV2ModelCatalog',
        'apiKeySource',
        'customProviderApiKeyProgrammaticName',
        'customProviderApiKeyEnvVarName',
      ],
    );
    assert.ok(
      providerEditor.options.some((option: any) => option.value === 'custom' && option.label === 'Custom provider'),
    );
    assert.deepEqual(modelEditor.data.modelOptions, [{ value: 'llama-custom', label: 'llama-custom' }]);
    assert.equal(programmaticKeyEditor.label, 'Alternative programmatic key name');
    assert.equal(
      programmaticKeyEditor.helperMessage,
      'If set, programmatic runs read this named run option instead of the shared customAiApiKey.',
    );
    assert.equal(programmaticKeyEditor.hideIf({ provider: 'custom', apiKeySource: 'environment' }), false);
    assert.equal(programmaticKeyEditor.hideIf({ provider: 'custom', apiKeySource: 'input' }), true);
    assert.equal(envVarEditor.label, 'Alternative API key env var');
    assert.equal(envVarEditor.helperMessage, 'If set, this env var is used instead of CUSTOM_PROVIDER_API_KEY.');
    assert.equal(envVarEditor.hideIf({ provider: 'custom', apiKeySource: 'environment' }), false);
    assert.equal(envVarEditor.hideIf({ provider: 'custom', apiKeySource: 'input' }), true);
    assert.equal(
      modelGroup.editors
        .find((editor: any) => editor.dataKey === 'apiKeySource')
        .helperMessage({
          ...node.data,
          customProviderApiKeyProgrammaticName: 'makoraApiKey',
          customProviderApiKeyEnvVarName: 'MAKORA_API_KEY',
        }),
      'Configured key checks makoraApiKey, then MAKORA_API_KEY env var, then Settings > LLM > Custom provider API key.',
    );
    assert.equal(
      modelGroup.editors.find((editor: any) => editor.dataKey === 'apiKeySource').helperMessage(node.data),
      'Configured key checks CUSTOM_PROVIDER_API_KEY env var, then Settings > LLM > Custom provider API key. Programmatic runs can pass the shared customAiApiKey.',
    );
    assert.equal(customBaseUrlEditor.label, 'Provider base URL');
    assert.equal(customBaseUrlEditor.useInputToggleDataKey, 'useCustomProviderBaseURLInput');
    assert.equal(customBaseUrlEditor.hideIf({ provider: 'custom' }), false);
    assert.equal(
      providerAdvancedGroup.editors.some((editor: any) => editor.dataKey === 'baseURL'),
      false,
    );
    assert.equal(extraProviderOptionsEditor.type, 'code');
    assert.equal(extraProviderOptionsEditor.language, 'json');
    assert.equal(extraProviderOptionsEditor.useInputToggleDataKey, 'useExtraProviderOptionsInput');
    assert.match(extraProviderOptionsEditor.helperMessage, /providerOptions/);
  });

  it('shows the custom provider base URL in the node body', () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
    });

    assert.equal(
      getMarkdownBodyText(node),
      [
        '<span style="opacity: 0.55">Provider:</span> Custom',
        '<span style="opacity: 0.55">Base URL:</span> https://api\\.cerebras\\.ai/v1',
        '<span style="opacity: 0.55">Model:</span> llama\\-custom',
        '<span style="opacity: 0.55">Temperature:</span> 0\\.5',
        '<span style="opacity: 0.55">Max output tokens:</span> 1024',
      ].join('\n'),
    );
  });

  it('breaks custom provider base URL autolinks in the markdown node body', () => {
    const body = getMarkdownBody(
      createNode({
        provider: 'custom',
        customProviderBaseURL: 'https://api.cerebras.ai/v1',
      }),
    );

    assert.equal(body.disableLinks, true);
    assert.match(body.text, /Base URL:<\/span> https:\/\/api\\\.cerebras\\\.ai\/v1/);
  });

  it('labels provider and model in the node body', () => {
    assert.match(
      getMarkdownBodyText(createNode({ provider: 'openai', model: 'custom-openai-model' })),
      /^<span style="opacity: 0\.55">Provider:<\/span> OpenAI\n<span style="opacity: 0\.55">Model:<\/span> custom\\-openai\\-model/m,
    );
    assert.match(
      getMarkdownBodyText(createNode({ provider: 'anthropic', model: 'custom-anthropic-model' })),
      /^<span style="opacity: 0\.55">Provider:<\/span> Anthropic\n<span style="opacity: 0\.55">Model:<\/span> custom\\-anthropic\\-model/m,
    );
  });

  it('escapes node body values before rendering markdown labels', () => {
    assert.ok(
      getMarkdownBodyText(createNode({ provider: 'custom', model: 'model_<script>_[x]\nnext' })).includes(
        'Model:</span> model\\_&lt;script&gt;\\_\\[x\\]\\\\nnext',
      ),
    );
  });

  it('shows when the custom provider base URL comes from an input port', () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      useCustomProviderBaseURLInput: true,
    });

    const body = getMarkdownBodyText(node);
    assert.match(body, /<span style="opacity: 0\.55">Base URL:<\/span> \\\(Using Input\\\)/);
    assert.doesNotMatch(body, /api\.cerebras/);
  });

  it('shows configured generation parameters in the node body', () => {
    const body = getMarkdownBodyText(
      createNode({
        topP: 0.75,
        topK: 40,
        presencePenalty: 0.2,
        frequencyPenalty: -0.1,
        stopSequences: ['END', '', 'STOP'],
        seed: 1234,
      }),
    );

    assert.match(body, /<span style="opacity: 0\.55">Top P:<\/span> 0\\\.75/);
    assert.match(body, /<span style="opacity: 0\.55">Top K:<\/span> 40/);
    assert.match(body, /<span style="opacity: 0\.55">Presence penalty:<\/span> 0\\\.2/);
    assert.match(body, /<span style="opacity: 0\.55">Frequency penalty:<\/span> \\\-0\\\.1/);
    assert.match(body, /<span style="opacity: 0\.55">Stop sequences:<\/span> &quot;END&quot;, &quot;STOP&quot;/);
    assert.match(body, /<span style="opacity: 0\.55">Seed:<\/span> 1234/);
  });

  it('shows input-driven generation parameters in the node body', () => {
    const body = getMarkdownBodyText(
      createNode({
        topK: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        useTopPInput: true,
        useTopKInput: true,
        usePresencePenaltyInput: true,
        useFrequencyPenaltyInput: true,
        useStopSequencesInput: true,
        useSeedInput: true,
      }),
    );

    assert.match(body, /<span style="opacity: 0\.55">Top P:<\/span> \\\(Using Input\\\)/);
    assert.match(body, /<span style="opacity: 0\.55">Top K:<\/span> \\\(Using Input\\\)/);
    assert.match(body, /<span style="opacity: 0\.55">Presence penalty:<\/span> \\\(Using Input\\\)/);
    assert.match(body, /<span style="opacity: 0\.55">Frequency penalty:<\/span> \\\(Using Input\\\)/);
    assert.match(body, /<span style="opacity: 0\.55">Stop sequences:<\/span> \\\(Using Input\\\)/);
    assert.match(body, /<span style="opacity: 0\.55">Seed:<\/span> \\\(Using Input\\\)/);
  });

  it('shows built-in provider reasoning effort in the node body', () => {
    assert.match(getMarkdownBodyText(createNode()), /<span style="opacity: 0\.55">Reasoning effort:<\/span> Default/);
    assert.match(
      getMarkdownBodyText(createNode({ provider: 'openai', openAIReasoningEffort: 'high' })),
      /<span style="opacity: 0\.55">Reasoning effort:<\/span> High/,
    );
    assert.match(
      getMarkdownBodyText(createNode({ provider: 'anthropic', anthropicEffort: 'max' })),
      /<span style="opacity: 0\.55">Reasoning effort:<\/span> Max/,
    );
    assert.match(
      getMarkdownBodyText(createNode({ provider: 'google', googleThinkingLevel: 'minimal' })),
      /<span style="opacity: 0\.55">Reasoning effort:<\/span> Minimal/,
    );
    assert.doesNotMatch(getMarkdownBodyText(createNode({ provider: 'custom' })), /Reasoning effort:/);
  });

  it('places error behavior after all LLM settings sections and retires editor cache', async () => {
    const node = createNode();
    const editors = await node.getEditors({});
    const groupLabels = editors.filter((editor) => editor.type === 'group').map((editor) => editor.label);
    const outputsGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;
    const errorBehaviorGroup = editors.at(-1) as any;

    assert.deepEqual(groupLabels, [
      'Model',
      'OpenAI',
      'Anthropic',
      'Google',
      'Parameters',
      'Reasoning',
      'Response format',
      'Tools',
      'Outputs',
      'Provider Advanced',
      'Error behavior',
    ]);
    assert.equal(errorBehaviorGroup.label, 'Error behavior');
    assert.equal(errorBehaviorGroup.editors[0]?.dataKey, 'retryOnNon200');
    assert.equal(errorBehaviorGroup.editors[1]?.dataKey, 'retryOnNon200RepeatTimes');
    assert.equal(errorBehaviorGroup.editors[1]?.hideIf({ retryOnNon200: false }), true);
    assert.equal(errorBehaviorGroup.editors[1]?.hideIf({ retryOnNon200: true }), false);
    assert.equal(errorBehaviorGroup.editors[2]?.dataKey, 'retryOnNon200CooldownMs');
    assert.equal(errorBehaviorGroup.editors[3]?.dataKey, 'outputRequestError');
    assert.equal(
      outputsGroup.editors.some((editor: any) => editor.dataKey === 'outputRequestStatus'),
      true,
    );
    assert.equal(
      outputsGroup.editors.some((editor: any) => editor.dataKey === 'outputRequestBody'),
      true,
    );
    assert.equal(
      outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputRequestBody')?.label,
      'Output request body',
    );
    assert.equal(
      outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputResponseBody')?.label,
      'Output response body',
    );
    const legacyCacheEditor = outputsGroup.editors.find((editor: any) => editor.dataKey === 'cache');
    assert.equal(legacyCacheEditor.label, 'Cache outputs (editor only) (legacy)');
    assert.equal(legacyCacheEditor.hideIf({ cache: false }), true);
    assert.equal(legacyCacheEditor.hideIf({ cache: true }), false);
  });

  it('adds independent request diagnostic outputs only when their controls are on', () => {
    const defaultNode = createNode();
    const statusNode = createNode({
      outputRequestStatus: true,
    });
    const retryStatusNode = createNode({
      outputRequestStatus: true,
      retryOnNon200: true,
    });
    const errorNode = createNode({
      outputRequestError: true,
    });
    const bodyNode = createNode({
      outputRequestBody: true,
    });
    const responseBodyNode = createNode({
      outputResponseBody: true,
    });
    const profileStatusNode = createNode({
      configurationMode: 'profile',
      outputRequestStatus: true,
    });

    assert.ok(!defaultNode.getOutputDefinitions().some((output) => output.id === 'requestStatus'));
    assert.ok(!defaultNode.getOutputDefinitions().some((output) => output.id === 'requestError'));
    assert.ok(!defaultNode.getOutputDefinitions().some((output) => output.id === 'requestBody'));
    assert.ok(!defaultNode.getOutputDefinitions().some((output) => output.id === 'responseBody'));
    assert.deepEqual(
      statusNode.getOutputDefinitions().find((output) => output.id === 'requestStatus'),
      {
        id: 'requestStatus',
        title: 'Response Status',
        dataType: 'number',
      },
    );
    assert.deepEqual(
      retryStatusNode.getOutputDefinitions().find((output) => output.id === 'requestStatus'),
      {
        id: 'requestStatus',
        title: 'Response Status',
        dataType: 'number[]',
      },
    );
    assert.deepEqual(
      statusNode.getOutputDefinitions().find((output) => output.id === 'requestError'),
      undefined,
    );
    assert.deepEqual(
      retryStatusNode.getOutputDefinitions().find((output) => output.id === 'requestError'),
      undefined,
    );
    assert.deepEqual(
      errorNode.getOutputDefinitions().find((output) => output.id === 'requestError'),
      {
        id: 'requestError',
        title: 'Response Error',
        dataType: 'string',
      },
    );
    assert.deepEqual(
      profileStatusNode.getOutputDefinitions().find((output) => output.id === 'requestStatus'),
      {
        id: 'requestStatus',
        title: 'Response Status',
        dataType: ['number', 'number[]', 'any'],
        description:
          'A scalar profile keeps the normal status shape. An LLM Profile array groups values by profile: one request is a number, retries are a number array.',
      },
    );
    assert.deepEqual(
      bodyNode.getOutputDefinitions().find((output) => output.id === 'requestBody'),
      {
        id: 'requestBody',
        title: 'LLM request body',
        dataType: ['object', 'object[]', 'string', 'string[]', 'any', 'any[]'],
      },
    );
    assert.deepEqual(
      responseBodyNode.getOutputDefinitions().find((output) => output.id === 'responseBody'),
      {
        id: 'responseBody',
        title: 'LLM response body',
        dataType: ['object', 'object[]', 'string', 'string[]', 'any', 'any[]'],
      },
    );
    const bothBodyNode = createNode({
      outputRequestBody: true,
      outputResponseBody: true,
    });
    const bothBodyOutputIds = bothBodyNode.getOutputDefinitions().map((output) => output.id);
    assert.equal(
      bothBodyOutputIds.indexOf('responseBody'),
      bothBodyOutputIds.indexOf('requestBody') + 1,
      'LLM response body follows LLM request body in the node output contract.',
    );
    assert.equal(
      retryStatusNode.getOutputDefinitions().some((output) => output.id === 'requestStatuses'),
      false,
    );
    assert.equal(
      retryStatusNode.getOutputDefinitions().some((output) => output.id === 'requestErrors'),
      false,
    );
    assert.equal(
      errorNode.getOutputDefinitions().some((output) => output.id === 'requestStatus'),
      false,
    );
    assert.equal(
      bodyNode.getOutputDefinitions().some((output) => output.id === 'requestStatus'),
      false,
    );
    assert.equal(
      bodyNode.getOutputDefinitions().some((output) => output.id === 'requestError'),
      false,
    );
    assert.equal(
      defaultNode.getOutputDefinitions().some((output) => output.id === 'responseTokens'),
      false,
    );
  });

  it('marks JSON object output as structured and JSON schema output as an object', () => {
    const defaultNode = createNode();
    const jsonNode = createNode({
      responseFormat: 'json',
    });
    const schemaNode = createNode({
      responseFormat: 'json_schema',
    });

    assert.equal(defaultNode.getOutputDefinitions().find((output) => output.id === 'response')?.dataType, 'string');
    assert.deepEqual(jsonNode.getOutputDefinitions().find((output) => output.id === 'response')?.dataType, [
      'object',
      'object[]',
      'any',
      'any[]',
      'string',
      'string[]',
      'number',
      'number[]',
      'boolean',
      'boolean[]',
    ]);
    assert.equal(schemaNode.getOutputDefinitions().find((output) => output.id === 'response')?.dataType, 'object');
  });

  it('adds the base URL input only for Custom provider URL fields', () => {
    const customInputNode = createNode({
      provider: 'custom',
      useCustomProviderBaseURLInput: true,
    });
    const builtInInputNode = createNode({
      provider: 'openai',
      useBaseURLInput: true,
    });

    assert.deepEqual(
      customInputNode.getInputDefinitions().find((input) => input.id === 'customProviderBaseURL'),
      {
        id: 'customProviderBaseURL',
        title: 'Provider base URL',
        dataType: 'string',
        required: false,
      },
    );
    assert.equal(
      builtInInputNode.getInputDefinitions().find((input) => input.id === 'baseURL'),
      undefined,
    );
  });

  it('adds an extra provider options input when enabled', () => {
    const defaultNode = createNode();
    const inputNode = createNode({
      useExtraProviderOptionsInput: true,
    });

    assert.ok(!defaultNode.getInputDefinitions().some((input) => input.id === 'extraProviderOptions'));
    assert.deepEqual(
      inputNode.getInputDefinitions().find((input) => input.id === 'extraProviderOptions'),
      {
        id: 'extraProviderOptions',
        title: 'Extra Provider Options',
        dataType: ['string', 'object'],
        required: false,
        coerced: true,
      },
    );
  });

  it('only adds Tool Calls output when Tool use is enabled', () => {
    const builtInToolsNode = createNode({
      provider: 'openai',
      useToolCalling: false,
      enableOpenAIWebSearch: true,
    });
    const toolUseNode = createNode({
      provider: 'openai',
      useToolCalling: true,
    });

    assert.ok(!builtInToolsNode.getOutputDefinitions().some((output) => output.id === 'function-calls'));

    const functionCalls = toolUseNode.getOutputDefinitions().find((output) => output.id === 'function-calls');

    assert.ok(functionCalls);
    assert.equal(functionCalls.title, 'Tool Calls');
    assert.equal(functionCalls?.dataType, 'object[]');
  });

  it('adds reasoning output when enabled', () => {
    const defaultNode = createNode();
    const reasoningNode = createNode({
      outputReasoning: true,
    });

    assert.ok(!defaultNode.getOutputDefinitions().some((output) => output.id === 'reasoning'));
    assert.deepEqual(
      reasoningNode.getOutputDefinitions().find((output) => output.id === 'reasoning'),
      {
        id: 'reasoning',
        title: 'Reasoning',
        dataType: ['string', 'string[]'],
      },
    );
  });

  it('exposes provider-specific thinking budget inputs only for the active provider', () => {
    const anthropicNode = createNode({
      provider: 'anthropic',
      useAnthropicThinkingBudgetInput: true,
    });
    const googleNode = createNode({
      provider: 'google',
      useGoogleThinkingBudgetInput: true,
    });

    const anthropicInputs = anthropicNode.getInputDefinitions();
    const googleInputs = googleNode.getInputDefinitions();

    assert.ok(anthropicInputs.some((input) => input.id === 'anthropicThinkingBudget'));
    assert.ok(!anthropicInputs.some((input) => input.id === 'googleThinkingBudget'));
    assert.ok(googleInputs.some((input) => input.id === 'googleThinkingBudget'));
    assert.ok(!googleInputs.some((input) => input.id === 'anthropicThinkingBudget'));
  });

  it('groups Rivet tool calling controls under Tools', async () => {
    const node = createNode({
      useToolCalling: true,
    });

    const editors = await node.getEditors({});
    const toolsGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Tools') as any;
    const outputGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;

    assert.ok(toolsGroup);
    assert.ok(outputGroup);
    const toolEditorKeys = toolsGroup.editors.map((editor: any) => editor.dataKey);

    assert.deepEqual(toolEditorKeys.slice(0, 5), [
      'useToolCalling',
      'toolChoice',
      'toolChoiceFunction',
      'parallelToolCalls',
      'autoContinueToolCalls',
    ]);
    assert.equal(toolsGroup.editors.find((editor: any) => editor.dataKey === 'useToolCalling')?.label, 'Tool use');
    assert.deepEqual(toolsGroup.editors.find((editor: any) => editor.dataKey === 'toolChoice')?.options, [
      { value: '', label: 'Default' },
      { value: 'auto', label: 'Auto' },
      { value: 'function', label: 'Specific tool' },
      { value: 'required', label: 'Required' },
    ]);
    assert.equal(toolsGroup.editors.find((editor: any) => editor.dataKey === 'toolChoiceFunction')?.label, 'Tool name');
    assert.equal(
      toolsGroup.editors.find((editor: any) => editor.dataKey === 'parallelToolCalls')?.label,
      'Allow parallel toolcalls',
    );
    assert.equal(
      toolsGroup.editors.find((editor: any) => editor.dataKey === 'parallelToolCalls')?.helperMessage,
      'Allows the model to request multiple tool calls in one round.',
    );
    assert.equal(
      toolsGroup.editors
        .find((editor: any) => editor.dataKey === 'parallelToolCalls')
        ?.hideIf({
          provider: 'custom',
          useToolCalling: true,
        }),
      false,
    );
    assert.equal(
      toolsGroup.editors
        .find((editor: any) => editor.dataKey === 'parallelToolCalls')
        ?.hideIf({
          provider: 'openai',
          useToolCalling: true,
        }),
      false,
    );
    assert.equal(
      toolsGroup.editors
        .find((editor: any) => editor.dataKey === 'parallelToolCalls')
        ?.hideIf({
          provider: 'anthropic',
          useToolCalling: true,
        }),
      false,
    );
    assert.equal(
      toolsGroup.editors
        .find((editor: any) => editor.dataKey === 'parallelToolCalls')
        ?.hideIf({
          provider: 'google',
          useToolCalling: true,
        }),
      true,
    );
    assert.equal(
      toolsGroup.editors
        .find((editor: any) => editor.dataKey === 'parallelToolCalls')
        ?.hideIf({
          provider: 'openai',
          useToolCalling: false,
        }),
      true,
    );
    assert.match(
      toolsGroup.editors.find((editor: any) => editor.dataKey === 'autoContinueToolCalls')?.helperMessage,
      /sends all tool results back to the model/,
    );
    assert.ok(toolsGroup.editors.some((editor: any) => editor.dataKey === 'toolChoice'));
    assert.ok(toolsGroup.editors.some((editor: any) => editor.dataKey === 'toolChoiceFunction'));
    assert.ok(toolsGroup.editors.some((editor: any) => editor.dataKey === 'autoContinueToolCalls'));
    assert.ok(toolsGroup.editors.some((editor: any) => editor.dataKey === 'maxToolRounds'));
    assert.equal(
      toolsGroup.editors.find((editor: any) => editor.dataKey === 'maxToolRounds')?.label,
      'Maximum tool rounds',
    );
    assert.equal(
      toolsGroup.editors.find((editor: any) => editor.dataKey === 'maxToolRounds')?.helperMessage,
      'Each round may contain multiple parallel tool calls if not disallowed.',
    );
    assert.ok(!outputGroup.editors.some((editor: any) => editor.dataKey === 'useToolCalling'));
    assert.equal(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'outputUsage')?.label,
      'Output usage details',
    );
    assert.match(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'outputUsage')?.helperMessage,
      /Vercel AI SDK usage metadata/,
    );
    assert.equal(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'outputReasoning')?.label,
      'Output reasoning',
    );
    assert.equal(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'useAsGraphPartialOutput')?.label,
      'Stream response',
    );
    assert.match(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'useAsGraphPartialOutput')?.helperMessage,
      /Other nodes only receive the final response/,
    );
    assert.equal(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'cache')?.label,
      'Cache outputs (editor only) (legacy)',
    );
    assert.match(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'cache')?.helperMessage,
      /this node's previous outputs/,
    );
    assert.match(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'cache')?.helperMessage,
      /while the Rivet app is open/,
    );
  });

  it('groups provider reasoning settings after Parameters', async () => {
    const node = createNode();

    const editors = await node.getEditors({});
    const groupLabels = editors.filter((editor) => editor.type === 'group').map((editor) => editor.label);
    const reasoningGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Reasoning') as any;
    const outputGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;
    const openAIGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'OpenAI') as any;
    const anthropicGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Anthropic') as any;
    const googleGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Google') as any;

    assert.deepEqual(groupLabels.slice(groupLabels.indexOf('Model') + 1, groupLabels.indexOf('Model') + 4), [
      'OpenAI',
      'Anthropic',
      'Google',
    ]);
    assert.equal(groupLabels.indexOf('Reasoning'), groupLabels.indexOf('Parameters') + 1);
    assert.ok(reasoningGroup);
    assert.deepEqual(
      reasoningGroup.editors.map((editor: any) => editor.dataKey),
      [
        'openAIReasoningEffort',
        'openAIReasoningSummary',
        'anthropicThinkingMode',
        'anthropicEffort',
        'anthropicThinkingBudget',
        'googleThinkingLevel',
        'googleThinkingBudget',
        'googleIncludeThoughts',
      ],
    );
    assert.match(
      outputGroup.editors.find((editor: any) => editor.dataKey === 'outputReasoning')?.helperMessage,
      /reasoning or thinking text/,
    );
    assert.equal(
      reasoningGroup.editors
        .find((editor: any) => editor.dataKey === 'openAIReasoningEffort')
        ?.hideIf({
          provider: 'openai',
        }),
      false,
    );
    assert.equal(
      reasoningGroup.editors
        .find((editor: any) => editor.dataKey === 'anthropicThinkingMode')
        ?.hideIf({
          provider: 'anthropic',
        }),
      false,
    );
    assert.deepEqual(
      reasoningGroup.editors.find((editor: any) => editor.dataKey === 'anthropicThinkingMode')?.options,
      [
        { value: '', label: 'Default' },
        { value: 'adaptive', label: 'Adaptive' },
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' },
      ],
    );
    assert.deepEqual(reasoningGroup.editors.find((editor: any) => editor.dataKey === 'anthropicEffort')?.options, [
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
    assert.equal(
      reasoningGroup.editors
        .find((editor: any) => editor.dataKey === 'googleThinkingBudget')
        ?.hideIf({
          provider: 'google',
        }),
      false,
    );
    assert.deepEqual(reasoningGroup.editors.find((editor: any) => editor.dataKey === 'googleThinkingLevel')?.options, [
      { value: '', label: 'Default' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]);
    assert.ok(!openAIGroup.editors.some((editor: any) => editor.dataKey === 'openAIReasoningEffort'));
    assert.ok(!anthropicGroup.editors.some((editor: any) => editor.dataKey === 'anthropicThinkingMode'));
    assert.ok(!googleGroup.editors.some((editor: any) => editor.dataKey === 'googleThinkingBudget'));
    assert.ok(!googleGroup.editors.some((editor: any) => editor.dataKey === 'googleStructuredOutputs'));
  });

  it('keeps Output reasoning in Outputs for Inline and From-profile configurations', async () => {
    const inlineCustomEditors = await createNode({ provider: 'custom' }).getEditors({});
    const profileEditors = await createNode({ configurationMode: 'profile' }).getEditors({});

    for (const editors of [inlineCustomEditors, profileEditors]) {
      const outputsGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;
      assert.equal(
        outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputReasoning')?.label,
        'Output reasoning',
      );
    }
    assert.ok(!inlineCustomEditors.some((editor) => editor.type === 'group' && editor.label === 'Reasoning'));
  });

  it('resolves provider-specific reasoning options in the Vercel providerOptions shape', () => {
    assert.equal(resolveLLMChatV2RuntimeProviderOptions(createNode({ provider: 'openai' }).data, {}), undefined);

    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'openai',
          openAIReasoningEffort: 'high',
          openAIReasoningSummary: 'auto',
        }).data,
        {},
      ),
      {
        openai: {
          reasoningEffort: 'high',
          reasoningSummary: 'auto',
        },
      },
    );

    assert.equal(resolveLLMChatV2RuntimeProviderOptions(createNode({ provider: 'anthropic' }).data, {}), undefined);
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'anthropic',
          anthropicThinkingMode: 'enabled',
          anthropicThinkingBudget: 12000,
          anthropicEffort: 'low',
        }).data,
        {},
      ),
      {
        anthropic: {
          effort: 'low',
          thinking: {
            type: 'enabled',
            budgetTokens: 12000,
          },
        },
      },
    );

    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'google',
          googleThinkingBudget: 8192,
          googleThinkingLevel: 'high',
          googleIncludeThoughts: true,
        }).data,
        {},
      ),
      {
        google: {
          thinkingConfig: {
            thinkingBudget: 8192,
            thinkingLevel: 'high',
            includeThoughts: true,
          },
        },
      },
    );
  });

  it('merges extra provider options into the selected Vercel provider namespace', () => {
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          extraProviderOptions: '{ "reasoningEffort": "high", "customFlag": true }',
        }).data,
        {},
      ),
      {
        custom: {
          reasoningEffort: 'high',
          customFlag: true,
        },
      },
    );

    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'openai',
          extraProviderOptions: '{ "reasoningEffort": "low", "store": false }',
          openAIReasoningEffort: 'high',
        }).data,
        {},
      ),
      {
        openai: {
          reasoningEffort: 'high',
          store: false,
        },
      },
    );
  });

  it('maps parallel tool-call controls to the selected provider without changing default Custom requests', () => {
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'openai',
          useToolCalling: true,
          parallelToolCalls: false,
          extraProviderOptions: '{ "parallelToolCalls": true, "customFlag": true }',
        }).data,
        {},
      ),
      { openai: { parallelToolCalls: false, customFlag: true } },
    );
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'openai',
          useToolCalling: true,
          parallelToolCalls: true,
        }).data,
        {},
      ),
      { openai: { parallelToolCalls: true } },
    );
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'anthropic',
          useToolCalling: true,
          parallelToolCalls: false,
          extraProviderOptions: '{ "disableParallelToolUse": false, "customFlag": true }',
        }).data,
        {},
      ),
      { anthropic: { disableParallelToolUse: true, customFlag: true } },
    );
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'anthropic',
          useToolCalling: true,
          parallelToolCalls: true,
        }).data,
        {},
      ),
      { anthropic: { disableParallelToolUse: false } },
    );
    assert.equal(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          useToolCalling: true,
          parallelToolCalls: false,
        }).data,
        {},
      ),
      undefined,
    );
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          useToolCalling: true,
          parallelToolCalls: true,
        }).data,
        {},
      ),
      { custom: { parallel_tool_calls: true } },
    );
    assert.equal(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          useToolCalling: false,
          parallelToolCalls: true,
        }).data,
        {},
      ),
      undefined,
    );
    assert.equal(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'google',
          useToolCalling: true,
          parallelToolCalls: true,
        }).data,
        {},
      ),
      undefined,
    );
  });

  it('preserves Custom provider advanced overrides until the parallel tool-call control is enabled', () => {
    const disabled = resolveLLMChatV2RuntimeProviderOptions(
      createNode({
        provider: 'custom',
        useToolCalling: true,
        parallelToolCalls: false,
        extraProviderOptions: '{ "parallel_tool_calls": false, "customFlag": true }',
      }).data,
      {},
    );
    const enabled = resolveLLMChatV2RuntimeProviderOptions(
      createNode({
        provider: 'custom',
        useToolCalling: true,
        parallelToolCalls: true,
        extraProviderOptions: '{ "parallel_tool_calls": false, "customFlag": true }',
      }).data,
      {},
    );

    assert.deepEqual(disabled, {
      custom: {
        parallel_tool_calls: false,
        customFlag: true,
      },
    });
    assert.deepEqual(enabled, {
      custom: {
        parallel_tool_calls: true,
        customFlag: true,
      },
    });
  });

  it('resolves extra provider options from an input port', () => {
    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          useExtraProviderOptionsInput: true,
          extraProviderOptions: '{ "ignored": true }',
        }).data,
        {
          extraProviderOptions: {
            type: 'string',
            value: '{ "reasoningEffort": "high", "customFlag": true }',
          },
        } as any,
      ),
      {
        custom: {
          reasoningEffort: 'high',
          customFlag: true,
        },
      },
    );

    assert.deepEqual(
      resolveLLMChatV2RuntimeProviderOptions(
        createNode({
          provider: 'custom',
          useExtraProviderOptionsInput: true,
        }).data,
        {
          extraProviderOptions: {
            type: 'object',
            value: { reasoningEffort: 'medium' },
          },
        } as any,
      ),
      {
        custom: {
          reasoningEffort: 'medium',
        },
      },
    );
  });

  it('rejects invalid extra provider options', () => {
    assert.throws(
      () =>
        resolveLLMChatV2RuntimeProviderOptions(
          createNode({
            extraProviderOptions: '{',
          }).data,
          {},
        ),
      /Extra provider options must be valid JSON/,
    );

    assert.throws(
      () =>
        resolveLLMChatV2RuntimeProviderOptions(
          createNode({
            extraProviderOptions: '[]',
          }).data,
          {},
        ),
      /Extra provider options must be a JSON object/,
    );
  });

  it('exposes expanded generation parameters and matching input ports', async () => {
    const node = createNode({
      useTopKInput: true,
      usePresencePenaltyInput: true,
      useFrequencyPenaltyInput: true,
      useStopSequencesInput: true,
      useSeedInput: true,
      useMaxTokensInput: true,
    });

    const editors = await node.getEditors({});
    const parametersGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Parameters') as any;
    const parameterLabels = parametersGroup.editors.map((editor: any) => editor.label);

    assert.deepEqual(parameterLabels.slice(0, 2), ['Temperature', 'Max output tokens']);
    assert.ok(parameterLabels.includes('Presence penalty'));
    assert.ok(parameterLabels.includes('Frequency penalty'));
    assert.ok(parameterLabels.includes('Stop sequences'));
    assert.ok(parameterLabels.includes('Seed'));
    assert.ok(parameterLabels.includes('Max output tokens'));
    assert.equal(
      parametersGroup.editors.find((editor: any) => editor.dataKey === 'topK')?.helperMessage,
      'Provider-dependent; some providers or models may ignore this setting.',
    );

    const inputs = node.getInputDefinitions();
    const inputById = new Map(inputs.map((input) => [input.id, input]));

    assert.equal(inputById.get('presencePenalty' as any)?.dataType, 'number');
    assert.equal(inputById.get('frequencyPenalty' as any)?.dataType, 'number');
    assert.deepEqual(inputById.get('stopSequences' as any)?.dataType, ['string', 'string[]']);
    assert.equal(inputById.get('seed' as any)?.dataType, 'number');
    assert.equal(inputById.get('maxTokens' as any)?.title, 'Max output tokens');
  });

  it('exposes response-format settings and JSON schema input ports only when needed', async () => {
    const defaultNode = createNode();
    const jsonSchemaNode = createNode({
      responseFormat: 'json_schema',
      useResponseSchemaNameInput: true,
      useResponseSchemaDescriptionInput: true,
    });

    const editors = await defaultNode.getEditors({});
    const responseFormatGroup = editors.find(
      (editor) => editor.type === 'group' && editor.label === 'Response format',
    ) as any;

    assert.ok(responseFormatGroup);
    assert.deepEqual(responseFormatGroup.editors.find((editor: any) => editor.dataKey === 'responseFormat')?.options, [
      { value: '', label: 'Default' },
      { value: 'text', label: 'Text' },
      { value: 'json', label: 'JSON object' },
      { value: 'json_schema', label: 'JSON schema' },
    ]);
    assert.equal(
      responseFormatGroup.editors.some((editor: any) => editor.dataKey === 'failProfileOnNonObjectResponse'),
      false,
    );
    assert.equal(
      createNode({ responseFormat: 'json_schema' })
        .getOutputDefinitions()
        .find((output) => output.id === 'response')?.dataType,
      'object',
    );
    assert.ok(!defaultNode.getInputDefinitions().some((input) => input.id === 'responseSchema'));

    const inputs = jsonSchemaNode.getInputDefinitions();
    const inputById = new Map(inputs.map((input) => [input.id, input]));

    assert.deepEqual(inputById.get('responseSchema' as any)?.dataType, ['object', 'gpt-function']);
    assert.equal(inputById.get('responseSchema' as any)?.required, true);
    assert.equal(inputById.get('responseSchemaName' as any)?.dataType, 'string');
    assert.equal(inputById.get('responseSchemaDescription' as any)?.dataType, 'string');
  });

  it('passes JSON schema response format to Custom provider OpenAI-compatible requests', async () => {
    const schema = {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
      additionalProperties: false,
    };
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
      responseFormat: 'json_schema',
      responseSchemaName: 'answer_schema',
      responseSchemaDescription: 'Answer payload',
      extraProviderOptions: '{ "customFlag": true, "response_format": { "type": "json_object" } }',
    });
    const context = createRuntimeContextWithPluginEnv({
      CEREBRAS_API_KEY: 'sk-cerebras-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs({
        responseSchema: {
          type: 'object',
          value: schema,
        },
      }),
      context,
    });

    assert.deepEqual(runtime.runOptions.providerOptions, {
      custom: {
        customFlag: true,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer_schema',
            description: 'Answer payload',
            strict: true,
            schema,
          },
        },
      },
    });
    assert.equal('failProfileOnNonObjectResponse' in runtime.runOptions, false);
  });

  it('restores explicit developer roles in Custom provider request bodies', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'openai-compatible-model',
      customProviderBaseURL: 'https://api.example.test/v1',
      customProviderApiKeyEnvVarName: 'CUSTOM_TEST_API_KEY',
    });
    const context = createRuntimeContextWithPluginEnv({
      CUSTOM_TEST_API_KEY: 'sk-test-secret',
    });
    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs({
        prompt: {
          type: 'chat-message[]',
          value: [
            { type: 'system', message: 'System instruction' },
            { type: 'developer', message: 'Developer instruction' },
            { type: 'user', message: 'User message' },
          ],
        },
      }),
      context,
    });
    const model = runtime.runOptions.model as unknown as { config?: { fetch?: typeof fetch } };
    let sentBody: any;
    const fetchMock = mock.method(globalThis, 'fetch', async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    });

    try {
      assert.ok(model.config?.fetch);
      await model.config.fetch('https://api.example.test/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'System instruction' },
            { role: 'system', content: 'Developer instruction' },
            { role: 'user', content: 'User message' },
          ],
        }),
      });

      assert.deepEqual(
        sentBody.messages.map((message: { role: string }) => message.role),
        ['system', 'developer', 'user'],
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('uses raw Custom provider JSON object mode without an AI SDK output descriptor', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      customProviderBaseURL: 'https://inference.makora.com/v1',
      customProviderApiKeyEnvVarName: 'MAKORA_API_KEY',
      responseFormat: 'json',
      responseSchemaName: 'answer_json',
      responseSchemaDescription: 'Answer payload',
      extraProviderOptions: '{ "customFlag": true, "response_format": { "type": "text" } }',
    });
    const context = createRuntimeContextWithPluginEnv({
      MAKORA_API_KEY: 'sk-makora-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs(),
      context,
    });

    assert.equal(runtime.runOptions.responseFormat, 'json');
    assert.equal(runtime.runOptions.responseOutput, undefined);
    assert.deepEqual(runtime.runOptions.providerOptions, {
      custom: {
        customFlag: true,
        response_format: { type: 'json_object' },
      },
    });
  });

  it('treats Tool use and structured response formats as mutually exclusive', () => {
    assert.equal(hasLLMChatV2ToolResponseFormatConflict({ useToolCalling: true, responseFormat: '' }), false);
    assert.equal(hasLLMChatV2ToolResponseFormatConflict({ useToolCalling: true, responseFormat: 'text' }), false);
    assert.equal(
      hasLLMChatV2ToolResponseFormatConflict({ useToolCalling: false, responseFormat: 'json_schema' }),
      false,
    );

    assert.equal(hasLLMChatV2ToolResponseFormatConflict({ useToolCalling: true, responseFormat: 'json_schema' }), true);
    assert.deepEqual(LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY, {
      title: '"Tool use" conflicts with "Structured outputs"',
      paragraphs: [
        '"Tool use" and "Structured outputs" cannot be used at the same time.',
        'Use "Tool use" with Default/Text response format, or turn "Tool use" off before choosing JSON object/JSON schema.',
      ],
    });
  });

  it('detects only edits that create a Tool use and structured response-format conflict', () => {
    assert.equal(
      createsLLMChatV2ToolResponseFormatConflictForEdit(
        { useToolCalling: false, responseFormat: 'json_schema' },
        { useToolCalling: true, responseFormat: 'json_schema' },
      ),
      true,
    );
    assert.equal(
      createsLLMChatV2ToolResponseFormatConflictForEdit(
        { useToolCalling: true, responseFormat: '' },
        { useToolCalling: true, responseFormat: 'json' },
      ),
      true,
    );
    assert.equal(
      createsLLMChatV2ToolResponseFormatConflictForEdit(
        { useToolCalling: true, responseFormat: 'json' },
        { useToolCalling: true, responseFormat: 'json_schema' },
      ),
      false,
    );
  });

  it('fails fast before execution when Tool use and structured response format are both enabled', async () => {
    await assert.rejects(
      () =>
        resolveLLMChatV2RuntimeConfig({
          data: createNode({
            useToolCalling: true,
            responseFormat: 'json_schema',
          }).data,
          nodeId: 'node-id' as any,
          inputs: {},
          context: createRuntimeContext(),
        }),
      { message: LLM_CHAT_V2_TOOL_RESPONSE_FORMAT_CONFLICT_COPY.paragraphs[0] },
    );
  });

  it('scopes editor cache keys by node id', () => {
    const firstNode = LLMChatV2NodeImpl.create();
    const secondNode = {
      ...LLMChatV2NodeImpl.create(),
      data: firstNode.data,
    };
    const commonParts = {
      nodeData: firstNode.data,
      provider: 'openai' as const,
      modelId: 'gpt-5',
      providerConfig: { baseURL: 'https://example.test' },
      prompt: { type: 'string', value: 'Hello' },
      systemPrompt: undefined,
      functions: undefined,
      generationParameters: { temperature: 0.5 },
      responseFormatParameters: undefined,
      providerOptions: undefined,
      toolChoice: undefined,
    };

    assert.equal(
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        nodeId: firstNode.id,
      }),
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        nodeId: firstNode.id,
      }),
    );
    assert.notEqual(
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        nodeId: firstNode.id,
      }),
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        nodeId: secondNode.id,
      }),
    );
  });

  it('scopes editor cache keys by API key input without storing the raw secret', async () => {
    const node = createNode({
      apiKeySource: 'input',
      cache: true,
    });
    const context = createRuntimeContext();
    const commonInputs = createPromptInputs();

    const first = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        ...commonInputs,
        apiKey: { type: 'string', value: 'sk-secret-a' },
      },
      context,
    });
    const second = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        ...commonInputs,
        apiKey: { type: 'string', value: 'sk-secret-b' },
      },
      context,
    });

    assert.ok(first.cacheKey);
    assert.ok(second.cacheKey);
    assert.notEqual(first.cacheKey, second.cacheKey);
    assert.doesNotMatch(first.cacheKey!, /sk-secret-a/);
    assert.doesNotMatch(second.cacheKey!, /sk-secret-b/);
  });

  it('fails clearly when the API key input source is selected but no key is provided', async () => {
    const node = createNode({
      apiKeySource: 'input',
    });

    await assert.rejects(
      () =>
        resolveLLMChatV2RuntimeConfig({
          data: node.data,
          nodeId: node.chartNode.id,
          inputs: createPromptInputs(),
          context: createRuntimeContext(),
        }),
      /API Key input is required/,
    );
  });

  it('resolves configured provider keys from shared LLM settings', () => {
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({ provider: 'openai' }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiApiKey: 'configured-openai-api-key',
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
          },
        }),
      ),
      'configured-openai-api-key',
    );
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({ provider: 'anthropic' }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
            anthropicApiKey: 'configured-anthropic-key',
          },
          getPluginConfig: () => '',
        }),
      ),
      'configured-anthropic-key',
    );
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({ provider: 'google' }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
            googleApiKey: 'configured-google-key',
          },
          getPluginConfig: () => '',
        }),
      ),
      'configured-google-key',
    );
  });

  it('resolves Custom provider configured key from programmatic key names before env vars and shared settings', () => {
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({
          provider: 'custom',
          customProviderApiKeyProgrammaticName: 'cerebrasApiKey',
          customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
        }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
            customAiApiKey: 'configured-custom-key',
            cerebrasApiKey: 'programmatic-specific-key',
            pluginEnv: {
              CEREBRAS_API_KEY: 'env-specific-key',
            },
          },
        }),
      ),
      'programmatic-specific-key',
    );
  });

  it('falls back to Custom provider API key env vars before shared LLM settings', () => {
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({
          provider: 'custom',
          customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
        }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
            customAiApiKey: 'configured-custom-key',
            pluginEnv: {
              CEREBRAS_API_KEY: 'env-specific-key',
            },
          },
        }),
      ),
      'env-specific-key',
    );
  });

  it('falls back to shared Custom provider LLM settings when the configured env var is absent', () => {
    assert.equal(
      resolveLLMChatV2ApiKey(
        createNode({
          provider: 'custom',
          customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
        }).data,
        {},
        createRuntimeContext({
          settings: {
            openAiKey: '',
            openAiEndpoint: '',
            openAiOrganization: '',
            chatNodeHeaders: {},
            customAiApiKey: 'configured-custom-key',
          },
        }),
      ),
      'configured-custom-key',
    );
  });

  it('resolves Custom provider config from base URL and configured API key env var', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1/chat/completions',
      customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
      cache: true,
    });
    const context = createRuntimeContextWithPluginEnv({
      CEREBRAS_API_KEY: 'sk-cerebras-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs(),
      context,
    });

    assert.equal(runtime.runOptions.provider, 'custom');
    assert.equal(runtime.runOptions.modelId, 'llama-custom');
    assert.equal(getCacheProviderConfig(runtime).baseURL, 'https://api.cerebras.ai/v1');
    assert.doesNotMatch(runtime.cacheKey!, /sk-cerebras-secret/);
  });

  it('resolves Custom provider base URL from the active input port', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://static.example.ai/v1',
      useCustomProviderBaseURLInput: true,
      customProviderApiKeyEnvVarName: 'CUSTOM_INPUT_API_KEY',
      cache: true,
    });
    const context = createRuntimeContextWithPluginEnv({
      CUSTOM_INPUT_API_KEY: 'sk-input-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs({
        customProviderBaseURL: { type: 'string', value: 'https://input.example.ai/v1/chat/completions' },
      }),
      context,
    });

    assert.equal(getCacheProviderConfig(runtime).baseURL, 'https://input.example.ai/v1');
  });

  it('keeps Custom provider base URL active while ignoring stale built-in provider base URLs', async () => {
    const customNode = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://static-custom.example.ai/v1',
      useCustomProviderBaseURLInput: true,
      customProviderApiKeyEnvVarName: 'CUSTOM_SEPARATE_API_KEY',
      cache: true,
    });
    const openAiNode = createNode({
      provider: 'openai',
      model: 'gpt-5',
      baseURL: 'https://static-openai.example.test/v1',
      useBaseURLInput: true,
      customProviderBaseURL: 'https://stale-custom.example.ai/v1',
      cache: true,
    });
    const context = createRuntimeContextWithPluginEnv({
      CUSTOM_SEPARATE_API_KEY: 'sk-custom-secret',
    });
    const inputs = createPromptInputs({
      baseURL: { type: 'string', value: 'https://input-openai.example.test/v1' },
      customProviderBaseURL: { type: 'string', value: 'https://input-custom.example.ai/v1/chat/completions' },
    });

    const customRuntime = await resolveLLMChatV2RuntimeConfig({
      data: customNode.data,
      nodeId: customNode.chartNode.id,
      inputs,
      context,
    });
    const openAiRuntime = await resolveLLMChatV2RuntimeConfig({
      data: openAiNode.data,
      nodeId: openAiNode.chartNode.id,
      inputs,
      context,
    });

    assert.equal(getCacheProviderConfig(customRuntime).baseURL, 'https://input-custom.example.ai/v1');
    assert.equal(getCacheProviderConfig(openAiRuntime).baseURL, undefined);
  });

  it('keeps built-in provider tools on provider-owned endpoints too', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/model/chat-v2/chatV2RuntimeOptions.ts', import.meta.url)),
      'utf8',
    );
    const openAiToolsBlock = source.match(/case 'openai': \{[\s\S]*?case 'google': \{/);
    const googleToolsBlock = source.match(/case 'google': \{[\s\S]*?case 'anthropic':/);

    assert.ok(openAiToolsBlock);
    assert.ok(googleToolsBlock);
    assert.match(openAiToolsBlock[0], /createOpenAI\([\s\S]*baseURL: undefined/);
    assert.match(googleToolsBlock[0], /createGoogleGenerativeAI\([\s\S]*baseURL: undefined/);
    assert.doesNotMatch(openAiToolsBlock[0], /baseURL: config\.baseURL/);
    assert.doesNotMatch(googleToolsBlock[0], /baseURL: config\.baseURL/);
  });

  it('does not reuse the Custom provider base URL as a built-in provider override', async () => {
    const node = createNode({
      provider: 'openai',
      model: 'gpt-5',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      cache: true,
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs(),
      context: createRuntimeContext(),
    });

    assert.equal(getCacheProviderConfig(runtime).baseURL, undefined);
  });

  it('ignores inactive base URL fields in editor cache keys', async () => {
    const context = createRuntimeContextWithPluginEnv({
      CUSTOM_CACHE_API_KEY: 'sk-custom-secret',
    });
    const commonInputs = createPromptInputs();
    const firstOpenAIRuntime = await resolveLLMChatV2RuntimeConfig({
      data: createNode({
        provider: 'openai',
        model: 'gpt-5',
        customProviderBaseURL: 'https://custom-a.example.ai/v1',
        cache: true,
      }).data,
      nodeId: 'same-openai-node-id' as any,
      inputs: commonInputs,
      context,
    });
    const secondOpenAIRuntime = await resolveLLMChatV2RuntimeConfig({
      data: createNode({
        provider: 'openai',
        model: 'gpt-5',
        customProviderBaseURL: 'https://custom-b.example.ai/v1',
        useCustomProviderBaseURLInput: true,
        cache: true,
      }).data,
      nodeId: 'same-openai-node-id' as any,
      inputs: commonInputs,
      context,
    });
    const firstCustomRuntime = await resolveLLMChatV2RuntimeConfig({
      data: createNode({
        provider: 'custom',
        model: 'llama-custom',
        customProviderBaseURL: 'https://custom-cache.example.ai/v1',
        baseURL: 'https://hidden-a.example.test/v1',
        useBaseURLInput: true,
        customProviderApiKeyEnvVarName: 'CUSTOM_CACHE_API_KEY',
        cache: true,
      }).data,
      nodeId: 'same-custom-node-id' as any,
      inputs: commonInputs,
      context,
    });
    const secondCustomRuntime = await resolveLLMChatV2RuntimeConfig({
      data: createNode({
        provider: 'custom',
        model: 'llama-custom',
        customProviderBaseURL: 'https://custom-cache.example.ai/v1',
        baseURL: 'https://hidden-b.example.test/v1',
        customProviderApiKeyEnvVarName: 'CUSTOM_CACHE_API_KEY',
        cache: true,
      }).data,
      nodeId: 'same-custom-node-id' as any,
      inputs: commonInputs,
      context,
    });

    assert.equal(firstOpenAIRuntime.cacheKey, secondOpenAIRuntime.cacheKey);
    assert.equal(firstCustomRuntime.cacheKey, secondCustomRuntime.cacheKey);
  });

  it('fingerprints provider header values in editor cache keys', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
      headers: [{ key: 'Authorization', value: 'Bearer raw-header-secret' }],
      cache: true,
    });
    const context = createRuntimeContextWithPluginEnv({
      CEREBRAS_API_KEY: 'sk-cerebras-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs(),
      context,
    });

    assert.doesNotMatch(runtime.cacheKey!, /raw-header-secret/);
    assert.doesNotMatch(runtime.cacheKey!, /sk-cerebras-secret/);
    assert.match(getCacheProviderConfig(runtime).headers.Authorization, /^sha256:[a-f0-9]{64}$/);
  });

  it('fingerprints extra provider option values in editor cache keys without changing runtime options', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
      extraProviderOptions: '{ "reasoningEffort": "high", "byok": { "apiKey": "raw-provider-option-secret" } }',
      cache: true,
    });
    const context = createRuntimeContextWithPluginEnv({
      CEREBRAS_API_KEY: 'sk-cerebras-secret',
    });

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: createPromptInputs(),
      context,
    });

    assert.deepEqual(runtime.runOptions.providerOptions, {
      custom: {
        reasoningEffort: 'high',
        byok: {
          apiKey: 'raw-provider-option-secret',
        },
      },
    });
    assert.ok(runtime.cacheKey);
    assert.doesNotMatch(runtime.cacheKey!, /raw-provider-option-secret/);
    assert.doesNotMatch(runtime.cacheKey!, /reasoningEffort/);
  });

  it('ignores stale static extra provider options in cache keys when input mode is enabled', async () => {
    const firstNode = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      customProviderApiKeyEnvVarName: 'CEREBRAS_API_KEY',
      extraProviderOptions: '{ "stale": "first" }',
      useExtraProviderOptionsInput: true,
      cache: true,
    });
    const secondNode = createNode({
      ...firstNode.data,
      extraProviderOptions: '{ "stale": "second" }',
    });
    const context = createRuntimeContextWithPluginEnv({
      CEREBRAS_API_KEY: 'sk-cerebras-secret',
    });
    const inputs = createPromptInputs({
      extraProviderOptions: {
        type: 'string',
        value: '{ "reasoningEffort": "high", "byok": { "apiKey": "input-option-secret" } }',
      },
    });

    const firstRuntime = await resolveLLMChatV2RuntimeConfig({
      data: firstNode.data,
      nodeId: firstNode.chartNode.id,
      inputs,
      context,
    });
    const secondRuntime = await resolveLLMChatV2RuntimeConfig({
      data: secondNode.data,
      nodeId: firstNode.chartNode.id,
      inputs,
      context,
    });

    assert.deepEqual(firstRuntime.runOptions.providerOptions, secondRuntime.runOptions.providerOptions);
    assert.equal(firstRuntime.cacheKey, secondRuntime.cacheKey);
    assert.ok(firstRuntime.cacheKey);
    assert.doesNotMatch(firstRuntime.cacheKey!, /input-option-secret/);
    assert.doesNotMatch(firstRuntime.cacheKey!, /stale/);
  });

  it('fails clearly when Custom provider configured-key env var is missing', async () => {
    const node = createNode({
      provider: 'custom',
      model: 'llama-custom',
      customProviderBaseURL: 'https://api.cerebras.ai/v1',
      customProviderApiKeyEnvVarName: 'MISSING_CUSTOM_KEY',
    });

    await assert.rejects(
      () =>
        resolveLLMChatV2RuntimeConfig({
          data: node.data,
          nodeId: node.chartNode.id,
          inputs: createPromptInputs(),
          context: createRuntimeContext(),
        }),
      /Custom provider API key env var MISSING_CUSTOM_KEY is not set/,
    );
  });

  it('builds stable editor cache keys for equivalent object inputs', () => {
    const node = LLMChatV2NodeImpl.create();
    const firstSchema = {
      type: 'object',
      properties: {
        city: { type: 'string' },
        units: { type: 'string' },
      },
      required: ['city'],
    };
    const secondSchema = {
      required: ['city'],
      properties: {
        units: { type: 'string' },
        city: { type: 'string' },
      },
      type: 'object',
    };
    const commonParts = {
      nodeId: node.id,
      nodeData: node.data,
      provider: 'openai' as const,
      modelId: 'gpt-5',
      providerConfig: { headers: { b: '2', a: '1' }, baseURL: 'https://example.test' },
      prompt: { type: 'string', value: 'Hello' },
      systemPrompt: undefined,
      generationParameters: { temperature: 0.5 },
      responseFormatParameters: undefined,
      providerOptions: undefined,
      toolChoice: undefined,
    };

    assert.equal(
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        functions: [
          {
            name: 'weather',
            description: 'Get weather',
            parameters: firstSchema,
            strict: false,
          },
        ],
      }),
      buildLLMChatV2EditorCacheKey({
        ...commonParts,
        functions: [
          {
            strict: false,
            parameters: secondSchema,
            description: 'Get weather',
            name: 'weather',
          },
        ],
      }),
    );
  });

  it('builds editor cache keys without throwing on circular input metadata', () => {
    const node = LLMChatV2NodeImpl.create();
    const providerConfig: Record<string, unknown> = { baseURL: 'https://example.test' };
    providerConfig.self = providerConfig;

    assert.doesNotThrow(() =>
      buildLLMChatV2EditorCacheKey({
        nodeId: node.id,
        nodeData: node.data,
        provider: 'openai',
        modelId: 'gpt-5',
        providerConfig,
        prompt: { type: 'string', value: 'Hello' },
        systemPrompt: undefined,
        functions: undefined,
        generationParameters: { temperature: 0.5 },
        responseFormatParameters: undefined,
        providerOptions: undefined,
        toolChoice: undefined,
      }),
    );
  });

  it('clones editor cache outputs while preserving excluded output values', () => {
    const outputs = {
      response: {
        type: 'string',
        value: 'Hello',
      },
      'function-calls': {
        type: 'object[]',
        value: [
          {
            name: 'tool',
            arguments: { city: 'Paris' },
          },
        ],
      },
      usage: {
        type: 'control-flow-excluded',
        value: undefined,
      },
    } as const;

    const cloned = cloneLLMChatV2EditorCacheOutputs(outputs as any);

    assert.deepEqual(cloned, outputs);
    assert.notEqual(cloned, outputs);
    assert.notEqual(cloned['function-calls' as any].value, outputs['function-calls'].value);

    (cloned['function-calls' as any].value[0].arguments as any).city = 'Berlin';

    assert.equal((outputs['function-calls'].value[0].arguments as any).city, 'Paris');
    assert.ok(Object.hasOwn(cloned.usage, 'value'));
  });

  it('clones editor cache outputs with circular arrays when structuredClone cannot copy a value', () => {
    const circularValue: unknown[] = [() => 'not structured-cloneable'];
    circularValue.push(circularValue);
    const outputs = {
      response: {
        type: 'object[]',
        value: circularValue,
      },
    } as const;

    const cloned = cloneLLMChatV2EditorCacheOutputs(outputs as any);
    const clonedValue = cloned.response.value as unknown[];

    assert.notEqual(clonedValue, circularValue);
    assert.equal(clonedValue[0], circularValue[0]);
    assert.equal(clonedValue[1], clonedValue);
  });
});
