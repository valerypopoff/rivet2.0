import {
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
} from './chatV2Retry.js';
import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';
import { getChatV2ModelInfo } from './modelRegistry.js';
import {
  anthropicCacheControlTtlOptions,
  anthropicEffortOptions,
  anthropicThinkingModeOptions,
  getChatV2ProviderLabel,
  getCustomProviderApiContract,
  googleThinkingLevelOptions,
  openAIReasoningEffortOptions,
  openAIWebSearchContextSizeOptions,
} from './providerOptions.js';

export type LLMChatV2BodyField = Readonly<{
  label: string;
  value: string;
}>;

export type LLMChatV2BodySnippet = Readonly<{
  label: string;
  text: string;
}>;

export type LLMChatV2BodySection = Readonly<{
  id:
    | 'configuration'
    | 'model'
    | 'parameters'
    | 'provider'
    | 'response-format'
    | 'tools'
    | 'behavior'
    | 'advanced'
    | 'error';
  fields: readonly LLMChatV2BodyField[];
  snippet?: LLMChatV2BodySnippet | undefined;
}>;

function getOptionLabel(options: readonly { value: string; label: string }[], value: unknown): string {
  const optionValue = typeof value === 'string' ? value : '';
  return options.find((option) => option.value === optionValue)?.label ?? (optionValue || 'Default');
}

function getProviderBodyLabel(data: LLMChatV2NodeData): string {
  return data.provider === 'custom' ? 'Custom' : getChatV2ProviderLabel(data.provider);
}

function getModelBodyValue(data: LLMChatV2NodeData): string {
  if (data.useModelInput) {
    return '(Using Input)';
  }

  try {
    return getChatV2ModelInfo(data.provider, data.model)?.displayName ?? data.model;
  } catch {
    // Hand-authored/corrupt projects should remain inspectable on the canvas.
    return data.model;
  }
}

function getCustomProviderBaseURLBodyValue(data: LLMChatV2NodeData): string | undefined {
  if (data.provider !== 'custom') {
    return undefined;
  }

  if (data.useCustomProviderBaseURLInput) {
    return '(Using Input)';
  }

  const baseURL = typeof data.customProviderBaseURL === 'string' ? data.customProviderBaseURL.trim() : '';
  return baseURL || undefined;
}

function getCustomProviderApiBodyField(data: LLMChatV2NodeData): LLMChatV2BodyField | undefined {
  if (data.provider !== 'custom') {
    return undefined;
  }

  try {
    const api = getCustomProviderApiContract(data.customProviderApi);
    return api.api === 'completions' ? undefined : { label: 'API', value: api.label };
  } catch {
    return { label: 'API', value: `Unsupported (${String(data.customProviderApi)})` };
  }
}

function getOptionalNumberBodyField(
  label: string,
  value: number | undefined,
  usesInput: boolean,
): LLMChatV2BodyField | undefined {
  if (usesInput) {
    return { label, value: '(Using Input)' };
  }

  return value === undefined ? undefined : { label, value: `${value}` };
}

function getOptionalStringBodyField(label: string, value: unknown, usesInput: boolean): LLMChatV2BodyField | undefined {
  if (usesInput) {
    return { label, value: '(Using Input)' };
  }

  return typeof value === 'string' && value.trim().length > 0 ? { label, value } : undefined;
}

function getStopSequencesBodyField(data: LLMChatV2NodeData): LLMChatV2BodyField | undefined {
  if (data.useStopSequencesInput) {
    return { label: 'Stop sequences', value: '(Using Input)' };
  }

  const stopSequences = Array.isArray(data.stopSequences)
    ? data.stopSequences.filter((sequence): sequence is string => typeof sequence === 'string' && sequence.length > 0)
    : [];
  return stopSequences.length === 0
    ? undefined
    : { label: 'Stop sequences', value: stopSequences.map((sequence) => JSON.stringify(sequence)).join(', ') };
}

function getHeadersBodyField(data: LLMChatV2NodeData): LLMChatV2BodyField | undefined {
  if (data.useHeadersInput) {
    return { label: 'Headers', value: '(Using Input)' };
  }

  const headers = Array.isArray(data.headers)
    ? data.headers.filter(
        (header): header is { key: string; value: string } =>
          typeof header?.key === 'string' && header.key.trim().length > 0 && typeof header.value === 'string',
      )
    : [];
  return headers.length > 0
    ? { label: 'Headers', value: headers.map(({ key, value }) => `${key}: ${value}`).join(', ') }
    : undefined;
}

function getProviderBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  switch (data.provider) {
    case 'openai':
      return [
        getOptionalStringBodyField(
          'Previous response ID',
          data.openAIPreviousResponseId,
          data.useOpenAIPreviousResponseIdInput,
        ),
        ...(data.openAIReasoningSummary ? [{ label: 'Reasoning summary', value: data.openAIReasoningSummary }] : []),
        ...(data.enableOpenAIWebSearch
          ? [
              {
                label: 'Web search',
                value: `Enabled (${getOptionLabel(openAIWebSearchContextSizeOptions, data.openAIWebSearchContextSize)})`,
              },
            ]
          : []),
        ...(data.enableOpenAICodeInterpreter ? [{ label: 'Code interpreter', value: 'Enabled' }] : []),
      ].filter((field): field is LLMChatV2BodyField => field !== undefined);
    case 'anthropic':
      return [
        ...(data.anthropicThinkingMode
          ? [
              {
                label: 'Thinking mode',
                value: getOptionLabel(anthropicThinkingModeOptions, data.anthropicThinkingMode),
              },
            ]
          : []),
        getOptionalNumberBodyField(
          'Thinking budget',
          data.anthropicThinkingBudget,
          data.useAnthropicThinkingBudgetInput,
        ),
        ...(data.anthropicCacheControlTtl
          ? [
              {
                label: 'Cache breakpoint TTL',
                value: getOptionLabel(anthropicCacheControlTtlOptions, data.anthropicCacheControlTtl),
              },
            ]
          : []),
      ].filter((field): field is LLMChatV2BodyField => field !== undefined);
    case 'google':
      return [
        getOptionalNumberBodyField('Thinking budget', data.googleThinkingBudget, data.useGoogleThinkingBudgetInput),
        ...(data.googleIncludeThoughts ? [{ label: 'Include thoughts', value: 'Enabled' }] : []),
        ...(data.enableGoogleSearchGrounding ? [{ label: 'Google search grounding', value: 'Enabled' }] : []),
        ...(data.enableGoogleUrlContext ? [{ label: 'URL context', value: 'Enabled' }] : []),
      ].filter((field): field is LLMChatV2BodyField => field !== undefined);
    case 'custom':
    default:
      return [];
  }
}

function getResponseFormatBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  if (!data.responseFormat) {
    return [];
  }

  const responseFormatLabel =
    data.responseFormat === 'json_schema' ? 'JSON schema' : data.responseFormat === 'json' ? 'JSON object' : 'Text';
  const hasSchemaMetadata = data.responseFormat === 'json' || data.responseFormat === 'json_schema';
  return [
    { label: 'Response format', value: responseFormatLabel },
    ...(hasSchemaMetadata
      ? [
          getOptionalStringBodyField('Schema name', data.responseSchemaName, !!data.useResponseSchemaNameInput),
          getOptionalStringBodyField(
            'Schema description',
            data.responseSchemaDescription,
            !!data.useResponseSchemaDescriptionInput,
          ),
        ]
      : []),
  ].filter((field): field is LLMChatV2BodyField => field !== undefined);
}

function getToolBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  if (!data.useToolCalling) {
    return [];
  }

  return [
    { label: 'Tool use', value: 'Enabled' },
    ...(data.toolChoice
      ? [
          {
            label: 'Tool choice',
            value:
              data.toolChoice === 'function'
                ? data.toolChoiceFunction?.trim()
                  ? `Specific tool (${data.toolChoiceFunction})`
                  : 'Specific tool'
                : data.toolChoice === 'required'
                  ? 'Required'
                  : 'Auto',
          },
        ]
      : []),
    ...(data.parallelToolCalls ? [{ label: 'Parallel toolcalls', value: 'Enabled' }] : []),
    ...(data.autoContinueToolCalls
      ? [
          { label: 'Auto-continue toolcalls', value: 'Enabled' },
          { label: 'Maximum tool rounds', value: `${data.maxToolRounds ?? 3}` },
        ]
      : []),
  ];
}

function getBehaviorBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  return [
    ...(data.useAsGraphPartialOutput === false ? [{ label: 'Stream response', value: 'Disabled' }] : []),
    ...(data.cache ? [{ label: 'Editor cache (legacy)', value: 'Enabled' }] : []),
  ];
}

function getErrorBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  if (!data.retryOnNon200) {
    return [];
  }

  const repeatTimes = data.retryOnNon200RepeatTimes ?? DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES;
  const cooldownMs = data.retryOnNon200CooldownMs ?? DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS;
  return [
    { label: 'Retry on non-200', value: 'Enabled' },
    { label: 'Repeat times', value: `${repeatTimes}` },
    { label: 'Cooldown, ms', value: `${cooldownMs}` },
  ];
}

function getAdvancedBodySection(data: LLMChatV2NodeData): LLMChatV2BodySection {
  const extraProviderOptions =
    !data.useExtraProviderOptionsInput &&
    typeof data.extraProviderOptions === 'string' &&
    data.extraProviderOptions.trim().length > 0
      ? { label: 'Extra provider options', text: data.extraProviderOptions }
      : undefined;

  return {
    id: 'advanced',
    fields: [
      getHeadersBodyField(data),
      ...(data.useExtraProviderOptionsInput ? [{ label: 'Extra provider options', value: '(Using Input)' }] : []),
    ].filter((field): field is LLMChatV2BodyField => field !== undefined),
    snippet: extraProviderOptions,
  };
}

function getInlineModelBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  const customBaseURL = getCustomProviderBaseURLBodyValue(data);
  return [
    { label: 'Provider', value: getProviderBodyLabel(data) },
    getCustomProviderApiBodyField(data),
    customBaseURL ? { label: 'Base URL', value: customBaseURL } : undefined,
    { label: 'Model', value: getModelBodyValue(data) },
    ...(data.apiKeySource === 'input' ? [{ label: 'API key source', value: 'Input port' }] : []),
    ...(data.provider === 'custom' && data.apiKeySource !== 'input'
      ? [
          data.customProviderApiKeyProgrammaticName?.trim()
            ? { label: 'Alternative programmatic key', value: data.customProviderApiKeyProgrammaticName }
            : undefined,
          data.customProviderApiKeyEnvVarName?.trim() &&
          data.customProviderApiKeyEnvVarName !== 'CUSTOM_PROVIDER_API_KEY'
            ? { label: 'Alternative API key env var', value: data.customProviderApiKeyEnvVarName }
            : undefined,
        ]
      : []),
  ].filter((field): field is LLMChatV2BodyField => field !== undefined);
}

function getParameterBodyFields(data: LLMChatV2NodeData): LLMChatV2BodyField[] {
  const reasoningEffort =
    data.provider === 'openai'
      ? getOptionLabel(openAIReasoningEffortOptions, data.openAIReasoningEffort)
      : data.provider === 'anthropic'
        ? getOptionLabel(anthropicEffortOptions, data.anthropicEffort)
        : data.provider === 'google'
          ? getOptionLabel(googleThinkingLevelOptions, data.googleThinkingLevel)
          : undefined;

  return [
    ...(reasoningEffort ? [{ label: 'Reasoning effort', value: reasoningEffort }] : []),
    { label: 'Temperature', value: data.useTemperatureInput ? '(Using Input)' : `${data.temperature}` },
    { label: 'Max output tokens', value: data.useMaxTokensInput ? '(Using Input)' : `${data.maxTokens}` },
    getOptionalNumberBodyField('Top P', data.topP, data.useTopPInput),
    getOptionalNumberBodyField('Top K', data.topK, data.useTopKInput),
    getOptionalNumberBodyField('Presence penalty', data.presencePenalty, data.usePresencePenaltyInput),
    getOptionalNumberBodyField('Frequency penalty', data.frequencyPenalty, data.useFrequencyPenaltyInput),
    getStopSequencesBodyField(data),
    getOptionalNumberBodyField('Seed', data.seed, data.useSeedInput),
  ].filter((field): field is LLMChatV2BodyField => field !== undefined);
}

function getInvocationSections(data: LLMChatV2NodeData): LLMChatV2BodySection[] {
  const sections: LLMChatV2BodySection[] = [
    { id: 'response-format', fields: getResponseFormatBodyFields(data) },
    { id: 'tools', fields: getToolBodyFields(data) },
    { id: 'behavior', fields: getBehaviorBodyFields(data) },
    { id: 'error', fields: getErrorBodyFields(data) },
  ];
  return sections.filter((section) => section.fields.length > 0);
}

/**
 * Stable canvas presentation data for LLM Chat configuration.
 *
 * Inline mode exposes its local model/provider settings plus every active
 * invocation setting. Profile mode deliberately exposes only invocation-owned
 * settings because provider configuration comes from the connected LLM Profile
 * value at runtime. Output toggles are intentionally omitted: their ports are
 * already the canonical canvas indication that an output is enabled.
 */
export function getLLMChatV2BodySections(data: LLMChatV2NodeData): readonly LLMChatV2BodySection[] {
  if (data.configurationMode === 'profile') {
    const sections: LLMChatV2BodySection[] = [
      { id: 'configuration', fields: [{ label: 'Configuration', value: 'From LLM Profiles input' }] },
      ...getInvocationSections(data),
    ];
    return sections;
  }

  const advancedSection = getAdvancedBodySection(data);
  const sections: LLMChatV2BodySection[] = [
    { id: 'model', fields: getInlineModelBodyFields(data) },
    { id: 'parameters', fields: getParameterBodyFields(data) },
    { id: 'provider', fields: getProviderBodyFields(data) },
    ...getInvocationSections(data),
    advancedSection,
  ];
  return sections.filter((section) => section.fields.length > 0 || section.snippet !== undefined);
}
