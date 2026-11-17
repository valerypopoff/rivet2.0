import { atom } from 'jotai';
import type { GraphId, NodeId, ProjectId } from '@valerypopoff/rivet2-core';
import { graphState } from './atoms/graph.js';
import { projectState } from './savedGraphs.js';
import { projectBindingRegistryState } from './projectBindings.js';

export type FullscreenOutputSelection = Readonly<{
  projectId: ProjectId;
  graphId: GraphId;
  nodeId: NodeId;
  bindingToken?: number;
}>;

// Presentation only: output bytes and process selection stay in execution snapshots.
const selectionsState = atom<Record<ProjectId, FullscreenOutputSelection | undefined>>({});

export const fullscreenOutputSelectionState = atom((get) => {
  const projectId = get(projectState).metadata.id;
  const selections = get(selectionsState);
  return (Object.hasOwn(selections, projectId) ? selections[projectId] : undefined) ?? null;
});

export const clearProjectFullscreenOutputState = atom(null, (get, set, projectId: ProjectId) => {
  const selections = get(selectionsState);
  if (!Object.hasOwn(selections, projectId)) return false;
  const next = { ...selections };
  delete next[projectId];
  set(selectionsState, next);
  return true;
});

/** Recheck the live graph: Undo or a tab switch may have overtaken a missing-node effect. */
export const clearInvalidFullscreenOutputSelectionState = atom(
  null,
  (get, set, selection: FullscreenOutputSelection) => {
    if (get(fullscreenOutputSelectionState) !== selection) return false;
    const graph = get(graphState);
    if (graph.metadata?.id === selection.graphId && graph.nodes.some((node) => node.id === selection.nodeId))
      return false;
    return set(clearProjectFullscreenOutputState, selection.projectId);
  },
);

/** User dismissal is valid only for the modal that is still on screen. */
export const closeFullscreenOutputSelectionState = atom(null, (get, set, selection: FullscreenOutputSelection) => {
  if (get(fullscreenOutputSelectionState) !== selection || get(graphState).metadata?.id !== selection.graphId)
    return false;
  return set(clearProjectFullscreenOutputState, selection.projectId);
});

/** Called at a committed activation/replacement, never on an attempted load. */
export const reconcileProjectFullscreenOutputState = atom(
  null,
  (get, set, target: { projectId: ProjectId; graphId?: GraphId; replace?: boolean }) => {
    const selections = get(selectionsState);
    const selection = Object.hasOwn(selections, target.projectId) ? selections[target.projectId] : undefined;
    if (selection && (target.replace || selection.graphId !== target.graphId)) {
      set(clearProjectFullscreenOutputState, target.projectId);
    }
  },
);

/** Compatibility facade for existing expansion, canvas and Undo/Redo callers. */
export const fullscreenOutputNodeState = atom(
  (get) => {
    const selection = get(fullscreenOutputSelectionState);
    return selection && selection.graphId === get(graphState).metadata?.id ? selection.nodeId : null;
  },
  (get, set, update: NodeId | null | ((previous: NodeId | null) => NodeId | null)) => {
    const nodeId = typeof update === 'function' ? update(get(fullscreenOutputNodeState)) : update;
    const projectId = get(projectState).metadata.id;
    if (nodeId == null) {
      set(clearProjectFullscreenOutputState, projectId);
      return;
    }
    const graphId = get(graphState).metadata?.id;
    if (!graphId) return;
    const bindingToken = get(projectBindingRegistryState).get(projectId)?.token;
    const current = get(fullscreenOutputSelectionState);
    if (current?.graphId === graphId && current.nodeId === nodeId && current.bindingToken === bindingToken) return;
    set(selectionsState, {
      ...get(selectionsState),
      [projectId]: { projectId, graphId, nodeId, bindingToken },
    });
  },
);
