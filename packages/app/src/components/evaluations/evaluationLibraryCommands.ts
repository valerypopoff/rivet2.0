import type { EvaluationsState } from '../../state/evaluations.js';
import { discardEvaluationSuiteWorkspaceState, selectEvaluationDatasetResource } from '../../state/evaluations.js';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import { nanoid } from 'nanoid/non-secure';
import {
  reassignEvaluationSuiteDataset,
  reassignEvaluationSuiteTarget,
  removeEvaluationDatasetField,
  removeEvaluationDatasetFieldReferences,
} from './evaluationWorkspaceModel.js';

export type EvaluationLibraryOutcome = {
  state: EvaluationsState;
  kind: 'success' | 'unavailable' | 'conflict';
  message?: string;
};

export function createDataset(suiteName = 'New evaluation suite'): EvaluationDataset {
  return { id: nanoid(), name: `${suiteName} dataset`, fields: [], cases: [] };
}

export function createStandaloneDataset(): EvaluationDataset {
  return { id: nanoid(), name: 'New evaluation dataset', fields: [], cases: [] };
}

export function createSuite(
  dataset: EvaluationDataset,
  graphId: string,
  name = 'New evaluation suite',
): EvaluationSuite {
  return {
    id: nanoid(),
    name,
    targetGraphId: graphId as EvaluationSuite['targetGraphId'],
    datasetId: dataset.id,
    inputBindings: [],
    assertions: [],
    evaluators: [],
    thresholds: [],
    configuration: { trialCount: 1, concurrency: 4, recordingRetention: 'failures-and-baselines' },
  };
}

export function addEvaluationDataset(
  current: EvaluationsState,
  dataset: EvaluationDataset,
  select = true,
): EvaluationLibraryOutcome {
  if (current.datasets.some((item) => item.id === dataset.id))
    return { state: current, kind: 'conflict', message: 'An evaluation dataset with this identity already exists.' };
  const state = { ...current, datasets: [...current.datasets, dataset] };
  return { state: select ? selectEvaluationDatasetResource(state, dataset.id) : state, kind: 'success' };
}

export function addEvaluationSuite(
  current: EvaluationsState,
  suite: EvaluationSuite,
  dataset?: EvaluationDataset,
  select = true,
): EvaluationLibraryOutcome {
  if (
    current.data.suites.some((item) => item.id === suite.id) ||
    (dataset && current.datasets.some((item) => item.id === dataset.id))
  )
    return { state: current, kind: 'conflict', message: 'An evaluation resource with this identity already exists.' };
  if (!current.datasets.some((item) => item.id === suite.datasetId) && dataset?.id !== suite.datasetId)
    return { state: current, kind: 'unavailable', message: 'The selected evaluation dataset no longer exists.' };
  return {
    kind: 'success',
    state: {
      ...current,
      datasets: dataset ? [...current.datasets, dataset] : current.datasets,
      data: { ...current.data, suites: [...current.data.suites, suite] },
      ...(select
        ? {
            activeView: 'definition' as const,
            selectedSuiteId: suite.id,
            selectedDatasetId: undefined,
            runs: [],
            runHistoryEntries: undefined,
            runHistoryNextCursor: undefined,
            runHistoryScope: undefined,
            runTrialExpansion: undefined,
            selectedRunId: undefined,
          }
        : {}),
    },
  };
}

export function assignEvaluationSuiteResource(
  current: EvaluationsState,
  input: { suiteId: string; datasetId: string } | { suiteId: string; graphId: EvaluationSuite['targetGraphId'] },
): EvaluationLibraryOutcome {
  const suite = current.data.suites.find((item) => item.id === input.suiteId);
  if (!suite || ('datasetId' in input && !current.datasets.some((item) => item.id === input.datasetId)))
    return {
      state: current,
      kind: 'unavailable',
      message: 'The selected evaluation suite or dataset no longer exists.',
    };
  if (current.runningSuiteId === suite.id)
    return { state: current, kind: 'conflict', message: 'Stop the running evaluation before changing its resources.' };
  const next =
    'datasetId' in input
      ? reassignEvaluationSuiteDataset(suite, input.datasetId)
      : reassignEvaluationSuiteTarget(suite, input.graphId);
  return {
    kind: 'success',
    state: {
      ...current,
      data: { ...current.data, suites: current.data.suites.map((item) => (item.id === suite.id ? next : item)) },
    },
  };
}

export function replaceEvaluationDataset(
  current: EvaluationsState,
  expected: EvaluationDataset,
  replacement: EvaluationDataset,
): EvaluationLibraryOutcome {
  const dataset = current.datasets.find((item) => item.id === expected.id);
  if (!dataset)
    return { state: current, kind: 'unavailable', message: 'The destination evaluation dataset no longer exists.' };
  if (dataset !== expected || replacement.id !== expected.id)
    return {
      state: current,
      kind: 'conflict',
      message: 'The evaluation dataset changed while the file was being selected. Import it again.',
    };
  if (current.data.suites.some((suite) => suite.datasetId === dataset.id && suite.id === current.runningSuiteId))
    return { state: current, kind: 'conflict', message: 'Stop the evaluation using this dataset before replacing it.' };
  return {
    kind: 'success',
    state: { ...current, datasets: current.datasets.map((item) => (item.id === dataset.id ? replacement : item)) },
  };
}

export function removeEvaluationField(
  current: EvaluationsState,
  datasetId: string,
  fieldId: string,
): EvaluationLibraryOutcome {
  const dataset = current.datasets.find((item) => item.id === datasetId);
  if (!dataset || !dataset.fields.some((field) => field.id === fieldId))
    return { state: current, kind: 'unavailable', message: 'The selected evaluation field no longer exists.' };
  if (current.data.suites.some((suite) => suite.datasetId === datasetId && suite.id === current.runningSuiteId))
    return {
      state: current,
      kind: 'conflict',
      message: 'Stop the evaluation using this dataset before removing a field.',
    };
  return {
    kind: 'success',
    state: {
      ...current,
      datasets: current.datasets.map((item) =>
        item.id === datasetId ? removeEvaluationDatasetField(item, fieldId) : item,
      ),
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) =>
          suite.datasetId === datasetId ? removeEvaluationDatasetFieldReferences(suite, fieldId) : suite,
        ),
      },
    },
  };
}

/** Shared-library deletion is evaluated against current state, not a dialog snapshot. */
export function removeEvaluationResources(
  current: EvaluationsState,
  input: { suiteIds: readonly string[]; datasetId?: string },
): { state: EvaluationsState; blocked: boolean } {
  const removedSuiteIds = new Set(input.suiteIds);
  if (input.datasetId) {
    for (const suite of current.data.suites) {
      if (suite.datasetId === input.datasetId) removedSuiteIds.add(suite.id);
    }
  }
  if (current.runningSuiteId && removedSuiteIds.has(current.runningSuiteId)) return { state: current, blocked: true };
  const workspace = discardEvaluationSuiteWorkspaceState(current, removedSuiteIds);
  return {
    blocked: false,
    state: {
      ...workspace,
      datasets:
        input.datasetId === undefined
          ? workspace.datasets
          : workspace.datasets.filter((dataset) => dataset.id !== input.datasetId),
      data: {
        ...workspace.data,
        suites: workspace.data.suites.filter((suite) => !removedSuiteIds.has(suite.id)),
        baselines: workspace.data.baselines.filter((baseline) => !removedSuiteIds.has(baseline.suiteId)),
      },
      selectedSuiteId: removedSuiteIds.has(workspace.selectedSuiteId ?? '') ? undefined : workspace.selectedSuiteId,
      selectedDatasetId: input.datasetId === workspace.selectedDatasetId ? undefined : workspace.selectedDatasetId,
    },
  };
}
