import type { EvaluationRecordingReference, EvaluationRunStore } from '@valerypopoff/rivet2-evaluations';
import type { ProjectId } from '@valerypopoff/rivet2-core';

type RecordingOwner = {
  recording?: EvaluationRecordingReference;
};

type TrialRecordingOwners = RecordingOwner & {
  observations: readonly RecordingOwner[];
};

type RecordingRetentionUpdate = Parameters<EvaluationRunStore['updateRecordingRetention']>[0];

/**
 * Builds one retention update per finalized target/evaluator recording.
 * Retention belongs to the individual reference: a failed evaluator must not
 * inherit a successful target's temporary policy (or vice versa).
 */
export function evaluationRecordingRetentionUpdates(
  projectId: ProjectId,
  trials: readonly TrialRecordingOwners[],
): RecordingRetentionUpdate[] {
  return trials.flatMap((trial) =>
    [trial.recording, ...trial.observations.map((observation) => observation.recording)]
      .filter((reference): reference is EvaluationRecordingReference => reference !== undefined)
      .map((reference) => ({
        projectId,
        recordingId: reference.id,
        retention: reference.retention,
        ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
      })),
  );
}
