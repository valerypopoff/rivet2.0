import fs from 'node:fs/promises';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import type { WorkflowProjectStats } from './types.js';
import { getWorkflowProjectStatsPath } from './fs-helpers.js';

const WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION = 2;

type WorkflowProjectStatsCache = {
  schemaVersion: typeof WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION;
  fileSize: number;
  fileMtimeMs: number;
  fileCtimeMs: number;
  stats: WorkflowProjectStats;
};

function emptyWorkflowProjectStats(): WorkflowProjectStats {
  return {
    graphCount: 0,
    totalNodeCount: 0,
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
    !Number.isFinite(raw.totalNodeCount)
  ) {
    return null;
  }

  return {
    graphCount: Math.max(0, Math.trunc(raw.graphCount)),
    totalNodeCount: Math.max(0, Math.trunc(raw.totalNodeCount)),
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
  };
}

export function getWorkflowProjectStatsFromContents(contents: string): WorkflowProjectStats {
  try {
    const project = loadProjectFromString(contents);
    const graphs = Object.values(project.graphs ?? {});

    return {
      graphCount: graphs.length,
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
    };
  } catch {
    return emptyWorkflowProjectStats();
  }
}

async function readWorkflowProjectStatsCache(
  filePath: string,
  fileStats: { size: number; mtimeMs: number; ctimeMs: number },
): Promise<WorkflowProjectStats | null> {
  try {
    const cacheContents = await fs.readFile(getWorkflowProjectStatsPath(filePath), 'utf8');
    const cache = normalizeStatsCache(JSON.parse(cacheContents));
    if (
      cache &&
      cache.fileSize === fileStats.size &&
      cache.fileMtimeMs === fileStats.mtimeMs &&
      cache.fileCtimeMs === fileStats.ctimeMs
    ) {
      return cache.stats;
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
  const stats = getWorkflowProjectStatsFromContents(contents);

  try {
    const resolvedFileStats = fileStats ?? await fs.stat(filePath);
    const cache: WorkflowProjectStatsCache = {
      schemaVersion: WORKFLOW_PROJECT_STATS_CACHE_SCHEMA_VERSION,
      fileSize: resolvedFileStats.size,
      fileMtimeMs: resolvedFileStats.mtimeMs,
      fileCtimeMs: resolvedFileStats.ctimeMs,
      stats,
    };

    await fs.writeFile(getWorkflowProjectStatsPath(filePath), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch {
  }

  return stats;
}

export async function getWorkflowProjectStatsFromFileCached(filePath: string): Promise<WorkflowProjectStats> {
  try {
    const fileStats = await fs.stat(filePath);
    const cachedStats = await readWorkflowProjectStatsCache(filePath, fileStats);
    if (cachedStats) {
      return cachedStats;
    }

    const contents = await fs.readFile(filePath, 'utf8');
    return writeWorkflowProjectStatsCacheFromContents(filePath, contents, fileStats);
  } catch {
    return emptyWorkflowProjectStats();
  }
}
