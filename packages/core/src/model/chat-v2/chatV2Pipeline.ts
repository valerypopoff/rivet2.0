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
import { isChatV2ProviderTimeoutError } from './chatV2Types.js';
import { chatV2ToolsToAiSdk } from './toolConverter.js';
import { buildChatV2RequestPlan, type ChatV2RequestPlan } from './chatV2RequestPlan.js';
import {
  getChatV2ProviderErrorStatusCode,
  normalizeChatV2ProviderError,
} from './chatV2Errors.js';
import { createLLMChatV2RetryAbortError, waitForLLMChatV2RetryCooldown } from './chatV2Retry.js';
import {
  createChatV2CommonOutputs,
  normalizeChatV2Usage,
} from './chatV2Outputs.js';
import { materializeLLMResponse } from './llmResponseMaterializer.js';

type ChatV2WithRetryResult = {
  result: StreamChatV2Result;
  responseError?: unknown;
};

export type ChatV2PipelineProviderFailure = {
  options: RunChatV2PipelineOptions;
  normalizedError: unknown;
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

/** Identifies legacy pipeline results that represent a terminal provider failure. */
export function isChatV2PipelineProviderFailureResult(result: ChatV2PipelineResult): boolean {
  return result.terminalOutcome === 'provider-failure';
}

export class ChatV2ResponseValidationError extends Error {
  constructor(public readonly responseDataType: string) {
    super(
      'LLM profile response validation failed.\n' +
        'Response format: JSON schema\n' +
        `Parsed Response type: ${responseDataType}\n` +
        'The provider request succeeded, but the final value prepared for the Response port is not an object. ' +
        'JSON schema response format requires an object, so Rivet rejected this LLM profile. ' +
        'Retry on non-200 does not apply to this validation failure.',
    );
    this.name = 'ChatV2ResponseValidationError';
  }
}

export function isChatV2ResponseValidationError(error: unknown): error is ChatV2ResponseValidationError {
  return error instanceof ChatV2ResponseValidationError;
}

function buildNon200StatusError(statusCode: number): Error & { statusCode: number } {
  const error = new Error(`Provider request returned non-200 status: ${statusCode}`) as Error & {
    statusCode: number;
  };
  error.name = 'AI_APICallError';
  error.statusCode = statusCode;
  return error;
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
  const prepareProviderRetry = async () => {
    try {
      await options.onBeforeProviderRetry?.(retryPlan.cooldownMs);
    } catch {
      // Circuit-health persistence is observational and must fail open.
    }
  };

  for (let attempt = 0; ; attempt++) {
    const callId = createObservedChatV2CallId(options);
    const callStartedAt = Date.now();
    let callWasObserved = false;
    const attemptController = new AbortController();
    const abortAttemptFromCaller = () => attemptController.abort(signal.reason);
    if (signal.aborted) {
      abortAttemptFromCaller();
    } else {
      signal.addEventListener('abort', abortAttemptFromCaller, { once: true });
    }
    try {
      const attemptChatOptions: StreamChatV2Options = {
        ...chatOptions,
        abortSignal: attemptController.signal,
        firstOutputTimeoutMs: options.firstOutputTimeoutMs,
        streamInactivityTimeoutMs: options.streamInactivityTimeoutMs,
        onStreamActivity: options.onStreamActivity,
        onTimeout: (error) => attemptController.abort(error),
      };
      const result =
        transportMode === 'generate'
          ? await generateChatV2(attemptChatOptions)
          : await streamChatV2(attemptChatOptions);
      await options.responseBodyCapture?.flush();
      const statusCode = result.requestStatus ?? 200;
      notifyChatV2CallFinished(options, {
        callId,
        attemptIndex: attempt,
        outcome: statusCode === 200 ? 'success' : 'provider-failure',
        result,
        startedAt: callStartedAt,
        durationMs: Math.max(0, Date.now() - callStartedAt),
      });
      callWasObserved = true;

      notifyProviderAttempt(options, {
        attemptIndex: attempt,
        outcome: statusCode === 200 ? 'success' : 'provider-failure',
        status: statusCode,
        ...(statusCode === 200 ? {} : { error: buildNon200StatusError(statusCode) }),
      });

      if (!retryPlan.enabled || statusCode === 200) {
        return { result };
      }

      const responseError = buildNon200StatusError(statusCode);

      if (attempt >= retryPlan.repeatTimes) {
        return { result, responseError };
      }

      await prepareProviderRetry();
      await waitForLLMChatV2RetryCooldown(retryPlan.cooldownMs, signal);
    } catch (caughtError) {
      const error =
        !signal.aborted && isChatV2ProviderTimeoutError(attemptController.signal.reason)
          ? attemptController.signal.reason
          : caughtError;
      await options.responseBodyCapture?.flush({
        waitForPending: !signal.aborted && !isChatV2ProviderTimeoutError(error),
      });
      if (!callWasObserved) {
        notifyChatV2CallFinished(options, {
          callId,
          attemptIndex: attempt,
          outcome: signal.aborted ? 'aborted' : 'provider-failure',
          error,
          startedAt: callStartedAt,
          durationMs: Math.max(0, Date.now() - callStartedAt),
        });
      }
      const statusCode = getChatV2ProviderErrorStatusCode(error);
      notifyProviderAttempt(options, {
        attemptIndex: attempt,
        outcome: signal.aborted ? 'aborted' : 'provider-failure',
        ...(statusCode == null ? {} : { status: statusCode }),
        error,
      });

      if (signal.aborted) {
        // The provider may reject concurrently with graph cancellation. The
        // cancellation wins: it must neither retry nor masquerade as a
        // provider failure to profile fallback and run activity.
        throw createLLMChatV2RetryAbortError();
      }

      if (isChatV2ProviderTimeoutError(error) || !retryPlan.enabled || statusCode == null || statusCode === 200) {
        throw error;
      }

      if (attempt >= retryPlan.repeatTimes) {
        throw error;
      }

      await prepareProviderRetry();
      await waitForLLMChatV2RetryCooldown(retryPlan.cooldownMs, signal);
    } finally {
      signal.removeEventListener('abort', abortAttemptFromCaller);
    }
  }
}

/**
 * Runs one provider/model round. Provider failures stay distinct from shared
 * graph configuration errors so an LLM Profile fallback chain can advance to
 * its next candidate; terminal failures always remain node errors.
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
                  requestBodies: undefined,
                  responseBodies: undefined,
                  outputUsage: false,
                  outputReasoning: false,
                  outputRequestBody: false,
                  outputResponseBody: false,
                  includeFunctionCalls: plan.output.includeFunctionCalls,
                  functionCallMode: plan.output.functionCallMode,
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

    return {
      outcome: 'provider-failure',
      failure: {
        options,
        normalizedError: normalizeProviderFailure(caughtError, options),
      },
    };
  }

  const usage = normalizeChatV2Usage(chatResponse.result.usage, options);
  const requestStatus = chatResponse.result.requestStatus ?? 200;
  const commonOutputs = createChatV2CommonOutputs({
    requestMessages,
    response: chatResponse.result.responseText,
    structuredOutput: chatResponse.result.structuredOutput,
    functionCalls: chatResponse.result.functionCalls,
    usage,
    reasoning: chatResponse.result.reasoning,
    requestBodies: options.requestBodies,
    responseBodies: options.responseBodies,
    outputUsage: plan.output.outputUsage,
    outputReasoning: plan.output.outputReasoning,
    outputRequestBody: plan.output.outputRequestBody,
    outputResponseBody: plan.output.outputResponseBody,
    includeFunctionCalls: plan.output.includeFunctionCalls,
    functionCallMode: plan.output.functionCallMode,
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
        options,
        normalizedError: normalizeProviderFailure(rawError, options),
      },
    };
  }

  // A tool-request round is not a terminal Response value. Auto-continuation
  // will make another model call after delegated tools finish, so validate the
  // value only once a provider round actually produces the final response.
  if (plan.request.responseFormat === 'json_schema' && chatResponse.result.functionCalls.length === 0) {
    const materialized = materializeLLMResponse({
      rawText: chatResponse.result.responseText,
      structuredOutput: chatResponse.result.structuredOutput,
      responseFormat: plan.request.responseFormat,
    });
    if (materialized.validation === 'invalid') {
      throw new ChatV2ResponseValidationError(materialized.value.type);
    }
  }

  return { outcome: 'success', result };
}

/**
 * Terminal provider failures are node errors. The fallback coordinator may
 * still catch this decision boundary and advance to a later LLM Profile.
 */
export function materializeChatV2PipelineFailure(failure: ChatV2PipelineProviderFailure): never {
  throw failure.normalizedError;
}

export async function runChatV2Pipeline(options: RunChatV2PipelineOptions): Promise<ChatV2PipelineResult> {
  const execution = await runChatV2PipelineExecution(options);
  return execution.outcome === 'success' ? execution.result : materializeChatV2PipelineFailure(execution.failure);
}
