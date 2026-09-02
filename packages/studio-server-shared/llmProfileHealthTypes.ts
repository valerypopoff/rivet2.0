import type { RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-node';

/** Why a suspension-contributing run cannot be opened as a replay. */
export type LLMProfileHealthRecordingAvailability =
  | 'available'
  | 'pending'
  | 'disabled'
  | 'queue-dropped'
  | 'persistence-failed'
  | 'deleted'
  | 'not-recorded';

/**
 * One replayable execution (or a transparent unavailable state) that
 * contributed one or more failures to an active LLM profile suspension.
 */
export type LLMProfileHealthContributorRun = {
  occurredAt: number;
  contributionCount: number;
  triggeredSuspension: boolean;
  availability: LLMProfileHealthRecordingAvailability;
  recordingId?: string;
};

/** A normal recording pipeline outcome joined by its private execution correlation ID. */
export type LLMProfileHealthRecordingOutcome = {
  correlationId: string;
  availability: Exclude<
    LLMProfileHealthRecordingAvailability,
    'pending' | 'not-recorded' | 'deleted'
  >;
  recordingId?: string;
};

/** Operator-facing health state returned only by Studio Server's admin API. */
export type LLMProfileHealthAdminEntry = RivetLLMProfileHealthSnapshot & {
  contributingRuns: readonly LLMProfileHealthContributorRun[];
};
