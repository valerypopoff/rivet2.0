import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  localizeEvaluationDataset,
  type EvaluationDataset,
  type EvaluationProjectData,
  type EvaluationRun,
  type EvaluationRunEvent,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import { getDefaultStore } from 'jotai';
import {
  applyEvaluationRunEvent,
  applyEvaluationRunSnapshot,
  createDefaultEvaluationsState,
  createEmptyEvaluationLibrary,
  discardEvaluationSuiteWorkspaceState,
  evaluationLibraryState,
  evaluationsState,
  getEvaluationSuitePresentation,
  getEvaluationRunHistoryScopeKey,
  isEvaluationRunHistoryCached,
  mergeLegacyEvaluationLibrary,
  normalizeEvaluationLibrary,
  resetEvaluationsForProjectLoad,
  selectEvaluationDatasetResource,
  selectEvaluationSuiteResource,
  updateEvaluationSuitePresentation,
  type EvaluationLibrary,
} from './evaluations.js';

const suite = (id: string, datasetId: string): EvaluationSuite => ({
  id,
  name: id,
  targetGraphId: 'target-graph' as EvaluationSuite['targetGraphId'],
  datasetId,
  inputBindings: [],
  assertions: [],
  evaluators: [],
});

const dataset = (id: string, projectId?: ProjectId): EvaluationDataset => ({
  id,
  ...(projectId === undefined ? {} : { projectId }),
  name: id,
  fields: [],
  cases: [],
});

const run = (
  id: string,
  executionStatus: EvaluationRun['executionStatus'],
  revision: number,
  name?: string,
): EvaluationRun => ({
  version: 2,
  id,
  projectId: 'project' as ProjectId,
  suiteId: 'suite',
  suiteName: 'Suite',
  ...(name === undefined ? {} : { name }),
  revision,
  startedAt: '2026-08-22T00:00:00.000Z',
  ...(executionStatus === 'completed' ? { completedAt: '2026-08-22T00:00:01.000Z' } : {}),
  purpose: 'evaluation',
  evaluationMode: 'scoring',
  requestedTrialCount: 1,
  executionStatus,
  qualityStatus: executionStatus === 'completed' ? 'scored' : 'not-evaluated',
  qualityReason:
    executionStatus === 'completed'
      ? { code: 'scores-complete', message: 'Complete.' }
      : { code: 'in-progress', message: 'Running.' },
  accountingStatus: 'complete',
  provenance: {
    projectFingerprint: 'project',
    suiteFingerprint: 'suite',
    datasetFingerprint: 'dataset',
    targetFingerprint: 'target',
    evaluatorFingerprints: {},
    executionMode: 'browser',
    accountingComplete: true,
  },
  thresholdResults: [],
  trials: [],
  warnings: [],
});

test('terminal runner snapshot becomes selected before history persistence completes', () => {
  const previousRun = run('previous', 'completed', 3, 'Previous');
  const runningRun = run('current', 'running', 2, 'Current name');
  const initial = {
    ...createDefaultEvaluationsState(),
    runningSuiteId: 'suite',
    selectedRunId: previousRun.id,
    currentRun: runningRun,
    runs: [previousRun],
  };

  const terminalRun = run('current', 'completed', 3);
  const terminalState = applyEvaluationRunSnapshot(initial, terminalRun);

  assert.equal(terminalState.selectedRunId, terminalRun.id);
  assert.equal(terminalState.currentRun?.id, terminalRun.id);
  assert.equal(terminalState.currentRun?.name, 'Current name');
  assert.equal(terminalState.runHistoryScope, undefined);
  assert.deepEqual(
    terminalState.runs.map((candidate) => candidate.id),
    ['current', 'previous'],
  );
  assert.equal(terminalState.runs[0]?.name, 'Current name');

  const enrichedTerminalState = applyEvaluationRunSnapshot(terminalState, {
    ...terminalRun,
    warnings: ['Recording retention could not be saved.'],
  });
  assert.deepEqual(enrichedTerminalState.currentRun?.warnings, ['Recording retention could not be saved.']);
  assert.equal(enrichedTerminalState.currentRun?.name, 'Current name');

  const delayedProgressState = applyEvaluationRunSnapshot(enrichedTerminalState, run('current', 'running', 2));
  assert.equal(delayedProgressState, enrichedTerminalState);
});

test('Runs cache is scoped to its exact project and suite and resets with a project change', () => {
  const scope = { projectId: 'project-a' as ProjectId, suiteId: 'suite-a' };
  const scopeKey = getEvaluationRunHistoryScopeKey(scope);
  const initial = {
    ...createDefaultEvaluationsState(),
    runHistoryScope: scope,
    runScoreSortByScope: { [scopeKey]: 'score-desc' as const },
    runTrialExpansion: { scope, runId: 'run-a', trialIds: ['trial-a'] },
    runScrollTopByScope: { [scopeKey]: 240 },
    runs: [run('run-a', 'completed', 1)],
  };

  assert.equal(isEvaluationRunHistoryCached(initial, scope), true);
  assert.equal(
    isEvaluationRunHistoryCached(initial, { projectId: 'project-b' as ProjectId, suiteId: scope.suiteId }),
    false,
  );
  assert.equal(isEvaluationRunHistoryCached(initial, { projectId: scope.projectId, suiteId: 'suite-b' }), false);

  const reset = resetEvaluationsForProjectLoad(initial, undefined, undefined, 'project-b' as ProjectId);
  assert.equal(reset.runHistoryScope, undefined);
  assert.deepEqual(reset.runScoreSortByScope, {});
  assert.equal(reset.runTrialExpansion, undefined);
  assert.deepEqual(reset.runScrollTopByScope, {});
  assert.deepEqual(reset.runs, []);
});

test('opening a project without legacy evaluations preserves the hydrated library references', () => {
  const initial = {
    ...createDefaultEvaluationsState(
      { version: 1, suites: [suite('shared-suite', 'shared-dataset')], baselines: [] },
      [dataset('shared-dataset')],
    ),
    migratedLegacyProjectIds: ['previous-project' as ProjectId],
  };

  const reset = resetEvaluationsForProjectLoad(initial, undefined, undefined, 'unrelated-project' as ProjectId);

  // The host only persists a library when this identity changes. A normal
  // project switch must therefore remain a true no-op for shared storage.
  assert.equal(reset.data, initial.data);
  assert.equal(reset.datasets, initial.datasets);
  assert.equal(reset.migratedLegacyProjectIds, initial.migratedLegacyProjectIds);
});

test('a dataset round trip preserves the last suite view and warm Runs presentation', () => {
  const scope = { projectId: 'project-a' as ProjectId, suiteId: 'suite-a' };
  const retainedRun = run('run-a', 'completed', 1);
  const initial = updateEvaluationSuitePresentation(
    {
      ...createDefaultEvaluationsState(),
      activeView: 'runs',
      selectedSuiteId: scope.suiteId,
      runs: [retainedRun],
      runHistoryScope: scope,
      selectedRunId: retainedRun.id,
      runTrialExpansion: { scope, runId: retainedRun.id, trialIds: ['trial-a'] },
    },
    scope,
    {
      activeView: 'runs',
      definitionView: 'evaluator-graphs',
      additionalExecutionSettingsExpanded: true,
    },
  );

  const datasetState = selectEvaluationDatasetResource(initial, 'dataset-a');
  assert.equal(datasetState.activeView, 'dataset');
  assert.equal(datasetState.selectedSuiteId, undefined);
  assert.equal(datasetState.selectedDatasetId, 'dataset-a');
  assert.equal(datasetState.runs, initial.runs);
  assert.equal(datasetState.runHistoryScope, initial.runHistoryScope);
  assert.equal(datasetState.runTrialExpansion, initial.runTrialExpansion);
  assert.equal(datasetState.selectedRunId, retainedRun.id);

  const restored = selectEvaluationSuiteResource(datasetState, scope, false);
  assert.equal(restored.activeView, 'runs');
  assert.equal(restored.selectedSuiteId, scope.suiteId);
  assert.equal(restored.selectedDatasetId, undefined);
  assert.equal(restored.runs, initial.runs);
  assert.equal(restored.runHistoryScope, initial.runHistoryScope);
  assert.equal(restored.runTrialExpansion, initial.runTrialExpansion);
  assert.equal(restored.selectedRunId, retainedRun.id);
  assert.deepEqual(getEvaluationSuitePresentation(restored, scope), {
    activeView: 'runs',
    definitionView: 'evaluator-graphs',
    additionalExecutionSettingsExpanded: true,
  });
});

test('opening a cold suite clears only the previous suite Runs payload', () => {
  const warmScope = { projectId: 'project-a' as ProjectId, suiteId: 'suite-a' };
  const coldScope = { projectId: warmScope.projectId, suiteId: 'suite-b' };
  const retainedRun = run('run-a', 'completed', 1);
  const initial = {
    ...createDefaultEvaluationsState(),
    activeView: 'runs' as const,
    selectedSuiteId: warmScope.suiteId,
    runs: [retainedRun],
    runHistoryScope: warmScope,
    selectedRunId: retainedRun.id,
    runTrialExpansion: { scope: warmScope, runId: retainedRun.id, trialIds: ['trial-a'] },
  };

  const selected = selectEvaluationSuiteResource(initial, coldScope, false);

  assert.equal(selected.selectedSuiteId, coldScope.suiteId);
  assert.equal(selected.activeView, 'definition');
  assert.deepEqual(selected.runs, []);
  assert.equal(selected.runHistoryScope, undefined);
  assert.equal(selected.runTrialExpansion, undefined);
  assert.equal(selected.selectedRunId, undefined);
});

test('deleting a suite drops only its session presentation and cached Runs state', () => {
  const removedScope = { projectId: 'project-a' as ProjectId, suiteId: 'suite-a' };
  const retainedScope = { projectId: 'project-b' as ProjectId, suiteId: 'suite-b' };
  const removedKey = getEvaluationRunHistoryScopeKey(removedScope);
  const retainedKey = getEvaluationRunHistoryScopeKey(retainedScope);
  const removedRun = { ...run('run-a', 'completed', 1), ...removedScope };
  const retainedRun = { ...run('run-b', 'completed', 1), ...retainedScope };
  const withPresentations = updateEvaluationSuitePresentation(
    updateEvaluationSuitePresentation(createDefaultEvaluationsState(), removedScope, {
      activeView: 'runs',
      definitionView: 'evaluator-graphs',
    }),
    retainedScope,
    {
      activeView: 'compare',
      definitionView: 'thresholds',
      additionalExecutionSettingsExpanded: true,
    },
  );
  const initial = {
    ...withPresentations,
    runs: [removedRun, retainedRun],
    currentRun: removedRun,
    runHistoryScope: removedScope,
    selectedRunId: removedRun.id,
    runTrialExpansion: { scope: removedScope, runId: removedRun.id, trialIds: ['trial-a'] },
    runScoreSortByScope: {
      [removedKey]: 'score-desc' as const,
      [retainedKey]: 'score-asc' as const,
    },
    runScrollTopByScope: { [removedKey]: 120, [retainedKey]: 240 },
  };

  const cleaned = discardEvaluationSuiteWorkspaceState(initial, new Set([removedScope.suiteId]));

  assert.deepEqual(cleaned.runs, [retainedRun]);
  assert.equal(cleaned.currentRun, undefined);
  assert.equal(cleaned.runHistoryScope, undefined);
  assert.equal(cleaned.selectedRunId, undefined);
  assert.equal(cleaned.runTrialExpansion, undefined);
  assert.equal(cleaned.suitePresentationByScope[removedKey], undefined);
  assert.equal(cleaned.runScoreSortByScope[removedKey], undefined);
  assert.equal(cleaned.runScrollTopByScope[removedKey], undefined);
  assert.deepEqual(getEvaluationSuitePresentation(cleaned, retainedScope), {
    activeView: 'compare',
    definitionView: 'thresholds',
    additionalExecutionSettingsExpanded: true,
  });
  assert.equal(cleaned.runScoreSortByScope[retainedKey], 'score-asc');
  assert.equal(cleaned.runScrollTopByScope[retainedKey], 240);
});

test('progress snapshots do not replace the selected retained run before completion', () => {
  const previousRun = run('previous', 'completed', 3);
  const initial = {
    ...createDefaultEvaluationsState(),
    selectedRunId: previousRun.id,
    runs: [previousRun],
  };

  const updated = applyEvaluationRunSnapshot(initial, run('current', 'running', 1));

  assert.equal(updated.selectedRunId, previousRun.id);
  assert.deepEqual(updated.runs, [previousRun]);
  assert.equal(updated.currentRun?.id, 'current');
});

test('incremental trial events preserve settled evidence and reject stale revisions', () => {
  const started = run('current', 'running', 1);
  const initial = applyEvaluationRunEvent(createDefaultEvaluationsState(), {
    type: 'run-started',
    revision: 1,
    run: started,
  });
  const trial = {
    id: 'trial-a',
    caseId: 'case-a',
    caseName: 'Case A',
    caseIndex: 0,
    trialIndex: 0,
    executionStatus: 'completed',
    qualityStatus: 'scored',
    qualityReason: { code: 'scores-complete', message: 'Scored.' },
    inputs: {},
    expected: {},
    outputs: { result: 'value' },
    observations: [],
    targetMetrics: { durationMs: 1 },
    evaluatorMetrics: { durationMs: 0 },
    totalMetrics: { durationMs: 1 },
  } as EvaluationRun['trials'][number];
  const event: EvaluationRunEvent = {
    type: 'trial-settled',
    revision: 2,
    runId: started.id,
    projectId: started.projectId,
    suiteId: started.suiteId,
    requestedTrialCount: 2,
    settledTrialCount: 1,
    trial,
  };

  const updated = applyEvaluationRunEvent(initial, event);
  assert.equal(updated.currentRun?.revision, 2);
  assert.equal(updated.currentRun?.requestedTrialCount, 2);
  assert.deepEqual(updated.currentRun?.trials, [trial]);
  assert.equal(applyEvaluationRunEvent(updated, { ...event, revision: 2 }), updated);
});

test('a partial current snapshot cannot discard fuller retained trial evidence', () => {
  const fullRun = {
    ...run('current', 'completed', 3),
    trials: [
      { id: 'first', observations: [] },
      { id: 'second', observations: [] },
    ],
  } as unknown as EvaluationRun;
  const partialRun = {
    ...fullRun,
    trials: [{ id: 'first', observations: [] }],
  } as unknown as EvaluationRun;
  const initial = {
    ...createDefaultEvaluationsState(),
    currentRun: partialRun,
    selectedRunId: fullRun.id,
    runs: [fullRun],
  };

  const updated = applyEvaluationRunSnapshot(initial, partialRun);

  assert.deepEqual(
    updated.currentRun?.trials.map((trial) => trial.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    updated.runs[0]?.trials.map((trial) => trial.id),
    ['first', 'second'],
  );
});

test('legacy project evaluations migrate into the local library once and become reusable', () => {
  const local: EvaluationLibrary = {
    ...createEmptyEvaluationLibrary(),
    data: { version: 1, suites: [suite('local-suite', 'local-dataset')], baselines: [] },
    datasets: [dataset('local-dataset')],
  };
  const legacyData: EvaluationProjectData = {
    version: 1,
    suites: [suite('legacy-suite', 'legacy-dataset')],
    baselines: [],
  };

  const sourceProjectId = 'project-a' as ProjectId;
  const migrated = mergeLegacyEvaluationLibrary(
    local,
    legacyData,
    [dataset('legacy-dataset', sourceProjectId)],
    sourceProjectId,
  );
  const migratedAgain = mergeLegacyEvaluationLibrary(
    migrated,
    legacyData,
    [dataset('legacy-dataset', sourceProjectId)],
    sourceProjectId,
  );

  assert.deepEqual(
    migrated.data.suites.map((item) => item.id),
    ['local-suite', 'legacy-suite'],
  );
  assert.equal(migrated.datasets.find((item) => item.id === 'legacy-dataset')?.projectId, undefined);
  assert.deepEqual(
    migratedAgain.data.suites.map((item) => item.id),
    ['local-suite', 'legacy-suite'],
  );
  assert.deepEqual(
    migratedAgain.datasets.map((item) => item.id),
    ['local-dataset', 'legacy-dataset'],
  );
  assert.deepEqual(migratedAgain.migratedLegacyProjectIds, [sourceProjectId]);

  const deleted = mergeLegacyEvaluationLibrary(
    { ...migrated, data: createEmptyEvaluationLibrary().data, datasets: [] },
    legacyData,
    [dataset('legacy-dataset', sourceProjectId)],
    sourceProjectId,
  );
  assert.deepEqual(deleted.data.suites, []);
  assert.deepEqual(deleted.datasets, []);
});

test('legacy resources with matching project-scoped IDs retain independent suite bindings', () => {
  const firstProjectId = 'project-a' as ProjectId;
  const secondProjectId = 'project-b' as ProjectId;
  const firstData: EvaluationProjectData = {
    version: 1,
    suites: [suite('shared-suite', 'shared-dataset')],
    baselines: [],
  };
  const secondData: EvaluationProjectData = {
    version: 1,
    suites: [suite('shared-suite', 'shared-dataset')],
    baselines: [],
  };

  const first = mergeLegacyEvaluationLibrary(
    createEmptyEvaluationLibrary(),
    firstData,
    [{ ...dataset('shared-dataset', firstProjectId), name: 'First dataset' }],
    firstProjectId,
  );
  const second = mergeLegacyEvaluationLibrary(
    first,
    secondData,
    [{ ...dataset('shared-dataset', secondProjectId), name: 'Second dataset' }],
    secondProjectId,
  );
  const reopenedSecond = mergeLegacyEvaluationLibrary(
    second,
    secondData,
    [{ ...dataset('shared-dataset', secondProjectId), name: 'Second dataset' }],
    secondProjectId,
  );

  assert.deepEqual(
    second.datasets.map((item) => item.id),
    ['shared-dataset', 'shared-dataset--legacy-project-b'],
  );
  assert.deepEqual(
    second.data.suites.map((item) => item.id),
    ['shared-suite', 'shared-suite--legacy-project-b'],
  );
  assert.equal(second.data.suites[1]?.datasetId, 'shared-dataset--legacy-project-b');
  assert.deepEqual(reopenedSecond, second);
});

test('local library recovery drops only malformed resources instead of all suites', () => {
  const validSuite = suite('valid-suite', 'valid-dataset');
  const malformedSuite = { ...suite('broken-suite', 'broken-dataset'), inputBindings: 'not-an-array' };
  const recovered = normalizeEvaluationLibrary({
    version: 1,
    data: { version: 1, suites: [validSuite, malformedSuite], baselines: [] },
    datasets: [dataset('valid-dataset'), { ...dataset('broken-dataset'), fields: 'not-an-array' }],
    migratedLegacyProjectIds: [],
  });

  assert.deepEqual(
    recovered.data.suites.map((item) => item.id),
    ['valid-suite'],
  );
  assert.deepEqual(
    recovered.datasets.map((item) => item.id),
    ['valid-dataset'],
  );
});

test('local library normalization preserves in-progress empty display names', () => {
  const draftDataset = {
    ...dataset('draft-dataset'),
    name: '',
    fields: [{ id: 'field', name: '', dataType: 'string', role: 'input' as const }],
    cases: [{ id: 'case', name: '', values: {} }],
  };
  const draftSuite = { ...suite('draft-suite', draftDataset.id), name: '' };

  const normalized = normalizeEvaluationLibrary({
    version: 1,
    data: { version: 1, suites: [draftSuite], baselines: [] },
    datasets: [draftDataset],
    migratedLegacyProjectIds: [],
  });

  assert.equal(normalized.data.suites[0]?.name, '');
  assert.equal(normalized.datasets[0]?.name, '');
  assert.equal(normalized.datasets[0]?.fields[0]?.name, '');
  assert.equal(normalized.datasets[0]?.cases[0]?.name, '');
});

test('the evaluation workspace publishes suite and dataset changes through its library atom', () => {
  const store = getDefaultStore();
  const previousState = store.get(evaluationsState);
  const localData: EvaluationProjectData = {
    version: 1,
    suites: [suite('persisted-suite', 'persisted-dataset')],
    baselines: [],
  };

  try {
    store.set(evaluationsState, createDefaultEvaluationsState(localData, [dataset('persisted-dataset')]));
    const library = store.get(evaluationLibraryState);
    assert.equal(library.version, 1);
    assert.deepEqual(library.data, localData);
    assert.deepEqual(library.datasets[0], localizeEvaluationDataset(dataset('persisted-dataset')));
  } finally {
    store.set(evaluationsState, previousState);
  }
});

test('workspace-only updates preserve normalized evaluation-library references', () => {
  const store = getDefaultStore();
  const previousState = store.get(evaluationsState);

  try {
    store.set(evaluationsState, {
      ...createDefaultEvaluationsState(
        { version: 1, suites: [suite('stable-suite', 'stable-dataset')], baselines: [] },
        [dataset('stable-dataset')],
      ),
      activeView: 'definition',
    });
    const library = store.get(evaluationLibraryState);

    store.set(evaluationsState, (current) => ({ ...current, activeView: 'runs' }));

    assert.equal(store.get(evaluationLibraryState), library);
    assert.equal(store.get(evaluationsState).data, library.data);
    assert.equal(store.get(evaluationsState).datasets, library.datasets);
  } finally {
    store.set(evaluationsState, previousState);
  }
});
