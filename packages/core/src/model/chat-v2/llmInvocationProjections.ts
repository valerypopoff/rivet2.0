import type { ChatV2CallFinishedEvent } from '../ProcessContext.js';
import { summarizeChatV2PhysicalCallUsage } from './chatV2UsageAccounting.js';
import { buildLLMProfileRequestDiagnostics, type LLMProfileAttempt } from './llmProfileFallback.js';

/** Pure public-shape projections over privacy-bounded invocation facts. */
export function projectLLMInvocationUsage(events: readonly ChatV2CallFinishedEvent[]) {
  return summarizeChatV2PhysicalCallUsage(events);
}

export function projectLLMProfileRequestDiagnostics(params: {
  profileCount: number;
  attempts: readonly LLMProfileAttempt[];
}) {
  return buildLLMProfileRequestDiagnostics(params.profileCount, params.attempts);
}
