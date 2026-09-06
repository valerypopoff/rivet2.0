import { useStore } from 'jotai';
import { toast } from 'react-toastify';
import { graphRunningState } from '../state/dataFlow.js';
import {
  activateLoadedRecordingState,
  canChangeLoadedRecordingForTab,
  clearLoadedRecordingForTabState,
  loadedRecordingState,
  recordingPlaybackStartingState,
} from '../state/execution.js';
import { loadedProjectState, projectState, projectsState } from '../state/savedGraphs.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../state/graph.js';
import { requireRecordingRootGraphId } from '../utils/recordingPlayback.js';
import { useLoadGraph } from './useLoadGraph.js';

export function useLoadRecording() {
  const ioProvider = useIOProvider();
  const store = useStore();
  const loadGraph = useLoadGraph();

  function canChangeRecording(
    action: 'loading' | 'unloading',
    owner: { projectId: string | undefined; projectPath: string | null | undefined },
  ) {
    const currentRecording = store.get(loadedRecordingState);
    if (!canChangeLoadedRecordingForTab(currentRecording, owner.projectId, owner.projectPath)) {
      toast.warn(`Switch back to the project that loaded this recording before ${action} a recording.`);
      return false;
    }

    if (!store.get(graphRunningState)) {
      if (!store.get(recordingPlaybackStartingState)) {
        return true;
      }

      toast.warn(`Wait for the current recording playback to start before ${action} a recording.`);
      return false;
    }

    toast.warn(`Stop the current execution before ${action} a recording.`);
    return false;
  }

  return {
    loadRecording: () => {
      // Capture ownership before the async file picker opens. The user can
      // change project tabs while it is open; the recording must still replay
      // only against the project from which they selected it.
      const project = store.get(projectState);
      const projectId = project.metadata.id;
      const projectPath = store.get(loadedProjectState).path;
      const ownerProjectWasOpen = projectId != null && store.get(projectsState).openedProjects[projectId] != null;
      if (!projectId) {
        toast.warn('Open a project before loading a recording.');
        return;
      }
      if (!canChangeRecording('loading', { projectId, projectPath })) {
        return;
      }

      ioProvider.loadRecordingData(({ recorder, path }) => {
        // A tab switch is safe: this project still owns the eventual replay.
        // A tab close is different: retaining a global selection for an
        // unavailable owner would block every remaining tab from changing it.
        // Non-workspace editor sessions have no opened-project record, so do
        // not treat their normal empty tab registry as a close.
        if (ownerProjectWasOpen && store.get(projectsState).openedProjects[projectId] == null) {
          toast.info('Recording selection was cancelled because its project was closed.');
          return;
        }

        if (!canChangeRecording('loading', { projectId, projectPath })) {
          return;
        }

        store.set(activateLoadedRecordingState, { recorder, path, projectId, projectPath });
      });
    },
    unloadRecording: () => {
      const project = store.get(projectState);
      if (!canChangeRecording('unloading', {
        projectId: project.metadata.id,
        projectPath: store.get(loadedProjectState).path,
      })) {
        return;
      }

      store.set(clearLoadedRecordingForTabState, {
        projectId: project.metadata.id,
        projectPath: store.get(loadedProjectState).path,
      });
    },
    /** Loads a recording already owned by a trusted Rivet run store. */
    loadSerializedRecording: (input: { serialized: string; path: string; projectId: ProjectId }): boolean => {
      const project = store.get(projectState);
      if (project.metadata.id !== input.projectId) {
        toast.warn('Switch to this evaluation project before opening its recording.');
        return false;
      }
      const projectPath = store.get(loadedProjectState).path;
      if (!canChangeRecording('loading', { projectId: input.projectId, projectPath })) return false;

      try {
        const recorder = ExecutionRecorder.deserializeFromString(input.serialized);
        const rootGraphId = requireRecordingRootGraphId(recorder.events);
        const rootGraph = project.graphs[rootGraphId];
        if (!rootGraph) {
          toast.error(`Could not open the evaluation recording: graph "${rootGraphId}" is no longer in the project.`);
          return false;
        }
        if (store.get(graphState).metadata?.id !== rootGraphId) loadGraph(rootGraph);
        store.set(activateLoadedRecordingState, {
          recorder,
          path: input.path,
          projectId: input.projectId,
          projectPath,
        });
        return true;
      } catch (error) {
        toast.error(`Could not open the evaluation recording: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}
