import { nanoid } from 'nanoid/non-secure';
import type {
  ChatV2CallFinishedEvent,
  ChatV2CallId,
  ChatV2CallNormalizedUsage,
  ChatV2CallRawUsage,
} from '../ProcessContext.js';
import type { RunChatV2PipelineOptions, StreamChatV2Result } from './chatV2Types.js';
import { calculateChatV2Cost, getChatV2ModelInfo } from './modelRegistry.js';

function toUsageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function copyRawUsage(usage: StreamChatV2Result['usage']): ChatV2CallRawUsage | undefined {
  if (usage == null) {
    return undefined;
  }

  const inputTokens = toUsageNumber(usage.inputTokens);
  const outputTokens = toUsageNumber(usage.outputTokens);
  const totalTokens = toUsageNumber(usage.totalTokens);
  const cacheReadTokens = toUsageNumber(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = toUsageNumber(usage.inputTokenDetails?.cacheWriteTokens);
  const noCacheTokens = toUsageNumber(usage.inputTokenDetails?.noCacheTokens);
  const reasoningTokens = toUsageNumber(usage.outputTokenDetails?.reasoningTokens);
  const textTokens = toUsageNumber(usage.outputTokenDetails?.textTokens);
  const inputTokenDetails = {
    ...(cacheReadTokens == null ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens == null ? {} : { cacheWriteTokens }),
    ...(noCacheTokens == null ? {} : { noCacheTokens }),
  };
  const outputTokenDetails = {
    ...(reasoningTokens == null ? {} : { reasoningTokens }),
    ...(textTokens == null ? {} : { textTokens }),
  };
  const copied = {
    ...(inputTokens == null ? {} : { inputTokens }),
    ...(outputTokens == null ? {} : { outputTokens }),
    ...(totalTokens == null ? {} : { totalTokens }),
    ...(Object.keys(inputTokenDetails).length === 0 ? {} : { inputTokenDetails }),
    ...(Object.keys(outputTokenDetails).length === 0 ? {} : { outputTokenDetails }),
  };

  return Object.keys(copied).length === 0 ? undefined : copied;
}

function normalizeObservedUsage(rawUsage: ChatV2CallRawUsage | undefined): ChatV2CallNormalizedUsage | undefined {
  if (rawUsage == null) {
    return undefined;
  }

  const promptTokens = rawUsage.inputTokens;
  const completionTokens = rawUsage.outputTokens;
  const totalTokens =
    rawUsage.totalTokens ??
    (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined);
  const cacheReadTokens = rawUsage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = rawUsage.inputTokenDetails?.cacheWriteTokens;
  const cachedTokens =
    cacheReadTokens != null && cacheWriteTokens != null ? cacheReadTokens + cacheWriteTokens : undefined;
  const reasoningTokens = rawUsage.outputTokenDetails?.reasoningTokens;

  const normalized = {
    ...(promptTokens == null ? {} : { promptTokens }),
    ...(completionTokens == null ? {} : { completionTokens }),
    ...(totalTokens == null ? {} : { totalTokens }),
    ...(cachedTokens == null ? {} : { cachedTokens }),
    ...(reasoningTokens == null ? {} : { reasoningTokens }),
  };

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function getErrorProperty<T>(error: unknown, key: string, guard: (value: unknown) => value is T): T | undefined {
  if (error == null || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }

  try {
    const value = (error as Record<string, unknown>)[key];
    return guard(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function safelyRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function containUnexpectedObserverPromise(value: unknown): void {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
    return;
  }

  try {
    if (typeof (value as { then?: unknown }).then === 'function') {
      void Promise.resolve(value as PromiseLike<unknown>).catch(() => undefined);
    }
  } catch {
    // Accessing a malformed thenable must not change graph behavior either.
  }
}

function isUsage(value: unknown): value is NonNullable<StreamChatV2Result['usage']> {
  return value != null && typeof value === 'object';
}

export function createObservedChatV2CallId(options: RunChatV2PipelineOptions): ChatV2CallId | undefined {
  return options.context.onChatV2CallFinished != null &&
    options.context.node?.id != null &&
    options.context.processId != null
    ? (nanoid() as ChatV2CallId)
    : undefined;
}

export function notifyChatV2CallFinished(
  options: RunChatV2PipelineOptions,
  params: {
    callId: ChatV2CallId | undefined;
    attemptIndex: number;
    outcome: ChatV2CallFinishedEvent['outcome'];
    result?: StreamChatV2Result;
    error?: unknown;
    startedAt?: number;
    durationMs?: number;
  },
): void {
  const observer = options.context.onChatV2CallFinished;
  const nodeId = options.context.node?.id;
  const processId = options.context.processId;
  if (observer == null || nodeId == null || processId == null || params.callId == null) {
    return;
  }

  const resultUsage = safelyRead(() => params.result?.usage);
  const errorUsage = getErrorProperty(params.error, 'usage', isUsage);
  const rawUsage = safelyRead(() => copyRawUsage(resultUsage ?? errorUsage));
  const normalizedUsage = safelyRead(() => normalizeObservedUsage(rawUsage));
  const modelInfo = safelyRead(() => getChatV2ModelInfo(options.provider, options.modelId));
  const calculatedCost =
    modelInfo != null && normalizedUsage?.promptTokens != null && normalizedUsage.completionTokens != null
      ? safelyRead(() =>
          calculateChatV2Cost(
            options.provider,
            options.modelId,
            normalizedUsage.promptTokens!,
            normalizedUsage.completionTokens!,
          ),
        )
      : undefined;
  const costUsd = toUsageNumber(calculatedCost);
  const finishReason =
    safelyRead(() => params.result?.finishReason) ??
    getErrorProperty(params.error, 'finishReason', (value): value is string => typeof value === 'string');
  const event: ChatV2CallFinishedEvent = {
    callId: params.callId,
    attemptIndex: params.attemptIndex,
    ...(options.profileIndex == null ? {} : { profileIndex: options.profileIndex }),
    ...(options.roundIndex == null ? {} : { roundIndex: options.roundIndex }),
    nodeId,
    processId,
    provider: options.provider,
    model: options.modelId,
    outcome: params.outcome,
    ...(finishReason == null ? {} : { finishReason }),
    ...(rawUsage == null ? {} : { rawUsage }),
    ...(normalizedUsage == null ? {} : { normalizedUsage }),
    pricing: {
      status: modelInfo == null ? 'unknown' : 'known',
      ...(costUsd == null ? {} : { costUsd }),
    },
    ...(params.startedAt == null ? {} : { startedAt: params.startedAt }),
    ...(params.durationMs == null ? {} : { durationMs: params.durationMs }),
  };

  try {
    containUnexpectedObserverPromise(observer(event));
  } catch {
    // Host observers must never change graph behavior.
  }
}
