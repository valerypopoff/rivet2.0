import fs from 'node:fs/promises';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import type { WorkflowProjectStats } from './types.js';
import { getWorkflowProjectStatsPath } from './fs-helpers.js';

const WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION = 4;

export type WorkflowProjectIndexData = {
  stats: WorkflowProjectStats;
  projectMetadataId?: string;
};

type WorkflowProjectStatsCache = {
  schemaVersion: typeof WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION;
  fileSize: number;
  fileMtimeMs: number;
  fileCtimeMs: number;
  stats: WorkflowProjectStats;
  projectMetadataId: string | null;
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
    !(raw.projectMetadataId === null || typeof raw.projectMetadataId === 'string') ||
    !stats
  ) {
    return null;
  }

  return {
    schemaVersion: WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION,
    fileSize: Math.max(0, Math.trunc(raw.fileSize)),
    fileMtimeMs: raw.fileMtimeMs,
    fileCtimeMs: raw.fileCtimeMs,
    stats,
    projectMetadataId: raw.projectMetadataId,
  };
}

export function getWorkflowProjectIndexDataFromContents(contents: string): WorkflowProjectIndexData {
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
      ...(project.metadata.id ? { projectMetadataId: project.metadata.id } : {}),
    };
  } catch {
    return { stats: emptyWorkflowProjectStats() };
  }
}

export function getWorkflowProjectStatsFromContents(contents: string): WorkflowProjectStats {
  return getWorkflowProjectIndexDataFromContents(contents).stats;
}

async function writeWorkflowProjectIndexCache(
  filePath: string,
  indexData: WorkflowProjectIndexData,
  fileStats?: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<void> {
  try {
    const resolvedFileStats = fileStats ?? await fs.stat(filePath);
    const cache: WorkflowProjectStatsCache = {
      schemaVersion: WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION,
      fileSize: resolvedFileStats.size,
      fileMtimeMs: resolvedFileStats.mtimeMs,
      fileCtimeMs: resolvedFileStats.ctimeMs,
      stats: indexData.stats,
      projectMetadataId: indexData.projectMetadataId ?? null,
    };

    await fs.writeFile(getWorkflowProjectStatsPath(filePath), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {
  }
}

async function readWorkflowProjectIndexCache(
  filePath: string,
  fileStats: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<WorkflowProjectIndexData | null> {
  try {
    const cacheContents = await fs.readFile(getWorkflowProjectStatsPath(filePath), 'utf8');
    const cache = normalizeStatsCache(JSON.parse(cacheContents));
    if (
      cache &&
      cache.fileSize === fileStats.size &&
      cache.fileMtimeMs === fileStats.mtimeMs &&
      cache.fileCtimeMs === fileStats.ctimeMs
    ) {
      return {
        stats: cache.stats,
        ...(cache.projectMetadataId ? { projectMetadataId: cache.projectMetadataId } : {}),
      };
    }
  } catch {
  }

  return null;
}

export async function writeWorkflowProjectStatsCacheFromContents(
  filePath: string,
  contents: string,
  fileStats?: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<WorkflowProjectStats> {
  const indexData = getWorkflowProjectIndexDataFromContents(contents);
  await writeWorkflowProjectIndexCache(filePath, indexData, fileStats);
  return indexData.stats;
}

export async function getWorkflowProjectIndexDataFromFileCached(filePath: string): Promise<WorkflowProjectIndexData> {
  try {
    const fileStats = await fs.stat(filePath);
    const cachedIndexData = await readWorkflowProjectIndexCache(filePath, fileStats);
    if (cachedIndexData) {
      return cachedIndexData;
    }

    const contents = await fs.readFile(filePath, 'utf8');
    const indexData = getWorkflowProjectIndexDataFromContents(contents);
    await writeWorkflowProjectIndexCache(filePath, indexData, fileStats);
    return indexData;
  } catch {
    return { stats: emptyWorkflowProjectStats() };
  }
}

export async function getWorkflowProjectStatsFromFileCached(filePath: string): Promise<WorkflowProjectStats> {
  return (await getWorkflowProjectIndexDataFromFileCached(filePath)).stats;
}
