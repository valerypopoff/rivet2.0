import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import type { ChatV2NormalizedUsage } from './chatV2Types.js';

/**
 * The provider-neutral numeric contract shared by LLM Chat V2 usage consumers.
 * Provider metadata is untrusted, so callers must not treat negative, NaN, or
 * infinite token counts as real usage.
 */
export function isChatV2FiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Aggregates one node invocation's physical provider calls into its portable
 * Usage output. The call id is a stable transport identity, so a redelivered
 * lifecycle event replaces prior metadata instead of inflating totals.
 */
export function summarizeChatV2PhysicalCallUsage(
  events: readonly ChatV2CallFinishedEvent[],
): ChatV2NormalizedUsage | undefined {
  const eventsByCallId = new Map<string, ChatV2CallFinishedEvent>();
  const callIdsInOrder: string[] = [];

  for (const event of events) {
    const callId = event.callId as string;
    if (!eventsByCallId.has(callId)) {
      callIdsInOrder.push(callId);
    }
    eventsByCallId.set(callId, event);
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let hasUsage = false;
  let totalCost = 0;
  let hasExactCost = callIdsInOrder.length > 0;

  for (const callId of callIdsInOrder) {
    const event = eventsByCallId.get(callId)!;
    const usage = event.normalizedUsage;
    const safePromptTokens = isChatV2FiniteNonNegativeNumber(usage?.promptTokens) ? usage.promptTokens : undefined;
    const safeCompletionTokens = isChatV2FiniteNonNegativeNumber(usage?.completionTokens)
      ? usage.completionTokens
      : undefined;
    const safeTotalTokens = isChatV2FiniteNonNegativeNumber(usage?.totalTokens) ? usage.totalTokens : undefined;
    const safeCachedTokens = isChatV2FiniteNonNegativeNumber(usage?.cachedTokens) ? usage.cachedTokens : undefined;
    const safeReasoningTokens = isChatV2FiniteNonNegativeNumber(usage?.reasoningTokens)
      ? usage.reasoningTokens
      : undefined;
    // Physical-call traces preserve omitted fields rather than manufacturing
    // zeros. The node-level Usage contract, however, has always exposed a
    // total; retain that contract when a provider reports only input or output
    // tokens by deriving a total from the safe fields that are present.
    const totalTokensForCall = safeTotalTokens ?? (safePromptTokens ?? 0) + (safeCompletionTokens ?? 0);

    if (
      safePromptTokens != null ||
      safeCompletionTokens != null ||
      safeTotalTokens != null ||
      safeCachedTokens != null ||
      safeReasoningTokens != null
    ) {
      hasUsage = true;
      promptTokens += safePromptTokens ?? 0;
      completionTokens += safeCompletionTokens ?? 0;
      totalTokens += totalTokensForCall;
      cachedTokens += safeCachedTokens ?? 0;
      reasoningTokens += safeReasoningTokens ?? 0;
    }

    if (event.pricing.status === 'known' && isChatV2FiniteNonNegativeNumber(event.pricing.costUsd)) {
      totalCost += event.pricing.costUsd;
    } else {
      hasExactCost = false;
    }
  }

  return hasUsage
    ? {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        reasoningTokens,
        totalCost: hasExactCost ? totalCost : undefined,
      }
    : undefined;
}
