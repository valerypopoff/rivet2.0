import { generateText, NoObjectGeneratedError, streamText } from 'ai';
import { consumeAiSdkStream } from '../chat/aiSdkStreaming.js';
import type {
  ChatV2GenerateHandle,
  ChatV2StreamExecutor,
  ChatV2StreamHandle,
  StreamChatV2Options,
  StreamChatV2Result,
  ChatV2StreamPart,
} from './chatV2Types.js';
import { ChatV2ProviderTimeoutError } from './chatV2Types.js';
import { isChatV2StructuredResponseFormat } from './chatV2ResponseFormat.js';

type GenerateTextArgs = Parameters<typeof generateText>[0];
type GenerateStepToolCall = NonNullable<ChatV2GenerateHandle['toolCalls']>[number];

function keepPromiseHandled<T>(value: PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(value);
  void promise.catch(() => undefined);
  return promise;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function markOptionalPromiseHandled(value: unknown): void {
  if (isPromiseLike(value)) {
    void keepPromiseHandled(value);
  }
}

function defaultStreamExecutor(args: Parameters<typeof streamText>[0]): ChatV2StreamHandle {
  const result = streamText(args);

  return {
    fullStream: result.fullStream,
    finishReason:
      'finishReason' in result
        ? keepPromiseHandled(
            Promise.resolve(result.finishReason).then((value) => (value == null ? undefined : String(value))),
          )
        : undefined,
    output:
      args.output != null && 'output' in result
        ? keepPromiseHandled(Promise.resolve(result.output as unknown))
        : undefined,
    providerMetadata:
      'providerMetadata' in result
        ? keepPromiseHandled(
            Promise.resolve(result.providerMetadata as unknown as StreamChatV2Result['providerMetadata']),
          )
        : undefined,
    requestStatus: 200,
    usage:
      'usage' in result
        ? keepPromiseHandled(Promise.resolve(result.usage as unknown as StreamChatV2Result['usage']))
        : undefined,
  };
}

async function defaultGenerateExecutor(args: Parameters<typeof generateText>[0]): Promise<ChatV2GenerateHandle> {
  return (await generateText(args)) as ChatV2GenerateHandle;
}

async function resolveOptionalValue<T>(value: T | PromiseLike<T> | undefined): Promise<T | undefined> {
  return value == null ? undefined : await value;
}

async function resolveOptionalStructuredOutput(value: unknown | PromiseLike<unknown> | undefined): Promise<unknown> {
  if (value == null) {
    return undefined;
  }

  try {
    return await value;
  } catch {
    return undefined;
  }
}

async function resolveGenerateStructuredOutput(
  result: ChatV2GenerateHandle,
  responseOutput: StreamChatV2Options['responseOutput'],
  finishReason: string | undefined,
): Promise<unknown> {
  if (responseOutput == null || (finishReason != null && finishReason !== 'stop')) {
    return undefined;
  }

  try {
    return await resolveOptionalStructuredOutput(result.output);
  } catch {
    return undefined;
  }
}

function recoverGenerateStructuredOutputError(
  error: unknown,
  options: StreamChatV2Options,
  toolCalls: ChatV2GenerateHandle['toolCalls'],
): StreamChatV2Result | undefined {
  if (options.responseOutput == null || !isChatV2StructuredResponseFormat(options.responseFormat)) {
    return undefined;
  }

  if (!NoObjectGeneratedError.isInstance(error)) {
    return undefined;
  }

  if (typeof error.text !== 'string') {
    return undefined;
  }

  const rawText = error.text;
  const responseText = collapseRepeatedStructuredJsonText(rawText);

  return {
    responseText,
    structuredOutput: undefined,
    functionCalls: toStreamedFunctionCalls(toolCalls),
    usage: error.usage,
    reasoning: '',
    finishReason: error.finishReason == null ? undefined : String(error.finishReason),
    providerMetadata: undefined,
    requestStatus: undefined,
  };
}

function attachGenerateStepToolCallCollector(args: GenerateTextArgs): ChatV2GenerateHandle['toolCalls'] {
  const toolCalls: GenerateStepToolCall[] = [];
  const previousOnStepFinish = args.onStepFinish;

  args.onStepFinish = async (event) => {
    const stepToolCalls = (event as { toolCalls?: readonly GenerateStepToolCall[] }).toolCalls;
    if (stepToolCalls != null) {
      toolCalls.push(...stepToolCalls);
    }

    await previousOnStepFinish?.(event);
  };

  return toolCalls;
}

function collapseRepeatedStructuredJsonText(responseText: string): string {
  if (responseText.length === 0 || responseText.length % 2 !== 0) {
    return responseText;
  }

  const midpoint = responseText.length / 2;
  const firstHalf = responseText.slice(0, midpoint);
  const firstNonWhitespaceCharacter = firstHalf.trimStart()[0];

  if (firstHalf !== responseText.slice(midpoint)) {
    return responseText;
  }

  if (firstNonWhitespaceCharacter !== '{' && firstNonWhitespaceCharacter !== '[') {
    return responseText;
  }

  try {
    JSON.parse(firstHalf);
    return firstHalf;
  } catch {
    return responseText;
  }
}

function buildTextArgs(options: StreamChatV2Options): Parameters<typeof streamText>[0] {
  const args: Parameters<typeof streamText>[0] = {
    model: options.model,
    messages: options.messages,
    maxRetries: options.maxRetries ?? 0,
  };

  if (options.tools !== undefined) args.tools = options.tools;
  if (options.maxTokens !== undefined) args.maxOutputTokens = options.maxTokens;
  if (options.temperature !== undefined) args.temperature = options.temperature;
  if (options.topP !== undefined) args.topP = options.topP;
  if (options.topK !== undefined) args.topK = options.topK;
  if (options.presencePenalty !== undefined) args.presencePenalty = options.presencePenalty;
  if (options.frequencyPenalty !== undefined) args.frequencyPenalty = options.frequencyPenalty;
  if (options.stopSequences !== undefined) args.stopSequences = options.stopSequences;
  if (options.seed !== undefined) args.seed = options.seed;
  if (options.responseOutput !== undefined) args.output = options.responseOutput;
  if (options.providerOptions !== undefined) args.providerOptions = options.providerOptions;
  if (options.toolChoice !== undefined) args.toolChoice = options.toolChoice;
  if (options.abortSignal !== undefined) args.abortSignal = options.abortSignal;

  return args;
}

function isUsefulStreamPart(part: unknown): boolean {
  const event = part as { type?: unknown; text?: unknown; delta?: unknown } | null;
  if (event?.type === 'tool-call') return true;
  if (event?.type === 'text-delta' || event?.type === 'reasoning-delta') {
    return typeof event.text === 'string' && event.text.length > 0;
  }
  if (event?.type === 'tool-input-delta') {
    return typeof event.delta === 'string' && event.delta.length > 0;
  }
  return false;
}

function timeoutPromise<T>(
  timeoutMs: number,
  kind: ChatV2ProviderTimeoutError['timeoutKind'],
  onTimeout: StreamChatV2Options['onTimeout'],
): { promise: Promise<T>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ChatV2ProviderTimeoutError(kind, timeoutMs);
      reject(error);
      try {
        onTimeout?.(error);
      } catch {
        // Timeout notification is cleanup-only and cannot replace the deadline.
      }
    }, timeoutMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer != null) clearTimeout(timer);
    },
  };
}

async function* streamWithDeadlines(
  stream: AsyncIterable<ChatV2StreamPart>,
  options: Pick<
    StreamChatV2Options,
    'firstOutputTimeoutMs' | 'streamInactivityTimeoutMs' | 'onTimeout' | 'onStreamActivity'
  >,
  firstOutputStartedAt: number,
): AsyncIterable<ChatV2StreamPart> {
  const iterator = stream[Symbol.asyncIterator]();
  let hasUsefulOutput = false;
  let lastUsefulOutputAt = firstOutputStartedAt;

  try {
    for (;;) {
      const kind = hasUsefulOutput ? 'stream-inactivity' : 'first-output';
      const configuredTimeout = hasUsefulOutput ? options.streamInactivityTimeoutMs : options.firstOutputTimeoutMs;
      const timeoutMs =
        configuredTimeout == null
          ? undefined
          : Math.max(1, configuredTimeout - (Date.now() - lastUsefulOutputAt));
      const timeout =
        timeoutMs == null ? undefined : timeoutPromise<IteratorResult<ChatV2StreamPart>>(timeoutMs, kind, options.onTimeout);
      let next: IteratorResult<ChatV2StreamPart>;
      try {
        next = await (timeout == null ? iterator.next() : Promise.race([iterator.next(), timeout.promise]));
      } finally {
        timeout?.cancel();
      }
      if (next.done) return;

      if (isUsefulStreamPart(next.value)) {
        hasUsefulOutput = true;
        lastUsefulOutputAt = Date.now();
        try {
          options.onStreamActivity?.();
        } catch {
          // Health lease renewal is observational and cannot break the stream.
        }
      }
      yield next.value;
    }
  } finally {
    try {
      const cleanup = iterator.return?.();
      if (cleanup != null) {
        void Promise.resolve(cleanup).catch(() => undefined);
      }
    } catch {
      // The deadline/consumer error remains authoritative over iterator cleanup.
    }
  }
}

async function waitForGeneratedResponse(
  executorPromise: Promise<ChatV2GenerateHandle>,
  options: StreamChatV2Options,
): Promise<ChatV2GenerateHandle> {
  if (options.firstOutputTimeoutMs == null) return await executorPromise;
  const timeout = timeoutPromise<ChatV2GenerateHandle>(
    options.firstOutputTimeoutMs,
    'first-output',
    options.onTimeout,
  );
  try {
    return await Promise.race([executorPromise, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

async function waitForPostResponseFinalization<T>(
  finalization: Promise<T>,
  options: StreamChatV2Options,
): Promise<T> {
  const timeoutMs = options.streamInactivityTimeoutMs ?? options.firstOutputTimeoutMs;
  if (timeoutMs == null) return await finalization;
  const timeout = timeoutPromise<T>(
    timeoutMs,
    options.streamInactivityTimeoutMs == null ? 'first-output' : 'stream-inactivity',
    options.onTimeout,
  );
  try {
    return await Promise.race([finalization, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

function toStreamedFunctionCalls(toolCalls: ChatV2GenerateHandle['toolCalls']) {
  return (toolCalls ?? []).map((toolCall) => ({
    type: 'function' as const,
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    arguments: JSON.stringify(toolCall.input),
    lastParsedArguments: toolCall.input,
  }));
}

async function resolveGenerateReasoning(result: ChatV2GenerateHandle): Promise<string> {
  const reasoningText = await resolveOptionalValue(result.reasoningText);
  if (reasoningText != null && reasoningText.trim().length > 0) {
    return reasoningText;
  }

  return (await resolveOptionalValue(result.reasoning))?.map((part) => part.text).join('') ?? '';
}

async function executeStream(
  options: StreamChatV2Options,
  executor: ChatV2StreamExecutor,
): Promise<StreamChatV2Result> {
  const args = buildTextArgs(options);
  const firstOutputStartedAt = Date.now();
  const handlePromise = Promise.resolve(executor(args));
  const handleTimeout =
    options.firstOutputTimeoutMs == null
      ? undefined
      : timeoutPromise<ChatV2StreamHandle>(options.firstOutputTimeoutMs, 'first-output', options.onTimeout);
  let handle: ChatV2StreamHandle;
  try {
    handle = await (handleTimeout == null ? handlePromise : Promise.race([handlePromise, handleTimeout.promise]));
  } finally {
    handleTimeout?.cancel();
  }
  markOptionalPromiseHandled(handle.finishReason);
  markOptionalPromiseHandled(handle.output);
  markOptionalPromiseHandled(handle.providerMetadata);
  markOptionalPromiseHandled(handle.requestStatus);
  markOptionalPromiseHandled(handle.usage);

  const isStructuredOutput = isChatV2StructuredResponseFormat(options.responseFormat);
  const streamed = await consumeAiSdkStream(
    streamWithDeadlines(handle.fullStream, options, firstOutputStartedAt),
    (text, functionCalls) => {
      options.onPartialOutput?.({
        text: isStructuredOutput ? collapseRepeatedStructuredJsonText(text) : text,
        functionCalls,
      });
    },
    {
      dedupeDuplicateTextBlocks: isStructuredOutput,
    },
  );
  const responseText = isStructuredOutput
    ? collapseRepeatedStructuredJsonText(streamed.responseText)
    : streamed.responseText;

  const [structuredOutput, usage, finishReason, providerMetadata, requestStatus] =
    await waitForPostResponseFinalization(
      Promise.all([
        options.responseOutput != null ? resolveOptionalStructuredOutput(handle.output) : undefined,
        streamed.usage != null ? streamed.usage : resolveOptionalValue(handle.usage),
        resolveOptionalValue(handle.finishReason),
        resolveOptionalValue(handle.providerMetadata),
        resolveOptionalValue(handle.requestStatus),
      ]),
      options,
    );

  return {
    responseText,
    structuredOutput,
    functionCalls: streamed.functionCalls,
    usage,
    reasoning: streamed.reasoning,
    finishReason,
    providerMetadata,
    requestStatus,
  };
}

export async function streamChatV2(options: StreamChatV2Options): Promise<StreamChatV2Result> {
  return executeStream(options, options.executeStream ?? defaultStreamExecutor);
}

export async function generateChatV2(options: StreamChatV2Options): Promise<StreamChatV2Result> {
  const args = buildTextArgs(options) as Parameters<typeof generateText>[0];
  const stepToolCalls = attachGenerateStepToolCallCollector(args);
  let result: ChatV2GenerateHandle;
  try {
    result = await waitForGeneratedResponse(
      Promise.resolve((options.executeGenerate ?? defaultGenerateExecutor)(args)),
      options,
    );
  } catch (error) {
    const recovered = recoverGenerateStructuredOutputError(error, options, stepToolCalls);
    if (recovered != null) {
      return recovered;
    }

    throw error;
  }

  const isStructuredOutput = isChatV2StructuredResponseFormat(options.responseFormat);
  const responseText = isStructuredOutput ? collapseRepeatedStructuredJsonText(result.text) : result.text;
  const [finishReason, structuredOutput, usage, reasoning, providerMetadata, requestStatus] =
    await waitForPostResponseFinalization(
      (async () => {
        const finishReason = await resolveOptionalValue(result.finishReason);
        const [structuredOutput, usage, reasoning, providerMetadata, requestStatus] = await Promise.all([
          resolveGenerateStructuredOutput(result, options.responseOutput, finishReason),
          (async () => (await resolveOptionalValue(result.totalUsage)) ?? (await resolveOptionalValue(result.usage)))(),
          resolveGenerateReasoning(result),
          resolveOptionalValue(result.providerMetadata),
          resolveOptionalValue(result.requestStatus),
        ]);
        return [finishReason, structuredOutput, usage, reasoning, providerMetadata, requestStatus] as const;
      })(),
      options,
    );

  return {
    responseText,
    structuredOutput,
    functionCalls: toStreamedFunctionCalls(
      result.toolCalls != null && result.toolCalls.length > 0 ? result.toolCalls : stepToolCalls,
    ),
    usage,
    reasoning,
    finishReason,
    providerMetadata,
    requestStatus,
  };
}
