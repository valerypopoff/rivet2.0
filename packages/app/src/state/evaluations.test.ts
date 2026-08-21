import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  localizeEvaluationDataset,
  type EvaluationDataset,
  type EvaluationProjectData,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import { getDefaultStore } from 'jotai';
import {
  createDefaultEvaluationsState,
  createEmptyEvaluationLibrary,
  evaluationsState,
  mergeLegacyEvaluationLibrary,
  normalizeEvaluationLibrary,
  type EvaluationLibrary,
} from './evaluations.js';
import { configureHybridStorageBackend, flushHybridStorageGroup, MemoryAsyncStorage } from './storage.js';

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
  const migrated = mergeLegacyEvaluationLibrary(local, legacyData, [dataset('legacy-dataset', sourceProjectId)], sourceProjectId);
  const migratedAgain = mergeLegacyEvaluationLibrary(migrated, legacyData, [
    dataset('legacy-dataset', sourceProjectId),
  ], sourceProjectId);

  assert.deepEqual(migrated.data.suites.map((item) => item.id), ['local-suite', 'legacy-suite']);
  assert.equal(migrated.datasets.find((item) => item.id === 'legacy-dataset')?.projectId, undefined);
  assert.deepEqual(migratedAgain.data.suites.map((item) => item.id), ['local-suite', 'legacy-suite']);
  assert.deepEqual(migratedAgain.datasets.map((item) => item.id), ['local-dataset', 'legacy-dataset']);
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

  assert.deepEqual(second.datasets.map((item) => item.id), ['shared-dataset', 'shared-dataset--legacy-project-b']);
  assert.deepEqual(second.data.suites.map((item) => item.id), ['shared-suite', 'shared-suite--legacy-project-b']);
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

  assert.deepEqual(recovered.data.suites.map((item) => item.id), ['valid-suite']);
  assert.deepEqual(recovered.datasets.map((item) => item.id), ['valid-dataset']);
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

test('the local evaluation library persists suites and datasets independently from a project', async () => {
  const store = getDefaultStore();
  const previousState = store.get(evaluationsState);
  const storage = new MemoryAsyncStorage();
  const restoreStorageBackend = configureHybridStorageBackend(storage);
  const localData: EvaluationProjectData = {
    version: 1,
    suites: [suite('persisted-suite', 'persisted-dataset')],
    baselines: [],
  };

  try {
    store.set(evaluationsState, createDefaultEvaluationsState(localData, [dataset('persisted-dataset')]));
    await flushHybridStorageGroup('evaluation-library');

    const persisted = JSON.parse((await storage.getItem('evaluation-library')) ?? '{}') as {
      library?: EvaluationLibrary;
    };
    assert.equal(persisted.library?.version, 1);
    assert.deepEqual(persisted.library?.data, localData);
    assert.deepEqual(persisted.library?.datasets[0], localizeEvaluationDataset(dataset('persisted-dataset')));
  } finally {
    store.set(evaluationsState, previousState);
    configureHybridStorageBackend(restoreStorageBackend);
  }
});
