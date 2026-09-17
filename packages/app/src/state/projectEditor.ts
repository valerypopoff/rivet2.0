import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { type GraphId, type ProjectId } from '@valerypopoff/rivet2-core';
import type { GraphNavigationStack } from '../domain/graphEditing/navigationActions.js';
import { createHybridStorage } from './storage.js';

const { storage } = createHybridStorage('project');
const PROJECT_EDITOR_RELOAD_CHECKPOINT_KEY = 'rivet-project-editor-reload-v1';

export type PersistedCanvasPosition = {
  x: number;
  y: number;
  zoom: number;
};

export type ProjectEditorState = {
  navigationStack: GraphNavigationStack;
  canvasPositionsByGraph: Record<GraphId, PersistedCanvasPosition | undefined>;
};

export type ProjectEditorStateByProjectId = Record<ProjectId, ProjectEditorState | undefined>;

export type ProjectEditorReloadCheckpoint = {
  projectId: ProjectId;
  state: ProjectEditorState;
};

function getReloadCheckpointStorage(): Storage | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    return window.top?.sessionStorage ?? window.sessionStorage;
  } catch {
    try {
      return window.sessionStorage;
    } catch {
      return undefined;
    }
  }
}

export function parseProjectEditorReloadCheckpoint(serializedCheckpoint: string | null | undefined): ProjectEditorReloadCheckpoint | undefined {
  if (!serializedCheckpoint) {
    return undefined;
  }

  try {
    const checkpoint = JSON.parse(serializedCheckpoint) as Partial<ProjectEditorReloadCheckpoint>;
    if (
      typeof checkpoint.projectId !== 'string' ||
      checkpoint.projectId.length === 0 ||
      typeof checkpoint.state !== 'object' ||
      checkpoint.state == null ||
      Array.isArray(checkpoint.state)
    ) {
      return undefined;
    }

    return checkpoint as ProjectEditorReloadCheckpoint;
  } catch {
    return undefined;
  }
}

export function mergeProjectEditorReloadCheckpoint(
  persistedState: ProjectEditorStateByProjectId,
  checkpoint: ProjectEditorReloadCheckpoint | undefined,
): ProjectEditorStateByProjectId {
  return checkpoint
    ? {
        ...persistedState,
        [checkpoint.projectId]: checkpoint.state,
      }
    : persistedState;
}

function consumeReloadCheckpoint(): ProjectEditorReloadCheckpoint | undefined {
  let serializedCheckpoint: string | null | undefined;
  try {
    const checkpointStorage = getReloadCheckpointStorage();
    serializedCheckpoint = checkpointStorage?.getItem(PROJECT_EDITOR_RELOAD_CHECKPOINT_KEY);
    checkpointStorage?.removeItem(PROJECT_EDITOR_RELOAD_CHECKPOINT_KEY);
  } catch {
    return undefined;
  }
  return parseProjectEditorReloadCheckpoint(serializedCheckpoint);
}

export function checkpointProjectEditorStateForReload(projectId: ProjectId, state: ProjectEditorState): void {
  try {
    getReloadCheckpointStorage()?.setItem(PROJECT_EDITOR_RELOAD_CHECKPOINT_KEY, JSON.stringify({ projectId, state }));
  } catch {
    // IndexedDB remains the canonical fallback if tab-scoped storage is unavailable.
  }
}

const projectEditorStorage = {
  ...storage,
  getItem(key: string, initialValue: ProjectEditorStateByProjectId): ProjectEditorStateByProjectId {
    return mergeProjectEditorReloadCheckpoint(storage.getItem(key, initialValue), consumeReloadCheckpoint());
  },
};

export const projectEditorStateByProjectIdState = atomWithStorage<ProjectEditorStateByProjectId>(
  'projectEditorStateByProjectId',
  {},
  projectEditorStorage,
);

export const projectEditorHydratedState = atom(false);
