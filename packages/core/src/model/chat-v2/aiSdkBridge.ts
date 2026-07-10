import { generateText, NoObjectGeneratedError, streamText } from 'ai';
import { consumeAiSdkStream } from '../chat/aiSdkStreaming.js';
import type {
  ChatV2GenerateHandle,
  ChatV2StreamExecutor,
  ChatV2StreamHandle,
  StreamChatV2Options,
  StreamChatV2Result,
} from './chatV2Types.js';
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
  const handle = await executor(args);
  markOptionalPromiseHandled(handle.finishReason);
  markOptionalPromiseHandled(handle.output);
  markOptionalPromiseHandled(handle.providerMetadata);
  markOptionalPromiseHandled(handle.requestStatus);
  markOptionalPromiseHandled(handle.usage);

  const isStructuredOutput = isChatV2StructuredResponseFormat(options.responseFormat);
  const streamed = await consumeAiSdkStream(
    handle.fullStream,
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

  return {
    responseText,
    structuredOutput: options.responseOutput != null ? await resolveOptionalStructuredOutput(handle.output) : undefined,
    functionCalls: streamed.functionCalls,
    usage: streamed.usage ?? (await resolveOptionalValue(handle.usage)),
    reasoning: streamed.reasoning,
    finishReason: await resolveOptionalValue(handle.finishReason),
    providerMetadata: await resolveOptionalValue(handle.providerMetadata),
    requestStatus: await resolveOptionalValue(handle.requestStatus),
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
    result = await (options.executeGenerate ?? defaultGenerateExecutor)(args);
  } catch (error) {
    const recovered = recoverGenerateStructuredOutputError(error, options, stepToolCalls);
    if (recovered != null) {
      return recovered;
    }

    throw error;
  }

  const isStructuredOutput = isChatV2StructuredResponseFormat(options.responseFormat);
  const responseText = isStructuredOutput ? collapseRepeatedStructuredJsonText(result.text) : result.text;
  const finishReason = await resolveOptionalValue(result.finishReason);

  return {
    responseText,
    structuredOutput: await resolveGenerateStructuredOutput(result, options.responseOutput, finishReason),
    functionCalls: toStreamedFunctionCalls(
      result.toolCalls != null && result.toolCalls.length > 0 ? result.toolCalls : stepToolCalls,
    ),
    usage: (await resolveOptionalValue(result.totalUsage)) ?? (await resolveOptionalValue(result.usage)),
    reasoning: await resolveGenerateReasoning(result),
    finishReason,
    providerMetadata: await resolveOptionalValue(result.providerMetadata),
    requestStatus: await resolveOptionalValue(result.requestStatus),
  };
}
