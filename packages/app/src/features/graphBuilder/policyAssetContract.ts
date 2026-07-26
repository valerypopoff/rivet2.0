import type { LLMChatV2NodeData } from '@valerypopoff/rivet2-core';

/**
 * Shared, data-only authority for the checked Graph Builder policy asset.
 *
 * The runtime validator and the asset generator/checker deliberately retain
 * independent validation code, but they must agree on these exact identities,
 * topology edges, and sealed LLM fields.
 */
export const GRAPH_BUILDER_POLICY_ASSET_PATH = 'packages/app/graphs/graph-builder-policy.rivet-project';
export const GRAPH_BUILDER_POLICY_PROJECT_ID = 'graph-builder-policy-project-v1';
export const GRAPH_BUILDER_POLICY_VERSION = 'graph-builder-policy-v1';

export const GRAPH_BUILDER_POLICY_IDS = Object.freeze({
  project: GRAPH_BUILDER_POLICY_PROJECT_ID,
  schema: Object.freeze({
    graph: 'graph-builder-policy-schema-v1',
    policyTurnInput: 'gbps-policy-turn-input',
    responseSchemaInput: 'gbps-response-schema-input',
    systemPrompt: 'gbps-system-prompt',
    llm: 'gbps-llm',
    decisionOutput: 'gbps-decision-output',
  }),
  text: Object.freeze({
    graph: 'graph-builder-policy-text-v1',
    policyTurnInput: 'gbpt-policy-turn-input',
    systemPrompt: 'gbpt-system-prompt',
    llm: 'gbpt-llm',
    decisionOutput: 'gbpt-decision-output',
  }),
});

export const GRAPH_BUILDER_POLICY_ALLOWED_NODE_TYPES = Object.freeze([
  'graphInput',
  'text',
  'llmChatV2',
  'graphOutput',
] as const);

export const GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS = Object.freeze([
  'provider',
  'model',
  'customProviderBaseURL',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'maxTokens',
  'openAIReasoningEffort',
  'openAIReasoningSummary',
  'anthropicThinkingMode',
  'anthropicThinkingBudget',
  'anthropicEffort',
  'anthropicCacheControlTtl',
  'googleThinkingBudget',
  'googleThinkingLevel',
  'googleIncludeThoughts',
] as const satisfies readonly (keyof LLMChatV2NodeData)[]);

export const GRAPH_BUILDER_POLICY_SEALED_FALSE_LLM_DATA_KEYS = Object.freeze([
  'useModelInput',
  'useTemperatureInput',
  'useTopPInput',
  'useTopKInput',
  'usePresencePenaltyInput',
  'useFrequencyPenaltyInput',
  'useStopSequencesInput',
  'useSeedInput',
  'useMaxTokensInput',
  'useToolCalling',
  'outputUsage',
  'outputReasoning',
  'cache',
  'useAsGraphPartialOutput',
  'useCustomProviderBaseURLInput',
  'useBaseURLInput',
  'useHeadersInput',
  'useExtraProviderOptionsInput',
  'useOpenAIPreviousResponseIdInput',
  'enableOpenAIWebSearch',
  'enableOpenAICodeInterpreter',
  'useAnthropicThinkingBudgetInput',
  'useGoogleThinkingBudgetInput',
  'googleIncludeThoughts',
  'enableGoogleSearchGrounding',
  'enableGoogleUrlContext',
  'useResponseSchemaNameInput',
  'useResponseSchemaDescriptionInput',
  'parallelToolCalls',
  'autoContinueToolCalls',
  'retryOnNon200',
  'outputRequestStatus',
] as const satisfies readonly (keyof LLMChatV2NodeData)[]);

export const GRAPH_BUILDER_POLICY_SEALED_EMPTY_LLM_DATA_KEYS = Object.freeze([
  'customProviderApiKeyProgrammaticName',
  'customProviderApiKeyEnvVarName',
  'customProviderBaseURL',
  'baseURL',
  'extraProviderOptions',
  'openAIPreviousResponseId',
  'toolChoice',
  'toolChoiceFunction',
] as const satisfies readonly (keyof LLMChatV2NodeData)[]);

export const GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS = Object.freeze({
  schema: Object.freeze([
    Object.freeze(['gbps-policy-turn-input', 'data', 'gbps-llm', 'prompt'] as const),
    Object.freeze(['gbps-response-schema-input', 'data', 'gbps-llm', 'responseSchema'] as const),
    Object.freeze(['gbps-system-prompt', 'output', 'gbps-llm', 'systemPrompt'] as const),
    Object.freeze(['gbps-llm', 'response', 'gbps-decision-output', 'value'] as const),
  ]),
  text: Object.freeze([
    Object.freeze(['gbpt-policy-turn-input', 'data', 'gbpt-llm', 'prompt'] as const),
    Object.freeze(['gbpt-system-prompt', 'output', 'gbpt-llm', 'systemPrompt'] as const),
    Object.freeze(['gbpt-llm', 'response', 'gbpt-decision-output', 'value'] as const),
  ]),
} as const);
