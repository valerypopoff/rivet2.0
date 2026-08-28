import { randomUUID } from 'node:crypto';

import { createRuntimeLibraryReleaseArtifactKey } from './blob-store.js';
import type { ManagedRuntimeLibrariesContext } from './context.js';
import { buildCandidatePackages, buildReleaseArtifact } from './release-builder.js';
import { getManagedActiveRelease } from './state.js';
import { normalizeJobPackages, normalizePackageMap, type RuntimeLibraryJobRow } from './schema.js';

export function createManagedRuntimeLibrariesArtifactActivation(options: {
  context: ManagedRuntimeLibrariesContext;
  jobStore: {
    appendJobLog(jobId: string, message: string, source?: 'system' | 'stdout' | 'stderr'): Promise<void>;
    updateJobStatus(jobId: string, status: 'validating' | 'activating'): Promise<void>;
    failJob(jobId: string, error: unknown): Promise<void>;
    throwIfCancellationRequested(jobId: string): Promise<void>;
    isCancellationRequested(jobId: string): Promise<boolean>;
  };
  processRegistry: {
    registerRunningProcess(jobId: string, process: import('node:child_process').ChildProcess | null): void;
    terminateRunningProcess(jobId: string, reason: string): void;
  };
}) {
  const { context, jobStore, processRegistry } = options;

  return {
    async processJob(job: RuntimeLibraryJobRow): Promise<void> {
      await jobStore.appendJobLog(job.job_id, `--- Starting ${job.type} job ---`);
      const candidatePackages = await buildCandidatePackages(
        job,
        async () => {
          const activeRelease = await getManagedActiveRelease(context.pool);
          return activeRelease ? normalizePackageMap(activeRelease.packages_json) : {};
        },
        jobStore.appendJobLog.bind(jobStore),
        normalizeJobPackages,
      );
      await jobStore.throwIfCancellationRequested(job.job_id);

      const buildResult = await buildReleaseArtifact({
        job,
        candidatePackages,
        jobsRoot: context.localCache.jobsRoot(),
        appendJobLog: jobStore.appendJobLog.bind(jobStore),
        throwIfCancellationRequested: jobStore.throwIfCancellationRequested.bind(jobStore),
        updateJobStatus: async (jobId, status) => jobStore.updateJobStatus(jobId, status),
        registerRunningProcess: processRegistry.registerRunningProcess,
        terminateRunningProcess: processRegistry.terminateRunningProcess,
        isCancellationRequested: jobStore.isCancellationRequested.bind(jobStore),
      });

      await jobStore.updateJobStatus(job.job_id, 'activating');
      await jobStore.appendJobLog(job.job_id, 'Uploading release artifact...');
      const releaseId = randomUUID();
      const artifactBlobKey = createRuntimeLibraryReleaseArtifactKey(releaseId);

      try {
        await jobStore.throwIfCancellationRequested(job.job_id);
        await context.blobStore.putBuffer(artifactBlobKey, buildResult.archiveBuffer, 'application/x-tar');
        await jobStore.throwIfCancellationRequested(job.job_id);
      } catch (error) {
        await context.blobStore.delete(artifactBlobKey).catch(() => {});
        await jobStore.failJob(job.job_id, error);
        return;
      }

      try {
        const client = await context.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `
              INSERT INTO runtime_library_releases(release_id, packages_json, artifact_blob_key, artifact_sha256)
              VALUES ($1, $2::jsonb, $3, $4)
            `,
            [releaseId, JSON.stringify(candidatePackages), artifactBlobKey, buildResult.archiveSha256],
          );
          await client.query(
            `
              UPDATE runtime_library_activation
              SET active_release_id = $1,
                  updated_at = NOW()
              WHERE slot = 'default'
            `,
            [releaseId],
          );
          await client.query(
            `
              UPDATE runtime_library_jobs
              SET status = 'succeeded',
                  release_id = $2,
                  error = NULL,
                  claimed_by = NULL,
                  cancel_requested_at = NULL,
                  finished_at = NOW(),
                  progress_at = NOW(),
                  updated_at = NOW()
              WHERE job_id = $1
            `,
            [job.job_id, releaseId],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        await context.blobStore.delete(artifactBlobKey).catch(() => {});
        await jobStore.failJob(job.job_id, error);
        return;
      }

      await jobStore.appendJobLog(job.job_id, `Activated release ${releaseId}.`).catch((error) => {
        console.error('[runtime-libraries] Failed to append managed activation log:', error);
      });
      await jobStore.appendJobLog(job.job_id, '--- Job completed successfully ---').catch((error) => {
        console.error('[runtime-libraries] Failed to append managed completion log:', error);
      });

      context.localCache.reset();
      await context.syncForLocalUse(true).catch((error) => {
        console.error('[runtime-libraries] Managed release activated but local API cache sync failed:', error);
      });
    },
  };
}
