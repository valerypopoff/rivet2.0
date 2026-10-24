import type { ExecutionRecorder, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationRecordingReference, EvaluationRunStore } from '@valerypopoff/rivet2-evaluations';

/**
 * Shared Browser/Node artifact policy. The executor owns capture and must settle
 * it before calling this function. Persistence is attempted once, never replayed
 * after an uncertain response, and cannot turn a model verdict into a failure.
 */
export function createEvaluationRecordingPersistence(input: {
  recorder: Pick<ExecutionRecorder, 'events' | 'serialize'>;
  store: Pick<EvaluationRunStore, 'putRecording'>;
  projectId: ProjectId;
  metadata: { evaluationRunId: string; caseId: string; trialIndex: number };
  onFailure: (error: unknown) => void;
}): () => Promise<EvaluationRecordingReference | undefined> {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const reference: EvaluationRecordingReference = {
    id: `evaluation-recording-${id}`,
    retention: 'temporary',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  let pending: Promise<EvaluationRecordingReference | undefined> | undefined;
  const persist = async () => {
    if (input.recorder.events.length === 0) return undefined;
    try {
      await input.store.putRecording({
        projectId: input.projectId,
        runId: input.metadata.evaluationRunId,
        trialId: `${input.metadata.caseId}:${input.metadata.trialIndex}`,
        reference,
        serialized: input.recorder.serialize(),
        createdAt: new Date().toISOString(),
      });
      return reference;
    } catch (error) {
      // Diagnostics must not break the compact result either.
      try {
        input.onFailure(error);
      } catch {
        // The owning lifecycle reports its artifact-failure count separately.
      }
      return undefined;
    }
  };
  return () => (pending ??= persist());
}
