import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  assertPortableJson,
  createEvaluationRunShell,
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
import {
  HostedEvaluationJobStore,
  HostedEvaluationCapacityError,
  HostedEvaluationRetryConflictError,
  parseSnapshot,
  projectId,
  terminalTrial,
  type HostedEvaluationSnapshot,
  type HostedEvaluationRunState,
  type HostedRunRow,
  type HostedJobRow,
} from './hosted-job-store.js';
export {
  HostedEvaluationCapacityError,
  HostedEvaluationRunConflictError,
  HostedEvaluationRetryConflictError,
} from './hosted-job-store.js';
export type { HostedEvaluationJobState, HostedEvaluationRunState } from './hosted-job-store.js';

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

function hostedEvaluationShutdownDrainMs(leaseMs: number): number {
  // Yield quickly to the broader API shutdown budget. If a graph runner cannot
  // observe cancellation, its accepted fenced lease is recovered explicitly
  // after the pod is gone instead of blocking resource disposal indefinitely.
  return Math.min(10_000, Math.max(1_000, Math.floor(leaseMs / 3)));
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Schedules process-local workers; durable transitions belong to HostedEvaluationJobStore. */
export class HostedEvaluationCoordinator {
  readonly #jobs: HostedEvaluationJobStore;
  // Each task owns its entry, including overlapping attempts of the same job.
  readonly #active = new Map<Promise<void>, ActiveHostedJob>();
  readonly #config: HostedEvaluationsCoordinatorConfig;
  readonly #graphRunner: HostedEvaluationGraphRunner;
  readonly #runStore: PostgresRivetEvaluationStore;
  readonly #workerId = `evaluation-worker:${process.env.HOSTNAME?.trim() || 'local'}:${process.pid}:${randomUUID()}`;
  #loopPromise: Promise<void> | undefined;
  #metricsRefreshPromise: Promise<void> | undefined;
  #stopping = false;
  #retiring = false;
  #retirementFailure: Error | undefined;
  #wake: (() => void) | undefined;

  constructor(input: {
    pool: Pool;
    runStore: PostgresRivetEvaluationStore;
    config: HostedEvaluationsCoordinatorConfig;
    runGraph: HostedEvaluationGraphRunner;
  }) {
    this.#runStore = input.runStore;
    this.#config = input.config;
    this.#graphRunner = input.runGraph;
    this.#jobs = new HostedEvaluationJobStore({
      pool: input.pool,
      runStore: input.runStore,
      config: input.config,
      workerId: this.#workerId,
    });
  }

  getRunState(input: { projectId: ProjectId; runId: string }): Promise<HostedEvaluationRunState | undefined> {
    return this.#jobs.getRunState(input);
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

    await this.#jobs.submit(run, plan, snapshot, input.dataset);
    getStudioMetrics().recordHostedEvaluationSubmission('accepted');
    this.#notify();
    return run;
  }

  requestCancel(input: { projectId: ProjectId; runId: string }): Promise<EvaluationRun | undefined> {
    return this.#jobs.requestCancel(input, () => {
      this.#abortRun(input.projectId, input.runId, 'Hosted evaluation cancellation requested.');
      this.#notify();
    });
  }

  async retryInterrupted(input: {
    projectId: ProjectId;
    runId: string;
    jobIds: readonly string[];
  }): Promise<EvaluationRun | undefined> {
    if (!this.#config.enabled)
      throw new Error('Hosted Evaluations are disabled, so interrupted trials cannot be retried.');
    const jobIds = [...new Set(input.jobIds.filter((id) => typeof id === 'string' && id.length > 0))];
    if (jobIds.length === 0)
      throw new HostedEvaluationRetryConflictError('Select one or more interrupted trials to retry.');

    return this.#jobs.retryInterrupted(input, jobIds, () => {
      this.#notify();
    });
  }

  deleteRun(input: { projectId: ProjectId; runId: string }): Promise<void> {
    return this.#jobs.deleteRun(input);
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

  start(): void {
    if (this.#retiring) return;
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
    const activeTasks = [...this.#active.keys()];
    await Promise.race([Promise.allSettled(activeTasks), waitFor(drainMs)]);
    if (this.#active.size > 0) {
      console.warn(
        `[hosted-evaluations] ${this.#active.size} worker task(s) exceeded the ${drainMs}ms shutdown drain; lease recovery will mark accepted work interrupted.`,
      );
    }
  }

  beginRetirement(): void {
    this.#retiring = true;
    this.#notify();
  }

  async drainAcceptedWork(): Promise<void> {
    this.beginRetirement();
    await this.#loopPromise;
    await Promise.all([...this.#active.keys()]);
    if (this.#retirementFailure) throw this.#retirementFailure;
  }

  #refreshMetrics(): void {
    if (this.#metricsRefreshPromise) return;
    const metrics = getStudioMetrics();
    if (!metrics.enabled) return;

    this.#metricsRefreshPromise = (async () => {
      try {
        const queued = await this.#jobs.readQueueCounts();
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
    while (!this.#stopping && !this.#retiring) {
      try {
        void this.#refreshMetrics();
        await this.#jobs.recoverExpiredLeases();
        while (!this.#stopping && !this.#retiring && this.#active.size < this.#config.workerConcurrency) {
          const claim = await this.#jobs.claimNext();
          if (!claim) break;
          if (this.#stopping || this.#retiring) {
            await this.#jobs.releaseUnacceptedClaim(claim.job);
            break;
          }
          const controller = new AbortController();
          const task: Promise<void> = this.#executeClaim(claim, controller)
            .catch((error) => {
              // Includes acceptance and failure-reporting awaits outside execution's try.
              // Never let a lost acknowledgement become a successful empty drain.
              this.#retirementFailure ??= new Error('Hosted Evaluation acceptance/cleanup outcome is unconfirmed.');
              console.error('[hosted-evaluations] Worker ownership failed:', error);
            })
            .finally(() => {
              this.#active.delete(task);
              void this.#refreshMetrics();
              this.#notify();
            });
          this.#active.set(task, { projectId: claim.job.project_id, runId: claim.job.run_id, controller });
          void task;
        }
      } catch (error) {
        this.#retirementFailure ??= new Error('Hosted Evaluation claim/cleanup outcome is unconfirmed.');
        console.error('[hosted-evaluations] Scheduler tick failed:', error);
      }
      await this.#waitForWake();
    }
  }

  async #waitForWake(): Promise<void> {
    if (this.#stopping || this.#retiring) return;
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

  async #executeClaim(claim: { run: HostedRunRow; job: HostedJobRow }, controller: AbortController): Promise<void> {
    if (!(await this.#jobs.accept(claim.job))) return;
    let heartbeatWork: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        if (heartbeatWork) return;
        heartbeatWork = this.#jobs
          .heartbeat(claim.job)
          .then((active) => {
            if (!active)
              controller.abort(new DOMException('Hosted evaluation claim is no longer active.', 'AbortError'));
          })
          .catch(() => {
            this.#retirementFailure ??= new Error('Hosted Evaluation heartbeat outcome is unconfirmed.');
            controller.abort(new DOMException('Hosted evaluation lease heartbeat failed.', 'AbortError'));
          })
          .finally(() => {
            heartbeatWork = undefined;
          });
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
      if (controller.signal.aborted && !(await this.#jobs.isCancellationRequested(claim.job))) {
        // The evaluator may turn an AbortSignal into a returned canceled trial
        // rather than throw. Worker shutdown/lease loss is still interruption,
        // not user cancellation, and must remain explicitly retryable.
        const interrupted = terminalTrial(
          claim.job,
          'interrupted',
          snapshot.purpose,
          plan.suite.evaluationMode ?? 'pass-fail',
          'The hosted trial worker stopped after dispatch.',
        );
        await this.#interrupt(claim.job, {
          ...trial,
          executionStatus: interrupted.executionStatus,
          qualityStatus: interrupted.qualityStatus,
          qualityReason: interrupted.qualityReason,
          error: interrupted.error,
        });
      } else {
        await this.#settle(claim.job, trial);
      }
    } catch (error) {
      const snapshot = parseSnapshot(claim.run.snapshot_json);
      const run = await this.#runStore.get({ projectId: projectId(claim.job.project_id), runId: claim.job.run_id });
      // An AbortSignal also represents fencing/heartbeat loss during worker
      // shutdown. Only an explicit durable cancel request is cancellation;
      // every other abort is interruption evidence, never a false cancellation.
      const cancellationRequested = controller.signal.aborted && (await this.#jobs.isCancellationRequested(claim.job));
      const fallback = terminalTrial(
        claim.job,
        cancellationRequested ? 'canceled' : 'interrupted',
        snapshot.purpose,
        run?.evaluationMode ?? 'pass-fail',
        error instanceof Error ? error.message : String(error),
      );
      const persist = cancellationRequested ? this.#settle(claim.job, fallback) : this.#interrupt(claim.job, fallback);
      await persist.catch((settleError) => {
        this.#retirementFailure ??= new Error('Hosted Evaluation terminal persistence is unconfirmed.');
        console.error('[hosted-evaluations] Failed to persist terminal worker failure:', settleError);
      });
    } finally {
      clearInterval(heartbeat);
      await heartbeatWork;
    }
  }

  async #interrupt(job: HostedJobRow, trial: EvaluationTrial): Promise<void> {
    if (!(await this.#jobs.interrupt(job, trial)))
      this.#retirementFailure ??= new Error('Hosted Evaluation interruption persistence was not acknowledged.');
  }

  async #settle(job: HostedJobRow, trial: EvaluationTrial): Promise<void> {
    if (!(await this.#jobs.settle(job, trial)))
      this.#retirementFailure ??= new Error('Hosted Evaluation terminal persistence was not acknowledged.');
  }
}
