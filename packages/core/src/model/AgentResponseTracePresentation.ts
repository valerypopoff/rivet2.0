import { getCustomProviderApiContract } from './chat-v2/customProviderApi.js';
import type { AgentLLMProfileAttemptTrace, AgentResponseTrace } from './AgentResponseTrace.js';

export type AgentProfileAttemptInspectorRow = Readonly<{
  context: string;
  error?: string;
  eventId: string;
  providerAndModel: string;
}>;

export function buildAgentProfileAttemptInspectorRows(
  attempts: readonly AgentLLMProfileAttemptTrace[],
): AgentProfileAttemptInspectorRow[] {
  return attempts.map((attempt) => ({
    eventId: attempt.eventId,
    providerAndModel: [
      ...(attempt.profileName == null || attempt.profileName.trim() === ''
        ? []
        : [`Profile: ${attempt.profileName.trim()}`]),
      `${formatProvider(attempt)} / ${attempt.model}`,
    ].join(' · '),
    context: [
      attempt.failureKind?.replaceAll('-', ' ') ?? describeStage(attempt.stage),
      describeOutcome(attempt),
      attempt.profileIndex == null ? undefined : `profile ${attempt.profileIndex + 1}`,
      attempt.family === 'classifier' ? undefined : `round ${attempt.roundIndex + 1}`,
      attempt.attemptIndex == null ? undefined : `attempt ${attempt.attemptIndex + 1}`,
      attempt.status == null ? undefined : `HTTP ${attempt.status}`,
      attempt.durationMs == null
        ? isClassifierRequest(attempt)
          ? 'duration unavailable'
          : undefined
        : `${(attempt.durationMs / 1000).toFixed(2)} sec`,
      attempt.classifierUsage == null
        ? isClassifierRequest(attempt)
          ? 'usage not reported'
          : undefined
        : `${attempt.classifierUsage.inputTokens} input / ${attempt.classifierUsage.outputTokens} output tokens`,
      attempt.classifierUsage == null
        ? isClassifierRequest(attempt)
          ? 'cost unknown'
          : undefined
        : attempt.classifierUsage.estimatedCostUsd == null
          ? 'cost unknown'
          : `estimated $${attempt.classifierUsage.estimatedCostUsd.toPrecision(4)}`,
    ]
      .filter((value): value is string => value != null)
      .join(' / '),
    ...(attempt.error == null ? {} : { error: attempt.error }),
  }));
}

/** Physical classifier requests share profile evidence, not LLM chat-round semantics. */
export function isClassifierRequest(attempt: AgentLLMProfileAttemptTrace): boolean {
  return attempt.family === 'classifier' && attempt.attemptIndex != null;
}

export function getClassifierRequestCount(trace: AgentResponseTrace): number | undefined {
  if (trace.summary.classifierRequestCount != null) return trace.summary.classifierRequestCount;
  const attempts = trace.profileAttempts?.filter((attempt) => attempt.family === 'classifier');
  if (trace.scope !== 'classifier-invocation' && !attempts?.length) return undefined;
  // Older schema-v1 hosts recorded attempts before adding a dedicated counter.
  return attempts?.filter(isClassifierRequest).length ?? 0;
}

/** Older trace counters inferred from capped rows are lower bounds, not exact totals. */
export function formatClassifierRequestCount(trace: AgentResponseTrace): string | undefined {
  const count = getClassifierRequestCount(trace);
  if (count == null) return undefined;
  return trace.summary.classifierRequestCount == null && (trace.omittedProfileAttemptCount ?? 0) > 0
    ? `${count} (retained evidence only)`
    : String(count);
}

/** One shared cap covers both physical classifier requests and profile decisions. */
export function getProfileAttemptOmissionNotice(trace: AgentResponseTrace): string | undefined {
  const omitted = trace.omittedProfileAttemptCount ?? 0;
  return omitted > 0
    ? `${omitted} additional profile-attempt rows (requests or decisions) omitted by the trace limit.`
    : undefined;
}

function formatProvider(attempt: Pick<AgentLLMProfileAttemptTrace, 'provider' | 'customProviderApi'>): string {
  return attempt.provider === 'custom'
    ? getCustomProviderApiContract(attempt.customProviderApi).label
    : attempt.provider;
}

function describeStage(stage: AgentLLMProfileAttemptTrace['stage']): string {
  switch (stage) {
    case 'health-gate':
      return 'reliability check';
    case 'health-update':
      return 'reliability update';
    case 'response-validation':
      return 'response validation';
    default:
      return stage;
  }
}

function describeOutcome(attempt: AgentLLMProfileAttemptTrace): string {
  if (attempt.skipReason === 'unreached') return 'not reached';
  if (attempt.healthDisposition === 'deny') {
    return attempt.retryAt == null
      ? 'profile suspended; skipped'
      : `profile suspended until ${new Date(attempt.retryAt).toLocaleString()}`;
  }
  if (attempt.healthDisposition === 'fail-open') {
    return 'reliability service unavailable; profile request continued';
  }
  if (attempt.timeoutKind === 'first-output') return 'first output timed out';
  if (attempt.timeoutKind === 'stream-inactivity') return 'stream became inactive';
  if (attempt.timeoutKind === 'response') return 'response timed out';
  if (attempt.stage === 'health-update' && attempt.healthOutcome) {
    return `recorded ${describeReliabilityOutcome(attempt.healthOutcome)}${describeReliabilityState(attempt.healthState)}`;
  }
  return `${attempt.outcome}${describeReliabilityState(attempt.healthState)}`;
}

function describeReliabilityOutcome(outcome: NonNullable<AgentLLMProfileAttemptTrace['healthOutcome']>): string {
  switch (outcome) {
    case 'healthy':
      return 'success';
    case 'unhealthy':
      return 'failure';
    default:
      return 'ignored result';
  }
}

function describeReliabilityState(state: AgentLLMProfileAttemptTrace['healthState']): string {
  switch (state) {
    case 'open':
      return '; profile suspended';
    case 'half-open':
      return '; recovery attempt in progress';
    case 'closed':
      return '; profile available';
    default:
      return '';
  }
}
