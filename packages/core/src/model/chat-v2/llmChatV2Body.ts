import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';
import { getChatV2ModelInfo } from './modelRegistry.js';
import {
  anthropicEffortOptions,
  getChatV2ProviderLabel,
  googleThinkingLevelOptions,
  openAIReasoningEffortOptions,
} from './providerOptions.js';

export type LLMChatV2BodyField = Readonly<{
  label: string;
  value: string;
}>;

export type LLMChatV2BodySection = Readonly<{
  id: 'configuration' | 'model' | 'parameters';
  fields: readonly LLMChatV2BodyField[];
}>;

function getOptionLabel(options: readonly { value: string; label: string }[], value: string | undefined): string {
  return options.find((option) => option.value === (value ?? ''))?.label ?? value ?? 'Default';
}

function getProviderBodyLabel(data: LLMChatV2NodeData): string {
  return data.provider === 'custom' ? 'Custom' : getChatV2ProviderLabel(data.provider);
}

function getCustomProviderBaseURLBodyValue(data: LLMChatV2NodeData): string | undefined {
  if (data.provider !== 'custom') {
    return undefined;
  }

  if (data.useCustomProviderBaseURLInput) {
    return '(Using Input)';
  }

  const baseURL = data.customProviderBaseURL.trim();
  return baseURL || undefined;
}

function getReasoningEffortBodyValue(data: LLMChatV2NodeData): string | undefined {
  switch (data.provider) {
    case 'openai':
      return getOptionLabel(openAIReasoningEffortOptions, data.openAIReasoningEffort);
    case 'anthropic':
      return getOptionLabel(anthropicEffortOptions, data.anthropicEffort);
    case 'google':
      return getOptionLabel(googleThinkingLevelOptions, data.googleThinkingLevel);
    case 'custom':
      return undefined;
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

/**
 * Stable canvas presentation data for an LLM Chat's local configuration.
 * Profile mode deliberately exposes only invocation-owned settings because the
 * provider configuration comes from the connected LLM Profile value at runtime.
 */
export function getLLMChatV2BodySections(data: LLMChatV2NodeData): readonly LLMChatV2BodySection[] {
  if (data.configurationMode === 'profile') {
    const behaviorFields: LLMChatV2BodyField[] = [
      ...(data.useToolCalling ? [{ label: 'Tools', value: 'Enabled' }] : []),
      ...(data.responseFormat ? [{ label: 'Response format', value: data.responseFormat }] : []),
    ];
    const sections: LLMChatV2BodySection[] = [
      { id: 'configuration', fields: [{ label: 'Configuration', value: 'From LLM Profiles input' }] },
      ...(behaviorFields.length > 0 ? [{ id: 'parameters' as const, fields: behaviorFields }] : []),
    ];
    return sections;
  }

  const modelInfo = getChatV2ModelInfo(data.provider, data.model);
  const modelFields: Array<LLMChatV2BodyField | undefined> = [
    { label: 'Provider', value: getProviderBodyLabel(data) },
    (() => {
      const baseURL = getCustomProviderBaseURLBodyValue(data);
      return baseURL ? { label: 'Base URL', value: baseURL } : undefined;
    })(),
    { label: 'Model', value: modelInfo?.displayName ?? data.model },
  ];
  const parameterFields: Array<LLMChatV2BodyField | undefined> = [
    (() => {
      const reasoningEffort = getReasoningEffortBodyValue(data);
      return reasoningEffort ? { label: 'Reasoning effort', value: reasoningEffort } : undefined;
    })(),
    { label: 'Temperature', value: data.useTemperatureInput ? '(Using Input)' : `${data.temperature}` },
    { label: 'Max output tokens', value: data.useMaxTokensInput ? '(Using Input)' : `${data.maxTokens}` },
    getOptionalNumberBodyField('Top P', data.topP, data.useTopPInput),
    getOptionalNumberBodyField('Top K', data.topK, data.useTopKInput),
    getOptionalNumberBodyField('Presence penalty', data.presencePenalty, data.usePresencePenaltyInput),
    getOptionalNumberBodyField('Frequency penalty', data.frequencyPenalty, data.useFrequencyPenaltyInput),
    getStopSequencesBodyField(data),
    getOptionalNumberBodyField('Seed', data.seed, data.useSeedInput),
  ];

  const sections: LLMChatV2BodySection[] = [
    { id: 'model', fields: modelFields.filter((field): field is LLMChatV2BodyField => field !== undefined) },
    { id: 'parameters', fields: parameterFields.filter((field): field is LLMChatV2BodyField => field !== undefined) },
  ];

  return sections.filter((section) => section.fields.length > 0);
}
