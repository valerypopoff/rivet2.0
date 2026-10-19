import type { createStore } from 'jotai';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import { createEmptyProjectExecutionSnapshot, type ProjectExecutionSnapshot } from '../state/dataFlow.js';
import { isCurrentLoadedRecordingForTab, loadedRecordingState, type LoadedRecording } from '../state/execution.js';
import { loadedProjectState, projectState, projectsState } from '../state/savedGraphs.js';
import { clearRemovedExecutionDataRefs } from '../utils/executionDataStorage.js';
import { getRecordingPlaybackGraphId } from '../utils/recordingPlayback.js';
import {
  captureProjectExecutionSnapshot,
  restoreProjectExecutionSnapshot,
} from './projectExecutionSnapshotBindings.js';
import { updateOpenProjectExecutionSnapshot } from './projectExecutionSnapshotRouting.js';

/** Child recordings have graphStart but no root start. Reset at acceptance, not from recorded events. */
export function resetRecordingPlaybackDisplay(
  store: ReturnType<typeof createStore>,
  recording: LoadedRecording,
  refStore: DataRefStore,
  ownerWasOpen: boolean,
): boolean {
  const { projectId, projectPath } = recording;
  if (!isCurrentLoadedRecordingForTab(store.get(loadedRecordingState), recording, projectId)) return false;
  const tab = store.get(projectsState).openedProjects[projectId];
  const active = store.get(projectState).metadata.id === projectId;
  // Check the current path too: the captured recording alone does not prove the
  // tab still exists. Standalone desktop sessions legitimately have no registry.
  if (tab ? (tab.fsPath ?? null) !== projectPath : ownerWasOpen || !active) return false;
  if (active && store.get(loadedProjectState).path !== projectPath) return false;

  let previous: ProjectExecutionSnapshot | undefined;
  let next: ProjectExecutionSnapshot | undefined;
  const reset = (before: ProjectExecutionSnapshot): ProjectExecutionSnapshot => {
    previous = before;
    next = {
      ...createEmptyProjectExecutionSnapshot(),
      frozenNodeOutputs: before.frozenNodeOutputs,
      runActivityJournal: before.runActivityJournal,
      graphRunning: true,
      graphStartTime: Date.now(),
      rootGraph: getRecordingPlaybackGraphId(recording.recorder.events),
    };
    return next;
  };
  if (tab) {
    updateOpenProjectExecutionSnapshot(store, projectId, reset);
  } else {
    const before = captureProjectExecutionSnapshot(store);
    restoreProjectExecutionSnapshot(store, reset(before), before);
  }
  // Install the display before releasing its obsolete references. This is a
  // synchronous boundary, never a React updater which could be evaluated twice.
  if (previous && next) clearRemovedExecutionDataRefs(refStore, previous.lastRunDataByNode, next.lastRunDataByNode);
  return next != null;
}
