import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationProjectFileData } from '../../app/src/io/IOProvider.js';

type OpenedProjectSessionEntry = {
  fsPath: string | null;
  evaluation: EvaluationProjectFileData;
};

const openedProjectSessionCache = new Map<ProjectId, OpenedProjectSessionEntry>();

function cloneEvaluation(evaluation: EvaluationProjectFileData): EvaluationProjectFileData {
  if (typeof structuredClone === 'function') {
    return structuredClone(evaluation);
  }

  return {
    evaluationData: JSON.parse(JSON.stringify(evaluation.evaluationData)),
    evaluationDatasets: JSON.parse(JSON.stringify(evaluation.evaluationDatasets)),
  };
}

export function primeOpenedProjectSession(projectId: ProjectId, options: {
  fsPath?: string | null;
  evaluation: EvaluationProjectFileData;
}): void {
  openedProjectSessionCache.set(projectId, {
    fsPath: options.fsPath ?? null,
    evaluation: cloneEvaluation(options.evaluation),
  });
}

export function getOpenedProjectSession(projectId: ProjectId, fsPath?: string | null): EvaluationProjectFileData | null {
  const entry = openedProjectSessionCache.get(projectId);
  if (!entry) {
    return null;
  }

  const normalizedPath = fsPath ?? null;
  if (normalizedPath && entry.fsPath && entry.fsPath !== normalizedPath) {
    return null;
  }

  return cloneEvaluation(entry.evaluation);
}

export function clearOpenedProjectSession(projectId: ProjectId): void {
  openedProjectSessionCache.delete(projectId);
}

export function remapOpenedProjectSessionPaths(moves: Iterable<{
  fromAbsolutePath: string;
  toAbsolutePath: string;
}>): void {
  const moveMap = new Map<string, string>();

  for (const move of moves) {
    moveMap.set(move.fromAbsolutePath, move.toAbsolutePath);
  }

  if (moveMap.size === 0) {
    return;
  }

  for (const entry of openedProjectSessionCache.values()) {
    if (!entry.fsPath) {
      continue;
    }

    const nextPath = moveMap.get(entry.fsPath);
    if (nextPath) {
      entry.fsPath = nextPath;
    }
  }
}

export function syncOpenedProjectSessionIds(projectIds: Iterable<ProjectId>): void {
  const activeIds = new Set(projectIds);

  for (const projectId of openedProjectSessionCache.keys()) {
    if (!activeIds.has(projectId)) {
      openedProjectSessionCache.delete(projectId);
    }
  }
}
