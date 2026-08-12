import type { generateText, streamText, LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai';
import type { ChatMessage, GptFunction } from '../DataValue.js';
import type { Outputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { AssistantMessageFunctionCallMode, StreamedFunctionCall } from '../chat/streamChatResponse.js';
import type { ChatV2Provider } from './chatV2ProviderTypes.js';
import type { ChatV2ResponseBodyCapture } from './chatV2ResponseBodyCapture.js';
import type { CustomProviderApi } from './customProviderApi.js';
import type { RivetLLMProfileHealthState } from './llmProfileHealthStore.js';

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
  /** Deadline to the first semantic stream event, or the complete generate response. */
  firstOutputTimeoutMs?: number | undefined;
  /** Maximum gap between events after the first semantic stream event. */
  streamInactivityTimeoutMs?: number | undefined;
  /** Internal hook used to abort the physical provider request on a deadline. */
  onTimeout?: ((error: ChatV2ProviderTimeoutError) => void) | undefined;
  /** Internal activity hook used to renew a half-open circuit probe lease. */
  onStreamActivity?: (() => void) | undefined;
  /** Internal hook used to keep one half-open probe exclusive across a retry cooldown. */
  onBeforeProviderRetry?: ((cooldownMs: number) => void | Promise<void>) | undefined;
};

export class ChatV2ProviderTimeoutError extends Error {
  readonly code = 'RIVET_LLM_PROVIDER_TIMEOUT';

  constructor(
    public readonly timeoutKind: 'first-output' | 'stream-inactivity',
    public readonly timeoutMs: number,
  ) {
    super(
      timeoutKind === 'first-output'
        ? `LLM provider did not produce a useful response within ${timeoutMs} ms.`
        : `LLM provider stream produced no activity for ${timeoutMs} ms.`,
    );
    this.name = 'ChatV2ProviderTimeoutError';
  }
}

export function isChatV2ProviderTimeoutError(error: unknown): error is ChatV2ProviderTimeoutError {
  return error instanceof ChatV2ProviderTimeoutError;
}

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
  responseBodies?: unknown[] | undefined;
  responseBodyCapture?: ChatV2ResponseBodyCapture | undefined;
  outputUsage?: boolean | undefined;
  outputReasoning?: boolean | undefined;
  outputRequestBody?: boolean | undefined;
  outputResponseBody?: boolean | undefined;
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
  profileHealthKey?: string | undefined;
  profileHealthState?: RivetLLMProfileHealthState | undefined;
  roundIndex?: number | undefined;
  /** Selected wire contract for Custom-provider calls. Never sent to the provider. */
  customProviderApi?: CustomProviderApi | undefined;
  /** Internal physical-call trace used by the LLM Profile fallback coordinator. */
  onProviderAttempt?: ((attempt: ChatV2ProviderAttempt) => void) | undefined;
  firstOutputTimeoutMs?: number | undefined;
  streamInactivityTimeoutMs?: number | undefined;
  onStreamActivity?: (() => void) | undefined;
  onBeforeProviderRetry?: ((cooldownMs: number) => void | Promise<void>) | undefined;
  context: Pick<InternalProcessContext, 'signal' | 'onPartialOutputs'> &
    Partial<Pick<InternalProcessContext, 'node' | 'onChatV2CallFinished' | 'processId'>>;
  executeStream?: ChatV2StreamExecutor | undefined;
  executeGenerate?: ChatV2GenerateExecutor | undefined;
};

/** Provider-neutral per-round fields. Candidate resolution supplies the model. */
export type ChatV2PipelineRoundOptions = Omit<RunChatV2PipelineOptions, 'model'>;

export function shouldOutputChatV2RequestBody(options: Pick<RunChatV2PipelineOptions, 'outputRequestBody'>): boolean {
  return options.outputRequestBody === true;
}

/** New diagnostics are opt-in; old status-detail nodes never expose responses. */
export function shouldOutputChatV2ResponseBody(options: Pick<RunChatV2PipelineOptions, 'outputResponseBody'>): boolean {
  return options.outputResponseBody === true;
}

export type ChatV2ProviderAttempt = {
  attemptIndex: number;
  outcome: 'success' | 'provider-failure' | 'aborted';
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
  /**
   * Internal terminal classification for a provider request that produced
   * diagnostic outputs instead of throwing. A non-200 response can still
   * carry partial text or tool-like data; it must never enter tool
   * continuation as though the provider completed successfully.
   */
  terminalOutcome?: 'provider-failure' | undefined;
};
