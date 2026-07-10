import type { ChatV2ResponseFormat } from './chatV2ResponseFormat.js';
import { createChatV2CommonNodeData, type ChatV2CommonNodeData } from './chatV2Shared.js';
import {
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES,
} from './chatV2Retry.js';
import type { ChatV2Provider } from './chatV2Types.js';
import type { ChartNode, NodeId } from '../NodeBase.js';

export type LLMChatV2ToolChoiceMode = '' | 'auto' | 'function' | 'required';
export type LLMChatV2ApiKeySource = 'environment' | 'input';

export type LLMChatV2NodeConfigData = ChatV2CommonNodeData & {
  provider: ChatV2Provider;
  apiKeySource?: LLMChatV2ApiKeySource;
  customProviderApiKeyProgrammaticName?: string;
  customProviderApiKeyEnvVarName?: string;
  customProviderBaseURL: string;
  useCustomProviderBaseURLInput: boolean;
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
  outputRequestStatus?: boolean;
};

export type LLMChatV2NodeData = LLMChatV2NodeConfigData;
export type LLMChatV2Node = ChartNode<'llmChatV2', LLMChatV2NodeData>;

export type LLMChatV2EditorCacheKeyParts = {
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
  toolChoice: unknown;
};

export function createLLMChatV2NodeData(): LLMChatV2NodeData {
  return {
    ...createChatV2CommonNodeData({
      model: 'gpt-5',
    }),
    provider: 'openai',
    apiKeySource: 'environment',
    customProviderApiKeyProgrammaticName: '',
    customProviderApiKeyEnvVarName: 'CUSTOM_PROVIDER_API_KEY',
    customProviderBaseURL: '',
    useCustomProviderBaseURLInput: false,
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
    outputRequestStatus: false,
  };
}

export function hasLLMChatV2BuiltInToolsEnabled(data: LLMChatV2NodeData): boolean {
  return (
    (data.provider === 'openai' && (data.enableOpenAIWebSearch || data.enableOpenAICodeInterpreter)) ||
    (data.provider === 'google' && (data.enableGoogleSearchGrounding || data.enableGoogleUrlContext))
  );
}
