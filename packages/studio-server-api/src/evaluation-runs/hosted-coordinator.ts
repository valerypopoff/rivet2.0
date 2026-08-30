import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  assertPortableJson,
  createEvaluationRunShell,
  finalizeEvaluationRecordingRetention,
  finalizeEvaluationRun,
  fingerprintEvaluationDataset,
  runEvaluationTrial,
  type EvaluationDataset,
  type EvaluationGraphRunner,
  type EvaluationProjectData,
  type EvaluationRun,
  type EvaluationRunPurpose,
  type EvaluationTrial,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import { deserializeDatasets, loadProjectFromString, type ProjectId } from '@valerypopoff/rivet2-node';

import type { HostedEvaluationsCoordinatorConfig } from '../hosted-evaluations-config.js';
import { getStudioMetrics } from '../metrics.js';
import type { PostgresRivetEvaluationStore } from './managed-store.js';

export type HostedEvaluationSubmission = {
  projectContents: string;
  projectPath: string;
  /** Exact `.rivet-data` contents used by target and evaluator graphs. */
  datasetsContents?: string;
  evaluationData: EvaluationProjectData;
  dataset: EvaluationDataset;
  suiteId: string;
  purpose: EvaluationRunPurpose;
  contextValues?: Record<string, PortableJson>;
  runId?: string;
};

type HostedEvaluationSnapshot = {
  version: 1;
  projectContents: string;
  projectPath: string;
  datasetsContents?: string;
  evaluationData: EvaluationProjectData;
  dataset: EvaluationDataset;
  suiteId: string;
  purpose: EvaluationRunPurpose;
  contextValues: Record<string, PortableJson>;
};

type HostedRunState = 'queued' | 'running' | 'completed' | 'canceled' | 'interrupted';
type HostedJobState = 'queued' | 'claimed' | 'accepted' | 'settled' | 'interrupted' | 'canceled';
type RecordingRetentionUpdate = Parameters<PostgresRivetEvaluationStore['updateRecordingRetention']>[0];

type HostedRunRow = QueryResultRow & {
  project_id: string;
  run_id: string;
  status: HostedRunState;
  snapshot_json: HostedEvaluationSnapshot | string;
  cancel_requested_at: Date | string | null;
};
type HostedJobRow = QueryResultRow & {
  project_id: string;
  run_id: string;
  job_id: string;
  case_id: string;
  case_name: string;
  case_index: number;
  trial_index: number;
  status: HostedJobState;
  attempt: number;
  fencing_token: string | number;
  worker_id: string | null;
  accepted_at: Date | string | null;
  settled_at: Date | string | null;
  trial_json: EvaluationTrial | string | null;
};
type ActiveHostedJob = {
  projectId: string;
  runId: string;
  controller: AbortController;
};

export type HostedEvaluationGraphRunner = (
  input: Parameters<EvaluationGraphRunner>[0] & {
    projectPath: string;
    datasetsContents?: string;
    contextValues: Record<string, PortableJson>;
  },
) => ReturnType<EvaluationGraphRunner>;

export type HostedEvaluationCoordinatorStatus = {
  enabled: boolean;
  workerEnabled: boolean;
  workerConcurrency: number;
  maxJobsPerRun: number;
  maxOutstandingJobs: number;
};

export class HostedEvaluationCapacityError extends Error {
  readonly retryAfterSeconds = 5;

  constructor(
    readonly limit: 'outstanding' | 'per-run',
    message: string,
  ) {
    super(message);
    this.name = 'HostedEvaluationCapacityError';
  }
}

export class HostedEvaluationRunConflictError extends Error {
  constructor() {
    super('Hosted Evaluation run ID already exists. Start the run again to generate a fresh ID.');
    this.name = 'HostedEvaluationRunConflictError';
  }
}
export type HostedEvaluationRunState = {
  status: HostedRunState;
  cancelRequested: boolean;
  jobs: ReadonlyArray<
    Pick<
      HostedJobRow,
      | 'job_id'
      | 'case_id'
      | 'case_name'
      | 'case_index'
      | 'trial_index'
      | 'status'
      | 'attempt'
      | 'accepted_at'
      | 'settled_at'
    >
  >;
};

const TERMINAL_JOB_STATES = new Set<HostedJobState>(['settled', 'interrupted', 'canceled']);
// Submission and interrupted-job retries both increase the durable outstanding
// queue. Guard both paths with the same transaction-scoped lock so the global
// capacity remains an invariant instead of a best-effort admission check.
const HOSTED_EVALUATION_CAPACITY_ADVISORY_LOCK = 5_611_002;

function parseSnapshot(value: HostedRunRow['snapshot_json']): HostedEvaluationSnapshot {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Hosted evaluation snapshot is unreadable.');
  }
  return parsed as HostedEvaluationSnapshot;
}

function parseTrial(value: HostedJobRow['trial_json']): EvaluationTrial | undefined {
  return value == null ? undefined : ((typeof value === 'string' ? JSON.parse(value) : value) as EvaluationTrial);
}

function jobId(runId: string, caseId: string, trialIndex: number): string {
  return `${runId}:${caseId}:${trialIndex}`;
}

function activeJobKey(projectId: string, jobId: string): string {
  // Run IDs can be supplied by a caller and are scoped by project in the
  // durable scheduler. Preserve that scope in this process-local index too.
  return JSON.stringify([projectId, jobId]);
}

function hostedEvaluationShutdownDrainMs(leaseMs: number): number {
  // Yield quickly to the broader API shutdown budget. If a graph runner cannot
  // observe cancellation, its accepted fenced lease is recovered explicitly
  // after the pod is gone instead of blocking resource disposal indefinitely.
  return Math.min(10_000, Math.max(1_000, Math.floor(leaseMs / 3)));
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectId(value: string): ProjectId {
  return value as ProjectId;
}

function recordingRetentionUpdates(project: ProjectId, trials: readonly EvaluationTrial[]): RecordingRetentionUpdate[] {
  const updates = new Map<string, RecordingRetentionUpdate>();
  for (const trial of trials) {
    for (const reference of [trial.recording, ...trial.observations.map((observation) => observation.recording)]) {
      if (!reference) continue;
      updates.set(reference.id, {
        projectId: project,
        recordingId: reference.id,
        retention: reference.retention,
        ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
      });
    }
  }
  return [...updates.values()];
}

function terminalTrial(
  job: Pick<HostedJobRow, 'job_id' | 'case_id' | 'case_name' | 'case_index' | 'trial_index'>,
  status: Extract<HostedJobState, 'interrupted' | 'canceled'>,
  purpose: EvaluationRunPurpose,
  evaluationMode: EvaluationRun['evaluationMode'],
  message: string,
): EvaluationTrial {
  const canceled = status === 'canceled';
  return {
    id: job.job_id,
    caseId: job.case_id,
    caseName: job.case_name,
    caseIndex: Number(job.case_index),
    trialIndex: Number(job.trial_index),
    executionStatus: canceled ? 'canceled' : 'error',
    qualityStatus:
      canceled || purpose === 'execution-benchmark'
        ? 'not-evaluated'
        : evaluationMode === 'scoring'
          ? 'unable-to-evaluate'
          : 'failed',
    qualityReason: canceled
      ? { code: 'canceled', message: 'The hosted evaluation was canceled before this trial could finish.' }
      : evaluationMode === 'scoring'
        ? { code: 'scores-incomplete', message }
        : purpose === 'execution-benchmark'
          ? { code: 'benchmark', message }
          : { code: 'target-error', message },
    inputs: {},
    expected: {},
    outputs: {},
    observations: [],
    targetMetrics: { durationMs: 0, hasUnknownCost: true },
    evaluatorMetrics: { durationMs: 0 },
    totalMetrics: { durationMs: 0, hasUnknownCost: true },
    error: message,
  };
}

/**
 * The database is the hosted-Evaluation scheduler of record. A job is retried
 * automatically only before acceptance. Once a graph could have started,
 * worker loss becomes durable interruption evidence and requires explicit
 * retry from an operator.
 */
export class HostedEvaluationCoordinator {
  readonly #active = new Map<string, ActiveHostedJob>();
  readonly #activeTasks = new Set<Promise<void>>();
  readonly #config: HostedEvaluationsCoordinatorConfig;
  readonly #graphRunner: HostedEvaluationGraphRunner;
  readonly #pool: Pool;
  readonly #runStore: PostgresRivetEvaluationStore;
  readonly #workerId = `evaluation-worker:${process.env.HOSTNAME?.trim() || 'local'}:${process.pid}:${randomUUID()}`;
  #loopPromise: Promise<void> | undefined;
  #metricsRefreshPromise: Promise<void> | undefined;
  #stopping = false;
  #wake: (() => void) | undefined;

  constructor(input: {
    pool: Pool;
    runStore: PostgresRivetEvaluationStore;
    config: HostedEvaluationsCoordinatorConfig;
    runGraph: HostedEvaluationGraphRunner;
  }) {
    this.#pool = input.pool;
    this.#runStore = input.runStore;
    this.#config = input.config;
    this.#graphRunner = input.runGraph;
  }

  getStatus(): HostedEvaluationCoordinatorStatus {
    return {
      enabled: this.#config.enabled,
      workerEnabled: this.#config.workerEnabled,
      workerConcurrency: this.#config.workerConcurrency,
      maxJobsPerRun: this.#config.maxJobsPerRun,
      maxOutstandingJobs: this.#config.maxOutstandingJobs,
    };
  }
  async getRunState(input: { projectId: ProjectId; runId: string }): Promise<HostedEvaluationRunState | undefined> {
    const result = await this.#pool.query<HostedJobRow & Pick<HostedRunRow, 'status' | 'cancel_requested_at'>>(
      `SELECT run.status, run.cancel_requested_at, job.job_id, job.case_id, job.case_name, job.case_index, job.trial_index,
              job.status AS job_status, job.attempt, job.accepted_at, job.settled_at
         FROM evaluation_hosted_runs AS run
         LEFT JOIN evaluation_hosted_trial_jobs AS job ON job.project_id = run.project_id AND job.run_id = run.run_id
        WHERE run.project_id = $1 AND run.run_id = $2
        ORDER BY job.case_index ASC NULLS LAST, job.trial_index ASC NULLS LAST`,
      [String(input.projectId), input.runId],
    );
    const first = result.rows[0];
    if (!first) return undefined;
    return {
      status: first.status,
      cancelRequested: first.cancel_requested_at != null,
      jobs: result.rows
        .filter((row) => row.job_id != null)
        .map((row) => ({
          job_id: row.job_id,
          case_id: row.case_id,
          case_name: row.case_name,
          case_index: Number(row.case_index),
          trial_index: Number(row.trial_index),
          status: (row as unknown as { job_status: HostedJobState }).job_status,
          attempt: Number(row.attempt),
          accepted_at: row.accepted_at,
          settled_at: row.settled_at,
        })),
    };
  }

  async submit(input: HostedEvaluationSubmission): Promise<EvaluationRun> {
    if (!this.#config.enabled) throw new Error('Hosted Evaluations are not enabled for this server.');
    if (!input.projectContents?.trim() || !input.projectPath?.trim()) {
      throw new Error('Hosted Evaluation submissions require immutable project contents and a project path.');
    }
    for (const [name, value] of Object.entries(input.contextValues ?? {})) {
      if (!name.trim()) throw new Error('Hosted Evaluation context input names cannot be empty.');
      assertPortableJson(value, `contextValues.${name}`);
    }
    const project = loadProjectFromString(input.projectContents);
    // Validate the sidecar before queuing work. A malformed `.rivet-data`
    // snapshot is an authoring error, never a post-acceptance worker failure.
    if (input.datasetsContents !== undefined) deserializeDatasets(input.datasetsContents);

    const { run, plan } = createEvaluationRunShell({
      project,
      evaluationData: input.evaluationData,
      dataset: input.dataset,
      suiteId: input.suiteId,
      purpose: input.purpose,
      runId: input.runId?.trim() || `evaluation-hosted-${randomUUID()}`,
      executionMode: 'hosted-managed',
    });
    // Local callers enter a worker pool immediately; the durable scheduler
    // does not. Keep the externally visible execution state honest until an
    // Evaluation-tier worker accepts the first trial. The upstream planner
    // rejects datasets with no enabled cases before this point.
    const plannedJobCount = plan.work.length;
    if (plannedJobCount > this.#config.maxJobsPerRun) {
      getStudioMetrics().recordHostedEvaluationSubmission('per_run_capacity_exceeded');
      throw new HostedEvaluationCapacityError(
        'per-run',
        `This Evaluation would schedule ${plannedJobCount} trials, exceeding the configured per-run limit of ${this.#config.maxJobsPerRun}.`,
      );
    }
    run.executionStatus = 'queued';
    const snapshot: HostedEvaluationSnapshot = {
      version: 1,
      projectContents: input.projectContents,
      projectPath: input.projectPath,
      ...(input.datasetsContents === undefined ? {} : { datasetsContents: input.datasetsContents }),
      evaluationData: structuredClone(input.evaluationData),
      dataset: structuredClone(input.dataset),
      suiteId: input.suiteId,
      purpose: input.purpose,
      contextValues: structuredClone(input.contextValues ?? {}),
    };
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Evaluation authoring is low-volume, so a transaction-scoped advisory
      // lock gives concurrent submitters one exact installation-wide capacity
      // decision without introducing a second queue or scheduler state.
      await client.query(`SELECT pg_advisory_xact_lock(${HOSTED_EVALUATION_CAPACITY_ADVISORY_LOCK}::bigint)`);
      const outstandingResult = await client.query<{ outstanding_count: number }>(
        `SELECT COUNT(*)::integer AS outstanding_count
           FROM evaluation_hosted_trial_jobs
          WHERE status IN ('queued', 'claimed', 'accepted')`,
      );
      const outstandingJobs = Number(outstandingResult.rows[0]?.outstanding_count ?? 0);
      if (outstandingJobs + plannedJobCount > this.#config.maxOutstandingJobs) {
        getStudioMetrics().recordHostedEvaluationSubmission('outstanding_capacity_exceeded');
        throw new HostedEvaluationCapacityError(
          'outstanding',
          `Hosted Evaluation capacity is full: ${outstandingJobs} trial jobs are already outstanding, and this run needs ${plannedJobCount} more (limit ${this.#config.maxOutstandingJobs}).`,
        );
      }
      // The user-visible run projection, its content-addressed dataset, and
      // scheduler rows must commit together. Otherwise a process crash between
      // independent store writes could leave a permanently queued run with no
      // durable work to claim.
      const datasetFingerprint = fingerprintEvaluationDataset(input.dataset);
      await client.query(
        `INSERT INTO evaluation_dataset_snapshots (project_id, dataset_fingerprint, snapshot_json, created_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (project_id, dataset_fingerprint) DO NOTHING`,
        [
          String(run.projectId),
          datasetFingerprint,
          JSON.stringify({
            projectId: run.projectId,
            fingerprint: datasetFingerprint,
            dataset: { ...input.dataset, projectId: run.projectId },
            createdAt: run.startedAt,
          }),
        ],
      );
      const insertedRun = await client.query(
        `INSERT INTO evaluation_runs (project_id, run_id, suite_id, started_at, run_json, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
         ON CONFLICT (project_id, run_id) DO NOTHING
         RETURNING run_id`,
        [String(run.projectId), run.id, run.suiteId, run.startedAt, JSON.stringify(run)],
      );
      if (insertedRun.rowCount !== 1) throw new HostedEvaluationRunConflictError();
      await client.query(
        `INSERT INTO evaluation_hosted_runs (project_id, run_id, status, snapshot_json, created_at, updated_at)
         VALUES ($1, $2, 'queued', $3::jsonb, NOW(), NOW())`,
        [String(run.projectId), run.id, JSON.stringify(snapshot)],
      );
      for (const item of plan.work) {
        await client.query(
          `INSERT INTO evaluation_hosted_trial_jobs
             (project_id, run_id, job_id, case_id, case_name, case_index, trial_index, status, attempt, fencing_token, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, 0, NOW(), NOW())`,
          [
            String(run.projectId),
            run.id,
            jobId(run.id, item.testCase.id, item.trialIndex),
            item.testCase.id,
            item.testCase.name,
            item.caseIndex,
            item.trialIndex,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    getStudioMetrics().recordHostedEvaluationSubmission('accepted');
    this.#notify();
    return run;
  }
  async requestCancel(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Every mutating scheduler path locks jobs before the run projection.
      // Claims use that same order, avoiding a claim/cancel deadlock where each
      // transaction owns one side of the relationship and waits for the other.
      const pending = await client.query<HostedJobRow>(
        `SELECT project_id, run_id, job_id, case_id, case_name, case_index, trial_index,
                status, attempt, fencing_token, worker_id, trial_json
           FROM evaluation_hosted_trial_jobs
          WHERE project_id = $1 AND run_id = $2 AND status IN ('queued', 'claimed')
          FOR UPDATE`,
        [String(input.projectId), input.runId],
      );
      const hosted = await this.#findHostedRunForUpdate(client, String(input.projectId), input.runId);
      if (!hosted) {
        await client.query('COMMIT');
        return undefined;
      }
      if (hosted.status === 'completed' || hosted.status === 'canceled' || hosted.status === 'interrupted') {
        await client.query('COMMIT');
        return await this.#runStore.get(input);
      }
      await client.query(
        `UPDATE evaluation_hosted_runs SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()), updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2`,
        [String(input.projectId), input.runId],
      );
      const snapshot = parseSnapshot(hosted.snapshot_json);
      const currentRun = await this.#getRunForUpdate(client, input.projectId, input.runId);
      for (const job of pending.rows) {
        const canceled = await client.query(
          `UPDATE evaluation_hosted_trial_jobs
              SET status = 'canceled', worker_id = NULL, lease_expires_at = NULL, settled_at = NOW(), updated_at = NOW()
            WHERE project_id = $1 AND run_id = $2 AND job_id = $3 AND status IN ('queued', 'claimed')`,
          [String(input.projectId), input.runId, job.job_id],
        );
        if (canceled.rowCount !== 1)
          throw new Error('Hosted Evaluation cancellation lost ownership of a pending trial.');
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, 'canceled', NOW())`,
          [job.project_id, job.run_id, job.job_id, job.attempt, job.fencing_token],
        );
        const trial = terminalTrial(
          job,
          'canceled',
          snapshot.purpose,
          currentRun.evaluationMode,
          'The hosted evaluation was canceled before dispatch.',
        );
        await client.query(
          `UPDATE evaluation_hosted_trial_jobs SET trial_json = $4::jsonb WHERE project_id = $1 AND run_id = $2 AND job_id = $3`,
          [String(input.projectId), input.runId, job.job_id, JSON.stringify(trial)],
        );
      }
      const run = await this.#updateProjection(client, input.projectId, input.runId, snapshot);
      await client.query('COMMIT');
      this.#abortRun(input.projectId, input.runId, 'Hosted evaluation cancellation requested.');
      this.#notify();
      return run;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async retryInterrupted(input: {
    projectId: ProjectId;
    runId: string;
    jobIds: readonly string[];
  }): Promise<EvaluationRun | undefined> {
    if (!this.#config.enabled)
      throw new Error('Hosted Evaluations are disabled, so interrupted trials cannot be retried.');
    const jobIds = [...new Set(input.jobIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (jobIds.length === 0) throw new Error('Select one or more interrupted trials to retry.');
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Retrying interrupted work returns terminal jobs to the same global
      // outstanding queue as a new submission. Share its advisory lock and
      // capacity accounting; otherwise retries can silently exceed the chart
      // owned safety limit during an incident.
      await client.query(`SELECT pg_advisory_xact_lock(${HOSTED_EVALUATION_CAPACITY_ADVISORY_LOCK}::bigint)`);
      const interrupted = await client.query<HostedJobRow>(
        `SELECT project_id, run_id, job_id, case_id, case_name, case_index, trial_index,
                status, attempt, fencing_token, worker_id, trial_json
           FROM evaluation_hosted_trial_jobs
          WHERE project_id = $1 AND run_id = $2 AND job_id = ANY($3::text[]) AND status = 'interrupted'
          FOR UPDATE`,
        [String(input.projectId), input.runId, jobIds],
      );
      if (interrupted.rowCount !== jobIds.length) {
        throw new Error('Only currently interrupted hosted trials can be retried. Refresh this run and try again.');
      }
      const hosted = await this.#findHostedRunForUpdate(client, String(input.projectId), input.runId);
      if (!hosted) {
        await client.query('COMMIT');
        return undefined;
      }
      if (hosted.cancel_requested_at)
        throw new Error('Canceled hosted evaluations cannot be retried. Start a new run instead.');
      const outstandingResult = await client.query<{ outstanding_count: number }>(
        `SELECT COUNT(*)::integer AS outstanding_count
           FROM evaluation_hosted_trial_jobs
          WHERE status IN ('queued', 'claimed', 'accepted')`,
      );
      const outstandingJobs = Number(outstandingResult.rows[0]?.outstanding_count ?? 0);
      if (outstandingJobs + interrupted.rowCount > this.#config.maxOutstandingJobs) {
        getStudioMetrics().recordHostedEvaluationSubmission('outstanding_capacity_exceeded');
        throw new HostedEvaluationCapacityError(
          'outstanding',
          `Hosted Evaluation capacity is full: ${outstandingJobs} trial jobs are already outstanding, and retrying ${interrupted.rowCount} more would exceed the configured limit of ${this.#config.maxOutstandingJobs}.`,
        );
      }
      for (const job of interrupted.rows) {
        await client.query(
          `UPDATE evaluation_hosted_trial_jobs
              SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, accepted_at = NULL,
                  settled_at = NULL, trial_json = NULL, updated_at = NOW()
            WHERE project_id = $1 AND run_id = $2 AND job_id = $3`,
          [String(input.projectId), input.runId, job.job_id],
        );
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, 'requeued', NOW())`,
          [job.project_id, job.run_id, job.job_id, job.attempt, job.fencing_token],
        );
      }
      await client.query(
        `UPDATE evaluation_hosted_runs SET status = 'running', updated_at = NOW() WHERE project_id = $1 AND run_id = $2`,
        [String(input.projectId), input.runId],
      );
      const run = await this.#getRunForUpdate(client, input.projectId, input.runId);
      const retryIds = new Set(jobIds);
      const next: EvaluationRun = {
        ...run,
        revision: (run.revision ?? 0) + 1,
        completedAt: undefined,
        executionStatus: 'running',
        qualityStatus: 'not-evaluated',
        qualityReason: { code: 'in-progress', message: 'The hosted evaluation is running.' },
        aggregate: undefined,
        thresholdResults: [],
        warnings: run.warnings.filter(
          (warning) => !warning.startsWith('One or more hosted trial workers were interrupted'),
        ),
        trials: run.trials.filter((trial) => !retryIds.has(trial.id)),
      };
      await this.#writeRun(client, next);
      await client.query('COMMIT');
      this.#notify();
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  /**
   * Deletes a terminal hosted run in the same transaction that fences its
   * scheduler rows. The generic run-store delete cannot provide that fence by
   * itself because a retry can otherwise revive an interrupted run between an
   * earlier status check and the delete.
   */
  async deleteRun(input: { projectId: ProjectId; runId: string }): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Scheduler mutations consistently acquire job rows before the parent
      // run. Lock all of them here so a concurrent claim/retry cannot change
      // the run after we decide that deletion is safe.
      await client.query(
        `SELECT job_id FROM evaluation_hosted_trial_jobs
          WHERE project_id = $1 AND run_id = $2
          FOR UPDATE`,
        [String(input.projectId), input.runId],
      );
      const hosted = await this.#findHostedRunForUpdate(client, String(input.projectId), input.runId);
      if (hosted?.status === 'queued' || hosted?.status === 'running') {
        throw new Error(
          'A queued or running hosted Evaluation cannot be deleted. Cancel it first so completed evidence remains auditable.',
        );
      }
      await client.query('DELETE FROM evaluation_recordings WHERE project_id = $1 AND run_id = $2', [
        String(input.projectId),
        input.runId,
      ]);
      await client.query('DELETE FROM evaluation_runs WHERE project_id = $1 AND run_id = $2', [
        String(input.projectId),
        input.runId,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  start(): void {
    if (!this.#config.workerEnabled || this.#loopPromise) return;
    this.#stopping = false;
    this.#loopPromise = this.#runLoop().finally(() => {
      this.#loopPromise = undefined;
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#notify();
    for (const active of this.#active.values())
      active.controller.abort(new DOMException('Hosted evaluation worker is stopping.', 'AbortError'));

    const drainMs = hostedEvaluationShutdownDrainMs(this.#config.leaseMs);
    if (this.#loopPromise) {
      await Promise.race([
        this.#loopPromise.catch((error) =>
          console.error('[hosted-evaluations] Scheduler did not stop cleanly:', error),
        ),
        waitFor(drainMs),
      ]);
    }

    // Do not let a cooperative shutdown lose terminal durable transitions. A
    // non-cooperative graph runner cannot consume the API's entire shutdown
    // budget: after this bounded drain its accepted fenced lease is recovered
    // as explicit interruption evidence by another worker.
    const activeTasks = [...this.#activeTasks];
    await Promise.race([Promise.allSettled(activeTasks), waitFor(drainMs)]);
    if (this.#activeTasks.size > 0) {
      console.warn(
        `[hosted-evaluations] ${this.#activeTasks.size} worker task(s) exceeded the ${drainMs}ms shutdown drain; lease recovery will mark accepted work interrupted.`,
      );
    }
  }

  #refreshMetrics(): void {
    if (this.#metricsRefreshPromise) return;
    const metrics = getStudioMetrics();
    if (!metrics.enabled) return;

    this.#metricsRefreshPromise = (async () => {
      try {
        const queued = await this.#pool.query<{ status: 'accepted' | 'claimed' | 'queued'; count: number }>(
          `SELECT status, COUNT(*)::integer AS count
             FROM evaluation_hosted_trial_jobs
            WHERE status IN ('queued', 'claimed', 'accepted')
            GROUP BY status`,
        );
        const counts = { accepted: 0, claimed: 0, queued: 0 };
        for (const row of queued.rows) counts[row.status] = Number(row.count);
        metrics.setHostedEvaluationQueue({ ...counts, maxOutstandingJobs: this.#config.maxOutstandingJobs });
        metrics.setHostedEvaluationWorkers({
          activeTrials: this.#active.size,
          workerConcurrency: this.#config.workerConcurrency,
        });
      } catch {
        // Metrics are strictly observational. A failed aggregate read must not
        // delay claims or turn a healthy worker unready.
      }
    })().finally(() => {
      this.#metricsRefreshPromise = undefined;
    });
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      try {
        void this.#refreshMetrics();
        await this.#recoverExpiredLeases();
        while (!this.#stopping && this.#active.size < this.#config.workerConcurrency) {
          const claim = await this.#claimNext();
          if (!claim) break;
          if (this.#stopping) {
            await this.#releaseUnacceptedClaim(claim.job);
            break;
          }
          const controller = new AbortController();
          const key = activeJobKey(claim.job.project_id, claim.job.job_id);
          this.#active.set(key, { projectId: claim.job.project_id, runId: claim.job.run_id, controller });
          let task: Promise<void>;
          task = this.#executeClaim(claim, controller).finally(() => {
            this.#active.delete(key);
            this.#activeTasks.delete(task);
            void this.#refreshMetrics();
            this.#notify();
          });
          this.#activeTasks.add(task);
          void task;
        }
      } catch (error) {
        console.error('[hosted-evaluations] Scheduler tick failed:', error);
      }
      await this.#waitForWake();
    }
  }

  async #waitForWake(): Promise<void> {
    if (this.#stopping) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timeout);
        if (this.#wake === wake) this.#wake = undefined;
        resolve();
      };
      const timeout = setTimeout(wake, this.#config.pollMs);
      this.#wake = wake;
    });
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #abortRun(project: ProjectId, runId: string, reason: string): void {
    for (const active of this.#active.values()) {
      if (active.projectId === String(project) && active.runId === runId) {
        active.controller.abort(new DOMException(reason, 'AbortError'));
      }
    }
  }

  async #claimNext(): Promise<{ run: HostedRunRow; job: HostedJobRow } | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<HostedJobRow>(
        `WITH candidate AS (
           SELECT job.project_id, job.run_id, job.job_id
             FROM evaluation_hosted_trial_jobs AS job
             JOIN evaluation_hosted_runs AS run ON run.project_id = job.project_id AND run.run_id = job.run_id
            WHERE job.status = 'queued' AND run.status IN ('queued', 'running') AND run.cancel_requested_at IS NULL
            ORDER BY run.created_at ASC, job.case_index ASC, job.trial_index ASC
            FOR UPDATE OF job SKIP LOCKED LIMIT 1
         )
         UPDATE evaluation_hosted_trial_jobs AS job
            SET status = 'claimed', worker_id = $1, attempt = job.attempt + 1, fencing_token = job.fencing_token + 1,
                lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
           FROM candidate
          WHERE job.project_id = candidate.project_id AND job.run_id = candidate.run_id AND job.job_id = candidate.job_id
         RETURNING job.project_id, job.run_id, job.job_id, job.case_id, job.case_name, job.case_index, job.trial_index,
                   job.status, job.attempt, job.fencing_token, job.worker_id, job.trial_json`,
        [this.#workerId, this.#config.leaseMs],
      );
      const job = claimed.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return undefined;
      }
      const run = await this.#getHostedRunForUpdate(client, job.project_id, job.run_id);
      await client.query(
        `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'claimed', NOW())`,
        [job.project_id, job.run_id, job.job_id, job.attempt, job.fencing_token, this.#workerId],
      );
      await client.query(
        `UPDATE evaluation_hosted_runs SET status = 'running', updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2 AND status = 'queued'`,
        [job.project_id, job.run_id],
      );
      await this.#updateProjection(client, projectId(job.project_id), job.run_id, parseSnapshot(run.snapshot_json));
      await client.query('COMMIT');
      return { run, job };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #releaseUnacceptedClaim(job: HostedJobRow): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // A shutdown can arrive after claiming but before the graph is accepted.
      // No execution could have begun, so returning this fenced claim is safe.
      const result = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs
            SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2 AND job_id = $3
            AND status = 'claimed' AND worker_id = $4 AND fencing_token = $5
         RETURNING project_id, run_id, job_id, case_id, case_name, case_index, trial_index,
                   status, attempt, fencing_token, worker_id, trial_json`,
        [job.project_id, job.run_id, job.job_id, this.#workerId, job.fencing_token],
      );
      const requeued = result.rows[0];
      if (requeued) {
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, 'requeued', NOW())`,
          [requeued.project_id, requeued.run_id, requeued.job_id, requeued.attempt, requeued.fencing_token],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #accept(job: HostedJobRow): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs AS job
            SET status = 'accepted', accepted_at = NOW(),
                lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
           FROM evaluation_hosted_runs AS run
          WHERE job.project_id = $1 AND job.run_id = $2 AND job.job_id = $3
            AND run.project_id = job.project_id AND run.run_id = job.run_id
            AND job.status = 'claimed' AND job.worker_id = $5 AND job.fencing_token = $6
            AND job.lease_expires_at > NOW() AND run.cancel_requested_at IS NULL
         RETURNING job.project_id, job.run_id, job.job_id, job.case_id, job.case_name, job.case_index, job.trial_index,
                   job.status, job.attempt, job.fencing_token, job.worker_id, job.trial_json`,
        [job.project_id, job.run_id, job.job_id, this.#config.leaseMs, this.#workerId, job.fencing_token],
      );
      const accepted = result.rows[0];
      if (accepted) {
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'accepted', NOW())`,
          [
            accepted.project_id,
            accepted.run_id,
            accepted.job_id,
            accepted.attempt,
            accepted.fencing_token,
            this.#workerId,
          ],
        );
      }
      await client.query('COMMIT');
      return accepted !== undefined;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #heartbeat(job: HostedJobRow): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE evaluation_hosted_trial_jobs AS job
          SET lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'), updated_at = NOW()
         FROM evaluation_hosted_runs AS run
        WHERE job.project_id = $1 AND job.run_id = $2 AND job.job_id = $3
          AND run.project_id = job.project_id AND run.run_id = job.run_id
          AND job.status = 'accepted' AND job.worker_id = $5 AND job.fencing_token = $6
          AND job.lease_expires_at > NOW() AND run.cancel_requested_at IS NULL`,
      [job.project_id, job.run_id, job.job_id, this.#config.leaseMs, this.#workerId, job.fencing_token],
    );
    return result.rowCount === 1;
  }

  async #executeClaim(claim: { run: HostedRunRow; job: HostedJobRow }, controller: AbortController): Promise<void> {
    if (!(await this.#accept(claim.job))) return;
    const heartbeat = setInterval(
      () => {
        void this.#heartbeat(claim.job)
          .then((active) => {
            if (!active)
              controller.abort(new DOMException('Hosted evaluation claim is no longer active.', 'AbortError'));
          })
          .catch(() => controller.abort(new DOMException('Hosted evaluation lease heartbeat failed.', 'AbortError')));
      },
      Math.max(1_000, Math.floor(this.#config.leaseMs / 3)),
    );
    try {
      const snapshot = parseSnapshot(claim.run.snapshot_json);
      const project = loadProjectFromString(snapshot.projectContents);
      const plan = createEvaluationRunShell({
        project,
        evaluationData: snapshot.evaluationData,
        dataset: snapshot.dataset,
        suiteId: snapshot.suiteId,
        purpose: snapshot.purpose,
        runId: claim.job.run_id,
        executionMode: 'hosted-managed',
      }).plan;
      const work = plan.work.find(
        (candidate) =>
          candidate.testCase.id === claim.job.case_id && candidate.trialIndex === Number(claim.job.trial_index),
      );
      if (!work) throw new Error('The immutable hosted Evaluation snapshot does not contain this job.');
      const trial = await runEvaluationTrial({
        project,
        suite: plan.suite,
        dataset: snapshot.dataset,
        purpose: snapshot.purpose,
        testCase: work.testCase,
        caseIndex: Number(claim.job.case_index),
        trialIndex: Number(claim.job.trial_index),
        runId: claim.job.run_id,
        trialId: claim.job.job_id,
        signal: controller.signal,
        runGraph: (input) =>
          this.#graphRunner({
            ...input,
            projectPath: snapshot.projectPath,
            ...(snapshot.datasetsContents === undefined ? {} : { datasetsContents: snapshot.datasetsContents }),
            contextValues: snapshot.contextValues,
          }),
      });
      await this.#settle(claim.job, trial);
    } catch (error) {
      const snapshot = parseSnapshot(claim.run.snapshot_json);
      const run = await this.#runStore.get({ projectId: projectId(claim.job.project_id), runId: claim.job.run_id });
      // An AbortSignal also represents fencing/heartbeat loss during worker
      // shutdown. Only an explicit durable cancel request is cancellation;
      // every other abort is interruption evidence, never a false cancellation.
      const cancellationRequested = controller.signal.aborted && (await this.#isCancellationRequested(claim.job));
      const fallback = terminalTrial(
        claim.job,
        cancellationRequested ? 'canceled' : 'interrupted',
        snapshot.purpose,
        run?.evaluationMode ?? 'pass-fail',
        error instanceof Error ? error.message : String(error),
      );
      const persist = cancellationRequested ? this.#settle(claim.job, fallback) : this.#interrupt(claim.job, fallback);
      await persist.catch((settleError) => {
        console.error('[hosted-evaluations] Failed to persist terminal worker failure:', settleError);
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #isCancellationRequested(job: HostedJobRow): Promise<boolean> {
    const result = await this.#pool.query<Pick<HostedRunRow, 'cancel_requested_at'>>(
      'SELECT cancel_requested_at FROM evaluation_hosted_runs WHERE project_id = $1 AND run_id = $2',
      [job.project_id, job.run_id],
    );
    return result.rows[0]?.cancel_requested_at != null;
  }

  async #interrupt(job: HostedJobRow, trial: EvaluationTrial): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs
            SET status = 'interrupted', trial_json = $6::jsonb, settled_at = NOW(), lease_expires_at = NULL, updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2 AND job_id = $3
            AND status = 'accepted' AND worker_id = $4 AND fencing_token = $5
          RETURNING project_id, run_id, job_id, case_id, case_name, case_index, trial_index, status, attempt, fencing_token, worker_id, trial_json`,
        [job.project_id, job.run_id, job.job_id, this.#workerId, job.fencing_token, JSON.stringify(trial)],
      );
      const interrupted = result.rows[0];
      if (!interrupted) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'interrupted', NOW())`,
        [
          interrupted.project_id,
          interrupted.run_id,
          interrupted.job_id,
          interrupted.attempt,
          interrupted.fencing_token,
          this.#workerId,
        ],
      );
      const hosted = await this.#getHostedRunForUpdate(client, interrupted.project_id, interrupted.run_id);
      await this.#updateProjection(
        client,
        projectId(interrupted.project_id),
        interrupted.run_id,
        parseSnapshot(hosted.snapshot_json),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async #settle(job: HostedJobRow, trial: EvaluationTrial): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs
            SET status = 'settled', trial_json = $6::jsonb, settled_at = NOW(), lease_expires_at = NULL, updated_at = NOW()
          WHERE project_id = $1 AND run_id = $2 AND job_id = $3
            AND status = 'accepted' AND worker_id = $4 AND fencing_token = $5
          RETURNING project_id, run_id, job_id, case_id, case_name, case_index, trial_index, status, attempt, fencing_token, worker_id, trial_json`,
        [job.project_id, job.run_id, job.job_id, this.#workerId, job.fencing_token, JSON.stringify(trial)],
      );
      const settled = result.rows[0];
      if (!settled) {
        await client.query('ROLLBACK');
        return;
      }
      const event = trial.executionStatus === 'canceled' ? 'canceled' : 'settled';
      await client.query(
        `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          settled.project_id,
          settled.run_id,
          settled.job_id,
          settled.attempt,
          settled.fencing_token,
          this.#workerId,
          event,
        ],
      );
      const hosted = await this.#getHostedRunForUpdate(client, settled.project_id, settled.run_id);
      await this.#updateProjection(
        client,
        projectId(settled.project_id),
        settled.run_id,
        parseSnapshot(hosted.snapshot_json),
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #recoverExpiredLeases(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // No graph can have started before acceptance, so an expired claim is safe
      // to return to the queue. This is the only automatic retry transition.
      const requeued = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs AS job
            SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
           FROM evaluation_hosted_runs AS run
          WHERE job.project_id = run.project_id AND job.run_id = run.run_id
            AND job.status = 'claimed' AND job.lease_expires_at <= NOW()
            AND run.status IN ('queued', 'running') AND run.cancel_requested_at IS NULL
          RETURNING job.project_id, job.run_id, job.job_id, job.case_id, job.case_name, job.case_index,
                    job.trial_index, job.status, job.attempt, job.fencing_token, job.worker_id, job.trial_json`,
      );
      for (const job of requeued.rows) {
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, 'requeued', NOW())`,
          [job.project_id, job.run_id, job.job_id, job.attempt, job.fencing_token],
        );
      }
      const expired = await client.query<HostedJobRow>(
        `UPDATE evaluation_hosted_trial_jobs AS job
            SET status = CASE WHEN run.cancel_requested_at IS NULL THEN 'interrupted' ELSE 'canceled' END,
                worker_id = NULL, lease_expires_at = NULL, settled_at = NOW(), updated_at = NOW()
           FROM evaluation_hosted_runs AS run
          WHERE job.project_id = run.project_id AND job.run_id = run.run_id
            AND job.status = 'accepted' AND job.lease_expires_at <= NOW()
          RETURNING job.project_id, job.run_id, job.job_id, job.case_id, job.case_name, job.case_index,
                    job.trial_index, job.status, job.attempt, job.fencing_token, job.worker_id, job.trial_json`,
      );
      const dirty = new Map<string, { projectId: ProjectId; runId: string; snapshot: HostedEvaluationSnapshot }>();
      for (const job of expired.rows) {
        const canceled = job.status === 'canceled';
        await client.query(
          `INSERT INTO evaluation_hosted_trial_attempts (project_id, run_id, job_id, attempt, fencing_token, worker_id, event, created_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, NOW())`,
          [
            job.project_id,
            job.run_id,
            job.job_id,
            job.attempt,
            job.fencing_token,
            canceled ? 'canceled' : 'interrupted',
          ],
        );
        const hosted = await this.#getHostedRunForUpdate(client, job.project_id, job.run_id);
        const run = await this.#getRunForUpdate(client, projectId(job.project_id), job.run_id);
        const snapshot = parseSnapshot(hosted.snapshot_json);
        const trial = terminalTrial(
          job,
          canceled ? 'canceled' : 'interrupted',
          snapshot.purpose,
          run.evaluationMode,
          canceled
            ? 'The hosted evaluation was canceled while this trial was running.'
            : 'An execution worker stopped after accepting this trial. Rivet did not retry it automatically.',
        );
        await client.query(
          `UPDATE evaluation_hosted_trial_jobs SET trial_json = $4::jsonb WHERE project_id = $1 AND run_id = $2 AND job_id = $3`,
          [job.project_id, job.run_id, job.job_id, JSON.stringify(trial)],
        );
        dirty.set(`${job.project_id}:${job.run_id}`, {
          projectId: projectId(job.project_id),
          runId: job.run_id,
          snapshot,
        });
      }
      for (const entry of dirty.values()) {
        await this.#updateProjection(client, entry.projectId, entry.runId, entry.snapshot);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #findHostedRunForUpdate(client: PoolClient, project: string, runId: string): Promise<HostedRunRow | undefined> {
    const result = await client.query<HostedRunRow>(
      `SELECT project_id, run_id, status, snapshot_json, cancel_requested_at
         FROM evaluation_hosted_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE`,
      [project, runId],
    );
    return result.rows[0];
  }

  async #getHostedRunForUpdate(client: PoolClient, project: string, runId: string): Promise<HostedRunRow> {
    const hosted = await this.#findHostedRunForUpdate(client, project, runId);
    if (!hosted) throw new Error('Hosted evaluation scheduler record was not found.');
    return hosted;
  }

  async #getRunForUpdate(client: PoolClient, project: ProjectId, runId: string): Promise<EvaluationRun> {
    const result = await client.query<{ run_json: EvaluationRun | string }>(
      'SELECT run_json FROM evaluation_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE',
      [String(project), runId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Hosted Evaluation run projection is missing.');
    return (typeof row.run_json === 'string' ? JSON.parse(row.run_json) : row.run_json) as EvaluationRun;
  }

  async #writeRun(client: PoolClient, run: EvaluationRun): Promise<void> {
    await client.query(
      `UPDATE evaluation_runs SET suite_id = $3, started_at = $4, run_json = $5::jsonb, updated_at = NOW()
        WHERE project_id = $1 AND run_id = $2`,
      [String(run.projectId), run.id, run.suiteId, run.startedAt, JSON.stringify(run)],
    );
  }

  async #updateProjection(
    client: PoolClient,
    project: ProjectId,
    runId: string,
    snapshot: HostedEvaluationSnapshot,
  ): Promise<EvaluationRun> {
    const run = await this.#getRunForUpdate(client, project, runId);
    const result = await client.query<HostedJobRow>(
      `SELECT project_id, run_id, job_id, case_id, case_name, case_index, trial_index, status, attempt, fencing_token, worker_id, trial_json
         FROM evaluation_hosted_trial_jobs WHERE project_id = $1 AND run_id = $2 ORDER BY case_index ASC, trial_index ASC`,
      [String(project), runId],
    );
    const jobs = result.rows;
    const trials = jobs
      .map((job) => parseTrial(job.trial_json))
      .filter((trial): trial is EvaluationTrial => trial !== undefined);
    const allTerminal = jobs.length > 0 && jobs.every((job) => TERMINAL_JOB_STATES.has(job.status));
    const interrupted = jobs.some((job) => job.status === 'interrupted');
    const hosted = await this.#getHostedRunForUpdate(client, String(project), runId);
    const canceled = hosted.cancel_requested_at != null;
    let next: EvaluationRun = { ...run, revision: (run.revision ?? 0) + 1, trials, requestedTrialCount: jobs.length };
    if (allTerminal) {
      const suite = snapshot.evaluationData.suites.find((candidate) => candidate.id === snapshot.suiteId);
      if (!suite) throw new Error('The hosted Evaluation snapshot no longer contains its suite.');
      next = finalizeEvaluationRun({ run: next, trials, suite, evaluationData: snapshot.evaluationData, canceled });
      next = finalizeEvaluationRecordingRetention(
        next,
        suite.configuration?.recordingRetention ?? 'failures-and-baselines',
      );
      for (const update of recordingRetentionUpdates(project, next.trials)) {
        const updated = await this.#runStore.updateRecordingRetentionInTransaction(client, update);
        if (!updated) {
          throw new Error('A replay recording disappeared before its terminal retention policy could be finalized.');
        }
      }
      if (interrupted && !canceled) {
        next.executionStatus = 'error';
        next.qualityStatus = suite.evaluationMode === 'scoring' ? 'unable-to-evaluate' : 'failed';
        next.qualityReason = {
          code: suite.evaluationMode === 'scoring' ? 'scores-incomplete' : 'target-error',
          message:
            'One or more hosted trial workers were interrupted after dispatch. Those trials were not retried automatically.',
        };
        next.warnings.push(
          'One or more hosted trial workers were interrupted after dispatch. An authenticated operator must explicitly retry those trials if repeating the work is safe.',
        );
        await client.query(
          `UPDATE evaluation_hosted_runs SET status = 'interrupted', updated_at = NOW() WHERE project_id = $1 AND run_id = $2`,
          [String(project), runId],
        );
      } else {
        await client.query(
          `UPDATE evaluation_hosted_runs SET status = $3, updated_at = NOW() WHERE project_id = $1 AND run_id = $2`,
          [String(project), runId, canceled ? 'canceled' : 'completed'],
        );
      }
    } else if (hosted.status === 'running') {
      next.executionStatus = 'running';
      next.qualityStatus = 'not-evaluated';
      next.qualityReason = { code: 'in-progress', message: 'The hosted evaluation is running.' };
    }
    await this.#writeRun(client, next);
    return next;
  }
}
