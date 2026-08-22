import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type {
  EvaluationBaselineSnapshot,
  EvaluationDataset,
  EvaluationLibrary,
  EvaluationProjectData,
  EvaluationRun,
  EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import {
  createEmptyEvaluationLibrary,
  createEmptyEvaluationProjectData,
  deserializeEvaluationProjectData,
  localizeEvaluationDataset,
  normalizeEvaluationLibrary,
  reconcileEvaluationRunSnapshots,
} from '@valerypopoff/rivet2-evaluations';
import { atom } from 'jotai';
export type { EvaluationLibrary } from '@valerypopoff/rivet2-evaluations';
export { createEmptyEvaluationLibrary, normalizeEvaluationLibrary } from '@valerypopoff/rivet2-evaluations';

export type EvaluationsState = {
  data: EvaluationProjectData;
  datasets: EvaluationDataset[];
  /** Internal local-library migration metadata, never written to a project. */
  migratedLegacyProjectIds: ProjectId[];
  /**
   * Workspace-only navigation state. Keep it outside EvaluationProjectData so
   * changing tabs never dirties the project, while still surviving a trip to
   * the graph editor or another workspace.
   */
  activeView: 'definition' | 'dataset' | 'runs' | 'compare';
  /** The active resource is session-only and must never be written to a project file. */
  selectedSuiteId?: string;
  selectedDatasetId?: string;
  currentRun?: EvaluationRun;
  runs: EvaluationRun[];
  /**
   * The project and suite for which `runs` was last fully hydrated from the
   * run store. Progress snapshots never set this: they are useful live
   * evidence, but do not prove that the complete persisted history is loaded.
   */
  runHistoryScope?: EvaluationRunHistoryScope;
  /** Session-only presentation preferences, scoped to one project and suite. */
  runScoreSortByScope: Record<string, EvaluationRunScoreSort>;
  /** The explicitly opened trial cards for the selected history run. */
  runTrialExpansion?: EvaluationRunTrialExpansion;
  /** Last Runs-pane scroll offsets, saved only when leaving that pane. */
  runScrollTopByScope: Record<string, number>;
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

export type EvaluationRunScoreSort = 'default' | 'score-desc' | 'score-asc';

export type EvaluationRunHistoryScope = {
  projectId: ProjectId;
  suiteId: string;
};

export type EvaluationRunTrialExpansion = {
  scope: EvaluationRunHistoryScope;
  runId: string;
  trialIds: string[];
};

/** A collision-free key for session-only Runs presentation state. */
export function getEvaluationRunHistoryScopeKey(scope: EvaluationRunHistoryScope): string {
  return JSON.stringify([scope.projectId, scope.suiteId]);
}

export function isEvaluationRunHistoryCached(
  state: Pick<EvaluationsState, 'runHistoryScope'>,
  scope: EvaluationRunHistoryScope | undefined,
): boolean {
  return (
    scope !== undefined &&
    state.runHistoryScope?.projectId === scope.projectId &&
    state.runHistoryScope.suiteId === scope.suiteId
  );
}

type EvaluationWorkspaceState = Omit<EvaluationsState, 'data' | 'datasets' | 'migratedLegacyProjectIds'>;
type EvaluationStateUpdate = EvaluationsState | ((previous: EvaluationsState) => EvaluationsState);

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function legacyResourceId(id: string, sourceProjectId: ProjectId | undefined, knownIds: Set<string>): string {
  if (!knownIds.has(id)) return id;

  // Legacy resource IDs were only project-unique. Deriving the collision
  // suffix from the old project identity preserves each resource.
  const importedId = `${id}--legacy-${sourceProjectId ?? 'unknown-project'}`;
  let candidate = importedId;
  let index = 2;
  while (knownIds.has(candidate)) {
    candidate = `${importedId}-${index}`;
    index += 1;
  }
  return candidate;
}

/**
 * One-way migration for evaluations embedded in projects created before the
 * local library existed. Legacy resource IDs were scoped to a project, so
 * collisions are remapped without changing their suite/dataset relationship.
 * Remembering each completed source migration prevents deleted resources from
 * being resurrected when that old project is opened again.
 */
export function mergeLegacyEvaluationLibrary(
  library: EvaluationLibrary,
  legacyData?: EvaluationProjectData,
  legacyDatasets?: readonly EvaluationDataset[],
  sourceProjectId?: ProjectId,
): EvaluationLibrary {
  const local = normalizeEvaluationLibrary(library);
  let data = createEmptyEvaluationProjectData();
  try {
    data = legacyData === undefined ? data : deserializeEvaluationProjectData(legacyData);
  } catch {
    // Invalid legacy attachments are ignored; they must never damage the
    // already durable local library.
  }
  const validatedLegacyDatasets = (legacyDatasets ?? []).flatMap((dataset) => {
    try {
      return [localizeEvaluationDataset(dataset)];
    } catch {
      return [];
    }
  });

  const hasLegacyResources = data.suites.length > 0 || data.baselines.length > 0 || validatedLegacyDatasets.length > 0;
  if (
    !hasLegacyResources ||
    (sourceProjectId !== undefined && local.migratedLegacyProjectIds.includes(sourceProjectId))
  ) {
    return local;
  }

  const datasetIds = new Set(local.datasets.map((dataset) => dataset.id));
  const importedDatasets: EvaluationDataset[] = [];
  const datasetIdMap = new Map<string, string>();
  for (const dataset of uniqueById(validatedLegacyDatasets)) {
    const id = legacyResourceId(dataset.id, sourceProjectId, datasetIds);
    datasetIdMap.set(dataset.id, id);
    if (!datasetIds.has(id)) {
      datasetIds.add(id);
      importedDatasets.push(localizeEvaluationDataset({ ...dataset, id }));
    }
  }

  const suiteIds = new Set(local.data.suites.map((suite) => suite.id));
  const importedSuites: EvaluationSuite[] = [];
  const suiteIdMap = new Map<string, string>();
  for (const suite of uniqueById(data.suites)) {
    const id = legacyResourceId(suite.id, sourceProjectId, suiteIds);
    suiteIdMap.set(suite.id, id);
    if (!suiteIds.has(id)) {
      suiteIds.add(id);
      const datasetId =
        datasetIdMap.get(suite.datasetId) ?? legacyResourceId(suite.datasetId, sourceProjectId, datasetIds);
      importedSuites.push({ ...suite, id, datasetId });
    }
  }

  const baselineIds = new Set(local.data.baselines.map((baseline) => baseline.id));
  const importedBaselines: EvaluationBaselineSnapshot[] = [];
  for (const baseline of uniqueById(data.baselines)) {
    const id = legacyResourceId(baseline.id, sourceProjectId, baselineIds);
    if (!baselineIds.has(id)) {
      baselineIds.add(id);
      importedBaselines.push({ ...baseline, id, suiteId: suiteIdMap.get(baseline.suiteId) ?? baseline.suiteId });
    }
  }

  return {
    version: 1,
    data: {
      version: 1,
      suites: [...local.data.suites, ...importedSuites],
      baselines: [...local.data.baselines, ...importedBaselines],
    },
    datasets: [...local.datasets, ...importedDatasets],
    migratedLegacyProjectIds:
      sourceProjectId === undefined
        ? local.migratedLegacyProjectIds
        : [...local.migratedLegacyProjectIds, sourceProjectId],
  };
}

export function createDefaultEvaluationsState(
  data: EvaluationProjectData = createEmptyEvaluationProjectData(),
  datasets: EvaluationDataset[] = [],
): EvaluationsState {
  return {
    data,
    datasets,
    migratedLegacyProjectIds: [],
    activeView: 'definition',
    runs: [],
    runScoreSortByScope: {},
    runScrollTopByScope: {},
    runningSuiteId: undefined,
  };
}

/**
 * Applies one detached runner snapshot to the workspace without allowing an
 * older revision to replace newer evidence. A terminal snapshot also becomes
 * the selected history entry immediately; recording retention and durable
 * persistence happen afterward and must not expose the previously selected
 * run while they are in flight.
 */
export function applyEvaluationRunSnapshot(state: EvaluationsState, run: EvaluationRun): EvaluationsState {
  const storedRun = state.runs.find((candidate) => candidate.id === run.id);
  const existing =
    state.currentRun?.id === run.id ? reconcileEvaluationRunSnapshots(storedRun, state.currentRun) : storedRun;
  const nextRun = reconcileEvaluationRunSnapshots(existing, run);
  if (nextRun === existing) return state;
  const isTerminal = run.executionStatus !== 'queued' && run.executionStatus !== 'running';
  if (!isTerminal) return { ...state, currentRun: nextRun };

  return {
    ...state,
    currentRun: nextRun,
    selectedRunId: nextRun.id,
    runs: [nextRun, ...state.runs.filter((candidate) => candidate.id !== nextRun.id)],
  };
}

/** Hydrated and persisted by the active EvaluationStore provider. */
export const evaluationLibraryState = atom<EvaluationLibrary>(createEmptyEvaluationLibrary());
const evaluationWorkspaceState = atom<EvaluationWorkspaceState>({
  activeView: 'definition',
  runs: [],
  runScoreSortByScope: {},
  runScrollTopByScope: {},
  runningSuiteId: undefined,
});

export const evaluationsState = atom(
  (get) => {
    // Hydration and every library write already pass through the shared
    // normalization boundary. Preserve these references while only workspace
    // state changes (for example, on every live-run progress snapshot) instead
    // of revalidating and cloning every suite, baseline, and dataset.
    const library = get(evaluationLibraryState);
    return {
      ...get(evaluationWorkspaceState),
      data: library.data,
      datasets: library.datasets,
      migratedLegacyProjectIds: library.migratedLegacyProjectIds,
    };
  },
  (get, set, update: EvaluationStateUpdate) => {
    const previous = get(evaluationsState);
    const next = typeof update === 'function' ? update(previous) : update;
    if (
      next.data !== previous.data ||
      next.datasets !== previous.datasets ||
      next.migratedLegacyProjectIds !== previous.migratedLegacyProjectIds
    ) {
      const library: EvaluationLibrary = {
        version: 1,
        data: next.data,
        datasets: next.datasets,
        migratedLegacyProjectIds: next.migratedLegacyProjectIds,
      };
      set(evaluationLibraryState, normalizeEvaluationLibrary(library));
    }
    const {
      data: _data,
      datasets: _datasets,
      migratedLegacyProjectIds: _migratedLegacyProjectIds,
      ...workspace
    } = next;
    set(evaluationWorkspaceState, workspace);
  },
);

/** Clears only active-project run/navigation state while retaining the local library. */
export function resetEvaluationsForProjectLoad(
  state: EvaluationsState,
  legacyData?: EvaluationProjectData,
  legacyDatasets?: readonly EvaluationDataset[],
  sourceProjectId?: ProjectId,
): EvaluationsState {
  const library = mergeLegacyEvaluationLibrary(
    {
      version: 1,
      data: state.data,
      datasets: state.datasets,
      migratedLegacyProjectIds: state.migratedLegacyProjectIds,
    },
    legacyData,
    legacyDatasets,
    sourceProjectId,
  );
  return {
    ...createDefaultEvaluationsState(library.data, library.datasets),
    migratedLegacyProjectIds: library.migratedLegacyProjectIds,
    selectedSuiteId:
      state.selectedSuiteId && library.data.suites.some((suite) => suite.id === state.selectedSuiteId)
        ? state.selectedSuiteId
        : undefined,
    selectedDatasetId:
      state.selectedDatasetId && library.datasets.some((dataset) => dataset.id === state.selectedDatasetId)
        ? state.selectedDatasetId
        : undefined,
  };
}

export const evaluationsRunningState = atom((get) => get(evaluationsState).runningSuiteId !== undefined);
