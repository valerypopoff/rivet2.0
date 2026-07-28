import type { ChatMessage } from '../DataValue.js';
import type { PortId } from '../NodeBase.js';
import { coercePromptToChatMessages, prependSystemPrompt } from '../chat/chatMessages.js';
import { generateChatV2, streamChatV2 } from './aiSdkBridge.js';
import { createObservedChatV2CallId, notifyChatV2CallFinished } from './chatV2CallObserver.js';
import { chatMessagesToModelMessages } from './messageConverter.js';
import type {
  ChatV2ProviderAttempt,
  ChatV2PipelineResult,
  RunChatV2PipelineOptions,
  StreamChatV2Result,
  StreamChatV2Options,
} from './chatV2Types.js';
import { chatV2ToolsToAiSdk } from './toolConverter.js';
import { buildChatV2RequestPlan, type ChatV2RequestPlan } from './chatV2RequestPlan.js';
import {
  getChatV2ProviderErrorStatusCode,
  isChatV2ProviderApiCallError,
  isChatV2ProviderFetchError,
  normalizeChatV2ProviderError,
} from './chatV2Errors.js';
import { waitForLLMChatV2RetryCooldown } from './chatV2Retry.js';
import {
  createChatV2CommonOutputs,
  createChatV2ProviderFailureOutputs,
  normalizeChatV2Usage,
} from './chatV2Outputs.js';

type ChatV2WithRetryResult = {
  result: StreamChatV2Result;
  requestStatuses: number[];
  requestErrors: unknown[];
  responseError?: unknown;
};

export type ChatV2PipelineProviderFailure = {
  requestMessages: ChatMessage[];
  options: RunChatV2PipelineOptions;
  plan: ChatV2RequestPlan;
  normalizedError: unknown;
  rawError: unknown;
  requestStatuses: number[];
  requestErrors: string[];
  /** A completed non-200 custom stream may still have a useful response body. */
  diagnosticResult?: ChatV2PipelineResult;
};

export type ChatV2PipelineExecution =
  | {
      outcome: 'success';
      result: ChatV2PipelineResult;
    }
  | {
      outcome: 'provider-failure';
      failure: ChatV2PipelineProviderFailure;
    };

class ChatV2RetryFailure extends Error {
  constructor(
    public readonly error: unknown,
    public readonly requestStatuses: number[],
    public readonly requestErrors: unknown[],
  ) {
    super('Chat v2 retry attempts failed');
    this.name = 'ChatV2RetryFailure';
  }
}

function isChatV2RetryFailure(error: unknown): error is ChatV2RetryFailure {
  return error instanceof ChatV2RetryFailure;
}

function getProviderFailureMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
  } catch {
    return 'Provider request failed with unreadable error metadata.';
  }

  try {
    return String(error);
  } catch {
    return 'Provider request failed with unreadable error metadata.';
  }
}

function buildNon200StatusError(statusCode: number): Error & { statusCode: number } {
  const error = new Error(`Provider request returned non-200 status: ${statusCode}`) as Error & {
    statusCode: number;
  };
  error.name = 'AI_APICallError';
  error.statusCode = statusCode;
  return error;
}

function normalizeProviderFailureMessage(
  error: unknown,
  options: Pick<RunChatV2PipelineOptions, 'provider' | 'modelId'>,
): string {
  return getProviderFailureMessage(normalizeProviderFailure(error, options));
}

function normalizeProviderFailure(
  error: unknown,
  options: Pick<RunChatV2PipelineOptions, 'provider' | 'modelId'>,
): unknown {
  try {
    return normalizeChatV2ProviderError(error, {
      provider: options.provider,
      modelId: options.modelId,
    });
  } catch {
    return error;
  }
}

function normalizeProviderFailureMessages(
  errors: unknown[],
  options: Pick<RunChatV2PipelineOptions, 'provider' | 'modelId'>,
): string[] {
  return errors.map((error) => normalizeProviderFailureMessage(error, options));
}

function notifyProviderAttempt(options: RunChatV2PipelineOptions, attempt: ChatV2ProviderAttempt): void {
  try {
    options.onProviderAttempt?.(attempt);
  } catch {
    // Attempt diagnostics are observational and must never affect the request.
  }
}

async function runChatV2WithRetry(
  options: RunChatV2PipelineOptions,
  chatOptions: StreamChatV2Options,
  retryPlan: ChatV2RequestPlan['retry'],
  signal: AbortSignal,
  transportMode: ChatV2RequestPlan['transportMode'],
): Promise<ChatV2WithRetryResult> {
  const requestStatuses: number[] = [];
  const requestErrors: unknown[] = [];

  for (let attempt = 0; ; attempt++) {
    const callId = createObservedChatV2CallId(options);
    let callWasObserved = false;
    try {
      const result = transportMode === 'generate' ? await generateChatV2(chatOptions) : await streamChatV2(chatOptions);
      const statusCode = result.requestStatus ?? 200;
      notifyChatV2CallFinished(options, {
        callId,
        attemptIndex: attempt,
        outcome: statusCode === 200 ? 'success' : 'provider-failure',
        result,
      });
      callWasObserved = true;

      notifyProviderAttempt(options, {
        attemptIndex: attempt,
        outcome: statusCode === 200 ? 'success' : 'provider-failure',
        status: statusCode,
        ...(statusCode === 200 ? {} : { error: buildNon200StatusError(statusCode) }),
      });

      if (retryPlan.enabled) {
        requestStatuses.push(statusCode);
      }

      if (!retryPlan.enabled || statusCode === 200) {
        return { result, requestStatuses, requestErrors };
      }

      const responseError = buildNon200StatusError(statusCode);
      requestErrors.push(responseError);

      if (attempt >= retryPlan.repeatTimes) {
        return { result, requestStatuses, requestErrors, responseError };
      }

      await waitForLLMChatV2RetryCooldown(retryPlan.cooldownMs, signal);
    } catch (error) {
      if (!callWasObserved) {
        notifyChatV2CallFinished(options, {
          callId,
          attemptIndex: attempt,
          outcome: signal.aborted ? 'aborted' : 'provider-failure',
          error,
        });
      }
      const statusCode = getChatV2ProviderErrorStatusCode(error);
      notifyProviderAttempt(options, {
        attemptIndex: attempt,
        outcome: 'provider-failure',
        ...(statusCode == null ? {} : { status: statusCode }),
        error,
      });

      if (!retryPlan.enabled || statusCode == null || statusCode === 200) {
        throw error;
      }

      requestStatuses.push(statusCode);
      requestErrors.push(error);

      if (attempt >= retryPlan.repeatTimes) {
        throw new ChatV2RetryFailure(error, requestStatuses, requestErrors);
      }

      await waitForLLMChatV2RetryCooldown(retryPlan.cooldownMs, signal);
    }
  }
}

function buildProviderFailureResult(
  requestMessages: ChatMessage[],
  options: RunChatV2PipelineOptions,
  plan: ChatV2RequestPlan,
  normalizedError: unknown,
  rawError: unknown,
  requestStatuses: number[],
  requestErrors: string[],
): ChatV2PipelineResult | undefined {
  if (!plan.output.outputRequestStatus && !plan.output.outputRequestError) {
    return undefined;
  }

  const statusCode = getChatV2ProviderErrorStatusCode(normalizedError);
  if (statusCode == null && !isChatV2ProviderApiCallError(rawError) && !isChatV2ProviderFetchError(rawError)) {
    return undefined;
  }
  const responseError = getProviderFailureMessage(normalizedError);
  const retryRequestStatuses = plan.retry.enabled
    ? requestStatuses.length > 0
      ? requestStatuses
      : statusCode == null
        ? []
        : [statusCode]
    : [];
  const retryRequestErrors = plan.retry.enabled ? (requestErrors.length > 0 ? requestErrors : [responseError]) : [];

  const commonOutputs = createChatV2ProviderFailureOutputs({
    requestMessages,
    responseStatus: statusCode,
    responseError,
    requestStatuses: retryRequestStatuses,
    requestErrors: retryRequestErrors,
    requestBodies: options.requestBodies,
    outputUsage: plan.output.outputUsage,
    outputReasoning: plan.output.outputReasoning,
    outputRequestStatus: plan.output.outputRequestStatus,
    outputRequestError: plan.output.outputRequestError,
    outputRequestBody: plan.output.outputRequestBody,
    includeFunctionCalls: plan.output.includeFunctionCalls,
    retryOnNon200: plan.retry.enabled,
  });
  const allMessagesOutput = commonOutputs['all-messages' as PortId];

  if (allMessagesOutput?.type !== 'chat-message[]') {
    throw new Error('Chat v2 provider failure expected all-messages output to be chat-message[].');
  }

  return {
    commonOutputs,
    requestMessages,
    allMessages: allMessagesOutput.value,
    response: '',
    functionCalls: [],
    reasoning: '',
    usage: undefined,
    rawUsage: undefined,
    finishReason: undefined,
    providerMetadata: undefined,
    requestStatus: statusCode,
  };
}

/**
 * Runs one provider/model round without deciding whether a provider failure
 * should become diagnostic outputs or should advance an LLM Profile fallback
 * chain. Shared prompt/schema/tool construction errors deliberately continue
 * to throw: they are graph configuration errors, not a profile failure.
 */
export async function runChatV2PipelineExecution(options: RunChatV2PipelineOptions): Promise<ChatV2PipelineExecution> {
  const requestMessages = prependSystemPrompt(
    coercePromptToChatMessages(options.prompt, { requirePrompt: true }),
    options.systemPrompt,
  );
  const modelMessages = await chatMessagesToModelMessages(requestMessages, {
    provider: options.provider,
    anthropicCacheControlTtl: options.anthropicCacheControlTtl,
  });
  const functionTools =
    options.functions != null && options.functions.length > 0 ? chatV2ToolsToAiSdk(options.functions) : undefined;
  const tools =
    functionTools == null
      ? options.additionalTools
      : options.additionalTools == null
        ? functionTools
        : { ...functionTools, ...options.additionalTools };
  const plan = buildChatV2RequestPlan({
    ...options,
    messages: modelMessages,
    tools,
  });
  const shouldStreamResponse = plan.transportMode === 'stream';

  let chatResponse: ChatV2WithRetryResult;
  try {
    chatResponse = await runChatV2WithRetry(
      options,
      {
        ...plan.request,
        abortSignal: options.context.signal,
        executeStream: options.executeStream,
        executeGenerate: options.executeGenerate,
        onPartialOutput: !shouldStreamResponse
          ? undefined
          : ({ text, functionCalls }) => {
              options.context.onPartialOutputs?.(
                createChatV2CommonOutputs({
                  requestMessages,
                  response: text,
                  structuredOutput: undefined,
                  functionCalls,
                  usage: undefined,
                  reasoning: '',
                  requestStatus: undefined,
                  responseError: undefined,
                  requestStatuses: [],
                  requestErrors: [],
                  requestBodies: undefined,
                  outputUsage: false,
                  outputReasoning: false,
                  outputRequestStatus: false,
                  outputRequestError: false,
                  outputRequestBody: false,
                  includeFunctionCalls: plan.output.includeFunctionCalls,
                  functionCallMode: plan.output.functionCallMode,
                  retryOnNon200: false,
                  responseFormat: undefined,
                }),
              );
            },
      },
      plan.retry,
      options.context.signal,
      plan.transportMode,
    );
  } catch (caughtError) {
    if (options.context.signal.aborted) {
      throw caughtError;
    }

    const retryFailure = isChatV2RetryFailure(caughtError) ? caughtError : undefined;
    const rawError = retryFailure?.error ?? caughtError;
    return {
      outcome: 'provider-failure',
      failure: {
        requestMessages,
        options,
        plan,
        normalizedError: normalizeProviderFailure(rawError, options),
        rawError,
        requestStatuses: retryFailure?.requestStatuses ?? [],
        requestErrors: normalizeProviderFailureMessages(retryFailure?.requestErrors ?? [], options),
      },
    };
  }

  const usage = normalizeChatV2Usage(chatResponse.result.usage, options);
  const requestStatuses = chatResponse.requestStatuses;
  const requestStatus = chatResponse.result.requestStatus ?? 200;
  const requestErrors = normalizeProviderFailureMessages(chatResponse.requestErrors, options);
  const responseError = chatResponse.responseError
    ? normalizeProviderFailureMessage(chatResponse.responseError, options)
    : undefined;
  const commonOutputs = createChatV2CommonOutputs({
    requestMessages,
    response: chatResponse.result.responseText,
    structuredOutput: chatResponse.result.structuredOutput,
    functionCalls: chatResponse.result.functionCalls,
    usage,
    reasoning: chatResponse.result.reasoning,
    requestStatus,
    responseError,
    requestStatuses,
    requestErrors,
    requestBodies: options.requestBodies,
    outputUsage: plan.output.outputUsage,
    outputReasoning: plan.output.outputReasoning,
    outputRequestStatus: plan.output.outputRequestStatus,
    outputRequestError: plan.output.outputRequestError,
    outputRequestBody: plan.output.outputRequestBody,
    includeFunctionCalls: plan.output.includeFunctionCalls,
    functionCallMode: plan.output.functionCallMode,
    retryOnNon200: plan.retry.enabled,
    responseFormat: plan.request.responseFormat,
  });
  const allMessagesOutput = commonOutputs['all-messages' as PortId];

  if (allMessagesOutput?.type !== 'chat-message[]') {
    throw new Error('Chat v2 pipeline expected all-messages output to be chat-message[].');
  }

  const result: ChatV2PipelineResult = {
    commonOutputs,
    requestMessages,
    allMessages: allMessagesOutput.value,
    response: chatResponse.result.responseText,
    functionCalls: chatResponse.result.functionCalls,
    reasoning: chatResponse.result.reasoning,
    usage,
    rawUsage: chatResponse.result.usage,
    finishReason: chatResponse.result.finishReason,
    providerMetadata: chatResponse.result.providerMetadata,
    requestStatus,
  };

  const providerRoundFailure =
    chatResponse.responseError ?? (requestStatus === 200 ? undefined : buildNon200StatusError(requestStatus));
  if (providerRoundFailure != null) {
    const rawError = providerRoundFailure;
    return {
      outcome: 'provider-failure',
      failure: {
        requestMessages,
        options,
        plan,
        normalizedError: normalizeProviderFailure(rawError, options),
        rawError,
        requestStatuses: chatResponse.requestStatuses,
        requestErrors: normalizeProviderFailureMessages(chatResponse.requestErrors, options),
        diagnosticResult: result,
      },
    };
  }

  return { outcome: 'success', result };
}

/**
 * Retains the established single-profile behavior: request-detail mode can
 * turn a provider failure into normal excluded outputs; otherwise it remains
 * a thrown normalized provider error.
 */
export function materializeChatV2PipelineFailure(failure: ChatV2PipelineProviderFailure): ChatV2PipelineResult {
  if (failure.diagnosticResult != null) {
    return failure.diagnosticResult;
  }
  const failureResult = buildProviderFailureResult(
    failure.requestMessages,
    failure.options,
    failure.plan,
    failure.normalizedError,
    failure.rawError,
    failure.requestStatuses,
    failure.requestErrors,
  );
  if (failureResult != null) {
    return failureResult;
  }

  throw failure.normalizedError;
}

export async function runChatV2Pipeline(options: RunChatV2PipelineOptions): Promise<ChatV2PipelineResult> {
  const execution = await runChatV2PipelineExecution(options);
  return execution.outcome === 'success' ? execution.result : materializeChatV2PipelineFailure(execution.failure);
}
