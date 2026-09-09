import { randomUUID } from 'node:crypto';

import type { JobStatus, RuntimeLibraryLogSource, RuntimeLibraryPackageSpec, RuntimeLibraryJobState } from '../../../../studio-server-shared/runtime-library-types.js';
import { conflict } from '../../utils/httpError.js';
import { getManagedActiveJob, getManagedJob } from './state.js';
import {
  ACTIVE_JOB_STATUS_CLAUSE,
  JobCancelledError,
  isUniqueViolation,
  mapJobRow,
  queryOne,
  type RuntimeLibraryJobRow,
} from './schema.js';
import type { ManagedRuntimeLibrariesContext } from './context.js';

export function createManagedRuntimeLibrariesJobStore(options: {
  context: ManagedRuntimeLibrariesContext;
  terminateRunningProcess(jobId: string, reason: string): void;
}) {
  const { context } = options;

  return {
    async insertJob(type: 'install' | 'remove', packages: RuntimeLibraryPackageSpec[]): Promise<RuntimeLibraryJobState> {
      const jobId = randomUUID();
      try {
        const row = await queryOne<RuntimeLibraryJobRow>(
          context.pool,
          `
            INSERT INTO runtime_library_jobs(job_id, type, status, packages_json)
            VALUES ($1, $2, 'queued', $3::jsonb)
            RETURNING job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
          `,
          [jobId, type, JSON.stringify(packages)],
        );

        if (!row) {
          throw new Error('Failed to create runtime-library job');
        }

        return mapJobRow(row, []);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const active = await getManagedActiveJob(context.pool);
          if (active) {
            throw conflict(`A job is already running (job ${active.id})`);
          }

          throw conflict('A job is already running');
        }

        throw error;
      }
    },

    async cancelJob(jobId: string): Promise<RuntimeLibraryJobState | null> {
      const row = await queryOne<RuntimeLibraryJobRow>(
        context.pool,
        `
          SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
          FROM runtime_library_jobs
          WHERE job_id = $1
        `,
        [jobId],
      );
      if (!row) {
        return null;
      }

      if (row.status === 'succeeded' || row.status === 'failed' || row.cancel_requested_at) {
        return getManagedJob(context.pool, jobId);
      }

      const cancellation = await context.pool.query<{
        status: JobStatus;
        claimed_by: string | null;
      }>(
        `
          UPDATE runtime_library_jobs
          SET cancel_requested_at = NOW(),
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
            AND status IN ${ACTIVE_JOB_STATUS_CLAUSE}
            AND cancel_requested_at IS NULL
          RETURNING status, claimed_by
        `,
        [jobId],
      );
      const cancelledJob = cancellation.rows[0];
      if (!cancelledJob) {
        return getManagedJob(context.pool, jobId);
      }
      await this.appendJobLog(jobId, 'Cancellation requested by user.', 'system');

      if (cancelledJob.status === 'queued') {
        await this.failJob(jobId, new JobCancelledError());
        return getManagedJob(context.pool, jobId);
      }

      if (cancelledJob.claimed_by === context.instanceId) {
        options.terminateRunningProcess(jobId, 'Cancellation requested by user.');
      }

      return getManagedJob(context.pool, jobId);
    },

    async appendJobLog(jobId: string, message: string, source: RuntimeLibraryLogSource = 'system'): Promise<void> {
      await context.pool.query(
        `
          WITH inserted AS (
            INSERT INTO runtime_library_job_logs(job_id, message, source)
            VALUES ($1, $2, $3)
            RETURNING job_id
          )
          UPDATE runtime_library_jobs
          SET progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
        `,
        [jobId, message, source],
      );
    },

    async updateJobStatus(jobId: string, status: 'validating' | 'activating'): Promise<void> {
      const updated = await context.pool.query<{ job_id: string }>(
        `
          UPDATE runtime_library_jobs
          SET status = $2,
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
            AND status IN ${ACTIVE_JOB_STATUS_CLAUSE}
            AND claimed_by = $3
            AND cancel_requested_at IS NULL
          RETURNING job_id
        `,
        [jobId, status, context.instanceId],
      );
      if ((updated.rowCount ?? updated.rows.length) !== 1) {
        throw new Error('Runtime-library job is no longer active on this worker.');
      }
    },

    async failJob(jobId: string, error: unknown): Promise<boolean> {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await context.pool.query<{ job_id: string }>(
        `
          UPDATE runtime_library_jobs
          SET status = 'failed',
              error = $2,
              claimed_by = NULL,
              finished_at = NOW(),
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
            AND status IN ${ACTIVE_JOB_STATUS_CLAUSE}
            AND (
              claimed_by = $3
              OR (status = 'queued' AND claimed_by IS NULL AND cancel_requested_at IS NOT NULL)
            )
          RETURNING job_id
        `,
        [jobId, message, context.instanceId],
      );
      if ((updated.rowCount ?? updated.rows.length) !== 1) {
        return false;
      }

      options.terminateRunningProcess(jobId, message);
      await this.appendJobLog(jobId, `ERROR: ${message}`).catch((logError) => {
        console.error('[runtime-libraries] Failed to append job failure log:', logError);
      });
      await this.appendJobLog(jobId, '--- Job failed ---').catch((logError) => {
        console.error('[runtime-libraries] Failed to append job failure completion log:', logError);
      });
      return true;
    },

    async touchJob(jobId: string, stopped: boolean): Promise<void> {
      if (stopped) {
        return;
      }

      await context.pool.query(
        `
          UPDATE runtime_library_jobs
          SET updated_at = NOW()
          WHERE job_id = $1
            AND status IN ${ACTIVE_JOB_STATUS_CLAUSE}
        `,
        [jobId],
      );
    },

    async isCancellationRequested(jobId: string): Promise<boolean> {
      const row = await queryOne<{ cancel_requested_at: Date | string | null }>(
        context.pool,
        'SELECT cancel_requested_at FROM runtime_library_jobs WHERE job_id = $1',
        [jobId],
      );
      return Boolean(row?.cancel_requested_at);
    },

    async throwIfCancellationRequested(jobId: string): Promise<void> {
      if (await this.isCancellationRequested(jobId)) {
        throw new JobCancelledError();
      }
    },
  };
}
