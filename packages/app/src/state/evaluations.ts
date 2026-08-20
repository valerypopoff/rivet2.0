import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationBaselineSnapshot, EvaluationDataset, EvaluationProjectData, EvaluationRun, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import {
  createEmptyEvaluationProjectData,
  deserializeEvaluationProjectData,
  localizeEvaluationDataset,
} from '@valerypopoff/rivet2-evaluations';
import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createHybridStorage } from './storage.js';

/** Reusable definitions and datasets stored locally by Rivet, not in a project file. */
export type EvaluationLibrary = {
  version: 1;
  data: EvaluationProjectData;
  datasets: EvaluationDataset[];
  /** Legacy project IDs whose embedded evaluation resources were imported. */
  migratedLegacyProjectIds: ProjectId[];
};

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

type EvaluationWorkspaceState = Omit<EvaluationsState, 'data' | 'datasets' | 'migratedLegacyProjectIds'>;
type EvaluationStateUpdate = EvaluationsState | ((previous: EvaluationsState) => EvaluationsState);

const EVALUATION_LIBRARY_STORAGE_KEY = 'evaluation-library';
const { storage } = createHybridStorage(EVALUATION_LIBRARY_STORAGE_KEY, undefined, { debounceMs: 0 });

export function createEmptyEvaluationLibrary(): EvaluationLibrary {
  return { version: 1, data: createEmptyEvaluationProjectData(), datasets: [], migratedLegacyProjectIds: [] };
}

export function normalizeEvaluationLibrary(value: unknown): EvaluationLibrary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return createEmptyEvaluationLibrary();
  const candidate = value as Partial<EvaluationLibrary>;
  let data = createEmptyEvaluationProjectData();
  try {
    data = deserializeEvaluationProjectData(candidate.data);
  } catch {
    // Isolate corruption to the malformed resource. Treating the complete
    // library as one validation unit would make one bad suite hide every
    // otherwise valid suite and baseline after restart.
    const dataCandidate =
      typeof candidate.data === 'object' && candidate.data !== null && !Array.isArray(candidate.data)
        ? (candidate.data as Partial<EvaluationProjectData>)
        : undefined;
    const suites = Array.isArray(dataCandidate?.suites)
      ? dataCandidate.suites.flatMap((suite) => {
          try {
            return [deserializeEvaluationProjectData({ version: 1, suites: [suite], baselines: [] }).suites[0]!];
          } catch {
            return [];
          }
        })
      : [];
    const baselines = Array.isArray(dataCandidate?.baselines)
      ? dataCandidate.baselines.flatMap((baseline) => {
          try {
            return [deserializeEvaluationProjectData({ version: 1, suites: [], baselines: [baseline] }).baselines[0]!];
          } catch {
            return [];
          }
        })
      : [];
    const suiteIds = new Set(suites.map((suite) => suite.id));
    data = { version: 1, suites, baselines: baselines.filter((baseline) => suiteIds.has(baseline.suiteId)) };
  }
  const datasets = Array.isArray(candidate.datasets)
    ? candidate.datasets.flatMap((dataset) => {
        try {
          return [localizeEvaluationDataset(dataset)];
        } catch {
          return [];
        }
      })
    : [];
  return {
    version: 1,
    data: {
      ...data,
      suites: uniqueById(data.suites),
      baselines: uniqueById(data.baselines),
    },
    datasets: uniqueById(datasets),
    migratedLegacyProjectIds: Array.isArray(candidate.migratedLegacyProjectIds)
      ? Array.from(new Set(candidate.migratedLegacyProjectIds.filter((id): id is ProjectId => typeof id === 'string')))
      : [],
  };
}

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

  const hasLegacyResources =
    data.suites.length > 0 || data.baselines.length > 0 || validatedLegacyDatasets.length > 0;
  if (!hasLegacyResources || (sourceProjectId !== undefined && local.migratedLegacyProjectIds.includes(sourceProjectId))) {
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
      sourceProjectId === undefined ? local.migratedLegacyProjectIds : [...local.migratedLegacyProjectIds, sourceProjectId],
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
    runningSuiteId: undefined,
  };
}

const evaluationLibraryState = atomWithStorage<EvaluationLibrary>(
  'library',
  createEmptyEvaluationLibrary(),
  storage,
);
const evaluationWorkspaceState = atom<EvaluationWorkspaceState>({
  activeView: 'definition',
  runs: [],
  runningSuiteId: undefined,
});

export const evaluationsState = atom(
  (get) => {
    const library = normalizeEvaluationLibrary(get(evaluationLibraryState));
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
    const { data: _data, datasets: _datasets, migratedLegacyProjectIds: _migratedLegacyProjectIds, ...workspace } = next;
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
    selectedSuiteId: state.selectedSuiteId && library.data.suites.some((suite) => suite.id === state.selectedSuiteId)
      ? state.selectedSuiteId
      : undefined,
    selectedDatasetId:
      state.selectedDatasetId && library.datasets.some((dataset) => dataset.id === state.selectedDatasetId)
        ? state.selectedDatasetId
        : undefined,
  };
}

export const evaluationsRunningState = atom((get) => get(evaluationsState).runningSuiteId !== undefined);
