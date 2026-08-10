import type { ChatV2ResponseFormat } from './chatV2ResponseFormat.js';
import { createChatV2CommonNodeData, type ChatV2CommonNodeData } from './chatV2Shared.js';
import {
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
} from './chatV2Retry.js';
import type { ChatV2Provider } from './chatV2Types.js';
import type { ChartNode, NodeId } from '../NodeBase.js';
import { llmProfileDataKeys } from './llmProfileFieldRegistry.js';
import type { CustomProviderApi } from './customProviderApi.js';

export type { CustomProviderApi } from './customProviderApi.js';

export type LLMChatV2ToolChoiceMode = '' | 'auto' | 'function' | 'required';
export type LLMChatV2ApiKeySource = 'environment' | 'input';
export type LLMChatV2ConfigurationMode = 'inline' | 'profile';
export type LLMChatV2NodeConfigData = ChatV2CommonNodeData & {
  configurationMode?: LLMChatV2ConfigurationMode;
  provider: ChatV2Provider;
  apiKeySource?: LLMChatV2ApiKeySource;
  customProviderApiKeyProgrammaticName?: string;
  customProviderApiKeyEnvVarName?: string;
  customProviderBaseURL: string;
  useCustomProviderBaseURLInput: boolean;
  /** Missing on legacy/programmatically-created nodes means Chat Completions. */
  customProviderApi?: CustomProviderApi;
  baseURL: string;
  useBaseURLInput: boolean;
  headers: { key: string; value: string }[];
  useHeadersInput: boolean;
  extraProviderOptions: string;
  useExtraProviderOptionsInput: boolean;
  openAIReasoningEffort: string;
  openAIReasoningSummary: string;
  openAIPreviousResponseId: string;
  useOpenAIPreviousResponseIdInput: boolean;
  enableOpenAIWebSearch: boolean;
  openAIWebSearchContextSize: 'low' | 'medium' | 'high';
  enableOpenAICodeInterpreter: boolean;
  anthropicThinkingMode: '' | 'adaptive' | 'enabled' | 'disabled';
  anthropicThinkingBudget?: number;
  useAnthropicThinkingBudgetInput: boolean;
  anthropicEffort?: '' | 'low' | 'medium' | 'high' | 'max';
  anthropicCacheControlTtl: '' | '5m' | '1h';
  googleThinkingBudget?: number;
  useGoogleThinkingBudgetInput: boolean;
  googleThinkingLevel?: '' | 'minimal' | 'low' | 'medium' | 'high';
  googleIncludeThoughts?: boolean;
  enableGoogleSearchGrounding: boolean;
  enableGoogleUrlContext: boolean;
  responseFormat?: ChatV2ResponseFormat;
  responseSchemaName?: string;
  useResponseSchemaNameInput?: boolean;
  responseSchemaDescription?: string;
  useResponseSchemaDescriptionInput?: boolean;
  toolChoice?: LLMChatV2ToolChoiceMode;
  toolChoiceFunction?: string;
  parallelToolCalls?: boolean;
  autoContinueToolCalls?: boolean;
  maxToolRounds?: number;
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  outputLLMAttempts?: boolean;
  outputRequestBody?: boolean;
  outputResponseBody?: boolean;
};

export type LLMChatV2NodeData = LLMChatV2NodeConfigData;
export type LLMChatV2Node = ChartNode<'llmChatV2', LLMChatV2NodeData>;

/** @deprecated Use llmProfileDataKeys from llmProfileFieldRegistry instead. */
export const llmChatV2ProfileDataKeys = llmProfileDataKeys;

export type LLMChatV2ProfileDataKey = (typeof llmChatV2ProfileDataKeys)[number];
export type LLMChatV2ProfileData = Pick<LLMChatV2NodeData, LLMChatV2ProfileDataKey>;

export type LLMChatV2EditorCacheKeyParts = {
  /** Bump when cache identity semantics change; entries are editor-memory only. */
  cacheVersion?: number;
  nodeId: NodeId;
  nodeData: LLMChatV2NodeData;
  provider: ChatV2Provider;
  modelId: string;
  providerConfig: unknown;
  apiKeyFingerprint?: string;
  prompt: unknown;
  systemPrompt: unknown;
  functions: unknown;
  generationParameters: unknown;
  responseFormatParameters: unknown;
  providerOptions: unknown;
  requestBodyOverlay?: unknown;
  toolChoice: unknown;
  /** Ordered, credential-fingerprinted fallback profile configuration. */
  profileChain?: unknown;
};

export function createLLMChatV2NodeData(): LLMChatV2NodeData {
  return {
    ...createChatV2CommonNodeData({
      model: 'gpt-5',
    }),
    configurationMode: 'inline',
    provider: 'openai',
    apiKeySource: 'environment',
    customProviderApiKeyProgrammaticName: '',
    customProviderApiKeyEnvVarName: 'CUSTOM_PROVIDER_API_KEY',
    customProviderBaseURL: '',
    useCustomProviderBaseURLInput: false,
    customProviderApi: 'completions',
    baseURL: '',
    useBaseURLInput: false,
    headers: [],
    useHeadersInput: false,
    extraProviderOptions: '',
    useExtraProviderOptionsInput: false,
    openAIReasoningEffort: '',
    openAIReasoningSummary: '',
    openAIPreviousResponseId: '',
    useOpenAIPreviousResponseIdInput: false,
    enableOpenAIWebSearch: false,
    openAIWebSearchContextSize: 'medium',
    enableOpenAICodeInterpreter: false,
    anthropicThinkingMode: '',
    anthropicThinkingBudget: undefined,
    useAnthropicThinkingBudgetInput: false,
    anthropicEffort: '',
    anthropicCacheControlTtl: '',
    googleThinkingBudget: undefined,
    useGoogleThinkingBudgetInput: false,
    googleThinkingLevel: '',
    googleIncludeThoughts: false,
    enableGoogleSearchGrounding: false,
    enableGoogleUrlContext: false,
    responseFormat: '',
    responseSchemaName: '',
    useResponseSchemaNameInput: false,
    responseSchemaDescription: '',
    useResponseSchemaDescriptionInput: false,
    toolChoice: '',
    toolChoiceFunction: '',
    parallelToolCalls: false,
    autoContinueToolCalls: false,
    maxToolRounds: 3,
    retryOnNon200: false,
    retryOnNon200RepeatTimes: DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
    retryOnNon200CooldownMs: DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
    outputLLMAttempts: false,
    outputRequestBody: false,
    outputResponseBody: false,
  };
}

export function shouldIncludeLLMChatV2ToolCalls(data: LLMChatV2NodeData): boolean {
  return data.useToolCalling;
}
