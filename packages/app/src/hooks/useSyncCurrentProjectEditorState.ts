import { useEffect } from 'react';
import { useAtomValue, useStore } from 'jotai';
import {
  checkpointProjectEditorStateForReload,
  projectEditorHydratedState,
  projectEditorStateByProjectIdState,
} from '../state/projectEditor.js';
import { projectsState, projectState } from '../state/savedGraphs.js';
import { flushHybridStorageGroup } from '../state/storage.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { getProjectWorkspaceLeavePolicy } from '../domain/workspace/projectWorkspaceTarget.js';
import { handleError } from '../utils/errorHandling.js';
import { useCurrentProjectEditorSnapshot } from './useCurrentProjectEditorSnapshot.js';
import { useStableCallback } from './useStableCallback.js';

export function useSyncCurrentProjectEditorState() {
  const hydrated = useAtomValue(projectEditorHydratedState);
  const store = useStore();
  const {
    canvasPosition,
    currentGraph,
    currentProject,
    graphNavigationStack,
    persistCurrentProjectEditorSnapshot,
  } = useCurrentProjectEditorSnapshot();

  const checkpointCurrentProjectEditorState = useStableCallback((event: PageTransitionEvent) => {
    // A document restored from bfcache keeps its live Jotai store. Leaving a
    // checkpoint in that case could later overwrite newer state unnecessarily.
    if (event.persisted) {
      return;
    }

    const activeProject = store.get(projectState);
    if (!hydrated || !store.get(projectsState).openedProjects[activeProject.metadata.id]) {
      return;
    }

    const activeWorkspaceTarget = store.get(projectWorkspaceTargetsState)[activeProject.metadata.id];
    const snapshot = getProjectWorkspaceLeavePolicy(activeWorkspaceTarget).persistGraphViewport
      ? persistCurrentProjectEditorSnapshot()
      : store.get(projectEditorStateByProjectIdState)[activeProject.metadata.id];
    if (!snapshot) {
      return;
    }

    checkpointProjectEditorStateForReload(activeProject.metadata.id, snapshot);
    void flushHybridStorageGroup('project').catch((error) => {
      handleError(error, 'Failed to persist the current project view before leaving the page', {
        toastError: false,
      });
    });
  });

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    persistCurrentProjectEditorSnapshot();
  }, [
    canvasPosition,
    currentGraph.metadata?.id,
    currentProject.metadata.id,
    graphNavigationStack,
    hydrated,
    persistCurrentProjectEditorSnapshot,
  ]);

  useEffect(() => {
    window.addEventListener('pagehide', checkpointCurrentProjectEditorState);

    return () => {
      window.removeEventListener('pagehide', checkpointCurrentProjectEditorState);
    };
  }, [checkpointCurrentProjectEditorState]);
}
