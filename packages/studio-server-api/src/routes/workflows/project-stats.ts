import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import type { WorkflowProjectStats } from './types.js';
import { getWorkflowDatasetPath, getWorkflowProjectStatsPath } from './fs-helpers.js';

const WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION = 5;

export type WorkflowProjectIndexData = {
  stats: WorkflowProjectStats;
  projectMetadataId?: string;
  /** Opaque content version used for hosted filesystem save conflict checks. */
  revisionId: string;
};

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

function appendRevisionPart(hash: ReturnType<typeof createHash>, contents: string | null): void {
  if (contents == null) {
    hash.update('null\0');
    return;
  }

  const bytes = Buffer.from(contents, 'utf8');
  hash.update('text\0');
  hash.update(String(bytes.byteLength));
  hash.update('\0');
  hash.update(bytes);
}

/**
 * A filesystem project has no database revision row. Hash both persisted
 * payloads so an in-place save can still use the same optimistic-concurrency
 * contract as managed storage.
 */
export function getFilesystemProjectRevisionId(contents: string, datasetsContents: string | null): string {
  const hash = createHash('sha256');
  hash.update('rivet-filesystem-project-revision-v1\0');
  appendRevisionPart(hash, contents);
  appendRevisionPart(hash, datasetsContents);
  return `fs-sha256:${hash.digest('hex')}`;
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
    !(raw.datasetFileSize === null || (typeof raw.datasetFileSize === 'number' && Number.isFinite(raw.datasetFileSize))) ||
    !(raw.datasetFileMtimeMs === null || (typeof raw.datasetFileMtimeMs === 'number' && Number.isFinite(raw.datasetFileMtimeMs))) ||
    !(raw.datasetFileCtimeMs === null || (typeof raw.datasetFileCtimeMs === 'number' && Number.isFinite(raw.datasetFileCtimeMs))) ||
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

export function getWorkflowProjectIndexDataFromContents(
  contents: string,
  datasetsContents: string | null = null,
): WorkflowProjectIndexData {
  const revisionId = getFilesystemProjectRevisionId(contents, datasetsContents);
  try {
    const project = loadProjectFromString(contents);
    const graphs = Object.values(project.graphs ?? {});

    return {
      stats: {
        graphCount: graphs.length,
        webAppCount: Object.keys(project.uiGraphs ?? {}).length,
        totalNodeCount: graphs.reduce((count, graph) => {
          const nodes = graph.nodes as unknown;
          if (Array.isArray(nodes)) {
            return count + nodes.length;
          }

          if (nodes != null && typeof nodes === 'object') {
            return count + Object.keys(nodes).length;
          }

          return count;
        }, 0),
      },
      revisionId,
      ...(project.metadata.id ? { projectMetadataId: project.metadata.id } : {}),
    };
  } catch {
    return { stats: emptyWorkflowProjectStats(), revisionId };
  }
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
    const resolvedFileStats = fileStats ?? await fs.stat(filePath);
    const resolvedDatasetFileStats = datasetFileStats ?? await getDatasetFileStats(filePath);
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

    await fs.writeFile(getWorkflowProjectStatsPath(filePath), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {
  }
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
  } catch {
  }

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
