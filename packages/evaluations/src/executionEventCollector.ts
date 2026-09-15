import type {
  ChatV2CallTraceEvent,
  LLMProfileAttemptTraceEvent,
  ToolCallFinishedEvent,
} from '@valerypopoff/rivet2-core';

import type { EvaluationExecutionMetrics, PortableJson } from './types.js';

/**
 * The evidence shape used by evaluation runners. The CLI intentionally keeps
 * its long-standing compact evidence contract, while interactive and hosted
 * runners retain the additional display-oriented provider fields.
 */
export type EvaluationProviderAttemptFormat = 'full' | 'cli';

/**
 * Per-graph physical provider and tool accounting for an evaluation run.
 * Duration belongs to the owning runner because it also includes graph work
 * that does not emit a provider or tool event.
 */
export type EvaluationEventCollector = {
  readonly metrics: EvaluationExecutionMetrics;
  readonly providerAttempts: PortableJson[];
  llmCallFinished(event: ChatV2CallTraceEvent): void;
  llmProfileAttempt(event: LLMProfileAttemptTraceEvent): void;
  toolCallFinished(event: ToolCallFinishedEvent): void;
};

export function createEvaluationEventCollector(
  attemptFormat: EvaluationProviderAttemptFormat,
): EvaluationEventCollector {
  const metrics: EvaluationExecutionMetrics = {
    durationMs: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
  };
  const providerAttempts: PortableJson[] = [];

  return {
    metrics,
    providerAttempts,
    llmCallFinished(event) {
      metrics.modelCallCount = (metrics.modelCallCount ?? 0) + 1;
      metrics.inputTokens = (metrics.inputTokens ?? 0) + (event.normalizedUsage?.promptTokens ?? 0);
      metrics.outputTokens = (metrics.outputTokens ?? 0) + (event.normalizedUsage?.completionTokens ?? 0);
      metrics.cachedInputTokens = (metrics.cachedInputTokens ?? 0) + (event.normalizedUsage?.cachedTokens ?? 0);
      metrics.reasoningTokens = (metrics.reasoningTokens ?? 0) + (event.normalizedUsage?.reasoningTokens ?? 0);
      if (event.pricing.status === 'known') {
        metrics.costUsd = (metrics.costUsd ?? 0) + (event.pricing.costUsd ?? 0);
      } else {
        metrics.hasUnknownCost = true;
      }

      providerAttempts.push({
        kind: 'provider-call',
        provider: event.provider,
        model: event.model,
        customProviderApi: event.customProviderApi ?? null,
        outcome: event.outcome,
        ...(attemptFormat === 'full' ? { finishReason: event.finishReason ?? null } : {}),
        profileIndex: event.profileIndex ?? null,
        ...(attemptFormat === 'full' ? { profileName: event.profileName ?? null } : {}),
        attemptIndex: event.attemptIndex,
        roundIndex: event.roundIndex ?? null,
        durationMs: event.durationMs ?? null,
      });
    },
    llmProfileAttempt(event) {
      providerAttempts.push({
        kind: 'profile-decision',
        provider: event.provider,
        model: event.model,
        customProviderApi: event.customProviderApi ?? null,
        stage: event.stage,
        outcome: event.outcome,
        profileIndex: event.profileIndex ?? null,
        ...(attemptFormat === 'full' ? { profileName: event.profileName ?? null } : {}),
        attemptIndex: event.attemptIndex ?? null,
        roundIndex: event.roundIndex,
        status: event.status ?? null,
        healthState: event.healthState ?? null,
        healthDisposition: event.healthDisposition ?? null,
        timeoutKind: event.timeoutKind ?? null,
      });
    },
    toolCallFinished(event) {
      metrics.toolCallCount = (metrics.toolCallCount ?? 0) + 1;
      if (event.outcome !== 'success') metrics.toolFailureCount = (metrics.toolFailureCount ?? 0) + 1;
    },
  };
}
