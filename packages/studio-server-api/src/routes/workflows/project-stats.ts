import fs from 'node:fs/promises';
import { assertLocalMetadataWritesAllowed } from '../../local-metadata/write-admission.js';
import { isVmMigrationMaintenanceActive } from '../../vm-migration-maintenance.js';

import type { WorkflowProjectStats } from './types.js';
import { getWorkflowDatasetPath, getWorkflowProjectStatsPath } from './fs-helpers.js';
import {
  getFilesystemProjectRevisionId,
  getWorkflowProjectIndexDataFromContents,
  type WorkflowProjectIndexData,
} from './project-index.js';
export {
  getFilesystemProjectRevisionId,
  getWorkflowProjectIndexDataFromContents,
  type WorkflowProjectIndexData,
} from './project-index.js';

const WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION = 5;

type WorkflowProjectStatsCache = {
  schemaVersion: typeof WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION;
  fileSize: number;
  fileMtimeMs: number;
  fileCtimeMs: number;
  datasetFileSize: number | null;
  datasetFileMtimeMs: number | null;
  datasetFileCtimeMs: number | null;
  stats: WorkflowProjectStats;
  projectMetadataId: string | null;
  revisionId: string;
};

type FileStats = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function emptyWorkflowProjectStats(): WorkflowProjectStats {
  return {
    graphCount: 0,
    totalNodeCount: 0,
    webAppCount: 0,
  };
}

function normalizeStats(value: unknown): WorkflowProjectStats | null {
  if (typeof value !== 'object' || value == null) {
    return null;
  }

  const raw = value as Partial<Record<keyof WorkflowProjectStats, unknown>>;
  if (
    typeof raw.graphCount !== 'number' ||
    !Number.isFinite(raw.graphCount) ||
    typeof raw.totalNodeCount !== 'number' ||
    !Number.isFinite(raw.totalNodeCount) ||
    typeof raw.webAppCount !== 'number' ||
    !Number.isFinite(raw.webAppCount)
  ) {
    return null;
  }

  return {
    graphCount: Math.max(0, Math.trunc(raw.graphCount)),
    totalNodeCount: Math.max(0, Math.trunc(raw.totalNodeCount)),
    webAppCount: Math.max(0, Math.trunc(raw.webAppCount)),
  };
}

function normalizeStatsCache(value: unknown): WorkflowProjectStatsCache | null {
  if (typeof value !== 'object' || value == null) {
    return null;
  }

  const raw = value as Partial<Record<keyof WorkflowProjectStatsCache, unknown>>;
  const stats = normalizeStats(raw.stats);
  if (
    raw.schemaVersion !== WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION ||
    typeof raw.fileSize !== 'number' ||
    !Number.isFinite(raw.fileSize) ||
    typeof raw.fileMtimeMs !== 'number' ||
    !Number.isFinite(raw.fileMtimeMs) ||
    typeof raw.fileCtimeMs !== 'number' ||
    !Number.isFinite(raw.fileCtimeMs) ||
    !(
      raw.datasetFileSize === null ||
      (typeof raw.datasetFileSize === 'number' && Number.isFinite(raw.datasetFileSize))
    ) ||
    !(
      raw.datasetFileMtimeMs === null ||
      (typeof raw.datasetFileMtimeMs === 'number' && Number.isFinite(raw.datasetFileMtimeMs))
    ) ||
    !(
      raw.datasetFileCtimeMs === null ||
      (typeof raw.datasetFileCtimeMs === 'number' && Number.isFinite(raw.datasetFileCtimeMs))
    ) ||
    !(raw.projectMetadataId === null || typeof raw.projectMetadataId === 'string') ||
    typeof raw.revisionId !== 'string' ||
    !/^fs-sha256:[a-f0-9]{64}$/.test(raw.revisionId) ||
    !stats
  ) {
    return null;
  }

  return {
    schemaVersion: WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION,
    fileSize: Math.max(0, Math.trunc(raw.fileSize)),
    fileMtimeMs: raw.fileMtimeMs,
    fileCtimeMs: raw.fileCtimeMs,
    datasetFileSize: raw.datasetFileSize == null ? null : Math.max(0, Math.trunc(raw.datasetFileSize)),
    datasetFileMtimeMs: raw.datasetFileMtimeMs,
    datasetFileCtimeMs: raw.datasetFileCtimeMs,
    stats,
    projectMetadataId: raw.projectMetadataId,
    revisionId: raw.revisionId,
  };
}

export function getWorkflowProjectStatsFromContents(contents: string): WorkflowProjectStats {
  return getWorkflowProjectIndexDataFromContents(contents).stats;
}

async function writeWorkflowProjectIndexCache(
  filePath: string,
  indexData: WorkflowProjectIndexData,
  fileStats?: FileStats,
  datasetFileStats?: FileStats | null,
): Promise<void> {
  try {
    const resolvedFileStats = fileStats ?? (await fs.stat(filePath));
    const resolvedDatasetFileStats = datasetFileStats ?? (await getDatasetFileStats(filePath));
    const cache: WorkflowProjectStatsCache = {
      schemaVersion: WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION,
      fileSize: resolvedFileStats.size,
      fileMtimeMs: resolvedFileStats.mtimeMs,
      fileCtimeMs: resolvedFileStats.ctimeMs,
      datasetFileSize: resolvedDatasetFileStats?.size ?? null,
      datasetFileMtimeMs: resolvedDatasetFileStats?.mtimeMs ?? null,
      datasetFileCtimeMs: resolvedDatasetFileStats?.ctimeMs ?? null,
      stats: indexData.stats,
      projectMetadataId: indexData.projectMetadataId ?? null,
      revisionId: indexData.revisionId,
    };

    // Tree browsing and validation during migration must not populate a cache
    // inside the frozen source. Cache persistence is optional, never authority.
    if (isVmMigrationMaintenanceActive()) return;
    assertLocalMetadataWritesAllowed();
    await fs.writeFile(getWorkflowProjectStatsPath(filePath), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {}
}

async function readWorkflowProjectIndexCache(
  filePath: string,
  fileStats: FileStats,
  datasetFileStats: FileStats | null,
): Promise<WorkflowProjectIndexData | null> {
  try {
    const cacheContents = await fs.readFile(getWorkflowProjectStatsPath(filePath), 'utf8');
    const cache = normalizeStatsCache(JSON.parse(cacheContents));
    if (
      cache &&
      cache.fileSize === fileStats.size &&
      cache.fileMtimeMs === fileStats.mtimeMs &&
      cache.fileCtimeMs === fileStats.ctimeMs &&
      cache.datasetFileSize === (datasetFileStats?.size ?? null) &&
      cache.datasetFileMtimeMs === (datasetFileStats?.mtimeMs ?? null) &&
      cache.datasetFileCtimeMs === (datasetFileStats?.ctimeMs ?? null)
    ) {
      return {
        stats: cache.stats,
        revisionId: cache.revisionId,
        ...(cache.projectMetadataId ? { projectMetadataId: cache.projectMetadataId } : {}),
      };
    }
  } catch {}

  return null;
}

async function getDatasetFileStats(filePath: string): Promise<FileStats | null> {
  try {
    return await fs.stat(getWorkflowDatasetPath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readDatasetContents(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(getWorkflowDatasetPath(filePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeWorkflowProjectStatsCacheFromContents(
  filePath: string,
  contents: string,
  datasetsContents: string | null = null,
  fileStats?: FileStats,
): Promise<WorkflowProjectStats> {
  const indexData = getWorkflowProjectIndexDataFromContents(contents, datasetsContents);
  await writeWorkflowProjectIndexCache(filePath, indexData, fileStats);
  return indexData.stats;
}

export async function getWorkflowProjectIndexDataFromFileCached(filePath: string): Promise<WorkflowProjectIndexData> {
  try {
    const fileStats = await fs.stat(filePath);
    const datasetFileStats = await getDatasetFileStats(filePath);
    const cachedIndexData = await readWorkflowProjectIndexCache(filePath, fileStats, datasetFileStats);
    if (cachedIndexData) {
      return cachedIndexData;
    }

    const contents = await fs.readFile(filePath, 'utf8');
    const datasetsContents = await readDatasetContents(filePath);
    const indexData = getWorkflowProjectIndexDataFromContents(contents, datasetsContents);
    await writeWorkflowProjectIndexCache(filePath, indexData, fileStats, datasetFileStats);
    return indexData;
  } catch {
    return {
      stats: emptyWorkflowProjectStats(),
      revisionId: getFilesystemProjectRevisionId('', null),
    };
  }
}

export async function getWorkflowProjectStatsFromFileCached(filePath: string): Promise<WorkflowProjectStats> {
  return (await getWorkflowProjectIndexDataFromFileCached(filePath)).stats;
}
