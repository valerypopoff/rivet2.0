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

import type { HostedEvaluationsCoordinatorConfig } from '../hosted-evaluations-config.js';
import {
  HostedEvaluationCapacityError,
  HostedEvaluationCoordinator,
  HostedEvaluationRunConflictError,
} from '../evaluation-runs/hosted-coordinator.js';
import type { PostgresRivetEvaluationStore } from '../evaluation-runs/managed-store.js';
import { configureStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';

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
  readonly #outstandingJobs: number;
  readonly #runProjectionRowCount?: number;

  constructor(
    options: { failWhen?: (sql: string) => boolean; outstandingJobs?: number; runProjectionRowCount?: number } = {},
  ) {
    this.#failWhen = options.failWhen;
    this.#outstandingJobs = options.outstandingJobs ?? 0;
    this.#runProjectionRowCount = options.runProjectionRowCount;
  }

  async query<T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    this.queries.push({ sql, values });
    if (this.#failWhen?.(sql)) throw new Error('forced scheduler persistence failure');
    if (sql.includes('AS outstanding_count')) {
      return {
        rows: [{ outstanding_count: this.#outstandingJobs }] as T[],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO evaluation_runs') && this.#runProjectionRowCount !== undefined) {
      return { rows: [] as T[], rowCount: this.#runProjectionRowCount };
    }
    return { rows: [] as T[], rowCount: 1 };
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }
}

class InterruptedRetryCapacityPool extends CapturePool {
  override async query<T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    this.queries.push({ sql, values });
    if (sql.includes("status = 'interrupted'\n          FOR UPDATE")) {
      return {
        rows: [
          {
            project_id: String(projectId),
            run_id: 'interrupted-run',
            job_id: 'interrupted-run:case-1:0',
            case_id: 'case-1',
            case_name: 'Case 1',
            case_index: 0,
            trial_index: 0,
            status: 'interrupted',
            attempt: 1,
            fencing_token: 1,
            worker_id: null,
            trial_json: null,
          },
        ] as T[],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM evaluation_hosted_runs WHERE') && sql.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            project_id: String(projectId),
            run_id: 'interrupted-run',
            status: 'interrupted',
            snapshot_json: { version: 1 },
            cancel_requested_at: null,
          },
        ] as T[],
        rowCount: 1,
      };
    }
    if (sql.includes('AS outstanding_count')) {
      return { rows: [{ outstanding_count: 10 }] as T[], rowCount: 1 };
    }
    return { rows: [] as T[], rowCount: 1 };
  }
}

class SlowMetricsPool extends CapturePool {
  readonly metricsStarted: Promise<void>;
  #metricQueryCalls = 0;
  #releaseMetrics: (() => void) | undefined;
  #signalMetricsStarted!: () => void;

  constructor() {
    super();
    this.metricsStarted = new Promise((resolve) => {
      this.#signalMetricsStarted = resolve;
    });
  }

  get metricQueryCalls(): number {
    return this.#metricQueryCalls;
  }

  releaseMetrics(): void {
    this.#releaseMetrics?.();
  }

  override async query<T = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    if (!sql.includes('GROUP BY status')) return super.query<T>(sql, values);
    this.queries.push({ sql, values });
    this.#metricQueryCalls += 1;
    this.#signalMetricsStarted();
    await new Promise<void>((resolve) => {
      this.#releaseMetrics = resolve;
    });
    return { rows: [] as T[], rowCount: 0 };
  }
}
function createCoordinator(
  pool: CapturePool,
  store: { getCalls: number },
  config: Partial<HostedEvaluationsCoordinatorConfig> = {},
) {
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
      maxJobsPerRun: 2_000,
      maxOutstandingJobs: 10_000,
      pollMs: 250,
      ...config,
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

test('hosted Evaluation metrics never overlap slow aggregate reads across scheduler ticks', async () => {
  const pool = new SlowMetricsPool();
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store, { workerEnabled: true, pollMs: 250 });
  configureStudioMetrics('evaluation', { RIVET_METRICS_ENABLED: 'true' });

  try {
    coordinator.start();
    await pool.metricsStarted;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(pool.metricQueryCalls, 1);
  } finally {
    pool.releaseMetrics();
    await coordinator.stop();
    resetStudioMetricsForTests();
  }
});
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

test('hosted Evaluation submission atomically rejects a duplicate run ID without a preflight race', async () => {
  const pool = new CapturePool({ runProjectionRowCount: 0 });
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
      runId: 'existing-run',
    }),
    (error: unknown) => error instanceof HostedEvaluationRunConflictError,
  );

  assert.equal(store.getCalls, 0);
  const insert = queryIndex(pool.queries, 'INSERT INTO evaluation_runs');
  const rollback = queryIndex(pool.queries, 'ROLLBACK');
  assert.ok(insert < rollback);
  assert.equal(
    pool.queries.some((query) => query.sql.includes('INSERT INTO evaluation_hosted_runs')),
    false,
  );
});

test('hosted Evaluation submission rejects a run that exceeds its chart-owned trial limit before opening a transaction', async () => {
  const pool = new CapturePool();
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store, { maxJobsPerRun: 1 });
  const twoTrialEvaluationData: EvaluationProjectData = {
    ...evaluationData,
    suites: [{ ...suite, configuration: { trialCount: 2 } }],
  };

  await assert.rejects(
    coordinator.submit({
      projectContents: serializedProject(),
      projectPath: 'examples/hosted-evaluation.rivet-project',
      evaluationData: twoTrialEvaluationData,
      dataset,
      suiteId: suite.id,
      purpose: 'evaluation',
    }),
    (error: unknown) => error instanceof HostedEvaluationCapacityError && error.limit === 'per-run',
  );

  assert.equal(pool.queries.length, 0);
});

test('hosted Evaluation submission makes its global outstanding-capacity decision inside the scheduler transaction', async () => {
  const pool = new CapturePool({ outstandingJobs: 10 });
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store, { maxOutstandingJobs: 10 });

  await assert.rejects(
    coordinator.submit({
      projectContents: serializedProject(),
      projectPath: 'examples/hosted-evaluation.rivet-project',
      evaluationData,
      dataset,
      suiteId: suite.id,
      purpose: 'evaluation',
    }),
    (error: unknown) => error instanceof HostedEvaluationCapacityError && error.limit === 'outstanding',
  );

  const begin = queryIndex(pool.queries, 'BEGIN');
  const lock = queryIndex(pool.queries, 'pg_advisory_xact_lock');
  const count = queryIndex(pool.queries, 'AS outstanding_count');
  const rollback = queryIndex(pool.queries, 'ROLLBACK');
  assert.ok(begin < lock && lock < count && count < rollback);
  assert.equal(
    pool.queries.some((query) => query.sql.includes('INSERT INTO evaluation_runs')),
    false,
  );
});
test('retrying interrupted hosted trials shares the global outstanding-capacity gate', async () => {
  const pool = new InterruptedRetryCapacityPool();
  const store = { getCalls: 0 };
  const coordinator = createCoordinator(pool, store, { maxOutstandingJobs: 10 });

  await assert.rejects(
    coordinator.retryInterrupted({
      projectId,
      runId: 'interrupted-run',
      jobIds: ['interrupted-run:case-1:0'],
    }),
    (error: unknown) => error instanceof HostedEvaluationCapacityError && error.limit === 'outstanding',
  );

  const begin = queryIndex(pool.queries, 'BEGIN');
  const lock = queryIndex(pool.queries, 'pg_advisory_xact_lock');
  const interrupted = queryIndex(pool.queries, "status = 'interrupted'");
  const count = queryIndex(pool.queries, 'AS outstanding_count');
  const rollback = queryIndex(pool.queries, 'ROLLBACK');
  assert.ok(begin < lock && lock < interrupted && interrupted < count && count < rollback);
  assert.equal(
    pool.queries.some((query) => query.sql.includes("SET status = 'queued'")),
    false,
  );
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
