import { type GraphId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { isEqual } from 'lodash-es';
import { graphState } from '../state/graph.js';
import { canvasPositionState, graphNavigationStackState } from '../state/graphBuilder.js';
import { openedProjectSnapshotsState, projectDataState, projectsState, projectState } from '../state/savedGraphs.js';
import { projectWorkspaceTargetsState } from '../state/workspaceTarget.js';
import { getProjectWorkspaceLeavePolicy } from '../domain/workspace/projectWorkspaceTarget.js';
import { projectEditorStateByProjectIdState, type ProjectEditorState } from '../state/projectEditor.js';
import { buildOpenedProjectSnapshot } from '../utils/openedProjectSnapshots.js';
import { buildCurrentProjectEditorStateSnapshot } from '../utils/projectEditorState.js';
import { useStableCallback } from './useStableCallback.js';

export function useCurrentProjectEditorSnapshot() {
  const currentProject = useAtomValue(projectState);
  const currentProjectData = useAtomValue(projectDataState);
  const currentGraph = useAtomValue(graphState);
  const canvasPosition = useAtomValue(canvasPositionState);
  const graphNavigationStack = useAtomValue(graphNavigationStackState);
  const setProjectEditorStateByProjectId = useSetAtom(projectEditorStateByProjectIdState);
  const setOpenedProjectSnapshots = useSetAtom(openedProjectSnapshotsState);
  const store = useStore();

  const buildSnapshot = useStableCallback((options: {
    project?: typeof currentProject;
    currentGraphId?: GraphId | undefined;
    existingProjectEditorState?: ProjectEditorState;
  } = {}) => {
    // A pointer event can update Jotai before React rerenders this hook. Snapshot
    // directly from the store so an immediate graph/resource switch never saves
    // the previous canvas transform.
    const snapshotProject = options.project ?? store.get(projectState);
    const snapshotGraph = store.get(graphState);

    return buildCurrentProjectEditorStateSnapshot({
      project: snapshotProject,
      currentGraphId: options.currentGraphId ?? snapshotGraph.metadata?.id,
      navigationStack: store.get(graphNavigationStackState),
      canvasPosition: store.get(canvasPositionState),
      existingProjectEditorState:
        options.existingProjectEditorState ?? store.get(projectEditorStateByProjectIdState)[snapshotProject.metadata.id],
    });
  });

  const persistSnapshot = useStableCallback((options: {
    project?: typeof currentProject;
    currentGraphId?: GraphId | undefined;
    existingProjectEditorState?: ProjectEditorState;
  } = {}) => {
    const snapshotProject = options.project ?? store.get(projectState);
    const snapshotProjectId = snapshotProject.metadata.id;
    // The last loaded project/graph survive closing the final tab. They do not
    // own the live canvas anymore, especially after an empty-workspace reload.
    if (
      !snapshotProjectId ||
      !store.get(projectsState).openedProjects[snapshotProjectId] ||
      !getProjectWorkspaceLeavePolicy(store.get(projectWorkspaceTargetsState)[snapshotProjectId]).persistGraphViewport
    ) {
      return undefined;
    }

    const nextProjectEditorState = buildSnapshot(options);

    setProjectEditorStateByProjectId((previousStateByProjectId) => {
      if (isEqual(previousStateByProjectId[snapshotProjectId], nextProjectEditorState)) {
        return previousStateByProjectId;
      }

      return {
        ...previousStateByProjectId,
        [snapshotProjectId]: nextProjectEditorState,
      };
    });

    return nextProjectEditorState;
  });

  const persistOpenedProjectSnapshot = useStableCallback((options: {
    project?: typeof currentProject;
    graph?: typeof currentGraph;
    data?: typeof currentProjectData;
  } = {}) => {
    const snapshotProject = options.project ?? store.get(projectState);
    if (!snapshotProject.metadata.id) {
      return;
    }

    const nextSnapshot = buildOpenedProjectSnapshot({
      project: snapshotProject,
      graph: options.graph ?? store.get(graphState),
      data: options.data ?? store.get(projectDataState),
    });

    setOpenedProjectSnapshots((previousSnapshots) => {
      if (isEqual(previousSnapshots[snapshotProject.metadata.id], nextSnapshot)) {
        return previousSnapshots;
      }

      return {
        ...previousSnapshots,
        [snapshotProject.metadata.id]: nextSnapshot,
      };
    });
  });

  return {
    canvasPosition,
    currentGraph,
    currentProject,
    graphNavigationStack,
    persistOpenedProjectSnapshot,
    buildCurrentProjectEditorSnapshot: buildSnapshot,
    persistCurrentProjectEditorSnapshot: persistSnapshot,
  };
}
