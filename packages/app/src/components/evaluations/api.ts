import type { Project } from '@valerypopoff/rivet2-core';
import type { EvaluationRun, EvaluationRunPurpose } from '@valerypopoff/rivet2-evaluations';

/**
 * `projectOverride` supports authoring surfaces such as Prompt Designer. It is
 * an in-memory candidate only: suite definitions and datasets are persisted as
 * usual, while the graph execution receives the unsaved project snapshot.
 */
export type TryRunEvaluation = (input: {
  suiteId: string;
  purpose: EvaluationRunPurpose;
  projectOverride?: Project;
}) => Promise<EvaluationRun | undefined>;

/** Cancels the active suite without discarding trials that already completed. */
export type AbortEvaluation = () => void;
