import type { EditorDefinition } from '../EditorDefinition.js';
import type { ChartNode } from '../NodeBase.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import {
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
} from './chatV2Retry.js';
import {
  anthropicCacheControlTtlOptions,
  anthropicEffortOptions,
  anthropicThinkingModeOptions,
  chatV2ProviderOptions,
  customProviderApiOptions,
  getChatV2ModelOptions,
  googleThinkingLevelOptions,
  openAIReasoningEffortOptions,
  openAIWebSearchContextSizeOptions,
} from './providerOptions.js';
import {
  LLM_CHAT_V2_PARALLEL_TOOL_CALLS_HELPER_MESSAGE,
  supportsLLMChatV2ParallelToolCalls,
} from './parallelToolCalls.js';
import type { LLMChatV2Node, LLMChatV2NodeData, LLMChatV2ProfileData } from './llmChatV2NodeData.js';
import {
  DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_WINDOW_MS,
  DEFAULT_LLM_PROFILE_CIRCUIT_OPEN_DURATION_MS,
  DEFAULT_LLM_PROFILE_FIRST_OUTPUT_TIMEOUT_MS,
  DEFAULT_LLM_PROFILE_STREAM_INACTIVITY_TIMEOUT_MS,
} from './llmProfileHealthStore.js';
import { getChatV2CredentialNamesForDisplay, isChatV2BuiltInProvider } from './chatV2CredentialNames.js';

type LLMChatV2EditorDefinition = EditorDefinition<LLMChatV2Node>;
type LLMProfileEditorNode = ChartNode<'llmProfile', LLMChatV2ProfileData>;

const hideUnlessProvider =
  (provider: LLMChatV2NodeData['provider']) =>
  (data: LLMChatV2NodeData): boolean =>
    data.provider !== provider;

function group(label: string, editors: LLMChatV2EditorDefinition[], defaultOpen?: boolean): LLMChatV2EditorDefinition {
  return {
    type: 'group',
    label,
    ...(defaultOpen != null ? { defaultOpen } : {}),
    editors,
  };
}

function providerGroup(
  provider: LLMChatV2NodeData['provider'],
  label: string,
  editors: LLMChatV2EditorDefinition[],
): LLMChatV2EditorDefinition {
  return {
    type: 'group',
    label,
    hideIf: hideUnlessProvider(provider),
    editors,
  };
}

async function getResolvedModelOptions(data: LLMChatV2NodeData, context: RivetUIContext) {
  if (data.provider === 'custom') {
    return data.model ? [{ value: data.model, label: data.model }] : [];
  }

  const modelOptions =
    (await context.getChatModelOptions?.(data.provider).catch(() => undefined)) ?? getChatV2ModelOptions(data.provider);

  return modelOptions.some((option) => option.value === data.model)
    ? modelOptions
    : [{ value: data.model, label: `${data.model} (Current)` }, ...modelOptions];
}

function getApiKeySourceHelperMessage(data: LLMChatV2NodeData): string {
  if (data.apiKeySource === 'input') {
    return 'Uses the API Key input port instead of a configured provider key.';
  }

  switch (data.provider) {
    case 'openai':
    case 'anthropic':
    case 'google': {
      const names = getChatV2CredentialNamesForDisplay(data.provider, data.providerApiKeyNames?.[data.provider]);
      const hasOverride = data.providerApiKeyNames?.[data.provider] != null;
      return hasOverride
        ? `Configured key checks ${names.programmaticName} first, then ${names.environmentVariableName}. This explicit override does not fall back to the shared provider key.`
        : `Configured key uses ${names.programmaticName} or ${names.environmentVariableName}, including the existing Settings > LLM provider key.`;
    }
    case 'custom': {
      const programmaticName = data.customProviderApiKeyProgrammaticName?.trim();
      const envVarName = data.customProviderApiKeyEnvVarName?.trim() || 'CUSTOM_PROVIDER_API_KEY';
      return programmaticName
        ? `Configured key checks ${programmaticName}, then ${envVarName} env var, then Settings > LLM > Custom provider API key.`
        : `Configured key checks ${envVarName} env var, then Settings > LLM > Custom provider API key. Programmatic runs can pass the shared customAiApiKey.`;
    }
  }
}

function getModelEditors(modelOptions: { value: string; label: string }[]): LLMChatV2EditorDefinition {
  return group(
    'Model',
    [
      {
        type: 'dropdown',
        label: 'Provider',
        dataKey: 'provider',
        options: [...chatV2ProviderOptions],
      },
      {
        type: 'string',
        label: 'Provider base URL',
        dataKey: 'customProviderBaseURL',
        useInputToggleDataKey: 'useCustomProviderBaseURLInput',
        placeholder: 'https://api.cerebras.ai/v1',
        helperMessage:
          'OpenAI-compatible provider base URL. Full /chat/completions or /responses URLs are accepted and normalized.',
        hideIf: hideUnlessProvider('custom'),
      },
      {
        type: 'segmented',
        label: 'API',
        ariaLabel: 'Custom provider API',
        dataKey: 'customProviderApi',
        defaultValue: 'completions',
        options: [...customProviderApiOptions],
        hideIf: hideUnlessProvider('custom'),
      },
      {
        type: 'custom',
        label: 'Model',
        customEditorId: 'LLMChatV2ModelCatalog',
        data: {
          modelOptions,
        },
      },
      {
        type: 'segmented',
        label: 'API key source',
        ariaLabel: 'API key source',
        dataKey: 'apiKeySource',
        defaultValue: 'environment',
        options: [
          { value: 'environment', label: 'Configured key' },
          { value: 'input', label: 'Input port' },
        ],
        helperMessage: getApiKeySourceHelperMessage,
      },
      {
        type: 'custom',
        label: 'Configured API key names',
        customEditorId: 'LLMChatV2CredentialNames',
        hideIf: (data) => !isChatV2BuiltInProvider(data.provider) || data.apiKeySource === 'input',
      },
      {
        type: 'string',
        label: 'Alternative programmatic key name',
        dataKey: 'customProviderApiKeyProgrammaticName',
        placeholder: 'cerebrasApiKey',
        helperMessage: 'If set, programmatic runs read this named run option instead of the shared customAiApiKey.',
        hideIf: (data) => data.provider !== 'custom' || data.apiKeySource === 'input',
      },
      {
        type: 'string',
        label: 'Alternative API key env var',
        dataKey: 'customProviderApiKeyEnvVarName',
        placeholder: 'CUSTOM_PROVIDER_API_KEY',
        helperMessage: 'If set, this env var is used instead of CUSTOM_PROVIDER_API_KEY.',
        hideIf: (data) => data.provider !== 'custom' || data.apiKeySource === 'input',
      },
    ],
    true,
  );
}

function getProviderEditors(): LLMChatV2EditorDefinition[] {
  return [getOpenAIProviderEditors(), getAnthropicProviderEditors(), getGoogleProviderEditors()];
}

function getCircuitBreakerEditors(): LLMChatV2EditorDefinition {
  return group('LLM profile suspension', [
    {
      type: 'info',
      label: "It's a hosted runtime capability",
      helperMessage:
        'This configuration is enforced by Rivet Studio Server or another host that explicitly provides shared LLM profile reliability. It has no effect in standalone Rivet.',
    },
    {
      type: 'toggle',
      label: 'Enable automatic suspension',
      dataKey: 'enableCircuitBreaker',
      helperMessage:
        'After provider failures or timeouts, temporarily suspend this profile in the LLM profiles fallback chain. When the suspension ends, one recovery attempt checks whether the profile can resume.',
    },
    {
      type: 'number',
      label: 'Useful output wait time, seconds',
      dataKey: 'firstOutputTimeoutMs',
      defaultValue: DEFAULT_LLM_PROFILE_FIRST_OUTPUT_TIMEOUT_MS,
      storageMultiplier: 1_000,
      min: 1_000,
      step: 1_000,
      helperMessage:
        'Maximum wait time for a non-stream response (or the first useful streamed output). A call that reaches this deadline falls back immediately, even before this profile is suspended.',
      hideIf: (data) => data.enableCircuitBreaker !== true,
    },
    {
      type: 'number',
      label: 'Stream inactivity timeout, seconds',
      dataKey: 'streamInactivityTimeoutMs',
      defaultValue: DEFAULT_LLM_PROFILE_STREAM_INACTIVITY_TIMEOUT_MS,
      storageMultiplier: 1_000,
      min: 1_000,
      step: 1_000,
      helperMessage: 'Maximum gap between streamed response events before falling back.',
      hideIf: (data) => data.enableCircuitBreaker !== true,
    },
    {
      type: 'number',
      label: 'Failures before suspension',
      dataKey: 'circuitBreakerFailureThreshold',
      defaultValue: DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_THRESHOLD,
      min: 1,
      step: 1,
      helperMessage:
        'Failed or timed-out profile attempts required within the failure window before suspending this profile.',
      hideIf: (data) => data.enableCircuitBreaker !== true,
    },
    {
      type: 'number',
      label: 'Failure window, seconds',
      dataKey: 'circuitBreakerFailureWindowMs',
      defaultValue: DEFAULT_LLM_PROFILE_CIRCUIT_FAILURE_WINDOW_MS,
      storageMultiplier: 1_000,
      min: 1_000,
      step: 1_000,
      helperMessage: 'Failed or timed-out profile attempts inside this rolling window count toward suspension.',
      hideIf: (data) => data.enableCircuitBreaker !== true,
    },
    {
      type: 'number',
      label: 'Suspension duration, seconds',
      dataKey: 'circuitBreakerOpenDurationMs',
      defaultValue: DEFAULT_LLM_PROFILE_CIRCUIT_OPEN_DURATION_MS,
      storageMultiplier: 1_000,
      min: 1_000,
      step: 1_000,
      helperMessage: 'How long the fallback chain skips this profile before allowing one recovery attempt.',
      hideIf: (data) => data.enableCircuitBreaker !== true,
    },
  ]);
}

function getOpenAIProviderEditors(): LLMChatV2EditorDefinition {
  return providerGroup('openai', 'OpenAI', [
    {
      type: 'string' as const,
      label: 'Previous Response ID',
      dataKey: 'openAIPreviousResponseId' as const,
      useInputToggleDataKey: 'useOpenAIPreviousResponseIdInput' as const,
    },
    {
      type: 'toggle',
      label: 'Enable Web Search',
      dataKey: 'enableOpenAIWebSearch',
    },
    {
      type: 'dropdown',
      label: 'Web Search Context',
      dataKey: 'openAIWebSearchContextSize',
      options: openAIWebSearchContextSizeOptions,
      hideIf: (data) => !data.enableOpenAIWebSearch,
    },
    {
      type: 'toggle',
      label: 'Enable Code Interpreter',
      dataKey: 'enableOpenAICodeInterpreter',
    },
  ]);
}

function getAnthropicProviderEditors(): LLMChatV2EditorDefinition {
  return providerGroup('anthropic', 'Anthropic', [
    {
      type: 'dropdown',
      label: 'Cache Breakpoint TTL',
      dataKey: 'anthropicCacheControlTtl',
      options: anthropicCacheControlTtlOptions,
      helperMessage: 'Applies when incoming chat messages mark a cache breakpoint.',
    },
  ]);
}

function getGoogleProviderEditors(): LLMChatV2EditorDefinition {
  return providerGroup('google', 'Google', [
    {
      type: 'toggle',
      label: 'Enable Google Search Grounding',
      dataKey: 'enableGoogleSearchGrounding',
    },
    {
      type: 'toggle',
      label: 'Enable URL Context',
      dataKey: 'enableGoogleUrlContext',
    },
  ]);
}

function getParameterEditors(): LLMChatV2EditorDefinition {
  return group(
    'Parameters',
    [
      {
        type: 'number',
        label: 'Temperature',
        helperMessage: 'Provider-dependent; some reasoning models may ignore this setting.',
        dataKey: 'temperature',
        useInputToggleDataKey: 'useTemperatureInput',
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        type: 'number',
        label: 'Max output tokens',
        dataKey: 'maxTokens',
        useInputToggleDataKey: 'useMaxTokensInput',
        min: 1,
        step: 1,
      },
      {
        type: 'number',
        label: 'Top P',
        dataKey: 'topP',
        useInputToggleDataKey: 'useTopPInput',
        allowEmpty: true,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        type: 'number',
        label: 'Top K',
        helperMessage: 'Provider-dependent; some providers or models may ignore this setting.',
        dataKey: 'topK',
        useInputToggleDataKey: 'useTopKInput',
        allowEmpty: true,
        min: 1,
        step: 1,
      },
      {
        type: 'number',
        label: 'Presence penalty',
        dataKey: 'presencePenalty',
        useInputToggleDataKey: 'usePresencePenaltyInput',
        allowEmpty: true,
        min: -1,
        max: 1,
        step: 0.1,
      },
      {
        type: 'number',
        label: 'Frequency penalty',
        dataKey: 'frequencyPenalty',
        useInputToggleDataKey: 'useFrequencyPenaltyInput',
        allowEmpty: true,
        min: -1,
        max: 1,
        step: 0.1,
      },
      {
        type: 'stringList',
        label: 'Stop sequences',
        dataKey: 'stopSequences',
        useInputToggleDataKey: 'useStopSequencesInput',
        placeholder: 'Stop sequence',
        newItemDefault: '',
      },
      {
        type: 'number',
        label: 'Seed',
        dataKey: 'seed',
        useInputToggleDataKey: 'useSeedInput',
        allowEmpty: true,
        min: 0,
        step: 1,
      },
    ],
    true,
  );
}

function getReasoningEditors(): LLMChatV2EditorDefinition {
  return group('Reasoning', [
    {
      type: 'dropdown',
      label: 'Reasoning effort',
      dataKey: 'openAIReasoningEffort',
      options: openAIReasoningEffortOptions,
      helperMessage:
        'OpenAI-compatible Vercel provider option for reasoning models. Some models only support a subset of effort levels.',
      hideIf: hideUnlessProvider('openai'),
    },
    {
      type: 'string',
      label: 'Reasoning summary',
      dataKey: 'openAIReasoningSummary',
      placeholder: 'auto, detailed, concise...',
      helperMessage:
        'OpenAI-compatible Vercel provider option that asks reasoning models to include a reasoning summary when supported.',
      hideIf: hideUnlessProvider('openai'),
    },
    {
      type: 'dropdown',
      label: 'Thinking mode',
      dataKey: 'anthropicThinkingMode',
      options: anthropicThinkingModeOptions,
      helperMessage: 'Anthropic Vercel provider option for Claude extended thinking.',
      hideIf: hideUnlessProvider('anthropic'),
    },
    {
      type: 'dropdown',
      label: 'Effort',
      dataKey: 'anthropicEffort',
      options: anthropicEffortOptions,
      helperMessage:
        'Anthropic provider option for newer Claude models. It affects thinking, text responses, and tool calls when supported.',
      hideIf: hideUnlessProvider('anthropic'),
    },
    {
      type: 'number',
      label: 'Thinking budget',
      dataKey: 'anthropicThinkingBudget',
      useInputToggleDataKey: 'useAnthropicThinkingBudgetInput',
      allowEmpty: true,
      step: 1,
      min: 0,
      helperMessage: 'Optional token budget for Anthropic extended thinking when thinking mode is enabled.',
      hideIf: (data) => data.provider !== 'anthropic' || data.anthropicThinkingMode !== 'enabled',
    },
    {
      type: 'dropdown',
      label: 'Thinking level',
      dataKey: 'googleThinkingLevel',
      options: googleThinkingLevelOptions,
      helperMessage: 'Google provider option for Gemini 3 thinking depth when supported by the selected model.',
      hideIf: hideUnlessProvider('google'),
    },
    {
      type: 'number',
      label: 'Thinking budget',
      dataKey: 'googleThinkingBudget',
      useInputToggleDataKey: 'useGoogleThinkingBudgetInput',
      allowEmpty: true,
      step: 1,
      min: 0,
      helperMessage: 'Google provider option for Gemini 2.5 thinking budget when supported by the selected model.',
      hideIf: hideUnlessProvider('google'),
    },
    {
      type: 'toggle',
      label: 'Include thoughts',
      dataKey: 'googleIncludeThoughts',
      helperMessage: 'Requests Google reasoning summaries when supported by the selected model.',
      hideIf: hideUnlessProvider('google'),
    },
  ]);
}

function getResponseSettingsEditors(): LLMChatV2EditorDefinition {
  return group('Response settings', [
    {
      type: 'dropdown',
      label: 'Response format',
      dataKey: 'responseFormat',
      options: [
        { value: '', label: 'Default' },
        { value: 'text', label: 'Text' },
        { value: 'json', label: 'JSON object' },
        { value: 'json_schema', label: 'JSON schema' },
      ],
      defaultValue: '',
      helperMessage:
        'Uses Vercel AI SDK structured-output response formatting when supported by the provider. JSON schema adds a Response Schema input port.',
    },
    {
      type: 'toggle',
      label: 'Stream response',
      dataKey: 'useAsGraphPartialOutput',
      helperMessage:
        'Shows streamed response updates in the node output while running in the editor. Other nodes only receive the final response after it is complete.',
    },
    {
      type: 'string',
      label: 'Schema name',
      dataKey: 'responseSchemaName',
      useInputToggleDataKey: 'useResponseSchemaNameInput',
      placeholder: 'response_schema',
      helperMessage: 'Optional name passed to the provider for JSON object or JSON schema responses.',
      hideIf: (data) => data.responseFormat !== 'json' && data.responseFormat !== 'json_schema',
    },
    {
      type: 'string',
      label: 'Schema description',
      dataKey: 'responseSchemaDescription',
      useInputToggleDataKey: 'useResponseSchemaDescriptionInput',
      helperMessage: 'Optional description passed to the provider for JSON object or JSON schema responses.',
      hideIf: (data) => data.responseFormat !== 'json' && data.responseFormat !== 'json_schema',
    },
  ]);
}

function getToolEditors(): LLMChatV2EditorDefinition {
  return group('Tools', [
    {
      type: 'toggle',
      label: 'Tool use',
      dataKey: 'useToolCalling',
    },
    {
      type: 'dropdown',
      label: 'Tool choice',
      dataKey: 'toolChoice',
      options: [
        { value: '', label: 'Default' },
        { value: 'auto', label: 'Auto' },
        { value: 'function', label: 'Specific tool' },
        { value: 'required', label: 'Required' },
      ],
      defaultValue: '',
      helperMessage: 'Controls whether the model may call tools. Default lets the model/provider choose.',
      hideIf: (data) => !data.useToolCalling,
    },
    {
      type: 'string',
      label: 'Tool name',
      dataKey: 'toolChoiceFunction',
      helperMessage: 'The name of the tool to force the model to call.',
      hideIf: (data) => !data.useToolCalling || data.toolChoice !== 'function',
    },
    {
      type: 'toggle',
      label: 'Allow parallel toolcalls',
      dataKey: 'parallelToolCalls',
      helperMessage: (data) =>
        data.configurationMode === 'profile'
          ? `${LLM_CHAT_V2_PARALLEL_TOOL_CALLS_HELPER_MESSAGE} In From profile mode, it applies only to candidates whose providers support parallel tool calls; unsupported candidates ignore it.`
          : LLM_CHAT_V2_PARALLEL_TOOL_CALLS_HELPER_MESSAGE,
      hideIf: (data) =>
        !data.useToolCalling ||
        (data.configurationMode !== 'profile' && !supportsLLMChatV2ParallelToolCalls(data.provider)),
    },
    {
      type: 'toggle',
      label: 'Auto-continue after toolcalls run',
      dataKey: 'autoContinueToolCalls',
      helperMessage:
        'When the model calls tools, Rivet runs them, sends all tool results back to the model, and repeats until a normal answer is produced or max rounds is reached.',
      hideIf: (data) => !data.useToolCalling,
    },
    {
      type: 'number',
      label: 'Maximum tool rounds',
      dataKey: 'maxToolRounds',
      helperMessage: 'Each round may contain multiple parallel tool calls if not disallowed.',
      min: 1,
      step: 1,
      hideIf: (data) => !data.useToolCalling || !data.autoContinueToolCalls,
    },
  ]);
}

function getOutputEditors(): LLMChatV2EditorDefinition {
  return group('Outputs', [
    {
      type: 'toggle',
      label: 'Output reasoning',
      dataKey: 'outputReasoning',
      helperMessage:
        'Adds a Reasoning output when the provider/model exposes reasoning or thinking text through the Vercel AI SDK. Some providers only expose token counts or summaries.',
    },
    {
      type: 'toggle',
      label: 'Output usage details',
      dataKey: 'outputUsage',
      helperMessage:
        'Adds a Usage output built from Vercel AI SDK usage metadata: prompt, completion, total, cached, reasoning tokens, and estimated cost when available.',
    },
    {
      type: 'toggle',
      label: 'Output LLM attempts',
      dataKey: 'outputLLMAttempts',
      helperMessage:
        'Adds one chronological record for every profile configuration, provider request, and response-validation attempt. Records include provider, model, retry status, and provider error details when available.',
    },
    {
      type: 'toggle',
      label: 'Output request body',
      dataKey: 'outputRequestBody',
      helperMessage:
        'Adds an LLM request body output. It can contain prompts and non-secret provider options; it never includes authorization headers or API keys.',
    },
    {
      type: 'toggle',
      label: 'Output response body',
      dataKey: 'outputResponseBody',
      helperMessage:
        'Adds the complete LLM response body captured at the provider HTTP boundary. JSON responses are parsed for inspection; other responses remain text. Rivet does not redact or truncate captured content.',
    },
    {
      type: 'toggle',
      label: 'Cache outputs (editor only) (legacy)',
      dataKey: 'cache',
      helperMessage:
        "Legacy editor-only cache. It reuses this node's previous outputs for the same input while the Rivet app is open. Turn it off to retire it from this node.",
      hideIf: (data) => data.cache !== true,
    },
  ]);
}

function getProviderAdvancedEditors(): LLMChatV2EditorDefinition {
  return group('Provider Advanced', [
    {
      type: 'keyValuePair',
      label: 'Headers',
      dataKey: 'headers',
      useInputToggleDataKey: 'useHeadersInput',
      keyPlaceholder: 'Header',
      valuePlaceholder: 'Value',
    },
    {
      type: 'code',
      label: 'Extra provider options',
      dataKey: 'extraProviderOptions',
      useInputToggleDataKey: 'useExtraProviderOptionsInput',
      language: 'json',
      helperMessage:
        'Adds these exact top-level JSON fields to the provider request body. Field names are preserved, and these values override generated request fields with the same name.',
      enableFolding: true,
    },
  ]);
}

function getErrorBehaviorEditors(): LLMChatV2EditorDefinition {
  return group('Error behavior', [
    {
      type: 'toggle',
      label: 'Retry on non-200',
      dataKey: 'retryOnNon200',
      helperMessage: 'Retries provider requests when Vercel reports a non-200 HTTP status.',
    },
    {
      type: 'number',
      label: 'Repeat times',
      dataKey: 'retryOnNon200RepeatTimes',
      defaultValue: DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
      min: 1,
      step: 1,
      layout: 'inline',
      helperMessage: 'Times to repeat after the initial request',
      hideIf: (data) => !data.retryOnNon200,
    },
    {
      type: 'number',
      label: 'Cooldown, ms',
      dataKey: 'retryOnNon200CooldownMs',
      defaultValue: DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
      min: 0,
      step: 1,
      layout: 'inline',
      helperMessage: 'Milliseconds to wait between repeats',
      hideIf: (data) => !data.retryOnNon200,
    },
  ]);
}

export async function getLLMChatV2Editors(
  data: LLMChatV2NodeData,
  context: RivetUIContext,
): Promise<EditorDefinition<LLMChatV2Node>[]> {
  const usesProfile = data.configurationMode === 'profile';

  return [
    {
      type: 'custom',
      label: 'Configuration',
      customEditorId: 'LLMChatV2Configuration',
    },
    ...(!usesProfile
      ? [
          getModelEditors(await getResolvedModelOptions(data, context)),
          ...getProviderEditors(),
          getParameterEditors(),
          ...(data.provider === 'custom' ? [] : [getReasoningEditors()]),
        ]
      : []),
    getResponseSettingsEditors(),
    getToolEditors(),
    getOutputEditors(),
    ...(!usesProfile ? [getProviderAdvancedEditors()] : []),
    getErrorBehaviorEditors(),
  ];
}

export async function getLLMProfileEditors(
  data: LLMChatV2ProfileData,
  context: RivetUIContext,
): Promise<EditorDefinition<LLMProfileEditorNode>[]> {
  const profileData = data as LLMChatV2NodeData;
  return [
    getModelEditors(await getResolvedModelOptions(profileData, context)),
    ...getProviderEditors(),
    getParameterEditors(),
    ...(profileData.provider === 'custom' ? [] : [getReasoningEditors()]),
    getCircuitBreakerEditors(),
    getProviderAdvancedEditors(),
  ] as unknown as EditorDefinition<LLMProfileEditorNode>[];
}
