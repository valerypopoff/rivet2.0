import { type CSSProperties, type FC, useEffect, useMemo, useRef, type SetStateAction } from 'react';
import styled from '@emotion/styled';
import { toast } from 'react-toastify';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  type ChartNode,
  type DataId,
  type NodeId,
  type NodePrefab,
  type NodePrefabId,
  type CodeNewNode,
  prepareCodeOutputEdit,
} from '@valerypopoff/rivet2-core';
import { NodeCanvas } from './NodeCanvas.js';
import { NodeEditor, type NodeChanged } from './NodeEditor.js';
import { EditNodeCommandOverrideContext, type EditNodeCommand } from '../commands/editNodeCommand.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { matchesKeyboardShortcut } from '../utils/keyboardShortcutMatcher.js';
import { useCanvasPositioning } from '../hooks/useCanvasPositioning.js';
import { getCanvasPositionForNodes } from '../hooks/useCenterViewOnGraph.js';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry.js';
import { graphState } from '../state/graph.js';
import {
  canvasPositionState,
  lastMousePositionState,
  nodeEditorSessionRevisionState,
  selectedNodesState,
  sidebarOpenState,
} from '../state/graphBuilder.js';
import { projectState, referencedProjectsState } from '../state/savedGraphs.js';
import {
  nodeLibraryCanvasPositionsState,
  projectWorkspaceTargetsState,
  setProjectWorkspaceTargetState,
} from '../state/workspaceTarget.js';
import { settingsState, resolveEditorPreferences } from '../state/settings.js';
import { leftSidebarLiveWidthState } from '../state/ui.js';
import { createAddedNode, duplicateNodesWithConnections } from '../domain/graphEditing/nodeActions.js';
import {
  buildNodePrefab,
  canUseNodeAsPrefabSource,
  getNodePrefabUsage,
  getNodePrefabUsageLabel,
  getNodePrefabUsages,
  type NodePrefabUsage,
} from '../domain/nodeLibrary/nodePrefabs.js';
import { createPastedNodeLibraryPrefabs } from '../domain/nodeLibrary/nodePrefabClipboard.js';
import { isNotNull } from '../utils/genericUtilFunctions.js';
import { handleError } from '../utils/errorHandling.js';
import { useSetStaticData } from '../hooks/useSetStaticData.js';
import type { ContextMenuContext } from './ContextMenu.js';
import { updateNodeLibraryState } from '../state/nodeLibrary.js';
import { clipboardState } from '../state/clipboard.js';
import { NodeLibraryReferencesContext } from './visualNode/NodeLibraryReferences.js';
import { useGoToNode } from '../hooks/useGoToNode.js';
import { mergeNodeEditorChange } from '../utils/nodeEditorSession.js';

const Container = styled.div`
  position: relative;
  --node-library-sidebar-offset: 0px;

  .node-library-empty {
    position: absolute;
    top: calc(var(--project-selector-height) + 28px);
    left: calc(var(--node-library-sidebar-offset) + (100% - var(--node-library-sidebar-offset)) / 2);
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

  .node-library-empty-title {
    margin: 0 0 6px;
    color: var(--foreground);
    font-weight: 700;
  }

  .node-library-empty-copy {
    margin: 0;
  }
`;

function getPrefabSourceId(prefab: NodePrefab): NodeId {
  return prefab.sourceNode.id;
}

export const NodeLibraryBuilder: FC = () => {
  const store = useStore();
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const revision = useAtomValue(nodeEditorSessionRevisionState);
  const [selectedNodeIds, setSelectedNodeIds] = useAtom(selectedNodesState);
  const workspaceTarget = useAtomValue(projectWorkspaceTargetsState)[project.metadata.id];
  const editingPrefabId = workspaceTarget?.type === 'nodeLibrary' ? workspaceTarget.editingPrefabId : undefined;
  const isCurrent = () =>
    store.get(projectState).metadata.id === project.metadata.id &&
    store.get(nodeEditorSessionRevisionState) === revision &&
    store.get(projectWorkspaceTargetsState)[project.metadata.id]?.type === 'nodeLibrary';
  const setEditingPrefabId = useStableCallback((update: SetStateAction<NodePrefabId | undefined>) => {
    if (!isCurrent()) return;
    const currentTarget = store.get(projectWorkspaceTargetsState)[project.metadata.id];
    const currentEditingPrefabId = currentTarget?.type === 'nodeLibrary' ? currentTarget.editingPrefabId : undefined;
    const nextEditingPrefabId = typeof update === 'function' ? update(currentEditingPrefabId) : update;

    store.set(setProjectWorkspaceTargetState, {
      projectId: project.metadata.id,
      target: { editingPrefabId: nextEditingPrefabId, type: 'nodeLibrary' },
    });
  });
  const settings = useAtomValue(settingsState);
  const sidebarOpen = useAtomValue(sidebarOpenState);
  const liveSidebarWidth = useAtomValue(leftSidebarLiveWidthState);
  const clipboard = useAtomValue(clipboardState);
  const lastMousePosition = useAtomValue(lastMousePositionState);
  const setCanvasPosition = useSetAtom(canvasPositionState);
  const canvasPosition = useAtomValue(canvasPositionState);
  const nodeLibraryCanvasPositions = useAtomValue(nodeLibraryCanvasPositionsState);
  const setNodeLibraryCanvasPositions = useSetAtom(nodeLibraryCanvasPositionsState);
  const setStaticData = useSetStaticData();
  const projectNodeRegistry = useProjectNodeRegistry();
  const { clientToCanvasPosition } = useCanvasPositioning();
  const editorPreferences = resolveEditorPreferences(settings);
  const centeredOnOpenRef = useRef(false);
  const centeredEditingPrefabIdRef = useRef<NodePrefabId | undefined>(undefined);
  const latestCanvasPositionRef = useRef(canvasPosition);
  latestCanvasPositionRef.current = canvasPosition;

  const prefabs = useMemo(() => Object.values(project.nodePrefabs ?? {}), [project.nodePrefabs]);
  const goToNode = useGoToNode();
  const usagesByPrefabId = useMemo(() => getNodePrefabUsages(project, [currentGraph]), [project, currentGraph]);
  const referenceUsages = useMemo(
    () => new Map(prefabs.map((prefab) => [prefab.sourceNode.id, usagesByPrefabId.get(prefab.id) ?? []])),
    [prefabs, usagesByPrefabId],
  );
  const onNavigateReference = useStableCallback((usage: NodePrefabUsage) => {
    goToNode(usage.nodeId, { graphId: usage.graph.metadata?.id });
    setSelectedNodeIds([usage.nodeId]);
  });
  const referencesContext = useMemo(
    () => ({ usages: referenceUsages, onNavigate: onNavigateReference }),
    [referenceUsages, onNavigateReference],
  );
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
  const containerStyle = {
    '--node-library-sidebar-offset': sidebarOpen ? `${liveSidebarWidth}px` : '0px',
  } as CSSProperties;

  useEffect(() => {
    if (!centeredOnOpenRef.current) {
      centeredOnOpenRef.current = true;
      centeredEditingPrefabIdRef.current = editingPrefabId;
      const savedPosition = nodeLibraryCanvasPositions[project.metadata.id];
      setCanvasPosition(
        editingPrefab
          ? getCanvasPositionForNodes([editingPrefab.sourceNode], sidebarOpen)
          : savedPosition ?? getCanvasPositionForNodes(nodes, sidebarOpen),
      );
      return;
    }

    if (!editingPrefab || centeredEditingPrefabIdRef.current === editingPrefabId) {
      return;
    }

    centeredEditingPrefabIdRef.current = editingPrefabId;
    setCanvasPosition(getCanvasPositionForNodes([editingPrefab.sourceNode], sidebarOpen));
  }, [
    editingPrefab,
    editingPrefabId,
    nodeLibraryCanvasPositions,
    nodes,
    project.metadata.id,
    setCanvasPosition,
    sidebarOpen,
  ]);

  useEffect(
    () => () => {
      setNodeLibraryCanvasPositions((positions) => ({
        ...positions,
        [project.metadata.id]: latestCanvasPositionRef.current,
      }));
    },
    [project.metadata.id, setNodeLibraryCanvasPositions],
  );

  const updateProjectNodePrefabs = useStableCallback(
    (update: (prefabs: Record<NodePrefabId, NodePrefab>) => void | false) =>
      store.set(updateNodeLibraryState, {
        projectId: project.metadata.id,
        revision,
        registry: projectNodeRegistry,
        update,
      }),
  );

  const updatePrefabSource = useStableCallback(
    (prefabId: NodePrefabId, nextNode: ChartNode, newData?: Record<DataId, string>) => {
      if (!canUseNodeAsPrefabSource(nextNode)) {
        handleError(new Error(`"${nextNode.type}" cannot be a library node.`), 'Node library update failed');
        return;
      }

      const updated = updateProjectNodePrefabs((draftPrefabs) => {
        const prefab = draftPrefabs[prefabId];
        if (!prefab || prefab.sourceNode.id !== nextNode.id) return false;
        prefab.sourceNode =
          nextNode.type === 'codeNew' && prefab.sourceNode.type === 'codeNew'
            ? {
                ...nextNode,
                data: prepareCodeOutputEdit((prefab.sourceNode as CodeNewNode).data, (nextNode as CodeNewNode).data),
              }
            : nextNode;
      });

      if (updated && newData) {
        setStaticData(newData);
      }
      return updated;
    },
  );

  const handleNodesChanged = useStableCallback((nextNodes: ChartNode[]) => {
    updateProjectNodePrefabs((draftPrefabs) => {
      for (const nextNode of nextNodes) {
        const prefab = Object.values(draftPrefabs).find((entry) => entry.sourceNode.id === nextNode.id);
        if (prefab) {
          const rendered = nodes.find((entry) => entry.id === nextNode.id);
          prefab.sourceNode = rendered ? mergeNodeEditorChange(prefab.sourceNode, rendered, nextNode) : nextNode;
        } else if (canUseNodeAsPrefabSource(nextNode)) {
          const nextPrefab = buildNodePrefab(nextNode);
          draftPrefabs[nextPrefab.id] = nextPrefab;
        }
      }
    });
  });

  const handleNodeSelected = useStableCallback((node: ChartNode, multi: boolean) => {
    if (!isCurrent()) return;
    setSelectedNodeIds((current) => {
      if (!multi) {
        return [node.id];
      }

      return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
    });
  });

  const addPrefabSource = useStableCallback((nodeType: string, position: { x: number; y: number }) => {
    if (!isCurrent()) return;
    const newNode = createAddedNode({
      nodeType,
      position,
      registry: projectNodeRegistry,
      project: store.get(projectState),
      referencedProjects: store.get(referencedProjectsState),
      applyDefaultColor: editorPreferences.applyDefaultNodeColors,
    });

    if (!canUseNodeAsPrefabSource(newNode)) {
      toast.warn('This node type cannot be a library node.');
      return;
    }

    const prefab = buildNodePrefab(newNode);
    const updated = updateProjectNodePrefabs((draftPrefabs) => {
      draftPrefabs[prefab.id] = prefab;
    });
    if (!updated) return;
    setSelectedNodeIds([prefab.sourceNode.id]);
    setEditingPrefabId(editorPreferences.openNodeSettingsOnCreate ? prefab.id : undefined);
  });

  const deletePrefabSources = useStableCallback((sourceNodeIds: readonly NodeId[]) => {
    if (!isCurrent()) return;
    const liveProject = store.get(projectState);
    const liveGraph = store.get(graphState);
    const prefabIdsToDelete: NodePrefabId[] = [];
    const sourceNodeIdsToDelete = new Set<NodeId>();
    const blockedUsageLabels: string[] = [];

    for (const sourceNodeId of sourceNodeIds) {
      const prefab = Object.values(liveProject.nodePrefabs ?? {}).find((entry) => entry.sourceNode.id === sourceNodeId);
      if (!prefab) {
        continue;
      }

      const usages = getNodePrefabUsage(liveProject, prefab.id, [liveGraph]);
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

    const updated = updateProjectNodePrefabs((draftPrefabs) => {
      for (const prefabId of prefabIdsToDelete) {
        delete draftPrefabs[prefabId];
      }
    });
    if (!updated) return;
    setSelectedNodeIds((current) => current.filter((nodeId) => !sourceNodeIdsToDelete.has(nodeId)));
    setEditingPrefabId((current) => (current && prefabIdsToDelete.includes(current) ? undefined : current));
  });

  const deletePrefabSource = useStableCallback((sourceNodeId: NodeId) => {
    deletePrefabSources([sourceNodeId]);
  });

  const duplicatePrefabSource = useStableCallback((sourceNodeId: NodeId) => {
    if (!isCurrent()) return;
    const prefab = Object.values(store.get(projectState).nodePrefabs ?? {}).find(
      (entry) => entry.sourceNode.id === sourceNodeId,
    );
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
    const updated = updateProjectNodePrefabs((draftPrefabs) => {
      draftPrefabs[duplicate.id] = duplicate;
    });
    if (!updated) return;
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

    const updated = updateProjectNodePrefabs((draftPrefabs) => {
      for (const prefab of pastedPrefabs) {
        draftPrefabs[prefab.id] = prefab;
      }
    });
    if (!updated) return;
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
      const isPaste = matchesKeyboardShortcut(event, {
        altKey: false,
        codes: ['KeyV'],
        commandModifier: 'any-command',
        keys: ['v'],
        shiftKey: false,
      });

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
  }, [
    clientToCanvasPosition,
    clipboard?.type,
    editingPrefabId,
    lastMousePosition.x,
    lastMousePosition.y,
    pastePrefabSources,
  ]);

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
    if (!isCurrent()) return false;
    const prefab = Object.values(store.get(projectState).nodePrefabs ?? {}).find(
      (entry) => entry.sourceNode.id === params.nodeId,
    );
    if (!prefab) {
      return false;
    }

    return updatePrefabSource(prefab.id, {
      ...prefab.sourceNode,
      ...structuredClone(params.newNode),
    } as ChartNode);
  });

  const updateEditingPrefab: NodeChanged = useStableCallback((node, newData) => {
    if (editingPrefab) {
      updatePrefabSource(editingPrefab.id, node, newData);
    }
  });

  return (
    <Container style={containerStyle}>
      {nodes.length === 0 && (
        <div className="node-library-empty">
          <p className="node-library-empty-title">Right-click to add library nodes.</p>
          <p className="node-library-empty-copy">
            Library nodes are reusable sources. Add them to graphs as linked nodes; edits here update every link.
          </p>
        </div>
      )}
      <EditNodeCommandOverrideContext.Provider value={editPrefabSourceNode}>
        <NodeLibraryReferencesContext.Provider value={referencesContext}>
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
        </NodeLibraryReferencesContext.Provider>
        {editingPrefab && (
          <NodeEditor
            key={editingPrefab.id}
            selectedNode={editingPrefab.sourceNode}
            onDeselect={closeEditor}
            onUpdateNode={updateEditingPrefab}
            onDeleteNode={() => deletePrefabSource(editingPrefab.sourceNode.id)}
          />
        )}
      </EditNodeCommandOverrideContext.Provider>
    </Container>
  );
};
