import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { createRuntimeLibraryReleaseArtifactKey } from './blob-store.js';
import type { ManagedRuntimeLibrariesContext } from './context.js';
import { buildCandidatePackages, buildReleaseArtifact } from './release-builder.js';
import { getManagedActiveRelease } from './state.js';
import {
  acquireManagedRuntimeLibrariesReleaseMutationLock,
  configureManagedRuntimeLibrariesTransactionTimeout,
  JobCancelledError,
  normalizeJobPackages,
  normalizePackageMap,
  queryOne,
  type RuntimeLibraryJobRow,
} from './schema.js';

export type ManagedRuntimeLibraryActivationOutcome = 'succeeded' | 'failed' | 'unresolved';

type ActivationResolutionRow = RuntimeLibraryJobRow & {
  committed_release_id: string | null;
  committed_artifact_blob_key: string | null;
  committed_artifact_sha256: string | null;
};

type ActivationAttempt = {
  releaseId: string;
  artifactBlobKey: string;
  artifactSha256: string;
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isCommittedActivation(row: ActivationResolutionRow | null, attempt: ActivationAttempt): boolean {
  return row?.status === 'succeeded' &&
    row.release_id === attempt.releaseId &&
    row.committed_release_id === attempt.releaseId &&
    row.committed_artifact_blob_key === attempt.artifactBlobKey &&
    row.committed_artifact_sha256 === attempt.artifactSha256;
}

function hasResolvedFailedActivation(row: ActivationResolutionRow | null): boolean {
  if (!row) {
    return false;
  }

  return row.status === 'failed' ||
    (row.status !== 'succeeded' && row.release_id == null);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => {});
}

export function createManagedRuntimeLibrariesArtifactActivation(options: {
  context: ManagedRuntimeLibrariesContext;
  jobStore: {
    appendJobLog(jobId: string, message: string, source?: 'system' | 'stdout' | 'stderr'): Promise<void>;
    updateJobStatus(jobId: string, status: 'validating' | 'activating'): Promise<void>;
    failJob(jobId: string, error: unknown): Promise<boolean>;
    throwIfCancellationRequested(jobId: string): Promise<void>;
    isCancellationRequested(jobId: string): Promise<boolean>;
  };
  processRegistry: {
    registerRunningProcess(jobId: string, process: import('node:child_process').ChildProcess | null): void;
    terminateRunningProcess(jobId: string, reason: string): void;
  };
  buildCandidatePackages?: typeof buildCandidatePackages;
  buildReleaseArtifact?: typeof buildReleaseArtifact;
}) {
  const { context, jobStore, processRegistry } = options;
  const candidateBuilder = options.buildCandidatePackages ?? buildCandidatePackages;
  const releaseBuilder = options.buildReleaseArtifact ?? buildReleaseArtifact;

  const resolveActivationOutcome = async (
    jobId: string,
    attempt: ActivationAttempt,
  ): Promise<ManagedRuntimeLibraryActivationOutcome> => {
    let client: PoolClient | null = null;
    let releaseError: Error | undefined;
    let observedOutcome: ManagedRuntimeLibraryActivationOutcome = 'unresolved';

    try {
      client = await context.pool.connect();
      await client.query('BEGIN');
      await configureManagedRuntimeLibrariesTransactionTimeout(client);
      await acquireManagedRuntimeLibrariesReleaseMutationLock(client);
      const row = await queryOne<ActivationResolutionRow>(
        client,
        `
          SELECT job.job_id, job.type, job.status, job.packages_json, job.error, job.claimed_by,
                 job.created_at, job.started_at, job.finished_at, job.progress_at,
                 job.cancel_requested_at, job.release_id,
                 release.release_id AS committed_release_id,
                 release.artifact_blob_key AS committed_artifact_blob_key,
                 release.artifact_sha256 AS committed_artifact_sha256
          FROM runtime_library_jobs AS job
          LEFT JOIN runtime_library_releases AS release ON release.release_id = job.release_id
          WHERE job.job_id = $1
          FOR UPDATE OF job
        `,
        [jobId],
      );
      if (isCommittedActivation(row, attempt)) {
        observedOutcome = 'succeeded';
      } else if (hasResolvedFailedActivation(row)) {
        observedOutcome = 'failed';
      }

      await client.query('COMMIT');
      return observedOutcome;
    } catch (error) {
      releaseError = toError(error);
      if (client) {
        await rollbackQuietly(client);
      }
      // This transaction only observed already-durable state. Once it read a
      // matching succeeded job and immutable release metadata, a lost read
      // transaction COMMIT acknowledgement cannot make that activation unsafe.
      return observedOutcome === 'succeeded' ? 'succeeded' : 'unresolved';
    } finally {
      client?.release(releaseError);
    }
  };

  const activateRelease = async (
    job: RuntimeLibraryJobRow,
    candidatePackages: Record<string, unknown>,
    attempt: ActivationAttempt,
  ): Promise<void> => {
    let client: PoolClient | null = null;
    let began = false;
    let releaseError: Error | undefined;

    try {
      client = await context.pool.connect();
      await client.query('BEGIN');
      began = true;
      await configureManagedRuntimeLibrariesTransactionTimeout(client);
      await acquireManagedRuntimeLibrariesReleaseMutationLock(client);

      const lockedJob = await queryOne<RuntimeLibraryJobRow>(
        client,
        `
          SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at,
                 finished_at, progress_at, cancel_requested_at, release_id
          FROM runtime_library_jobs
          WHERE job_id = $1
          FOR UPDATE
        `,
        [job.job_id],
      );
      if (!lockedJob || lockedJob.status !== 'activating' || lockedJob.claimed_by !== context.instanceId) {
        throw new Error('Runtime-library job is no longer active on this worker.');
      }
      if (lockedJob.cancel_requested_at) {
        throw new JobCancelledError();
      }

      await client.query(
        `
          INSERT INTO runtime_library_releases(release_id, packages_json, artifact_blob_key, artifact_sha256)
          VALUES ($1, $2::jsonb, $3, $4)
        `,
        [attempt.releaseId, JSON.stringify(candidatePackages), attempt.artifactBlobKey, attempt.artifactSha256],
      );
      const activation = await queryOne<{ slot: string }>(
        client,
        `
          UPDATE runtime_library_activation
          SET active_release_id = $1,
              updated_at = NOW()
          WHERE slot = 'default'
          RETURNING slot
        `,
        [attempt.releaseId],
      );
      if (!activation) {
        throw new Error('Runtime-library activation row is missing.');
      }

      const completedJob = await queryOne<{ job_id: string }>(
        client,
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
            AND status = 'activating'
            AND claimed_by = $3
            AND cancel_requested_at IS NULL
          RETURNING job_id
        `,
        [job.job_id, attempt.releaseId, context.instanceId],
      );
      if (!completedJob) {
        throw new Error('Runtime-library job was canceled or superseded before activation completed.');
      }

      await client.query('COMMIT');
      began = false;
    } catch (error) {
      releaseError = toError(error);
      if (client && began) {
        await rollbackQuietly(client);
      }
      throw releaseError;
    } finally {
      client?.release(releaseError);
    }
  };

  const finishSuccessfulActivation = async (jobId: string, releaseId: string): Promise<void> => {
    await jobStore.appendJobLog(jobId, `Activated release ${releaseId}.`).catch((error) => {
      console.error('[runtime-libraries] Failed to append managed activation log:', error);
    });
    await jobStore.appendJobLog(jobId, '--- Job completed successfully ---').catch((error) => {
      console.error('[runtime-libraries] Failed to append managed completion log:', error);
    });

    context.localCache.reset();
    await context.syncForLocalUse(true).catch((error) => {
      console.error('[runtime-libraries] Managed release activated but local API cache sync failed:', error);
    });
  };

  const failJob = async (jobId: string, error: unknown): Promise<ManagedRuntimeLibraryActivationOutcome> => {
    const failed = await jobStore.failJob(jobId, error);
    return failed ? 'failed' : 'unresolved';
  };

  return {
    async processJob(job: RuntimeLibraryJobRow): Promise<ManagedRuntimeLibraryActivationOutcome> {
      let activationAttempt: ActivationAttempt | null = null;

      try {
        await jobStore.appendJobLog(job.job_id, `--- Starting ${job.type} job ---`);
        const candidatePackages = await candidateBuilder(
          job,
          async () => {
            const activeRelease = await getManagedActiveRelease(context.pool);
            return activeRelease ? normalizePackageMap(activeRelease.packages_json) : {};
          },
          jobStore.appendJobLog.bind(jobStore),
          normalizeJobPackages,
        );
        await jobStore.throwIfCancellationRequested(job.job_id);

        const buildResult = await releaseBuilder({
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
        activationAttempt = {
          releaseId,
          artifactBlobKey: createRuntimeLibraryReleaseArtifactKey(releaseId),
          artifactSha256: buildResult.archiveSha256,
        };

        await jobStore.throwIfCancellationRequested(job.job_id);
        await context.blobStore.putBuffer(
          activationAttempt.artifactBlobKey,
          buildResult.archiveBuffer,
          'application/x-tar',
        );
        await jobStore.throwIfCancellationRequested(job.job_id);

        await activateRelease(job, candidatePackages, activationAttempt);
        await finishSuccessfulActivation(job.job_id, activationAttempt.releaseId);
        return 'succeeded';
      } catch (error) {
        if (activationAttempt) {
          const outcome = await resolveActivationOutcome(job.job_id, activationAttempt);
          if (outcome === 'succeeded') {
            await finishSuccessfulActivation(job.job_id, activationAttempt.releaseId);
            return 'succeeded';
          }
          if (outcome === 'unresolved') {
            console.error(
              `[runtime-libraries] Activation outcome for job ${job.job_id} is uncertain; preserving ${activationAttempt.artifactBlobKey} for audit and manual cleanup:`,
              error,
            );
            return 'unresolved';
          }
        }

        return failJob(job.job_id, error);
      }
    },
  };
}
