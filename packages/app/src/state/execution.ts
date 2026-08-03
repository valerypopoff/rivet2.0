import { atom } from 'jotai';
import { type ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';

/** Transient render tick for the runtime-owned executor/debugger session. */
export const executorSessionRevisionState = atom(0);

export type LoadedRecording = {
  path: string;
  recorder: ExecutionRecorder;
  /** The editor project that selected this recording for playback. */
  projectId: ProjectId;
};

export const loadedRecordingState = atom<LoadedRecording | null>(null);

/**
 * True when a loaded recording belongs to this exact editor project. Keep the
 * ownership check at the state boundary so close, load, unload, and playback
 * controls cannot drift into subtly different cross-tab behavior.
 */
export function isLoadedRecordingOwnedByProject(
  loadedRecording: LoadedRecording | null | undefined,
  projectId: string | undefined,
): loadedRecording is LoadedRecording {
  return projectId != null && loadedRecording?.projectId === projectId;
}

/**
 * A loaded recording is an editor-local playback selection, not a global
 * execution mode. Keep another open project's controls and canvas live while
 * preserving the recording when its owning project is selected again.
 */
export function getLoadedRecordingForProject(
  loadedRecording: LoadedRecording | null | undefined,
  // Project metadata comes from the serialized project shape, where ids are
  // represented as strings. The recording itself keeps the stronger
  // ProjectId type, but ownership is an equality check at this UI boundary.
  projectId: string | undefined,
): LoadedRecording | undefined {
  return isLoadedRecordingOwnedByProject(loadedRecording, projectId) ? loadedRecording : undefined;
}

/**
 * A playback invocation captures the exact loaded-recording object that started
 * it. Do not let a stale invocation clear the short "starting" flag after its
 * tab has closed or another project has selected a newer recording.
 */
export function isCurrentLoadedRecordingForProject(
  loadedRecording: LoadedRecording | null | undefined,
  expectedRecording: LoadedRecording | undefined,
  projectId: string | undefined,
): boolean {
  return expectedRecording != null && getLoadedRecordingForProject(loadedRecording, projectId) === expectedRecording;
}

/** A loaded recording can only be replaced or unloaded from its owning tab. */
export function canChangeLoadedRecordingForProject(
  loadedRecording: LoadedRecording | null | undefined,
  projectId: string | undefined,
): boolean {
  return loadedRecording == null || getLoadedRecordingForProject(loadedRecording, projectId) != null;
}

export const recordingPlaybackStartingState = atom(false);

/**
 * Atomically releases a recording only for its owner. Closing a tab must not
 * leave a hidden, global recording selection behind that prevents other open
 * projects from loading or unloading their own recording.
 */
export const clearLoadedRecordingForProjectState = atom(
  null,
  (get, set, projectId: string | undefined): boolean => {
    if (!isLoadedRecordingOwnedByProject(get(loadedRecordingState), projectId)) {
      return false;
    }

    set(loadedRecordingState, null);
    set(recordingPlaybackStartingState, false);
    return true;
  },
);

export const lastRecordingState = atom<string | undefined>(undefined);
