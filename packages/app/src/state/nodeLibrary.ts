import { atom } from 'jotai';
import { produce } from 'immer';
import type { GraphId, NodePrefab, NodePrefabId, NodeRegistration, ProjectId } from '@valerypopoff/rivet2-core';
import { graphState, isReadOnlyGraphState } from './graph.js';
import { projectState, referencedProjectsState } from './savedGraphs.js';
import { nodeEditorSessionRevisionState } from './graphBuilder.js';
import { projectWorkspaceTargetsState } from './workspaceTarget.js';
import {
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraph,
} from './recoverableNodeConnections.js';
import { reconcileNodePrefabInstanceConnectionsInGraph } from '../domain/nodeLibrary/nodePrefabConnectionRecovery.js';

/** One live, owner-checked transaction for sources and the graphs that link to them. */
export const updateNodeLibraryState = atom(
  null,
  (
    get,
    set,
    input: {
      projectId: ProjectId;
      revision: number;
      registry: NodeRegistration<any, any>;
      update(prefabs: Record<NodePrefabId, NodePrefab>): void | false;
    },
  ) => {
    const project = get(projectState);
    if (
      project.metadata.id !== input.projectId ||
      get(nodeEditorSessionRevisionState) !== input.revision ||
      get(projectWorkspaceTargetsState)[input.projectId]?.type !== 'nodeLibrary' ||
      get(isReadOnlyGraphState)
    )
      return false;

    let accepted = true;
    const baseProject = produce(project, (draft) => {
      draft.nodePrefabs ??= {};
      accepted = input.update(draft.nodePrefabs as Record<NodePrefabId, NodePrefab>) !== false;
      if (Object.keys(draft.nodePrefabs).length === 0) delete draft.nodePrefabs;
    });
    if (!accepted) return false;
    const referencedProjects = get(referencedProjectsState);
    const liveGraph = get(graphState);
    const liveGraphId = liveGraph.metadata?.id;
    let recoverable = get(recoverableNodeConnectionsStatePerGraph);
    const graphs = { ...baseProject.graphs };
    const reconcile = (graph: typeof liveGraph, graphId: GraphId | undefined) => {
      const result = reconcileNodePrefabInstanceConnectionsInGraph({
        graph,
        project: baseProject,
        projectNodeRegistry: input.registry,
        recoverableConnections: graphId ? recoverable[graphId] ?? {} : {},
        referencedProjects,
      });
      recoverable = setRecoverableNodeConnectionsForGraph(recoverable, graphId, result.recoverableConnections);
      return result.graph;
    };
    for (const [graphId, graph] of Object.entries(graphs)) {
      // The active graph is the live overlay, not the older project snapshot.
      if (graphId !== liveGraphId)
        graphs[graphId as GraphId] = reconcile(graph, (graph.metadata?.id ?? graphId) as GraphId);
    }
    const nextLiveGraph = reconcile(liveGraph, liveGraphId);
    if (liveGraphId && liveGraphId in graphs) graphs[liveGraphId] = nextLiveGraph;
    set(projectState, { ...baseProject, graphs });
    set(graphState, nextLiveGraph);
    set(recoverableNodeConnectionsStatePerGraph, recoverable);
    return true;
  },
);
