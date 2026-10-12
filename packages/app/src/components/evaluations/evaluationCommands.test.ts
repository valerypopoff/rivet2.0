import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationRun, EvaluationRunStore, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import { createDefaultEvaluationsState, type EvaluationsState } from '../../state/evaluations.js';
import { createEvaluationRunCommands, type EvaluationCommandNotice } from './evaluationRunCommands.js';
import {
  addEvaluationSuite,
  assignEvaluationSuiteResource,
  createDataset,
  createSuite,
  removeEvaluationField,
  removeEvaluationResources,
  replaceEvaluationDataset,
} from './evaluationLibraryCommands.js';
import { createEvaluationTransferCommands } from './evaluationTransferCommands.js';
import { serializeEvaluationDatasetJson } from '@valerypopoff/rivet2-evaluations';

test('suite creation and reassignment cannot resurrect a removed dataset', () => {
  const state = createDefaultEvaluationsState();
  const dataset = createDataset();
  const suite = createSuite(dataset, 'graph');
  assert.equal(addEvaluationSuite(state, suite).kind, 'unavailable');
  state.data.suites = [suite];
  assert.equal(assignEvaluationSuiteResource(state, { suiteId: suite.id, datasetId: dataset.id }).kind, 'unavailable');
});

test('creating a suite preserves the independently owned live run', () => {
  const state = createDefaultEvaluationsState();
  state.currentRun = { id: 'live' } as EvaluationRun;
  state.runningSuiteId = 'running';
  const dataset = createDataset();
  const outcome = addEvaluationSuite(state, createSuite(dataset, 'graph'), dataset);
  assert.equal(outcome.state.currentRun, state.currentRun);
  assert.equal(outcome.state.runningSuiteId, 'running');
});

test('field removal rechecks running dependencies after a confirmation was opened', () => {
  const state = createDefaultEvaluationsState();
  const dataset = createDataset();
  dataset.fields = [{ id: 'field', name: 'Input', dataType: 'string', role: 'input' }];
  const suite = createSuite(dataset, 'graph');
  state.datasets = [dataset];
  state.data.suites = [suite];
  state.runningSuiteId = suite.id;
  assert.equal(removeEvaluationField(state, dataset.id, 'field').kind, 'conflict');
  state.runningSuiteId = undefined;
  const removed = removeEvaluationField(state, dataset.id, 'field');
  assert.equal(removed.kind, 'success');
  assert.deepEqual(removed.state.datasets[0]?.fields, []);
});

test('file replacement detects edits, deletion and a newly running dependent suite', () => {
  const state = createDefaultEvaluationsState();
  const dataset = createDataset();
  state.datasets = [dataset];
  assert.equal(replaceEvaluationDataset(state, dataset, { ...dataset, name: 'Imported' }).kind, 'success');
  state.datasets = [{ ...dataset, name: 'Newer edit' }];
  assert.equal(replaceEvaluationDataset(state, dataset, dataset).kind, 'conflict');
  state.datasets = [dataset];
  const suite = createSuite(dataset, 'graph');
  state.data.suites = [suite];
  state.runningSuiteId = suite.id;
  assert.equal(replaceEvaluationDataset(state, dataset, dataset).kind, 'conflict');
  state.datasets = [];
  assert.equal(replaceEvaluationDataset(state, dataset, dataset).kind, 'unavailable');
});

test('accepted library import after navigation does not replace the current workspace selection', async () => {
  let state = createDefaultEvaluationsState();
  state.selectedDatasetId = 'new-selection';
  let active = true;
  let deliver!: (source: string, fileName: string) => void;
  let finish!: () => void;
  const notices: EvaluationCommandNotice[] = [];
  const commands = createEvaluationTransferCommands({
    io: {
      readFileAsString: async (callback) => {
        deliver = callback;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      saveString: async () => {},
    },
    setState: (update) => {
      state = update(state);
    },
    isCurrent: () => active,
    onNotice: (notice) => notices.push(notice),
  });
  const importing = commands.importDataset();
  active = false;
  deliver(serializeEvaluationDatasetJson(createDataset()), 'dataset.json');
  finish();
  await importing;
  assert.equal(state.datasets.length, 1);
  assert.equal(state.selectedDatasetId, 'new-selection');
  assert.equal(notices[0]?.kind, 'success');
});

const projectId = 'project' as ProjectId;
const run = {
  id: 'run',
  projectId,
  suiteId: 'suite',
  executionStatus: 'completed',
  trials: [],
} as unknown as EvaluationRun;

function commands(store: Partial<EvaluationRunStore>, isCurrent = () => true, sourceRun = run) {
  const suite = { id: sourceRun.suiteId } as EvaluationSuite;
  let state: EvaluationsState = {
    ...createDefaultEvaluationsState(),
    runs: [sourceRun],
    selectedRunId: sourceRun.id,
  };
  state.data.suites = [suite];
  const notices: EvaluationCommandNotice[] = [];
  let invalidations = 0;
  const command = createEvaluationRunCommands({
    state,
    projectId,
    runStore: store as EvaluationRunStore,
    selectedSuite: suite,
    comparableRun: sourceRun,
    isCurrent,
    setState: (update) => {
      state = update(state);
    },
    onNotice: (notice) => notices.push(notice),
    invalidateHistory: () => {
      invalidations += 1;
    },
    markHistoryReady: () => {},
  });
  return {
    command,
    notices,
    getState: () => state,
    updateState: (update: (current: EvaluationsState) => EvaluationsState) => {
      state = update(state);
    },
    getInvalidations: () => invalidations,
  };
}

test('deleting a run commits before selection and history invalidation', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const c = commands({ delete: () => pending });
  const deleting = c.command.deleteEvaluationRun(run);
  assert.equal(c.getState().runs.length, 1);
  resolve();
  await deleting;
  assert.equal(c.getState().runs.length, 0);
  assert.equal(c.getInvalidations(), 1);
});

test('navigation suppresses stale projection, not the accepted durable delete', async () => {
  let active = true;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const c = commands({ delete: () => pending }, () => active);
  const deleting = c.command.deleteEvaluationRun(run);
  active = false;
  resolve();
  await deleting;
  assert.equal(c.getState().runs.length, 1);
  assert.equal(c.getInvalidations(), 0);
});

test('a durable delete after panel disposal invalidates only its matching warm cache', async () => {
  let active = true;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const c = commands({ delete: () => pending }, () => active);
  c.updateState((current) => ({ ...current, runHistoryScope: { projectId, suiteId: run.suiteId } }));
  const deleting = c.command.deleteEvaluationRun(run);
  active = false;
  resolve();
  await deleting;
  assert.equal(c.getState().runHistoryScope, undefined);
  assert.equal(c.getState().selectedRunId, run.id);
  assert.equal(c.getState().runs.length, 1);
  assert.equal(c.getInvalidations(), 0);
});

test('a stale command cannot invalidate a different suite or project cache', async () => {
  for (const scope of [
    { projectId, suiteId: 'other-suite' },
    { projectId: 'other-project' as ProjectId, suiteId: run.suiteId },
  ]) {
    const c = commands({ updateRunName: async () => ({ ...run, name: 'Saved' }) }, () => false);
    c.updateState((current) => ({ ...current, runHistoryScope: scope }));
    await c.command.renameEvaluationRun(run.id, 'Saved');
    assert.equal(c.getState().runHistoryScope, scope);
    assert.equal(c.getState().runs[0]!.name, undefined);
  }
});

test('failed persistence keeps history and selection unchanged', async () => {
  const c = commands({
    delete: async () => {
      throw new Error('offline');
    },
  });
  await c.command.deleteEvaluationRun(run);
  assert.equal(c.getState().selectedRunId, run.id);
  assert.equal(c.getInvalidations(), 0);
  assert.equal(c.notices[0]!.kind, 'failed');
});

test('a committed rename fences outstanding history reads before projecting its name', async () => {
  let resolve!: (value: EvaluationRun) => void;
  const pending = new Promise<EvaluationRun>((done) => {
    resolve = done;
  });
  const c = commands({ updateRunName: () => pending });
  const renaming = c.command.renameEvaluationRun(run.id, 'New name');
  assert.equal(c.getInvalidations(), 0);
  assert.equal(c.getState().runs[0]!.name, undefined);
  resolve({ ...run, name: 'New name' });
  await renaming;
  assert.equal(c.getInvalidations(), 1);
  assert.equal(c.getState().runs[0]!.name, 'New name');
});

test('failed rename and superseded rename never invalidate the active history scope', async () => {
  const failed = commands({
    updateRunName: async () => {
      throw new Error('offline');
    },
  });
  await failed.command.renameEvaluationRun(run.id, 'Unsaved');
  assert.equal(failed.getInvalidations(), 0);
  assert.equal(failed.getState().runs[0]!.name, undefined);
  const superseded = commands({ updateRunName: async () => ({ ...run, name: 'Saved' }) }, () => false);
  await superseded.command.renameEvaluationRun(run.id, 'Saved');
  assert.equal(superseded.getInvalidations(), 0);
  assert.equal(superseded.getState().runs[0]!.name, undefined);
});

test('rapid renames are ordered across command instances while other runs remain independent', async () => {
  const writes: string[] = [];
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const store = {
    updateRunName: async ({ name, runId }: { name?: string; runId: string }) => {
      writes.push(`${runId}:${name}`);
      if (name === 'First') await blocked;
      return { ...run, id: runId, name };
    },
  };
  const first = commands(store);
  const reopened = commands(store);
  const one = first.command.renameEvaluationRun(run.id, 'First');
  const two = reopened.command.renameEvaluationRun(run.id, 'Second');
  await reopened.command.renameEvaluationRun('independent', 'Other');
  assert.deepEqual(writes, ['run:First', 'independent:Other']);
  finish();
  await Promise.all([one, two]);
  assert.deepEqual(writes, ['run:First', 'independent:Other', 'run:Second']);
  assert.equal(reopened.getState().runs[0]!.name, 'Second');
  await reopened.command.renameEvaluationRun(run.id, 'Third');
  assert.equal(reopened.getState().runs[0]!.name, 'Third');
});

test('rename queue is bounded and a failed save does not strand later names', async () => {
  let fail!: () => void;
  const blocked = new Promise<void>((resolve) => {
    fail = resolve;
  });
  let writes = 0;
  const c = commands({
    updateRunName: async ({ name }) => {
      writes++;
      if (name === '0') {
        await blocked;
        throw new Error('offline');
      }
      return { ...run, name };
    },
  });
  const renames = Array.from({ length: 9 }, (_, index) => c.command.renameEvaluationRun(run.id, String(index)));
  await Promise.resolve();
  assert.equal(writes, 1);
  assert.equal(c.notices[0]!.kind, 'conflict');
  fail();
  await Promise.all(renames);
  assert.equal(writes, 8);
  assert.equal(c.getState().runs[0]!.name, '7');
  await c.command.renameEvaluationRun(run.id, 'After');
  assert.equal(c.getState().runs[0]!.name, 'After');
});

test('a command never mutates a run owned by another project', async () => {
  let writes = 0;
  const c = commands({
    delete: async () => {
      writes += 1;
    },
  });
  await c.command.deleteEvaluationRun({ ...run, projectId: 'other' as ProjectId });
  assert.equal(writes, 0);
  assert.equal(c.notices[0]!.kind, 'failed');
});

test('dataset deletion includes dependencies added after its confirmation dialog opened', () => {
  const state = createDefaultEvaluationsState();
  state.data.suites = [{ id: 'new-suite', datasetId: 'dataset' } as EvaluationSuite];
  state.runningSuiteId = 'new-suite';
  const blocked = removeEvaluationResources(state, { suiteIds: [], datasetId: 'dataset' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.state, state);
  state.runningSuiteId = undefined;
  assert.equal(removeEvaluationResources(state, { suiteIds: [], datasetId: 'dataset' }).state.data.suites.length, 0);
});

const recordedRun = {
  ...run,
  purpose: 'execution-benchmark',
  aggregate: {},
  provenance: {},
  trials: ['first', 'second'].map((id) => ({
    id,
    caseId: id,
    caseName: id,
    caseIndex: 0,
    trialIndex: 0,
    executionStatus: 'completed',
    inputs: {},
    outputs: {},
    expected: {},
    observations: [],
    targetMetrics: { durationMs: 1 },
    evaluatorMetrics: { durationMs: 0 },
    totalMetrics: { durationMs: 1 },
    recording: { id, retention: 'temporary' },
  })),
} as unknown as EvaluationRun;

test('partial recording retention projects only committed changes', async () => {
  const c = commands(
    { updateRecordingRetention: async ({ recordingId }) => recordingId === 'first' },
    () => true,
    recordedRun,
  );
  await c.command.updateEvaluationRunRecordingRetention(recordedRun, 'keep');
  assert.deepEqual(
    c.getState().runs[0]!.trials.map((trial) => trial.recording?.retention),
    ['retained', 'temporary'],
  );
  assert.equal(c.notices[0]!.kind, 'partial');
  assert.equal(c.getInvalidations(), 1);
});

test('baseline promotion fences reads only after durable pins succeed', async () => {
  const c = commands({ promoteBaseline: async () => {} }, () => true, recordedRun);
  await c.command.promoteBaseline();
  assert.equal(c.getInvalidations(), 1);
  assert.equal(c.getState().runs[0]!.trials[0]!.recording?.retention, 'baseline');
});

test('accepted baseline promotion completes the library command after navigation', async () => {
  let active = true;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const c = commands({ promoteBaseline: () => pending }, () => active, recordedRun);
  const promoting = c.command.promoteBaseline();
  active = false;
  resolve();
  await promoting;
  assert.equal(c.getState().data.baselines[0]?.sourceRunId, recordedRun.id);
  assert.equal(c.getState().runs[0]!.trials[0]!.recording?.retention, 'temporary');
});

test('baseline promotion cannot resurrect a suite deleted while storage was pending', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const c = commands({ promoteBaseline: () => pending }, () => true, recordedRun);
  const promoting = c.command.promoteBaseline();
  c.updateState((current) => removeEvaluationResources(current, { suiteIds: [recordedRun.suiteId] }).state);
  resolve();
  await promoting;
  assert.deepEqual(c.getState().data.suites, []);
  assert.deepEqual(c.getState().data.baselines, []);
  assert.deepEqual(c.getState().runs, []);
});
