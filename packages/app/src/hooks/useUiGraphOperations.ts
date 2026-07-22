import { produce } from 'immer';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  createDefaultUiGraph,
  getGraphBoundary,
  initializeUiGraphRunGraphActionBindings,
  newId,
  type UiComponentId,
  type Project,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { projectState, savedGraphsState } from '../state/savedGraphs.js';
import { removeProjectWorkspaceTargetState } from '../state/workspaceTarget.js';
import { useLoadGraph } from './useLoadGraph.js';
import { useOpenUiGraph } from './useOpenUiGraph.js';
import { useProjectWorkspaceTarget } from './useProjectWorkspaceTarget.js';
import { useStableCallback } from './useStableCallback.js';
import { clearUiGraphPreviewSession } from '../components/rivetWebApps/uiGraphPreviewSession.js';

export function useUiGraphOperations() {
  const project = useAtomValue(projectState);
  const savedGraphs = useAtomValue(savedGraphsState);
  const workspaceTarget = useProjectWorkspaceTarget();
  const setProject = useSetAtom(projectState);
  const clearWorkspaceTarget = useSetAtom(removeProjectWorkspaceTargetState);
  const loadGraph = useLoadGraph();
  const openUiGraph = useOpenUiGraph();

  const createUiGraph = useStableCallback(() => {
    const boundary = getGraphBoundary(project, project.metadata.mainGraphId);
    const uiGraph = createDefaultUiGraph({ graphId: boundary ? project.metadata.mainGraphId : undefined });
    const button = uiGraph.components.find((component) => component.type === 'button');
    if (button?.type === 'button' && boundary) {
      button.action = initializeUiGraphRunGraphActionBindings(button.action, boundary);
    }
    setProject((currentProject) => addUiGraph(currentProject, uiGraph));
    openUiGraph(uiGraph.id);
  });

  const duplicateUiGraph = useStableCallback((uiGraph: UiGraph) => {
    const duplicate = cloneUiGraph(uiGraph);
    setProject((currentProject) => addUiGraph(currentProject, duplicate));
    openUiGraph(duplicate.id);
  });

  const deleteUiGraph = useStableCallback((uiGraphId: UiGraphId) => {
    clearUiGraphPreviewSession(project.metadata.id, uiGraphId);
    setProject((currentProject) =>
      produce(currentProject, (draft) => {
        delete draft.uiGraphs?.[uiGraphId];
        if (draft.uiGraphs && Object.keys(draft.uiGraphs).length === 0) {
          delete draft.uiGraphs;
        }
      }),
    );

    if (workspaceTarget?.type !== 'uiGraph' || workspaceTarget.uiGraphId !== uiGraphId) {
      return;
    }

    const fallbackGraph =
      savedGraphs.find((graph) => graph.metadata?.id === project.metadata.mainGraphId) ?? savedGraphs[0];
    if (fallbackGraph) {
      loadGraph(fallbackGraph);
    } else {
      clearWorkspaceTarget(project.metadata.id);
    }
  });

  return { createUiGraph, deleteUiGraph, duplicateUiGraph, openUiGraph };
}

function addUiGraph(project: Omit<Project, 'data'>, uiGraph: UiGraph) {
  return produce(project, (draft) => {
    draft.uiGraphs ??= {};
    draft.uiGraphs[uiGraph.id] = uiGraph;
  });
}

function cloneUiGraph(uiGraph: UiGraph): UiGraph {
  const duplicate = structuredClone(uiGraph);
  duplicate.id = newId<UiGraphId>();
  duplicate.name = `${uiGraph.name} (Copy)`;
  duplicate.components = duplicate.components.map((component) => ({
    ...component,
    id: newId<UiComponentId>(),
  }));
  return duplicate;
}
