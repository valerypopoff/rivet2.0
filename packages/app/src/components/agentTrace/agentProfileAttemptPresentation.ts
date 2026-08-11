import { getCustomProviderApiContract, type AgentLLMProfileAttemptTrace } from '@valerypopoff/rivet2-core';

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
    providerAndModel: `${formatProvider(attempt)} / ${attempt.model}`,
    context: [
      describeStage(attempt.stage),
      describeOutcome(attempt),
      attempt.profileIndex == null ? undefined : `profile ${attempt.profileIndex + 1}`,
      `round ${attempt.roundIndex + 1}`,
      attempt.attemptIndex == null ? undefined : `attempt ${attempt.attemptIndex + 1}`,
    ]
      .filter((value): value is string => value != null)
      .join(' / '),
    ...(attempt.error == null ? {} : { error: attempt.error }),
  }));
}

function formatProvider(attempt: Pick<AgentLLMProfileAttemptTrace, 'provider' | 'customProviderApi'>): string {
  return attempt.provider === 'custom'
    ? getCustomProviderApiContract(attempt.customProviderApi).label
    : attempt.provider;
}

function describeStage(stage: AgentLLMProfileAttemptTrace['stage']): string {
  switch (stage) {
    case 'health-gate':
      return 'circuit gate';
    case 'health-update':
      return 'circuit update';
    case 'response-validation':
      return 'response validation';
    default:
      return stage;
  }
}

function describeOutcome(attempt: AgentLLMProfileAttemptTrace): string {
  if (attempt.healthDisposition === 'deny') {
    return attempt.retryAt == null
      ? 'skipped while circuit is open'
      : `skipped until ${new Date(attempt.retryAt).toLocaleString()}`;
  }
  if (attempt.healthDisposition === 'fail-open') {
    return 'health store failed open; profile request continued';
  }
  if (attempt.timeoutKind === 'first-output') return 'first output timed out';
  if (attempt.timeoutKind === 'stream-inactivity') return 'stream became inactive';
  if (attempt.stage === 'health-update' && attempt.healthOutcome) {
    return `recorded ${attempt.healthOutcome}${attempt.healthState ? `; circuit ${attempt.healthState}` : ''}`;
  }
  return `${attempt.outcome}${attempt.healthState ? `; circuit ${attempt.healthState}` : ''}`;
}
