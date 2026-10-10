// test-style: fixture-read: reads the canonical serialized project, never implementation source.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import { loadProjectFromString, serializeProject } from '@valerypopoff/rivet2-node';
import {
  createEmptyEvaluationProjectData,
  type EvaluationDataset,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import { HostedEvaluationCoordinator } from '../../evaluation-runs/hosted-coordinator.js';
import { PostgresRivetEvaluationStore } from '../../evaluation-runs/managed-store.js';

/** Runs the real scheduler against only the integration runner's owned database. */
export async function verifyHostedEvaluationProjectionContract(pool: Pool) {
  const project = loadProjectFromString(
    await fs.readFile(
      new URL(
        '../../../../../deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  project.metadata.id = randomUUID() as typeof project.metadata.id;
  const suite: EvaluationSuite = {
    id: 'projection-suite',
    name: 'Projection',
    targetGraphId: project.metadata.mainGraphId!,
    datasetId: 'projection-data',
    inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
    assertions: [
      {
        id: 'output-type',
        name: 'Output',
        outputPath: '$',
        operator: 'type-is',
        expected: { kind: 'literal', value: 'object' },
        required: true,
      },
    ],
    evaluators: [],
    thresholds: [],
    configuration: { trialCount: 1 },
  };
  const dataset: EvaluationDataset = {
    id: suite.datasetId,
    projectId: project.metadata.id,
    name: 'Projection',
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true }],
    cases: Array.from({ length: 4 }, (_, index) => ({
      id: `case-${index}`,
      name: `Case ${index}`,
      values: { input: `case-${index}` },
    })),
  };
  const store = new PostgresRivetEvaluationStore(pool);
  let block = true;
  let release: (() => void) | undefined;
  const schedulerQueries: string[] = [];
  const schedulerPool = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => {
          schedulerQueries.push(sql);
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as Pool;
  const coordinator = new HostedEvaluationCoordinator({
    pool: schedulerPool,
    runStore: store,
    config: {
      enabled: true,
      workerEnabled: true,
      workerConcurrency: 1,
      leaseMs: 15000,
      maxJobsPerRun: 100,
      maxOutstandingJobs: 100,
      pollMs: 250,
    },
    runGraph: async ({ inputs, metadata, signal }) => {
      if (metadata.caseId === 'case-2' && block)
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal?.removeEventListener('abort', abort);
            reject(signal?.reason);
          };
          release = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      return { outputs: { output: inputs.input! }, metrics: { durationMs: 1 } };
    },
  });
  const waitFor = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 20000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Hosted projection contract timed out.');
      await delay(25);
    }
  };
  try {
    await pool.query(
      `INSERT INTO workflows(workflow_id, name, file_name, relative_path, folder_relative_path, current_draft_revision_id)
      VALUES ($1, 'Projection', 'Projection.rivet-project', $2, '', 'fixture-draft')`,
      [project.metadata.id, `projection-${project.metadata.id}.rivet-project`],
    );
    for (const scenario of ['complete', 'retry', 'cancel', 'lease-recovery'] as const) {
      schedulerQueries.length = 0;
      block = true;
      release = undefined;
      const run = await coordinator.submit({
        projectContents: serializeProject(project) as string,
        projectPath: '/workflows/Projection.rivet-project',
        evaluationData: { ...createEmptyEvaluationProjectData(), suites: [suite] },
        dataset,
        suiteId: suite.id,
        purpose: 'evaluation',
      });
      const identity = { projectId: project.metadata.id, runId: run.id };
      await assert.rejects(
        store.delete(identity),
        /queued or running/,
        'generic store deletion must protect queued jobs even without a coordinator route',
      );
      await assert.rejects(store.put(run), /fenced coordinator/, 'queued state is protected before any worker starts');
      if (scenario === 'lease-recovery') {
        // Simulate two accepted jobs owned by a worker which died. Recovery must
        // preserve both interruptions without loading the same run per job.
        await pool.query(
          `UPDATE evaluation_hosted_trial_jobs SET status = 'accepted', attempt = 1, fencing_token = 1,
             worker_id = 'expired-fixture-worker', accepted_at = NOW(), lease_expires_at = NOW() - INTERVAL '1 second'
           WHERE project_id = $1 AND run_id = $2 AND case_index < 2`,
          [identity.projectId, identity.runId],
        );
      }
      coordinator.start();
      await waitFor(async () => Boolean(release) && (await store.get(identity))?.trials.length === 2);
      await assert.rejects(store.delete(identity), /queued or running/, 'active worker evidence cannot be deleted');
      assert.equal(
        schedulerQueries.filter((sql) => sql.includes('SELECT project_id, run_id, status, snapshot_json')).length,
        scenario === 'lease-recovery' ? 2 : 3,
        'snapshots are loaded only for execution claims or once per recovered run, never for pending progress',
      );
      const raw = await pool.query('SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2', [
        identity.projectId,
        identity.runId,
      ]);
      assert.equal(raw.rows[0].run_json._hostedTrialsFromJobs, true);
      assert.deepEqual(raw.rows[0].run_json.trials, []);
      const renamed = await store.updateRunName({ ...identity, name: 'Preserve evidence' });
      assert.equal(renamed?.trials.length, 2);
      assert.ok(!('_hostedTrialsFromJobs' in renamed!));
      if (scenario === 'lease-recovery') {
        assert.ok(renamed?.trials.every((trial) => trial.executionStatus === 'error'));
        assert.deepEqual(
          (await coordinator.getRunState(identity))?.jobs.slice(0, 2).map((job) => job.status),
          ['interrupted', 'interrupted'],
        );
      } else {
        assert.deepEqual(
          renamed?.trials.map((trial) => trial.outputs.output),
          ['case-0', 'case-1'],
        );
      }
      await assert.rejects(store.put(renamed!), /fenced coordinator/);
      const page = await store.listPage({ projectId: identity.projectId });
      assert.ok(!('_hostedTrialsFromJobs' in page.runs[0]!));
      if (scenario === 'retry') {
        await coordinator.stop();
        const state = await coordinator.getRunState(identity);
        const interrupted = state!.jobs.filter((job) => job.status === 'interrupted').map((job) => job.jobId);
        assert.equal(interrupted.length, 1);
        const retried = await coordinator.retryInterrupted({ ...identity, jobIds: interrupted });
        assert.equal(retried?.trials.length, 2);
        assert.ok(!('_hostedTrialsFromJobs' in retried!));
        await assert.rejects(store.put(retried!), /fenced coordinator/, 'manual retry keeps scheduler ownership');
        const storedRetry = await pool.query(
          'SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2',
          [identity.projectId, identity.runId],
        );
        assert.equal(storedRetry.rows[0].run_json._hostedTrialsFromJobs, true);
        assert.deepEqual(storedRetry.rows[0].run_json.trials, []);
        block = false;
        coordinator.start();
      } else if (scenario === 'cancel') {
        const canceled = await coordinator.requestCancel(identity);
        assert.ok(canceled);
        assert.ok(!('_hostedTrialsFromJobs' in canceled));
        assert.deepEqual(
          canceled.trials.slice(0, 2).map((trial) => trial.outputs.output),
          ['case-0', 'case-1'],
        );
      } else {
        block = false;
        release!();
      }
      await waitFor(async () => Boolean((await store.get(identity))?.completedAt));
      const completed = (await store.get(identity))!;
      assert.equal(completed.trials.length, 4);
      assert.equal(completed.name, 'Preserve evidence');
      assert.equal(
        completed.executionStatus,
        scenario === 'lease-recovery' ? 'error' : scenario === 'cancel' ? 'canceled' : 'completed',
      );
      assert.ok(!('_hostedTrialsFromJobs' in completed));
      if (scenario === 'complete') {
        const generic = { ...completed, id: randomUUID(), _hostedTrialsFromJobs: true };
        await store.put(generic);
        const publicRun = await store.get({ projectId: generic.projectId, runId: generic.id });
        assert.equal(publicRun?.trials.length, 4, 'generic input cannot replace its trials with scheduler jobs');
        assert.ok(!('_hostedTrialsFromJobs' in publicRun!));
        await store.delete({ projectId: generic.projectId, runId: generic.id });
      }
      await coordinator.stop();
      const canceledAgain = await coordinator.requestCancel(identity);
      assert.deepEqual(canceledAgain, completed, 'cancellation is idempotent after finalization');
      if (scenario === 'complete') await store.delete(identity);
      else await coordinator.deleteRun(identity);
      assert.equal(await store.get(identity), undefined);
    }
  } finally {
    block = false;
    release?.();
    await coordinator.stop();
    await pool.query('DELETE FROM workflows WHERE workflow_id = $1', [project.metadata.id]);
  }
}
