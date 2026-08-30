import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { Pool } from 'pg';
import { loadProjectFromString, type ProjectId } from '@valerypopoff/rivet2-node';
import {
  createEmptyEvaluationProjectData,
  type EvaluationDataset,
  type EvaluationProjectData,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';

import { HostedEvaluationCoordinator } from '../evaluation-runs/hosted-coordinator.js';
import type { PostgresRivetEvaluationStore } from '../evaluation-runs/managed-store.js';

const projectContents = await fs.readFile(
  fileURLToPath(
    new URL('../../../../deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project', import.meta.url),
  ),
  'utf8',
);
const project = loadProjectFromString(projectContents);
const projectId = project.metadata.id as ProjectId;
const targetGraphId = project.metadata.mainGraphId;
assert.ok(targetGraphId, 'The canonical managed-release fixture must have a main graph.');
const dataset: EvaluationDataset = {
  id: 'dataset',
  projectId,
  name: 'Dataset',
  fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true }],
  cases: [{ id: 'case-1', name: 'Case 1', values: { input: 'hello' } }],
};

const suite: EvaluationSuite = {
  id: 'suite',
  name: 'Suite',
  targetGraphId,
  datasetId: dataset.id,
  inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
  assertions: [
    {
      id: 'output-object',
      name: 'Target returned outputs',
      outputPath: '$',
      operator: 'type-is',
      expected: { kind: 'literal', value: 'object' },
      required: true,
    },
  ],
  evaluators: [],
  configuration: { trialCount: 1 },
  thresholds: [],
};

const evaluationData: EvaluationProjectData = {
  ...createEmptyEvaluationProjectData(),
  suites: [suite],
};

function serializedProject(): string {
  return projectContents;
}

type Query = { sql: string; values: readonly unknown[] };

class CapturePool {
  readonly queries: Query[] = [];
  readonly #failWhen?: (sql: string) => boolean;

  constructor(options: { failWhen?: (sql: string) => boolean } = {}) {
    this.#failWhen = options.failWhen;
  }

  async connect() {
    return {
      query: async <T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
        this.queries.push({ sql, values });
        if (this.#failWhen?.(sql)) throw new Error('forced scheduler persistence failure');
        return { rows: [] as T[], rowCount: 1 };
      },
      release() {},
    };
  }
}

function createCoordinator(pool: CapturePool, store: { getCalls: number }) {
  return new HostedEvaluationCoordinator({
    pool: pool as unknown as Pool,
    runStore: {
      get: async () => {
        store.getCalls += 1;
        return undefined;
      },
    } as unknown as PostgresRivetEvaluationStore,
    config: {
      enabled: true,
      workerEnabled: false,
      workerConcurrency: 1,
      leaseMs: 15_000,
      pollMs: 250,
    },
    runGraph: async () => {
      throw new Error('The worker is deliberately disabled in this persistence test.');
    },
  });
}

function queryIndex(queries: readonly Query[], fragment: string): number {
  const index = queries.findIndex((query) => query.sql.includes(fragment));
  assert.notEqual(index, -1, `Expected query containing ${fragment}.`);
  return index;
}

test('hosted Evaluation submission commits its run projection, snapshot, and jobs in one transaction', async () => {
  const pool = new CapturePool();
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store);

  const run = await coordinator.submit({
    projectContents: serializedProject(),
    projectPath: 'examples/hosted-evaluation.rivet-project',
    evaluationData,
    dataset,
    suiteId: suite.id,
    purpose: 'evaluation',
  });

  assert.equal(run.executionStatus, 'queued');
  assert.equal(store.getCalls, 0);
  const begin = queryIndex(pool.queries, 'BEGIN');
  const datasetSnapshot = queryIndex(pool.queries, 'INSERT INTO evaluation_dataset_snapshots');
  const runProjection = queryIndex(pool.queries, 'INSERT INTO evaluation_runs');
  const hostedRun = queryIndex(pool.queries, 'INSERT INTO evaluation_hosted_runs');
  const job = queryIndex(pool.queries, 'INSERT INTO evaluation_hosted_trial_jobs');
  const commit = queryIndex(pool.queries, 'COMMIT');
  assert.ok(begin < datasetSnapshot);
  assert.ok(datasetSnapshot < runProjection);
  assert.ok(runProjection < hostedRun);
  assert.ok(hostedRun < job);
  assert.ok(job < commit);
});

test('hosted Evaluation submission rolls back as a unit when scheduler persistence fails', async () => {
  const pool = new CapturePool({ failWhen: (sql) => sql.includes('INSERT INTO evaluation_hosted_runs') });
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store);

  await assert.rejects(
    coordinator.submit({
      projectContents: serializedProject(),
      projectPath: 'examples/hosted-evaluation.rivet-project',
      evaluationData,
      dataset,
      suiteId: suite.id,
      purpose: 'evaluation',
    }),
    /forced scheduler persistence failure/u,
  );

  assert.equal(store.getCalls, 0);
  assert.notEqual(
    pool.queries.findIndex((query) => query.sql.includes('ROLLBACK')),
    -1,
  );
  assert.equal(
    pool.queries.some((query) => query.sql.includes('COMMIT')),
    false,
  );
});

test('canceling a non-hosted Evaluation returns a missing result instead of a scheduler error', async () => {
  const pool = new CapturePool();
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store);

  assert.equal(await coordinator.requestCancel({ projectId, runId: 'ordinary-run' }), undefined);
  assert.notEqual(
    pool.queries.findIndex((query) => query.sql.includes('COMMIT')),
    -1,
  );
});
