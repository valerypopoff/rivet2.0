import { useStore } from 'jotai';
import { toast } from 'react-toastify';
import { graphRunningState, projectExecutionSnapshotsState } from '../state/dataFlow.js';
import {
  activateLoadedRecordingState,
  canChangeLoadedRecordingForTab,
  canUnloadCurrentProjectRecordingState,
  clearLoadedRecordingForTabState,
  currentRecordingTabPathState,
  loadedRecordingState,
  pendingRecordingLoadState,
  recordingPlaybackStartingState,
} from '../state/execution.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { projectBindingRegistryState } from '../state/projectBindings.js';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { ExecutionRecorder, type ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from '../state/graph.js';
import { requireRecordingRootGraphId } from '../utils/recordingPlayback.js';
import { useLoadGraph } from './useLoadGraph.js';
import { handleError } from '../utils/errorHandling.js';

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

    const inactiveOwnerRunning =
      owner.projectId != null &&
      owner.projectId !== store.get(projectState).metadata.id &&
      store.get(projectExecutionSnapshotsState)[owner.projectId as ProjectId]?.graphRunning;
    if (!store.get(graphRunningState) && !inactiveOwnerRunning) {
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
    loadRecording: async () => {
      // Capture ownership before the async file picker opens. The user can
      // change project tabs while it is open; the recording must still replay
      // only against the project from which they selected it.
      const project = store.get(projectState);
      const projectId = project.metadata.id;
      const projectPath = store.get(currentRecordingTabPathState);
      if (!projectId) {
        toast.warn('Open a project before loading a recording.');
        return;
      }
      if (!canChangeRecording('loading', { projectId, projectPath })) {
        return;
      }

      const bindings = store.get(projectBindingRegistryState);
      const binding = bindings.get(projectId);
      const workspaceToken = bindings.getWorkspaceToken();
      const request = Symbol('recording-load');
      store.set(pendingRecordingLoadState, request);
      const isCurrent = () =>
        store.get(pendingRecordingLoadState) === request && bindings.getWorkspaceToken() === workspaceToken;
      const currentOwner = () => {
        if (!isCurrent()) return undefined;
        // Reading the tab registry reconciles its runtime binding first.
        const opened = store.get(projectsState).openedProjects[projectId];
        const currentBinding = bindings.get(projectId);
        if (binding) {
          return currentBinding?.token === binding.token
            ? { projectId, projectPath: currentBinding.path ?? null }
            : undefined;
        }
        return !opened &&
          store.get(projectState).metadata.id === projectId &&
          store.get(currentRecordingTabPathState) === projectPath
          ? { projectId, projectPath }
          : undefined;
      };

      try {
        await ioProvider.loadRecordingData(({ recorder, path }) => {
          const owner = currentOwner();
          if (!owner) {
            if (isCurrent())
              toast.info('Recording selection was cancelled because its project was closed or replaced.');
            return;
          }
          if (!canChangeRecording('loading', owner)) return;

          store.set(activateLoadedRecordingState, { recorder, path, ...owner });
        });
      } catch (error) {
        if (currentOwner()) handleError(error, 'Failed to load recording');
      } finally {
        if (store.get(pendingRecordingLoadState) === request) store.set(pendingRecordingLoadState, null);
      }
    },
    unloadRecording: () => {
      const project = store.get(projectState);
      if (
        !canChangeRecording('unloading', {
          projectId: project.metadata.id,
          projectPath: store.get(currentRecordingTabPathState),
        })
      ) {
        return;
      }

      store.set(pendingRecordingLoadState, null);
      if (!store.get(canUnloadCurrentProjectRecordingState)) return;

      store.set(clearLoadedRecordingForTabState, {
        projectId: project.metadata.id,
        projectPath: store.get(currentRecordingTabPathState),
      });
    },
    /** Loads a recording already owned by a trusted Rivet run store. */
    loadSerializedRecording: (input: { serialized: string; path: string; projectId: ProjectId }): boolean => {
      const project = store.get(projectState);
      if (project.metadata.id !== input.projectId) {
        toast.warn('Switch to this evaluation project before opening its recording.');
        return false;
      }
      const projectPath = store.get(currentRecordingTabPathState);
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
        toast.error(
          `Could not open the evaluation recording: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
  };
}
