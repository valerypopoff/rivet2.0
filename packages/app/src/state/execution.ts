import { atom } from 'jotai';
import { type ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { loadedProjectState, projectState } from './savedGraphs.js';
import { getRecordingPresentation, type RecordingRunDetails } from '../utils/recordingPresentation.js';

/** Transient render tick for the runtime-owned executor/debugger session. */
export const executorSessionRevisionState = atom(0);

export type LoadedRecording = {
  path: string;
  recorder: ExecutionRecorder;
  summary?: RecordingRunDetails;
  /** The exact editor tab that selected this recording for playback. */
  projectId: ProjectId;
  projectPath: string | null;
};

export const loadedRecordingState = atom<LoadedRecording | null>(null);

/** Small, transient tab decorations; never retain a second copy of recording events. */
type RecordingTabIndicator = Pick<ReturnType<typeof getRecordingPresentation>, 'status' | 'color' | 'label'> &
  Pick<LoadedRecording, 'projectPath'>;
export const recordingTabIndicatorsState = atom<Record<string, RecordingTabIndicator>>({});

/**
 * True when a loaded recording belongs to this exact editor tab. Project IDs
 * usually distinguish tabs, but the current path is the authoritative tab
 * identity when an older replay artifact or a stale transition reuses an ID.
 */
export function isLoadedRecordingOwnedByTab(
  loadedRecording: LoadedRecording | null | undefined,
  projectId: string | undefined,
  projectPath: string | null | undefined,
): loadedRecording is LoadedRecording {
  return (
    projectId != null &&
    projectPath !== undefined &&
    loadedRecording?.projectId === projectId &&
    loadedRecording.projectPath === projectPath
  );
}

/**
 * A loaded recording is an editor-tab-local playback selection, not a global
 * execution mode. Keep another open tab's controls and canvas live while
 * preserving the recording when its owning tab is selected again.
 */
export function getLoadedRecordingForTab(
  loadedRecording: LoadedRecording | null | undefined,
  // Project metadata comes from the serialized project shape, where ids are
  // represented as strings. The recording itself keeps the stronger
  // ProjectId type, but ownership is an equality check at this UI boundary.
  projectId: string | undefined,
  projectPath: string | null | undefined,
): LoadedRecording | undefined {
  return isLoadedRecordingOwnedByTab(loadedRecording, projectId, projectPath) ? loadedRecording : undefined;
}

/** The recording mode visible to the current editor tab, if any. */
export const currentProjectLoadedRecordingState = atom((get) =>
  getLoadedRecordingForTab(get(loadedRecordingState), get(projectState).metadata.id, get(loadedProjectState).path),
);

/**
 * A detached hosted replay is already a snapshot before its recording activates,
 * and remains detached after unloading. Local files use snapshot presentation
 * only while their own tab has a recording loaded. Never use this as authority
 * to access a live project or infer bundle membership.
 */
export const isRecordingProjectState = atom(
  (get) =>
    !!get(currentProjectLoadedRecordingState) || get(loadedProjectState).path?.startsWith('recording://') === true,
);

/**
 * A playback invocation captures the exact loaded-recording object that started
 * it. Do not let a stale invocation clear the short "starting" flag after its
 * tab has closed or another project has selected a newer recording.
 */
export function isCurrentLoadedRecordingForTab(
  loadedRecording: LoadedRecording | null | undefined,
  expectedRecording: LoadedRecording | undefined,
  projectId: string | undefined,
): boolean {
  return (
    expectedRecording != null &&
    getLoadedRecordingForTab(loadedRecording, projectId, expectedRecording.projectPath) === expectedRecording
  );
}

/** A loaded recording can only be replaced or unloaded from its owning tab. */
export function canChangeLoadedRecordingForTab(
  loadedRecording: LoadedRecording | null | undefined,
  projectId: string | undefined,
  projectPath: string | null | undefined,
): boolean {
  return loadedRecording == null || getLoadedRecordingForTab(loadedRecording, projectId, projectPath) != null;
}

export const recordingPlaybackStartingState = atom(false);

/** Selects a recording for playback and clears any prior tab's start-in-progress flag. */
export const activateLoadedRecordingState = atom(null, (_get, set, loadedRecording: LoadedRecording) => {
  const { status, color, label } = getRecordingPresentation(loadedRecording);
  set(recordingTabIndicatorsState, (current) => ({
    ...current,
    [loadedRecording.projectId]: { projectPath: loadedRecording.projectPath, status, color, label },
  }));
  set(loadedRecordingState, loadedRecording);
  set(recordingPlaybackStartingState, false);
});

/** Keeps a manually loaded recording attached when its owning tab is moved or renamed. */
export const rebindLoadedRecordingPathState = atom(
  null,
  (get, set, move: { fromPath: string; toPath: string }): boolean => {
    set(recordingTabIndicatorsState, (current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, indicator]) => [
          id,
          indicator.projectPath === move.fromPath ? { ...indicator, projectPath: move.toPath } : indicator,
        ]),
      ),
    );
    const loadedRecording = get(loadedRecordingState);
    if (loadedRecording?.projectPath !== move.fromPath) {
      return false;
    }

    set(activateLoadedRecordingState, { ...loadedRecording, projectPath: move.toPath });
    return true;
  },
);

/**
 * Atomically releases a recording only for its owner. Closing a tab must not
 * leave a hidden, global recording selection behind that prevents other open
 * projects from loading or unloading their own recording.
 */
export const clearLoadedRecordingForTabState = atom(
  null,
  (get, set, owner: { projectId: string | undefined; projectPath: string | null | undefined }): boolean => {
    set(recordingTabIndicatorsState, (current) => {
      if (!owner.projectId || !current[owner.projectId] || current[owner.projectId]?.projectPath !== owner.projectPath)
        return current;
      const next = { ...current };
      delete next[owner.projectId];
      return next;
    });
    if (!isLoadedRecordingOwnedByTab(get(loadedRecordingState), owner.projectId, owner.projectPath)) {
      return false;
    }

    set(loadedRecordingState, null);
    set(recordingPlaybackStartingState, false);
    return true;
  },
);

/**
 * Releases a replay when the tab identified by its path is replaced. Hosted
 * bridge commands sometimes no longer have the original tab's project ID;
 * the virtual path remains its stable ownership key.
 */
export const clearLoadedRecordingForPathState = atom(
  null,
  (get, set, projectPath: string | null | undefined): boolean => {
    if (projectPath != null) {
      set(recordingTabIndicatorsState, (current) =>
        Object.fromEntries(Object.entries(current).filter(([, indicator]) => indicator.projectPath !== projectPath)),
      );
    }
    if (projectPath == null || get(loadedRecordingState)?.projectPath !== projectPath) {
      return false;
    }

    set(loadedRecordingState, null);
    set(recordingPlaybackStartingState, false);
    return true;
  },
);

export const lastRecordingState = atom<string | undefined>(undefined);
