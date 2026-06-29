import { type FC, useEffect, useMemo, useRef } from 'react';
import styled from '@emotion/styled';
import { produce } from 'immer';
import { toast } from 'react-toastify';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  type ChartNode,
  type DataId,
  type GraphId,
  type NodeId,
  type NodePrefab,
  type NodePrefabId,
} from '@valerypopoff/rivet2-core';
import { NodeCanvas } from './NodeCanvas.js';
import { NodeEditor, type NodeChanged } from './NodeEditor.js';
import { EditNodeCommandOverrideContext, type EditNodeCommand } from '../commands/editNodeCommand.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useCanvasPositioning } from '../hooks/useCanvasPositioning.js';
import { getCanvasPositionForNodes } from '../hooks/useCenterViewOnGraph.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry.js';
import { graphState } from '../state/graph.js';
import { canvasPositionState, lastMousePositionState, selectedNodesState, sidebarOpenState } from '../state/graphBuilder.js';
import { editingNodePrefabIdState } from '../state/nodeLibrary.js';
import { projectState, referencedProjectsState } from '../state/savedGraphs.js';
import { settingsState, resolveEditorPreferences } from '../state/settings.js';
import { createAddedNode, duplicateNodesWithConnections } from '../domain/graphEditing/nodeActions.js';
import {
  buildNodePrefab,
  canUseNodeAsPrefabSource,
  getNodePrefabUsage,
  getNodePrefabUsageLabel,
} from '../domain/nodeLibrary/nodePrefabs.js';
import { createPastedNodeLibraryPrefabs } from '../domain/nodeLibrary/nodePrefabClipboard.js';
import { isNotNull } from '../utils/genericUtilFunctions.js';
import { handleError } from '../utils/errorHandling.js';
import { useSetStaticData } from '../hooks/useSetStaticData.js';
import type { ContextMenuContext } from './ContextMenu.js';
import {
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraph,
} from '../state/recoverableNodeConnections.js';
import { reconcileNodePrefabInstanceConnectionsInGraph } from '../domain/nodeLibrary/nodePrefabConnectionRecovery.js';
import { clipboardState } from '../state/clipboard.js';

const Container = styled.div`
  position: relative;

  .node-library-empty {
    position: absolute;
    top: calc(var(--project-selector-height) + 28px);
    left: 50%;
    z-index: 10;
    max-width: 420px;
    padding: 12px 16px;
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    background: var(--modal-surface-bg);
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    line-height: 1.35;
    pointer-events: none;
    transform: translateX(-50%);
  }
`;

function getPrefabSourceId(prefab: NodePrefab): NodeId {
  return prefab.sourceNode.id;
}

export const NodeLibraryBuilder: FC = () => {
  const store = useStore();
  const [project, setProject] = useAtom(projectState);
  const [currentGraph, setCurrentGraph] = useAtom(graphState);
  const referencedProjects = useAtomValue(referencedProjectsState);
  const [selectedNodeIds, setSelectedNodeIds] = useAtom(selectedNodesState);
  const [editingPrefabId, setEditingPrefabId] = useAtom(editingNodePrefabIdState);
  const settings = useAtomValue(settingsState);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const clipboard = useAtomValue(clipboardState);
  const lastMousePosition = useAtomValue(lastMousePositionState);
  const setCanvasPosition = useSetAtom(canvasPositionState);
  const setStaticData = useSetStaticData();
  const projectNodeRegistry = useProjectNodeRegistry();
  const { clientToCanvasPosition } = useCanvasPositioning();
  const editorPreferences = resolveEditorPreferences(settings);
  const centeredOnOpenRef = useRef(false);
  const centeredEditingPrefabIdRef = useRef<NodePrefabId | undefined>(undefined);

  const prefabs = useMemo(() => Object.values(project.nodePrefabs ?? {}), [project.nodePrefabs]);
  const nodes = useMemo(() => prefabs.map((prefab) => prefab.sourceNode), [prefabs]);
  const prefabsBySourceNodeId = useMemo(
    () => new Map(prefabs.map((prefab) => [getPrefabSourceId(prefab), prefab])),
    [prefabs],
  );
  const selectedNodes = useMemo(
    () => selectedNodeIds.map((nodeId) => prefabsBySourceNodeId.get(nodeId)?.sourceNode).filter(isNotNull),
    [prefabsBySourceNodeId, selectedNodeIds],
  );
  const editingPrefab = editingPrefabId ? project.nodePrefabs?.[editingPrefabId] : undefined;

  useEffect(() => {
    if (!centeredOnOpenRef.current) {
      centeredOnOpenRef.current = true;
      centeredEditingPrefabIdRef.current = editingPrefabId;
      setCanvasPosition(getCanvasPositionForNodes(editingPrefab ? [editingPrefab.sourceNode] : nodes, sidebarOpen));
      return;
    }

    if (!editingPrefab || centeredEditingPrefabIdRef.current === editingPrefabId) {
      return;
    }

    centeredEditingPrefabIdRef.current = editingPrefabId;
    setCanvasPosition(getCanvasPositionForNodes([editingPrefab.sourceNode], sidebarOpen));
  }, [editingPrefab, editingPrefabId, nodes, setCanvasPosition, sidebarOpen]);

  const updateProjectNodePrefabs = useStableCallback((update: (prefabs: Record<NodePrefabId, NodePrefab>) => void) => {
    const baseProject = produce(project, (draft) => {
      draft.nodePrefabs ??= {};
      update(draft.nodePrefabs as Record<NodePrefabId, NodePrefab>);
      if (Object.keys(draft.nodePrefabs).length === 0) {
        delete draft.nodePrefabs;
      }
    });
    let nextRecoverableConnectionsByGraph = store.get(recoverableNodeConnectionsStatePerGraph);
    const nextGraphs = { ...baseProject.graphs };

    for (const [graphId, graph] of Object.entries(baseProject.graphs)) {
      const graphMetadataId = (graph.metadata?.id ?? graphId) as GraphId;
      const result = reconcileNodePrefabInstanceConnectionsInGraph({
        graph,
        project: baseProject,
        projectNodeRegistry,
        recoverableConnections: nextRecoverableConnectionsByGraph[graphMetadataId] ?? {},
        referencedProjects,
      });

      nextGraphs[graphId as GraphId] = result.graph;
      nextRecoverableConnectionsByGraph = setRecoverableNodeConnectionsForGraph(
        nextRecoverableConnectionsByGraph,
        graphMetadataId,
        result.recoverableConnections,
      );
    }

    const nextProject = {
      ...baseProject,
      graphs: nextGraphs,
    };
    const liveGraph = store.get(graphState);
    const liveGraphId = liveGraph.metadata?.id;
    const liveGraphResult = reconcileNodePrefabInstanceConnectionsInGraph({
      graph: liveGraph,
      project: nextProject,
      projectNodeRegistry,
      recoverableConnections: liveGraphId ? nextRecoverableConnectionsByGraph[liveGraphId] ?? {} : {},
      referencedProjects,
    });

    nextRecoverableConnectionsByGraph = setRecoverableNodeConnectionsForGraph(
      nextRecoverableConnectionsByGraph,
      liveGraphId,
      liveGraphResult.recoverableConnections,
    );

    const finalProject =
      liveGraphId && liveGraphId in nextProject.graphs
        ? {
            ...nextProject,
            graphs: {
              ...nextProject.graphs,
              [liveGraphId]: liveGraphResult.graph,
            },
          }
        : nextProject;

    setProject(finalProject);
    setCurrentGraph(liveGraphResult.graph);
    store.set(recoverableNodeConnectionsStatePerGraph, nextRecoverableConnectionsByGraph);
  });

  const updatePrefabSource = useStableCallback((prefabId: NodePrefabId, nextNode: ChartNode, newData?: Record<DataId, string>) => {
    if (!canUseNodeAsPrefabSource(nextNode)) {
      handleError(new Error(`"${nextNode.type}" cannot be a library node.`), 'Node library update failed');
      return;
    }

    updateProjectNodePrefabs((draftPrefabs) => {
      const prefab = draftPrefabs[prefabId];
      if (prefab) {
        prefab.sourceNode = nextNode;
      }
    });

    if (newData) {
      setStaticData(newData);
    }
  });

  const handleNodesChanged = useStableCallback((nextNodes: ChartNode[]) => {
    updateProjectNodePrefabs((draftPrefabs) => {
      for (const nextNode of nextNodes) {
        const prefab = prefabsBySourceNodeId.get(nextNode.id);
        if (prefab && draftPrefabs[prefab.id]) {
          draftPrefabs[prefab.id]!.sourceNode = nextNode;
        } else if (canUseNodeAsPrefabSource(nextNode)) {
          const nextPrefab = buildNodePrefab(nextNode);
          draftPrefabs[nextPrefab.id] = nextPrefab;
        }
      }
    });
  });

  const handleNodeSelected = useStableCallback((node: ChartNode, multi: boolean) => {
    setSelectedNodeIds((current) => {
      if (!multi) {
        return [node.id];
      }

      return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
    });
  });

  const addPrefabSource = useStableCallback((nodeType: string, position: { x: number; y: number }) => {
    const newNode = createAddedNode({
      nodeType,
      position,
      registry: projectNodeRegistry,
      project,
      referencedProjects,
      applyDefaultColor: editorPreferences.applyDefaultNodeColors,
    });

    if (!canUseNodeAsPrefabSource(newNode)) {
      toast.warn('This node type cannot be a library node.');
      return;
    }

    const prefab = buildNodePrefab(newNode);
    updateProjectNodePrefabs((draftPrefabs) => {
      draftPrefabs[prefab.id] = prefab;
    });
    setSelectedNodeIds([prefab.sourceNode.id]);
    setEditingPrefabId(editorPreferences.openNodeSettingsOnCreate ? prefab.id : undefined);
  });

  const deletePrefabSources = useStableCallback((sourceNodeIds: readonly NodeId[]) => {
    const prefabIdsToDelete: NodePrefabId[] = [];
    const sourceNodeIdsToDelete = new Set<NodeId>();
    const blockedUsageLabels: string[] = [];

    for (const sourceNodeId of sourceNodeIds) {
      const prefab = prefabsBySourceNodeId.get(sourceNodeId);
      if (!prefab) {
        continue;
      }

      const usages = getNodePrefabUsage(project, prefab.id, [currentGraph]);
      if (usages.length > 0) {
        blockedUsageLabels.push(...usages.map(getNodePrefabUsageLabel));
        continue;
      }

      prefabIdsToDelete.push(prefab.id);
      sourceNodeIdsToDelete.add(sourceNodeId);
    }

    if (blockedUsageLabels.length > 0) {
      toast.warn(`Cannot delete a used library node. Linked from: ${blockedUsageLabels.join(', ')}`);
    }

    if (prefabIdsToDelete.length === 0) {
      return;
    }

    updateProjectNodePrefabs((draftPrefabs) => {
      for (const prefabId of prefabIdsToDelete) {
        delete draftPrefabs[prefabId];
      }
    });
    setSelectedNodeIds((current) => current.filter((nodeId) => !sourceNodeIdsToDelete.has(nodeId)));
    setEditingPrefabId((current) => (current && prefabIdsToDelete.includes(current) ? undefined : current));
  });

  const deletePrefabSource = useStableCallback((sourceNodeId: NodeId) => {
    deletePrefabSources([sourceNodeId]);
  });

  const duplicatePrefabSource = useStableCallback((sourceNodeId: NodeId) => {
    const prefab = prefabsBySourceNodeId.get(sourceNodeId);
    if (!prefab) {
      return;
    }

    if (!canUseNodeAsPrefabSource(prefab.sourceNode)) {
      toast.warn('This library node cannot be duplicated because its type is not supported.');
      return;
    }

    const { newNodes } = duplicateNodesWithConnections({
      nodes: [prefab.sourceNode],
      nodeIds: [prefab.sourceNode.id],
      connections: [],
    });
    const duplicate = buildNodePrefab(newNodes[0]!);
    updateProjectNodePrefabs((draftPrefabs) => {
      draftPrefabs[duplicate.id] = duplicate;
    });
    setSelectedNodeIds([duplicate.sourceNode.id]);
  });

  const pastePrefabSources = useStableCallback((position: { x: number; y: number }) => {
    if (clipboard?.type !== 'nodes') {
      return;
    }

    const { prefabs: pastedPrefabs, skippedNodeCount } = createPastedNodeLibraryPrefabs({
      nodes: clipboard.nodes,
      position,
    });

    if (pastedPrefabs.length === 0) {
      if (skippedNodeCount > 0) {
        toast.warn('None of the copied nodes can become library nodes.');
      }
      return;
    }

    updateProjectNodePrefabs((draftPrefabs) => {
      for (const prefab of pastedPrefabs) {
        draftPrefabs[prefab.id] = prefab;
      }
    });
    setSelectedNodeIds(pastedPrefabs.map((prefab) => prefab.sourceNode.id));

    if (skippedNodeCount > 0) {
      toast.warn(
        `${skippedNodeCount} copied node${skippedNodeCount === 1 ? '' : 's'} skipped because the node type cannot become a library node.`,
      );
    }
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = document.activeElement;
      const inputFocused =
        activeElement instanceof HTMLElement &&
        (['INPUT', 'TEXTAREA'].includes(activeElement.tagName) || activeElement.isContentEditable);
      const isPaste = event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey) && !event.shiftKey;

      if (!isPaste || inputFocused || editingPrefabId || clipboard?.type !== 'nodes') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      pastePrefabSources(clientToCanvasPosition(lastMousePosition.x, lastMousePosition.y));
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [clientToCanvasPosition, clipboard?.type, editingPrefabId, lastMousePosition.x, lastMousePosition.y, pastePrefabSources]);

  const handleContextMenuItemSelected = useStableCallback(
    (menuItemId: string, data: unknown, context: ContextMenuContext, meta: { x: number; y: number }) => {
      if (menuItemId.startsWith('add-node:')) {
        addPrefabSource(data as string, clientToCanvasPosition(meta.x, meta.y));
        return;
      }

      if (menuItemId === 'paste') {
        pastePrefabSources(clientToCanvasPosition(meta.x, meta.y));
        return;
      }

      const nodeId = (context.data as { nodeId?: NodeId } | undefined)?.nodeId;
      if (!nodeId) {
        return;
      }

      if (menuItemId === 'node-edit') {
        setEditingPrefabId(prefabsBySourceNodeId.get(nodeId)?.id);
      } else if (menuItemId === 'node-delete') {
        deletePrefabSource(nodeId);
      } else if (menuItemId === 'node-duplicate') {
        duplicatePrefabSource(nodeId);
      }
    },
  );

  const closeEditor = useStableCallback(() => {
    setEditingPrefabId(undefined);
  });

  const editPrefabSourceNode: EditNodeCommand = useStableCallback((params) => {
    const prefab = prefabsBySourceNodeId.get(params.nodeId);
    if (!prefab) {
      return false;
    }

    updatePrefabSource(prefab.id, {
      ...prefab.sourceNode,
      ...structuredClone(params.newNode),
    } as ChartNode);

    return true;
  });

  const updateEditingPrefab: NodeChanged = useStableCallback((node, newData) => {
    if (editingPrefab) {
      updatePrefabSource(editingPrefab.id, node, newData);
    }
  });

  return (
    <Container>
      {nodes.length === 0 && (
        <div className="node-library-empty">Right-click to add library nodes.</div>
      )}
      <EditNodeCommandOverrideContext.Provider value={editPrefabSourceNode}>
        <NodeCanvas
          nodes={nodes}
          connections={[]}
          onNodesChanged={handleNodesChanged}
          onConnectionsChanged={() => {}}
          onNodeSelected={handleNodeSelected}
          selectedNodes={selectedNodes}
          onNodeStartEditing={(node) => setEditingPrefabId(prefabsBySourceNodeId.get(node.id)?.id)}
          onCanvasClick={closeEditor}
          onNodesDeleted={deletePrefabSources}
          onContextMenuItemSelected={handleContextMenuItemSelected}
          disableConnections
          disableGraphCommands
          pasteCommandsEnabled
        />
        {editingPrefab && (
          <NodeEditor key={editingPrefab.id} selectedNode={editingPrefab.sourceNode} onDeselect={closeEditor} onUpdateNode={updateEditingPrefab} />
        )}
      </EditNodeCommandOverrideContext.Provider>
    </Container>
  );
};
