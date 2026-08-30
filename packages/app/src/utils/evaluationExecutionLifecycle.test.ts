import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EvaluationDataset,
  EvaluationGraphRunner,
  EvaluationProjectData,
  EvaluationRun,
  EvaluationRunStore,
  EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { executeEvaluationRunLifecycle } from './evaluationExecutionLifecycle.js';

const projectId = 'project-1' as ProjectId;
const project = {
  metadata: { id: projectId, title: 'Project', description: '', mainGraphId: 'target' },
  graphs: {
    target: {
      metadata: { id: 'target', name: 'Target' },
      nodes: [
        { id: 'input-node', type: 'graphInput', data: { id: 'input', dataType: 'string' } },
        { id: 'output-node', type: 'graphOutput', data: { id: 'output', dataType: 'string' } },
      ],
      connections: [],
    },
  },
} as unknown as Project;
const dataset: EvaluationDataset = {
  id: 'dataset-1',
  name: 'Dataset',
  fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input' }],
  cases: [{ id: 'case-1', name: 'Case', values: { input: 'value' } }],
};
const suite: EvaluationSuite = {
  id: 'suite-1',
  name: 'Suite',
  targetGraphId: 'target' as EvaluationSuite['targetGraphId'],
  datasetId: dataset.id,
  inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
  assertions: [],
  evaluators: [],
  configuration: { trialCount: 1 },
};
const evaluationData: EvaluationProjectData = {
  version: 1,
  suites: [suite],
  baselines: [],
};

type StoreCalls = { snapshots: number; runs: EvaluationRun[] };

function createStore(overrides: Partial<EvaluationRunStore> = {}): EvaluationRunStore & { calls: StoreCalls } {
  const calls: StoreCalls = { snapshots: 0, runs: [] };
  return {
    calls,
    put: async (run) => {
      calls.runs.push(run);
    },
    updateRunName: async () => undefined,
    get: async () => undefined,
    list: async () => [],
    delete: async () => undefined,
    putDatasetSnapshot: async () => {
      calls.snapshots += 1;
    },
    getDatasetSnapshot: async () => undefined,
    putRecording: async () => undefined,
    getRecording: async () => undefined,
    updateRecordingRetention: async () => true,
    promoteBaseline: async () => undefined,
    ...overrides,
  };
}

const runGraph: EvaluationGraphRunner = async () => ({ outputs: { output: 'result' }, metrics: { durationMs: 1 } });

test('evaluation lifecycle orders snapshotting, running, finalization, and persistence', async () => {
  const stages: string[] = [];
  const store = createStore();

  const result = await executeEvaluationRunLifecycle({
    project,
    projectId,
    evaluationData,
    dataset,
    suite,
    purpose: 'execution-benchmark',
    executionMode: 'test',
    signal: new AbortController().signal,
    runGraph,
    runStore: store,
    getExistingRun: () => undefined,
    onStageChange: (stage) => stages.push(stage),
  });

  assert.deepEqual(stages, ['preparing', 'running', 'finalizing', 'persisting', 'completed']);
  assert.equal(store.calls.snapshots, 1);
  assert.deepEqual(store.calls.runs, [result]);
});

test('evaluation lifecycle keeps a successful run usable and reports non-fatal storage failures', async () => {
  const faults: string[] = [];
  const store = createStore({
    putDatasetSnapshot: async () => {
      throw new Error('snapshot failed');
    },
    put: async () => {
      throw new Error('history failed');
    },
  });

  const result = await executeEvaluationRunLifecycle({
    project,
    projectId,
    evaluationData,
    dataset,
    suite,
    purpose: 'execution-benchmark',
    executionMode: 'test',
    signal: new AbortController().signal,
    runGraph,
    runStore: store,
    getExistingRun: () => undefined,
    getRecordingPersistenceFailureCount: () => 2,
    onStorageFault: (kind) => faults.push(kind),
  });

  assert.deepEqual(faults, ['dataset-snapshot', 'run-history']);
  assert.ok(result.warnings.some((warning) => warning.includes('dataset snapshot could not be retained')));
  assert.ok(result.warnings.some((warning) => warning.includes('2 replay recordings could not be retained')));
  assert.ok(result.warnings.some((warning) => warning.includes('could not be saved to run history: history failed')));
});

test('evaluation lifecycle records a warning when a replay disappears before its retention policy is finalized', async () => {
  const faults: string[] = [];
  const result = await executeEvaluationRunLifecycle({
    project,
    projectId,
    evaluationData,
    dataset,
    suite,
    purpose: 'execution-benchmark',
    executionMode: 'test',
    signal: new AbortController().signal,
    runGraph: async () => ({
      outputs: { output: 'result' },
      metrics: { durationMs: 1 },
      recording: { id: 'disappeared-recording', retention: 'temporary' },
    }),
    runStore: createStore({ updateRecordingRetention: async () => false }),
    getExistingRun: () => undefined,
    onStorageFault: (kind) => faults.push(kind),
  });

  assert.deepEqual(faults, ['recording-retention']);
  assert.ok(result.warnings.includes('Some evaluation recording retention updates could not be saved.'));
});

test('evaluation lifecycle preserves a user-assigned live run name when finalizing', async () => {
  const result = await executeEvaluationRunLifecycle({
    project,
    projectId,
    evaluationData,
    dataset,
    suite,
    purpose: 'execution-benchmark',
    executionMode: 'test',
    signal: new AbortController().signal,
    runGraph,
    runStore: createStore(),
    getExistingRun: (runId) => ({ id: runId, name: 'Named while running' }) as EvaluationRun,
  });

  assert.equal(result.name, 'Named while running');
});
