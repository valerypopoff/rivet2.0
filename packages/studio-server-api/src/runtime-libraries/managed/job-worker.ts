import {
  ACTIVE_JOB_STATUS_CLAUSE,
  JOB_HEARTBEAT_INTERVAL_MS,
  queryOne,
  queryRows,
  STALE_JOB_TIMEOUT_MS,
  wait,
  type RuntimeLibraryJobRow,
} from './schema.js';
import type { ManagedRuntimeLibrariesContext } from './context.js';

export function createManagedRuntimeLibrariesJobWorker(options: {
  context: ManagedRuntimeLibrariesContext;
  isStopped(): boolean;
  syncForLocalUse(force: boolean): Promise<void>;
  getProcessManagedSync(): ((force?: boolean) => Promise<void>) | undefined;
  jobStore: {
    appendJobLog(jobId: string, message: string, source?: 'system' | 'stdout' | 'stderr'): Promise<void>;
    failJob(jobId: string, error: unknown): Promise<void>;
    touchJob(jobId: string, stopped: boolean): Promise<void>;
  };
  artifactActivation: {
    processJob(job: RuntimeLibraryJobRow): Promise<void>;
  };
}) {
  let workerStarted = false;

  const withJobHeartbeat = async <T>(jobId: string, run: () => Promise<T>): Promise<T> => {
    const heartbeat = setInterval(() => {
      void options.jobStore.touchJob(jobId, options.isStopped()).catch((error) => {
        console.error('[runtime-libraries] Managed job heartbeat failed:', error);
      });
    }, JOB_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      return await run();
    } finally {
      clearInterval(heartbeat);
    }
  };

  const recoverStaleJobs = async (): Promise<void> => {
    const rows = await queryRows<{ job_id: string }>(
      options.context.pool,
      `
        UPDATE runtime_library_jobs
        SET status = 'failed',
            error = COALESCE(error, 'Job heartbeat timed out; worker was assumed dead'),
            claimed_by = NULL,
            finished_at = COALESCE(finished_at, NOW()),
            progress_at = NOW(),
            updated_at = NOW()
        WHERE status IN ${ACTIVE_JOB_STATUS_CLAUSE}
          AND updated_at < NOW() - ($1 * INTERVAL '1 millisecond')
        RETURNING job_id
      `,
      [STALE_JOB_TIMEOUT_MS],
    );

    for (const row of rows) {
      await options.jobStore.appendJobLog(row.job_id, 'ERROR: Job heartbeat timed out; marking job as failed.').catch(() => {});
      await options.jobStore.appendJobLog(row.job_id, '--- Job failed ---').catch(() => {});
    }
  };

  const claimNextJob = async (): Promise<RuntimeLibraryJobRow | null> => {
    const client = await options.context.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await queryOne<RuntimeLibraryJobRow>(
        client,
        `
          WITH next_job AS (
            SELECT job_id
            FROM runtime_library_jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE runtime_library_jobs AS job
          SET status = 'running',
              started_at = COALESCE(started_at, NOW()),
              claimed_by = $1,
              updated_at = NOW()
          FROM next_job
          WHERE job.job_id = next_job.job_id
          RETURNING job.job_id, job.type, job.status, job.packages_json, job.error, job.claimed_by, job.created_at, job.started_at, job.finished_at, job.progress_at, job.cancel_requested_at, job.release_id
        `,
        [options.context.instanceId],
      );
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const workerLoop = async (): Promise<void> => {
    while (!options.isStopped()) {
      try {
        await recoverStaleJobs();
        if (!options.getProcessManagedSync()) {
          await options.syncForLocalUse(false);
        }
        const job = await claimNextJob();
        if (!job) {
          await wait(1_000);
          continue;
        }

        await withJobHeartbeat(job.job_id, async () => {
          await options.artifactActivation.processJob(job);
        }).catch(async (error) => {
          await options.jobStore.failJob(job.job_id, error);
        });
      } catch (error) {
        if (options.isStopped()) {
          break;
        }

        console.error('[runtime-libraries] Managed worker loop failed:', error);
        await wait(2_000);
      }
    }
  };

  return {
    startWorkerLoop(): void {
      if (workerStarted) {
        return;
      }

      workerStarted = true;
      void workerLoop();
    },

    reset(): void {
      workerStarted = false;
    },
  };
}
