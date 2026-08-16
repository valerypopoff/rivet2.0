import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationDataset, EvaluationProjectData, EvaluationRun } from '@valerypopoff/rivet2-evaluations';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import { atom } from 'jotai';

/**
 * Project definitions are saved in the .rivet-project attachment; datasets are
 * saved beside it in .rivet-data. Runs intentionally live in an injected store.
 */
export type EvaluationsState = {
  data: EvaluationProjectData;
  datasets: EvaluationDataset[];
  /**
   * Workspace-only navigation state. Keep it outside EvaluationProjectData so
   * changing tabs never dirties the project, while still surviving a trip to
   * the graph editor or another workspace.
   */
  activeView: 'definition' | 'dataset' | 'runs' | 'compare';
  currentRun?: EvaluationRun;
  runs: EvaluationRun[];
  runningSuiteId?: string;
  selectedRunId?: string;
  /** One-shot navigation request from another workspace, such as Data Studio. */
  requestedView?: 'definition' | 'dataset' | 'runs' | 'compare';
  /**
   * An ephemeral Prompt Designer candidate, scoped to its containing graph.
   * It is deliberately not serializable and must never affect an unrelated
   * suite merely because the user changed the selected suite in Evaluations.
   */
  promptDesignerProjectOverride?: { project: Project; projectId: ProjectId; graphId: GraphId };
};

export function createDefaultEvaluationsState(
  data: EvaluationProjectData = createEmptyEvaluationProjectData(),
  datasets: EvaluationDataset[] = [],
): EvaluationsState {
  return { data, datasets, activeView: 'definition', runs: [], runningSuiteId: undefined };
}

export const evaluationsState = atom<EvaluationsState>(createDefaultEvaluationsState());
export const evaluationsRunningState = atom((get) => get(evaluationsState).runningSuiteId !== undefined);
