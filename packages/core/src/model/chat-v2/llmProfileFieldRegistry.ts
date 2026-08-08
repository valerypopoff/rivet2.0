import type { LLMChatV2NodeData } from './llmChatV2NodeData.js';

/**
 * Static ownership metadata for fields supplied by an LLM Profile.
 *
 * This deliberately does not attempt to describe editor layout or provider
 * request construction. It provides the one fact those surfaces must share:
 * which persisted LLM Chat fields are profile-owned, and which dynamic input
 * ports a resolved profile consumes before it is passed to LLM Chat.
 */
export type LLMProfileFieldSpec = {
  key: keyof LLMChatV2NodeData;
  inputId?: string;
  /** Runtime validation for scalar fields; enum and collection fields keep named validators. */
  valueKind?: 'string' | 'boolean' | 'required-number' | 'optional-number';
  /** A resolved profile must never retain an active dynamic-input toggle. */
  resolvedInputToggle?: boolean;
};

export const llmProfileFieldSpecs = [
  { key: 'model', inputId: 'model', valueKind: 'string' },
  { key: 'useModelInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'temperature', inputId: 'temperature', valueKind: 'required-number' },
  { key: 'useTemperatureInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'topP', inputId: 'topP', valueKind: 'optional-number' },
  { key: 'useTopPInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'topK', inputId: 'topK', valueKind: 'optional-number' },
  { key: 'useTopKInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'presencePenalty', inputId: 'presencePenalty', valueKind: 'optional-number' },
  { key: 'usePresencePenaltyInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'frequencyPenalty', inputId: 'frequencyPenalty', valueKind: 'optional-number' },
  { key: 'useFrequencyPenaltyInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'stopSequences', inputId: 'stopSequences' },
  { key: 'useStopSequencesInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'seed', inputId: 'seed', valueKind: 'optional-number' },
  { key: 'useSeedInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'maxTokens', inputId: 'maxTokens', valueKind: 'required-number' },
  { key: 'useMaxTokensInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'provider' },
  { key: 'apiKeySource', inputId: 'apiKey' },
  { key: 'customProviderApiKeyProgrammaticName', valueKind: 'string' },
  { key: 'customProviderApiKeyEnvVarName', valueKind: 'string' },
  { key: 'customProviderBaseURL', inputId: 'customProviderBaseURL', valueKind: 'string' },
  { key: 'useCustomProviderBaseURLInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'customProviderApi' },
  { key: 'headers', inputId: 'headers' },
  { key: 'useHeadersInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'extraProviderOptions', inputId: 'extraProviderOptions', valueKind: 'string' },
  { key: 'useExtraProviderOptionsInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'openAIReasoningEffort', valueKind: 'string' },
  { key: 'openAIReasoningSummary', valueKind: 'string' },
  { key: 'openAIPreviousResponseId', inputId: 'previousResponseId', valueKind: 'string' },
  { key: 'useOpenAIPreviousResponseIdInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'enableOpenAIWebSearch', valueKind: 'boolean' },
  { key: 'openAIWebSearchContextSize' },
  { key: 'enableOpenAICodeInterpreter', valueKind: 'boolean' },
  { key: 'anthropicThinkingMode' },
  { key: 'anthropicThinkingBudget', inputId: 'anthropicThinkingBudget', valueKind: 'optional-number' },
  { key: 'useAnthropicThinkingBudgetInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'anthropicEffort' },
  { key: 'anthropicCacheControlTtl' },
  { key: 'googleThinkingBudget', inputId: 'googleThinkingBudget', valueKind: 'optional-number' },
  { key: 'useGoogleThinkingBudgetInput', valueKind: 'boolean', resolvedInputToggle: true },
  { key: 'googleThinkingLevel' },
  { key: 'googleIncludeThoughts', valueKind: 'boolean' },
  { key: 'enableGoogleSearchGrounding', valueKind: 'boolean' },
  { key: 'enableGoogleUrlContext', valueKind: 'boolean' },
] as const satisfies readonly LLMProfileFieldSpec[];

export const llmProfileDataKeys = llmProfileFieldSpecs.map((field) => field.key);

export const llmProfileInputIds = llmProfileFieldSpecs
  .flatMap((field) => ('inputId' in field ? [field.inputId] : []))
  .filter((inputId, index, inputIds) => inputIds.indexOf(inputId) === index);

function keysForValueKind(valueKind: NonNullable<LLMProfileFieldSpec['valueKind']>) {
  return llmProfileFieldSpecs
    .filter((field) => 'valueKind' in field && field.valueKind === valueKind)
    .map((field) => field.key) as Array<keyof LLMChatV2NodeData>;
}

/** Runtime validation categories for resolved LLM Profile values. */
export const llmProfileStringDataKeys = keysForValueKind('string');
export const llmProfileBooleanDataKeys = keysForValueKind('boolean');
export const llmProfileRequiredNumberDataKeys = keysForValueKind('required-number');
export const llmProfileOptionalNumberDataKeys = keysForValueKind('optional-number');

/** A serialized profile must be self-contained, not driven by hidden ports. */
export const llmProfileResolvedInputToggleDataKeys = llmProfileFieldSpecs
  .filter((field) => 'resolvedInputToggle' in field && field.resolvedInputToggle)
  .map((field) => field.key) as Array<keyof LLMChatV2NodeData>;
