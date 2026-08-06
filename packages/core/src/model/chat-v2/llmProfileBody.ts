import type { LLMChatV2ProfileData } from './llmChatV2NodeData.js';
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

export type LLMProfileBodyField = Readonly<{
  label: string;
  value: string;
}>;

export type LLMProfileBodySnippet = Readonly<{
  label: string;
  text: string;
}>;

export type LLMProfileBodySection = Readonly<{
  id: 'model' | 'parameters' | 'provider' | 'advanced';
  fields: readonly LLMProfileBodyField[];
  snippet?: LLMProfileBodySnippet | undefined;
}>;

function getOptionLabel(options: readonly { value: string; label: string }[], value: unknown): string {
  const optionValue = typeof value === 'string' ? value : '';
  return options.find((option) => option.value === optionValue)?.label ?? (optionValue || 'Default');
}

function getOptionalNumberBodyField(
  label: string,
  value: number | undefined,
  usesInput: boolean,
): LLMProfileBodyField | undefined {
  if (usesInput) {
    return { label, value: '(Using Input)' };
  }

  return value === undefined ? undefined : { label, value: `${value}` };
}

function getOptionalStringBodyField(
  label: string,
  value: unknown,
  usesInput: boolean,
): LLMProfileBodyField | undefined {
  if (usesInput) {
    return { label, value: '(Using Input)' };
  }

  return typeof value === 'string' && value.trim().length > 0 ? { label, value } : undefined;
}

function getCustomProviderBodyLabel(api: LLMChatV2ProfileData['customProviderApi']): string {
  try {
    return getCustomProviderApiContract(api).label;
  } catch {
    // Corrupt hand-authored project data must not prevent canvas rendering.
    // Runtime profile validation still rejects it before a request.
    return `Custom (${String(api)})`;
  }
}

function getModelBodyLabel(data: LLMChatV2ProfileData): string {
  if (data.useModelInput) {
    return '(Using Input)';
  }

  try {
    return getChatV2ModelInfo(data.provider, data.model)?.displayName ?? String(data.model);
  } catch {
    return String(data.model);
  }
}

function getProviderBodyFields(data: LLMChatV2ProfileData): LLMProfileBodyField[] {
  switch (data.provider) {
    case 'openai':
      return [
        getOptionalStringBodyField(
          'Previous response ID',
          data.openAIPreviousResponseId,
          data.useOpenAIPreviousResponseIdInput,
        ),
        ...(data.openAIReasoningEffort
          ? [
              {
                label: 'Reasoning effort',
                value: getOptionLabel(openAIReasoningEffortOptions, data.openAIReasoningEffort),
              },
            ]
          : []),
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
      ].filter((field): field is LLMProfileBodyField => field !== undefined);
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
        ...(data.anthropicEffort
          ? [{ label: 'Effort', value: getOptionLabel(anthropicEffortOptions, data.anthropicEffort) }]
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
      ].filter((field): field is LLMProfileBodyField => field !== undefined);
    case 'google':
      return [
        ...(data.googleThinkingLevel
          ? [{ label: 'Thinking level', value: getOptionLabel(googleThinkingLevelOptions, data.googleThinkingLevel) }]
          : []),
        getOptionalNumberBodyField('Thinking budget', data.googleThinkingBudget, data.useGoogleThinkingBudgetInput),
        ...(data.googleIncludeThoughts ? [{ label: 'Include thoughts', value: 'Enabled' }] : []),
        ...(data.enableGoogleSearchGrounding ? [{ label: 'Google search grounding', value: 'Enabled' }] : []),
        ...(data.enableGoogleUrlContext ? [{ label: 'URL context', value: 'Enabled' }] : []),
      ].filter((field): field is LLMProfileBodyField => field !== undefined);
    case 'custom':
    default:
      return [];
  }
}

function getHeadersBodyField(data: LLMChatV2ProfileData): LLMProfileBodyField | undefined {
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

function getStopSequencesBodyField(data: LLMChatV2ProfileData): LLMProfileBodyField | undefined {
  if (data.useStopSequencesInput) {
    return { label: 'Stop sequences', value: '(Using Input)' };
  }

  const stopSequences = Array.isArray(data.stopSequences)
    ? data.stopSequences.filter((sequence): sequence is string => typeof sequence === 'string' && sequence.length > 0)
    : [];
  return stopSequences.length > 0
    ? { label: 'Stop sequences', value: stopSequences.map((sequence) => JSON.stringify(sequence)).join(', ') }
    : undefined;
}

/**
 * Stable canvas presentation data for LLM Profile configuration. It deliberately
 * contains stored configuration only: runtime API-key values are never present
 * in the node data and therefore cannot be rendered here.
 */
export function getLLMProfileBodySections(data: LLMChatV2ProfileData): readonly LLMProfileBodySection[] {
  const modelFields: Array<LLMProfileBodyField | undefined> = [
    {
      label: 'Provider',
      value:
        data.provider === 'custom'
          ? getCustomProviderBodyLabel(data.customProviderApi)
          : getChatV2ProviderLabel(data.provider),
    },
    ...(data.provider === 'custom'
      ? [getOptionalStringBodyField('Base URL', data.customProviderBaseURL, data.useCustomProviderBaseURLInput)]
      : []),
    { label: 'Model', value: getModelBodyLabel(data) },
    { label: 'API key source', value: data.apiKeySource === 'input' ? 'Input port' : 'Configured key' },
    ...(data.provider === 'custom' && data.apiKeySource !== 'input'
      ? [
          data.customProviderApiKeyProgrammaticName?.trim()
            ? { label: 'Alternative programmatic key', value: data.customProviderApiKeyProgrammaticName }
            : undefined,
          data.customProviderApiKeyEnvVarName?.trim()
            ? { label: 'Alternative API key env var', value: data.customProviderApiKeyEnvVarName }
            : undefined,
        ]
      : []),
  ];
  const parameterFields: Array<LLMProfileBodyField | undefined> = [
    { label: 'Temperature', value: data.useTemperatureInput ? '(Using Input)' : `${data.temperature}` },
    { label: 'Max output tokens', value: data.useMaxTokensInput ? '(Using Input)' : `${data.maxTokens}` },
    getOptionalNumberBodyField('Top P', data.topP, data.useTopPInput),
    getOptionalNumberBodyField('Top K', data.topK, data.useTopKInput),
    getOptionalNumberBodyField('Presence penalty', data.presencePenalty, data.usePresencePenaltyInput),
    getOptionalNumberBodyField('Frequency penalty', data.frequencyPenalty, data.useFrequencyPenaltyInput),
    getStopSequencesBodyField(data),
    getOptionalNumberBodyField('Seed', data.seed, data.useSeedInput),
  ];
  const advancedFields = [
    getHeadersBodyField(data),
    ...(data.useExtraProviderOptionsInput ? [{ label: 'Extra provider options', value: '(Using Input)' }] : []),
  ];
  const extraProviderOptions =
    !data.useExtraProviderOptionsInput &&
    typeof data.extraProviderOptions === 'string' &&
    data.extraProviderOptions.trim().length > 0
      ? { label: 'Extra provider options', text: data.extraProviderOptions }
      : undefined;

  const sections: LLMProfileBodySection[] = [
    { id: 'model', fields: modelFields.filter((field): field is LLMProfileBodyField => field !== undefined) },
    { id: 'parameters', fields: parameterFields.filter((field): field is LLMProfileBodyField => field !== undefined) },
    { id: 'provider', fields: getProviderBodyFields(data) },
    {
      id: 'advanced',
      fields: advancedFields.filter((field): field is LLMProfileBodyField => field !== undefined),
      snippet: extraProviderOptions,
    },
  ];

  return sections.filter((section) => section.fields.length > 0 || section.snippet !== undefined);
}
