import type { generateText, streamText, LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai';
import type { ChatMessage, GptFunction } from '../DataValue.js';
import type { Outputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { AssistantMessageFunctionCallMode, StreamedFunctionCall } from '../chat/streamChatResponse.js';
import type { ChatV2Provider } from './chatV2ProviderTypes.js';

export type { ChatV2Provider };

type StreamTextArgs = Parameters<typeof streamText>[0];
type GenerateTextArgs = Parameters<typeof generateText>[0];
type MaybePromiseLike<T> = T | PromiseLike<T>;

export type ChatV2Model = StreamTextArgs['model'];
export type ChatV2ProviderOptions = StreamTextArgs['providerOptions'];
export type ChatV2ToolSet = NonNullable<StreamTextArgs['tools']>;
export type ChatV2ToolChoice = StreamTextArgs['toolChoice'];
export type ChatV2ResponseOutput = StreamTextArgs['output'];
export type ChatV2MessageList = ModelMessage[];
export type ChatV2StreamPart = TextStreamPart<ToolSet>;
export type ChatV2ResponseFormatMode = 'text' | 'json' | 'json_schema';

export type ChatV2ProviderMetadata = Record<string, Record<string, unknown>>;
export type ChatV2ReasoningOutput = string | string[];

export type ChatV2NormalizedUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalCost: number | undefined;
};

export type ChatV2StreamHandle = {
  fullStream: AsyncIterable<ChatV2StreamPart>;
  finishReason?: MaybePromiseLike<string | undefined> | undefined;
  output?: MaybePromiseLike<unknown> | undefined;
  providerMetadata?: MaybePromiseLike<ChatV2ProviderMetadata | undefined> | undefined;
  requestStatus?: MaybePromiseLike<number | undefined> | undefined;
  usage?: MaybePromiseLike<LanguageModelUsage | undefined> | undefined;
};

export type ChatV2StreamExecutor = (args: StreamTextArgs) => ChatV2StreamHandle | Promise<ChatV2StreamHandle>;

export type ChatV2GenerateHandle = {
  text: string;
  output?: unknown;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  finishReason?: MaybePromiseLike<string | undefined> | undefined;
  reasoningText?: MaybePromiseLike<string | undefined> | undefined;
  reasoning?: MaybePromiseLike<Array<{ text: string }> | undefined> | undefined;
  providerMetadata?: MaybePromiseLike<ChatV2ProviderMetadata | undefined> | undefined;
  requestStatus?: MaybePromiseLike<number | undefined> | undefined;
  totalUsage?: MaybePromiseLike<LanguageModelUsage | undefined> | undefined;
  usage?: MaybePromiseLike<LanguageModelUsage | undefined> | undefined;
};

export type ChatV2GenerateExecutor = (args: GenerateTextArgs) => ChatV2GenerateHandle | Promise<ChatV2GenerateHandle>;

export type StreamChatV2Options = {
  model: ChatV2Model;
  messages: ChatV2MessageList;
  maxRetries?: 0 | undefined;
  tools?: ChatV2ToolSet | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  presencePenalty?: number | undefined;
  frequencyPenalty?: number | undefined;
  stopSequences?: string[] | undefined;
  seed?: number | undefined;
  responseOutput?: ChatV2ResponseOutput | undefined;
  responseFormat?: ChatV2ResponseFormatMode | undefined;
  providerOptions?: ChatV2ProviderOptions | undefined;
  toolChoice?: ChatV2ToolChoice | undefined;
  abortSignal?: AbortSignal | undefined;
  executeStream?: ChatV2StreamExecutor | undefined;
  executeGenerate?: ChatV2GenerateExecutor | undefined;
  onPartialOutput?: ((partial: { text: string; functionCalls: StreamedFunctionCall[] }) => void) | undefined;
};

export type StreamChatV2Result = {
  responseText: string;
  structuredOutput: unknown | undefined;
  functionCalls: StreamedFunctionCall[];
  usage: LanguageModelUsage | undefined;
  reasoning: string;
  finishReason: string | undefined;
  providerMetadata: ChatV2ProviderMetadata | undefined;
  requestStatus: number | undefined;
};

export type RunChatV2PipelineOptions = {
  provider: ChatV2Provider;
  model: ChatV2Model;
  modelId: string;
  prompt: unknown;
  systemPrompt?: unknown;
  functions?: GptFunction[] | undefined;
  additionalTools?: ChatV2ToolSet | undefined;
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  presencePenalty?: number | undefined;
  frequencyPenalty?: number | undefined;
  stopSequences?: string[] | undefined;
  seed?: number | undefined;
  responseOutput?: ChatV2ResponseOutput | undefined;
  responseFormat?: ChatV2ResponseFormatMode | undefined;
  providerOptions?: ChatV2ProviderOptions | undefined;
  toolChoice?: ChatV2ToolChoice | undefined;
  anthropicCacheControlTtl?: '5m' | '1h' | undefined;
  requestBodies?: unknown[] | undefined;
  outputUsage?: boolean | undefined;
  outputReasoning?: boolean | undefined;
  outputRequestStatus?: boolean | undefined;
  outputRequestError?: boolean | undefined;
  outputRequestBody?: boolean | undefined;
  includeFunctionCalls?: boolean | undefined;
  emitPartialOutputs?: boolean | undefined;
  functionCallMode?: AssistantMessageFunctionCallMode | undefined;
  retryOnNon200?: boolean | undefined;
  retryOnNon200RepeatTimes?: number | undefined;
  retryOnNon200CooldownMs?: number | undefined;
  /**
   * Internal, privacy-bounded metadata for an ordered LLM Profile fallback
   * chain. It is forwarded to physical-call observers but never sent to a
   * provider.
   */
  profileIndex?: number | undefined;
  roundIndex?: number | undefined;
  /** Internal physical-call trace used by the LLM Profile fallback coordinator. */
  onProviderAttempt?: ((attempt: ChatV2ProviderAttempt) => void) | undefined;
  context: Pick<InternalProcessContext, 'signal' | 'onPartialOutputs'> &
    Partial<Pick<InternalProcessContext, 'node' | 'onChatV2CallFinished' | 'processId'>>;
  executeStream?: ChatV2StreamExecutor | undefined;
  executeGenerate?: ChatV2GenerateExecutor | undefined;
};

/**
 * Older LLM Chat nodes used Output request details as one switch for status,
 * error, and request body. Keep that saved contract intact while newly saved
 * nodes use the independent controls.
 */
export function shouldOutputChatV2RequestError(
  options: Pick<RunChatV2PipelineOptions, 'outputRequestStatus' | 'outputRequestError'>,
): boolean {
  return options.outputRequestError ?? options.outputRequestStatus ?? false;
}

export function shouldOutputChatV2RequestBody(
  options: Pick<RunChatV2PipelineOptions, 'outputRequestStatus' | 'outputRequestBody'>,
): boolean {
  return options.outputRequestBody ?? options.outputRequestStatus ?? false;
}

export type ChatV2ProviderAttempt = {
  attemptIndex: number;
  outcome: 'success' | 'provider-failure';
  status?: number | undefined;
  error?: unknown;
};

export type ChatV2PipelineResult = {
  commonOutputs: Outputs;
  requestMessages: ChatMessage[];
  allMessages: ChatMessage[];
  response: string;
  functionCalls: StreamedFunctionCall[];
  reasoning: ChatV2ReasoningOutput;
  usage: ChatV2NormalizedUsage | undefined;
  rawUsage: LanguageModelUsage | undefined;
  finishReason: string | undefined;
  providerMetadata: ChatV2ProviderMetadata | undefined;
  requestStatus: number | undefined;
};
