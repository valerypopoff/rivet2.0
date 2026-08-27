import { randomUUID } from 'node:crypto';

import type { JobStatus, RuntimeLibraryLogSource, RuntimeLibraryPackageSpec, RuntimeLibraryJobState } from '../../../../shared/runtime-library-types.js';
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

      await context.pool.query(
        `
          UPDATE runtime_library_jobs
          SET cancel_requested_at = NOW(),
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
        `,
        [jobId],
      );
      await this.appendJobLog(jobId, 'Cancellation requested by user.', 'system');

      if (row.status === 'queued') {
        await this.failJob(jobId, new JobCancelledError());
        return getManagedJob(context.pool, jobId);
      }

      if (row.claimed_by === context.instanceId) {
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

    async updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
      await context.pool.query(
        `
          UPDATE runtime_library_jobs
          SET status = $2,
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
        `,
        [jobId, status],
      );
    },

    async failJob(jobId: string, error: unknown): Promise<void> {
      const message = error instanceof Error ? error.message : String(error);
      options.terminateRunningProcess(jobId, message);
      await this.appendJobLog(jobId, `ERROR: ${message}`);
      await this.appendJobLog(jobId, '--- Job failed ---');
      await context.pool.query(
        `
          UPDATE runtime_library_jobs
          SET status = 'failed',
              error = $2,
              claimed_by = NULL,
              finished_at = NOW(),
              progress_at = NOW(),
              updated_at = NOW()
          WHERE job_id = $1
        `,
        [jobId, message],
      );
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
