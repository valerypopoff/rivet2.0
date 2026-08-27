import { Pool } from 'pg';

import type { JobStatus } from '../../../../shared/runtime-library-types.js';
import { getManagedRuntimeLibrariesConfig, type ManagedRuntimeLibrariesConfig } from '../config.js';
import {
  deleteRuntimeLibrariesBlobObjects,
  listRuntimeLibrariesBlobObjects,
  type RuntimeLibrariesBlobObject,
} from './blob-store.js';
import {
  ACTIVE_JOB_STATUS_CLAUSE,
  ensureManagedRuntimeLibrariesSchema,
  getPoolConfig,
  queryOne,
  queryRows,
  toIsoString,
  type RuntimeLibraryActivationRow,
  type RuntimeLibraryJobRow,
  type RuntimeLibraryReleaseRow,
} from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const RELEASE_MIN_RETENTION_MS = 7 * DAY_MS;
const ORPHANED_ARTIFACT_MIN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SUCCEEDED_JOB_RETENTION_MS = 30 * DAY_MS;
const FAILED_JOB_RETENTION_MS = 14 * DAY_MS;
const RETAIN_NEWEST_INACTIVE_RELEASE_COUNT = 5;

const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'validating',
  'activating',
  'succeeded',
  'failed',
];

type ReleaseRetentionReason =
  | 'active'
  | 'in-flight-job'
  | 'recent'
  | 'newest-inactive'
  | 'integrity-missing-artifact';

type JobRetentionReason = 'in-flight' | 'within-retention';

export type ManagedRuntimeLibrariesAuditReleaseEntry = {
  releaseId: string;
  artifactBlobKey: string;
  artifactSha256: string;
  createdAt: string;
  artifactPresent: boolean;
  referencedByInFlightJob: boolean;
  retainReasons: ReleaseRetentionReason[];
  pruneCandidate: boolean;
};

export type ManagedRuntimeLibrariesAuditJobEntry = {
  jobId: string;
  type: 'install' | 'remove';
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastProgressAt: string | null;
  releaseId: string | null;
  cancelRequestedAt: string | null;
  retainReasons: JobRetentionReason[];
  pruneCandidate: boolean;
};

export type ManagedRuntimeLibrariesAuditObjectEntry = {
  key: string;
  size: number;
  lastModified: string | null;
  orphaned: boolean;
  pruneCandidate: boolean;
};

export type ManagedRuntimeLibrariesPrunePlan = {
  retainedReleaseIds: string[];
  pruneCandidateReleaseIds: string[];
  retainedJobIds: string[];
  pruneCandidateJobIds: string[];
  pruneCandidateOrphanedArtifactKeys: string[];
};

export type ManagedRuntimeLibrariesAuditSnapshot = {
  generatedAt: string;
  activeReleaseId: string | null;
  totalReleaseCount: number;
  totalJobCount: number;
  totalJobCountByStatus: Record<JobStatus, number>;
  totalObjectCount: number;
  totalObjectBytes: number;
  releaseRowsMissingArtifacts: Array<{
    releaseId: string;
    artifactBlobKey: string;
    createdAt: string;
  }>;
  orphanedArtifacts: ManagedRuntimeLibrariesAuditObjectEntry[];
  releasesReferencedByInFlightJobs: string[];
  releases: ManagedRuntimeLibrariesAuditReleaseEntry[];
  jobs: ManagedRuntimeLibrariesAuditJobEntry[];
  objects: ManagedRuntimeLibrariesAuditObjectEntry[];
  prunePlan: ManagedRuntimeLibrariesPrunePlan;
};

export type ManagedRuntimeLibrariesPruneDriver = {
  audit: () => Promise<ManagedRuntimeLibrariesAuditSnapshot>;
  deleteJobs: (jobIds: string[]) => Promise<number>;
  deleteReleases: (releaseIds: string[]) => Promise<number>;
  deleteObjects: (keys: string[]) => Promise<number>;
};

type CleanupQueryState = {
  activeReleaseId: string | null;
  releases: RuntimeLibraryReleaseRow[];
  jobs: RuntimeLibraryJobRow[];
  objects: RuntimeLibrariesBlobObject[];
};

function toTimestampMs(value: string | Date | null | undefined): number | null {
  const iso = toIsoString(value);
  if (!iso) {
    return null;
  }

  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sortByNewestCreated<T extends { created_at: string | Date }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const leftMs = toTimestampMs(left.created_at) ?? 0;
    const rightMs = toTimestampMs(right.created_at) ?? 0;
    return rightMs - leftMs;
  });
}

function createEmptyJobStatusCounts(): Record<JobStatus, number> {
  return {
    queued: 0,
    running: 0,
    validating: 0,
    activating: 0,
    succeeded: 0,
    failed: 0,
  };
}

function buildManagedRuntimeLibrariesAuditSnapshotFromState(
  state: CleanupQueryState,
  now = new Date(),
): ManagedRuntimeLibrariesAuditSnapshot {
  const nowMs = now.getTime();
  const activeReleaseId = state.activeReleaseId;
  const inFlightStatuses = new Set<JobStatus>(['queued', 'running', 'validating', 'activating']);
  const inFlightReleaseIds = new Set(
    state.jobs
      .filter((job) => inFlightStatuses.has(job.status) && job.release_id)
      .map((job) => job.release_id!)
      .filter(Boolean),
  );
  const objectByKey = new Map(state.objects.map((entry) => [entry.key, entry]));
  const releaseArtifactKeys = new Set(state.releases.map((release) => release.artifact_blob_key));
  const releaseRetentionReasons = new Map<string, Set<ReleaseRetentionReason>>();
  const missingArtifactReleaseIds = new Set<string>();

  for (const release of state.releases) {
    const reasons = new Set<ReleaseRetentionReason>();
    const createdMs = toTimestampMs(release.created_at) ?? 0;

    if (release.release_id === activeReleaseId) {
      reasons.add('active');
    }

    if (inFlightReleaseIds.has(release.release_id)) {
      reasons.add('in-flight-job');
    }

    if (createdMs >= nowMs - RELEASE_MIN_RETENTION_MS) {
      reasons.add('recent');
    }

    if (!objectByKey.has(release.artifact_blob_key)) {
      reasons.add('integrity-missing-artifact');
      missingArtifactReleaseIds.add(release.release_id);
    }

    releaseRetentionReasons.set(release.release_id, reasons);
  }

  const newestInactive = sortByNewestCreated(
    state.releases.filter((release) => release.release_id !== activeReleaseId),
  ).slice(0, RETAIN_NEWEST_INACTIVE_RELEASE_COUNT);

  for (const release of newestInactive) {
    releaseRetentionReasons.get(release.release_id)?.add('newest-inactive');
  }

  const releases = sortByNewestCreated(state.releases).map<ManagedRuntimeLibrariesAuditReleaseEntry>((release) => {
    const retainReasons = Array.from(releaseRetentionReasons.get(release.release_id) ?? []).sort();
    return {
      releaseId: release.release_id,
      artifactBlobKey: release.artifact_blob_key,
      artifactSha256: release.artifact_sha256,
      createdAt: toIsoString(release.created_at) ?? new Date(0).toISOString(),
      artifactPresent: objectByKey.has(release.artifact_blob_key),
      referencedByInFlightJob: inFlightReleaseIds.has(release.release_id),
      retainReasons,
      pruneCandidate: retainReasons.length === 0,
    };
  });

  const jobStatusCounts = createEmptyJobStatusCounts();
  for (const job of state.jobs) {
    jobStatusCounts[job.status] += 1;
  }

  const jobs = sortByNewestCreated(state.jobs).map<ManagedRuntimeLibrariesAuditJobEntry>((job) => {
    const retainReasons: JobRetentionReason[] = [];
    if (inFlightStatuses.has(job.status)) {
      retainReasons.push('in-flight');
    } else {
      const cutoff = job.status === 'succeeded'
        ? nowMs - SUCCEEDED_JOB_RETENTION_MS
        : nowMs - FAILED_JOB_RETENTION_MS;
      const referenceMs = toTimestampMs(job.finished_at) ??
        toTimestampMs(job.progress_at) ??
        toTimestampMs(job.created_at) ??
        0;
      if (referenceMs >= cutoff) {
        retainReasons.push('within-retention');
      }
    }

    return {
      jobId: job.job_id,
      type: job.type,
      status: job.status,
      createdAt: toIsoString(job.created_at) ?? new Date(0).toISOString(),
      startedAt: toIsoString(job.started_at),
      finishedAt: toIsoString(job.finished_at),
      lastProgressAt: toIsoString(job.progress_at),
      releaseId: job.release_id,
      cancelRequestedAt: toIsoString(job.cancel_requested_at),
      retainReasons,
      pruneCandidate: retainReasons.length === 0,
    };
  });

  const objects = [...state.objects]
    .sort((left, right) => {
      const leftMs = toTimestampMs(left.lastModified) ?? 0;
      const rightMs = toTimestampMs(right.lastModified) ?? 0;
      return rightMs - leftMs;
    })
    .map<ManagedRuntimeLibrariesAuditObjectEntry>((entry) => {
      const orphaned = !releaseArtifactKeys.has(entry.key);
      const lastModifiedMs = toTimestampMs(entry.lastModified) ?? 0;
      return {
        key: entry.key,
        size: entry.size,
        lastModified: entry.lastModified,
        orphaned,
        pruneCandidate: orphaned && lastModifiedMs < nowMs - ORPHANED_ARTIFACT_MIN_RETENTION_MS,
      };
    });

  const prunePlan: ManagedRuntimeLibrariesPrunePlan = {
    retainedReleaseIds: releases.filter((release) => !release.pruneCandidate).map((release) => release.releaseId),
    pruneCandidateReleaseIds: releases.filter((release) => release.pruneCandidate).map((release) => release.releaseId),
    retainedJobIds: jobs.filter((job) => !job.pruneCandidate).map((job) => job.jobId),
    pruneCandidateJobIds: jobs.filter((job) => job.pruneCandidate).map((job) => job.jobId),
    pruneCandidateOrphanedArtifactKeys: objects
      .filter((entry) => entry.pruneCandidate)
      .map((entry) => entry.key),
  };

  return {
    generatedAt: now.toISOString(),
    activeReleaseId,
    totalReleaseCount: releases.length,
    totalJobCount: jobs.length,
    totalJobCountByStatus: jobStatusCounts,
    totalObjectCount: objects.length,
    totalObjectBytes: objects.reduce((sum, entry) => sum + entry.size, 0),
    releaseRowsMissingArtifacts: releases
      .filter((release) => !release.artifactPresent)
      .map((release) => ({
        releaseId: release.releaseId,
        artifactBlobKey: release.artifactBlobKey,
        createdAt: release.createdAt,
      })),
    orphanedArtifacts: objects.filter((entry) => entry.orphaned),
    releasesReferencedByInFlightJobs: Array.from(inFlightReleaseIds).sort(),
    releases,
    jobs,
    objects,
    prunePlan,
  };
}

async function queryCleanupState(pool: Pool): Promise<CleanupQueryState> {
  const [activation, releases, jobs] = await Promise.all([
    queryOne<RuntimeLibraryActivationRow>(
      pool,
      `
        SELECT activation.active_release_id AS release_id,
               release.packages_json,
               release.artifact_blob_key,
               release.artifact_sha256,
               release.created_at,
               activation.updated_at
        FROM runtime_library_activation AS activation
        LEFT JOIN runtime_library_releases AS release
          ON release.release_id = activation.active_release_id
        WHERE activation.slot = 'default'
      `,
    ),
    queryRows<RuntimeLibraryReleaseRow>(
      pool,
      `
        SELECT release_id, packages_json, artifact_blob_key, artifact_sha256, created_at
        FROM runtime_library_releases
      `,
    ),
    queryRows<RuntimeLibraryJobRow>(
      pool,
      `
        SELECT job_id, type, status, packages_json, error, claimed_by, created_at, started_at, finished_at, progress_at, cancel_requested_at, release_id
        FROM runtime_library_jobs
      `,
    ),
  ]);

  return {
    activeReleaseId: activation?.release_id ?? null,
    releases,
    jobs,
    objects: [],
  };
}

export async function auditManagedRuntimeLibrariesState(
  options: { now?: Date; config?: ManagedRuntimeLibrariesConfig } = {},
): Promise<ManagedRuntimeLibrariesAuditSnapshot> {
  const config = options.config ?? getManagedRuntimeLibrariesConfig();
  const pool = new Pool(getPoolConfig(config));

  try {
    await ensureManagedRuntimeLibrariesSchema(pool);
    const state = await queryCleanupState(pool);
    state.objects = await listRuntimeLibrariesBlobObjects(config);
    return buildManagedRuntimeLibrariesAuditSnapshotFromState(state, options.now);
  } finally {
    await pool.end();
  }
}

export async function pruneManagedRuntimeLibrariesState(options: {
  apply?: boolean;
  now?: Date;
  config?: ManagedRuntimeLibrariesConfig;
  driver?: ManagedRuntimeLibrariesPruneDriver;
} = {}): Promise<{
  before: ManagedRuntimeLibrariesAuditSnapshot;
  deletedReleaseCount: number;
  deletedJobCount: number;
  deletedObjectCount: number;
  after: ManagedRuntimeLibrariesAuditSnapshot;
}> {
  const driver = options.driver;
  const config = driver ? undefined : (options.config ?? getManagedRuntimeLibrariesConfig());
  const before = driver
    ? await driver.audit()
    : await auditManagedRuntimeLibrariesState({ now: options.now, config: config! });

  if (!options.apply) {
    return {
      before,
      deletedReleaseCount: 0,
      deletedJobCount: 0,
      deletedObjectCount: 0,
      after: before,
    };
  }

  const releaseIdsToDelete = before.prunePlan.pruneCandidateReleaseIds;
  const jobIdsToDelete = before.prunePlan.pruneCandidateJobIds;
  const objectKeysToDelete = Array.from(new Set([
    ...before.releases
      .filter((release) => release.pruneCandidate)
      .map((release) => release.artifactBlobKey),
    ...before.prunePlan.pruneCandidateOrphanedArtifactKeys,
  ]));

  const deletedJobCount = driver
    ? await driver.deleteJobs(jobIdsToDelete)
    : await deleteManagedRuntimeLibraryJobs(config!, jobIdsToDelete);
  const deletedReleaseCount = driver
    ? await driver.deleteReleases(releaseIdsToDelete)
    : await deleteManagedRuntimeLibraryReleases(config!, releaseIdsToDelete);
  const deletedObjectCount = driver
    ? await driver.deleteObjects(objectKeysToDelete)
    : await deleteRuntimeLibrariesBlobObjects(config!, objectKeysToDelete);
  const after = driver
    ? await driver.audit()
    : await auditManagedRuntimeLibrariesState({ now: options.now, config: config! });
  const retainedReleaseIdSet = new Set(before.prunePlan.retainedReleaseIds);
  const retainedMissingArtifacts = after.releaseRowsMissingArtifacts.filter((release) =>
    retainedReleaseIdSet.has(release.releaseId),
  );

  if (retainedMissingArtifacts.length > 0) {
    const releaseIds = retainedMissingArtifacts.map((entry) => entry.releaseId).join(', ');
    throw new Error(`Retained release rows still reference missing artifacts after prune: ${releaseIds}`);
  }

  return {
    before,
    deletedReleaseCount,
    deletedJobCount,
    deletedObjectCount,
    after,
  };
}

export const managedRuntimeLibrariesCleanupPolicy = {
  releaseMinRetentionMs: RELEASE_MIN_RETENTION_MS,
  orphanedArtifactMinRetentionMs: ORPHANED_ARTIFACT_MIN_RETENTION_MS,
  succeededJobRetentionMs: SUCCEEDED_JOB_RETENTION_MS,
  failedJobRetentionMs: FAILED_JOB_RETENTION_MS,
  retainNewestInactiveReleaseCount: RETAIN_NEWEST_INACTIVE_RELEASE_COUNT,
};

export { buildManagedRuntimeLibrariesAuditSnapshotFromState };

async function deleteManagedRuntimeLibraryJobs(
  config: ManagedRuntimeLibrariesConfig,
  jobIds: string[],
): Promise<number> {
  if (jobIds.length === 0) {
    return 0;
  }

  const pool = new Pool(getPoolConfig(config));

  try {
    await ensureManagedRuntimeLibrariesSchema(pool);
    const deletedJobs = await pool.query<{ job_id: string }>(
      `
        DELETE FROM runtime_library_jobs
        WHERE job_id = ANY($1::text[])
        RETURNING job_id
      `,
      [jobIds],
    );
    return deletedJobs.rowCount ?? deletedJobs.rows.length;
  } finally {
    await pool.end();
  }
}

async function deleteManagedRuntimeLibraryReleases(
  config: ManagedRuntimeLibrariesConfig,
  releaseIds: string[],
): Promise<number> {
  if (releaseIds.length === 0) {
    return 0;
  }

  const pool = new Pool(getPoolConfig(config));

  try {
    await ensureManagedRuntimeLibrariesSchema(pool);
    const deletedReleases = await pool.query<{ release_id: string }>(
      `
        DELETE FROM runtime_library_releases
        WHERE release_id = ANY($1::text[])
        RETURNING release_id
      `,
      [releaseIds],
    );
    return deletedReleases.rowCount ?? deletedReleases.rows.length;
  } finally {
    await pool.end();
  }
}
