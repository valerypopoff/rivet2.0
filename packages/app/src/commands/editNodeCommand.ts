import { useSetAtom } from 'jotai';
import { type GraphCommandState, commandHistoryStackStatePerGraph, type CommandData, useCommand } from './Command';
import {
  type NodeId,
  type NodeConnection,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeRegistration,
  type CodeNewNode,
  prepareCodeOutputEdit,
} from '@valerypopoff/rivet2-core';
import { nodesState, connectionsState } from '../state/graph';
import { produce } from 'immer';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { useStableCallback } from '../hooks/useStableCallback';
import {
  getRecoverableNodeConnectionsForNode,
  recoverableNodeConnectionsStatePerGraph,
  setRecoverableNodeConnectionsForGraphNode,
} from '../state/recoverableNodeConnections';
import { reconcileNodeEditConnections } from '../domain/graphEditing/editNodeConnectionRecovery';
import {
  getGraphPortId,
  type GraphPortRenameKind,
  type GraphPortRenameProjectGraphSnapshots,
  type PropagateGraphPortRenameResult,
  propagateGraphPortRename,
  rewriteSubGraphCallerGraphForGraphPortRename,
} from '../domain/graphEditing/graphPortRenamePropagation';
import { projectState } from '../state/savedGraphs';
import { createContext, useContext } from 'react';

const MERGE_WINDOW_MS = 5000;

type EditNodeParams = {
  nodeId: NodeId;
  newNode: Partial<ChartNode>;
  previousNodeOverride?: Partial<ChartNode>;
  mergeWithPrevious?: boolean;
};

export type EditNodeCommand = (params: EditNodeParams) => unknown;

export const EditNodeCommandOverrideContext = createContext<EditNodeCommand | null>(null);

type EditNodeAppliedData = {
  previousNode: Partial<ChartNode>;
  preparedNode?: Partial<ChartNode>;
  previousConnections: NodeConnection[];
  previousCurrentNodes?: ChartNode[];
  nextCurrentNodes?: ChartNode[];
  nextConnections: NodeConnection[];
  previousRecoverableConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
  currentGraphSnapshot?: CurrentGraphSnapshot;
  projectGraphSnapshots?: GraphPortRenameProjectGraphSnapshots;
};

type CurrentGraphSnapshot = {
  graphId: GraphId;
  previousGraph: NodeGraph;
  nextGraph: NodeGraph;
};

// This is the original command's rename, retained for merged-edit history.
// Propagation itself uses the smaller rename record inside graphPortRenamePropagation.
type HistoricalGraphPortRename = {
  kind: GraphPortRenameKind;
  newPortId: string;
  oldPortId: string;
  targetGraphId: GraphId;
};

function cloneConnections(connections: readonly NodeConnection[]): NodeConnection[] {
  return structuredClone([...connections]);
}

function cloneNodes(nodes: readonly ChartNode[]): ChartNode[] {
  return structuredClone([...nodes]);
}

export function shouldMergeEditNodeCommand(
  lastCommand: CommandData<any, any> | undefined,
  nodeId: NodeId,
  now = Date.now(),
): boolean {
  return !!(
    lastCommand &&
    now - lastCommand.timestamp <= MERGE_WINDOW_MS &&
    lastCommand.command.type === 'editNode' &&
    lastCommand.data.nodeId === nodeId
  );
}

function replaceNodeInGraph(nodes: readonly ChartNode[], nodeId: NodeId, newNode: Partial<ChartNode>): ChartNode[] {
  return produce([...nodes], (draft) => {
    const index = draft.findIndex((node) => node.id === nodeId);

    if (index < 0) {
      throw new Error(`Node with id ${nodeId} not found`);
    }

    draft[index] = {
      ...draft[index],
      ...structuredClone(newNode),
    } as ChartNode;
  });
}

function removeLastCommandHistoryEntryForGraph(
  stacks: Record<string, CommandData<any, any>[]>,
  graphId: string | undefined,
): Record<string, CommandData<any, any>[]> {
  if (!graphId) {
    return stacks;
  }

  const stack = stacks[graphId] ?? [];

  return {
    ...stacks,
    [graphId]: stack.slice(0, -1),
  };
}

function getNextProjectFromRenameSnapshots({
  project,
  currentGraphSnapshot,
  projectGraphSnapshots,
  snapshotKey,
}: {
  project: GraphCommandState['project'];
  currentGraphSnapshot: CurrentGraphSnapshot | undefined;
  projectGraphSnapshots: GraphPortRenameProjectGraphSnapshots | undefined;
  snapshotKey: 'nextGraph' | 'previousGraph';
}) {
  if ((!projectGraphSnapshots || Object.keys(projectGraphSnapshots).length === 0) && !currentGraphSnapshot) {
    return project;
  }

  return produce(project, (draft) => {
    for (const [graphId, snapshot] of Object.entries(projectGraphSnapshots ?? {}) as Array<
      [GraphId, GraphPortRenameProjectGraphSnapshots[GraphId]]
    >) {
      draft.graphs[graphId] = structuredClone(snapshot[snapshotKey]);
    }
    // The active graph is the live overlay and therefore wins if a future
    // propagation change also supplies it in the external snapshot record.
    if (currentGraphSnapshot) {
      draft.graphs[currentGraphSnapshot.graphId] = structuredClone(currentGraphSnapshot[snapshotKey]);
    }
  });
}

function mergeProjectGraphSnapshots({
  currentProject,
  originalRename,
  previousSnapshots,
  nextSnapshots,
}: {
  currentProject: GraphCommandState['project'];
  originalRename: HistoricalGraphPortRename | undefined;
  previousSnapshots: GraphPortRenameProjectGraphSnapshots | undefined;
  nextSnapshots: GraphPortRenameProjectGraphSnapshots;
}): GraphPortRenameProjectGraphSnapshots | undefined {
  const mergedSnapshots: GraphPortRenameProjectGraphSnapshots = structuredClone(nextSnapshots);

  for (const [graphId, previousSnapshot] of Object.entries(previousSnapshots ?? {}) as Array<
    [GraphId, GraphPortRenameProjectGraphSnapshots[GraphId]]
  >) {
    const nextGraph = originalRename
      ? getNextGraphFromOriginalRenameSnapshot(previousSnapshot.previousGraph, originalRename)
      : mergedSnapshots[graphId]?.nextGraph ?? currentProject.graphs[graphId] ?? previousSnapshot.nextGraph;

    mergedSnapshots[graphId] = {
      previousGraph: structuredClone(previousSnapshot.previousGraph),
      nextGraph: structuredClone(nextGraph),
    };
  }

  return Object.keys(mergedSnapshots).length > 0 ? mergedSnapshots : undefined;
}

function getNextGraphFromOriginalRenameSnapshot(graph: NodeGraph, rename: HistoricalGraphPortRename): NodeGraph {
  if (rename.oldPortId === rename.newPortId) {
    return structuredClone(graph);
  }

  return rewriteSubGraphCallerGraphForGraphPortRename({
    graph,
    kind: rename.kind,
    newPortId: rename.newPortId,
    oldPortId: rename.oldPortId,
    targetGraphId: rename.targetGraphId,
  }).graph;
}

function getOriginalGraphPortRename({
  currentGraphId,
  editedNodeId,
  isMergedEdit,
  nextCurrentNodes,
  previousNode,
}: {
  currentGraphId: GraphId | undefined;
  editedNodeId: NodeId;
  isMergedEdit: boolean | undefined;
  nextCurrentNodes: readonly ChartNode[];
  previousNode: Partial<ChartNode>;
}): HistoricalGraphPortRename | undefined {
  if (!currentGraphId) {
    return undefined;
  }

  const oldInputId = getGraphPortId(previousNode, 'input');
  const newInputId = getGraphPortId(
    nextCurrentNodes.find((node) => node.id === editedNodeId),
    'input',
  );

  if (oldInputId != null && newInputId != null) {
    // A merged edit may intentionally return to the original ID. Retain that
    // history so it can rebuild callers from the original snapshot; a normal
    // same-ID edit is not a boundary rename and must not write project state.
    if (oldInputId === newInputId && !isMergedEdit) {
      return undefined;
    }

    const oldInputStillExists = nextCurrentNodes.some(
      (node) => node.id !== editedNodeId && getGraphPortId(node, 'input') === oldInputId,
    );

    if (oldInputStillExists) {
      return undefined;
    }

    return {
      kind: 'input',
      newPortId: newInputId,
      oldPortId: oldInputId,
      targetGraphId: currentGraphId,
    };
  }

  const oldOutputId = getGraphPortId(previousNode, 'output');
  const newOutputId = getGraphPortId(
    nextCurrentNodes.find((node) => node.id === editedNodeId),
    'output',
  );

  if (oldOutputId == null || newOutputId == null) {
    return undefined;
  }

  if (oldOutputId === newOutputId && !isMergedEdit) {
    return undefined;
  }

  const oldOutputStillExists = nextCurrentNodes.some(
    (node) => node.id !== editedNodeId && getGraphPortId(node, 'output') === oldOutputId,
  );

  if (oldOutputStillExists) {
    return undefined;
  }

  return {
    kind: 'output',
    newPortId: newOutputId,
    oldPortId: oldOutputId,
    targetGraphId: currentGraphId,
  };
}

function buildPreviousCurrentNodesForMergedEdit({
  currentNodes,
  editedNodeId,
  previousCurrentNodes,
  previousNode,
}: {
  currentNodes: readonly ChartNode[];
  editedNodeId: NodeId;
  previousCurrentNodes: readonly ChartNode[] | undefined;
  previousNode: Partial<ChartNode>;
}): ChartNode[] {
  return previousCurrentNodes
    ? cloneNodes(previousCurrentNodes)
    : replaceNodeInGraph(currentNodes, editedNodeId, previousNode);
}

function getMergedGraphPortRenameResult({
  currentGraphId,
  graphPortRenameResult,
  isMergedEdit,
  nextNodes,
  originalRename,
  params,
  previousConnections,
  previousCurrentNodes,
  previousNode,
}: {
  currentGraphId: GraphId | undefined;
  graphPortRenameResult: PropagateGraphPortRenameResult;
  isMergedEdit: boolean | undefined;
  nextNodes: readonly ChartNode[];
  originalRename: HistoricalGraphPortRename | undefined;
  params: EditNodeParams;
  previousConnections: readonly NodeConnection[];
  previousCurrentNodes: readonly ChartNode[] | undefined;
  previousNode: Partial<ChartNode>;
}): PropagateGraphPortRenameResult {
  if (!isMergedEdit || !currentGraphId || !originalRename) {
    return graphPortRenameResult;
  }

  const previousNodes = buildPreviousCurrentNodesForMergedEdit({
    currentNodes: nextNodes,
    editedNodeId: params.nodeId,
    previousCurrentNodes,
    previousNode,
  });
  const nextNodesFromOriginalRename = replaceNodeInGraph(previousNodes, params.nodeId, params.newNode);
  const nextCurrentGraph = getNextGraphFromOriginalRenameSnapshot(
    {
      metadata: {
        id: currentGraphId,
      },
      nodes: nextNodesFromOriginalRename,
      connections: cloneConnections(previousConnections),
    },
    originalRename,
  );

  return {
    ...graphPortRenameResult,
    nextCurrentConnections: nextCurrentGraph.connections,
    nextCurrentNodes: nextCurrentGraph.nodes,
  };
}

function getCurrentGraphSnapshot({
  currentGraphId,
  effectiveGraphPortRenameResult,
  originalRename,
  previousConnections,
  previousCurrentNodes,
  project,
  currentNodes,
}: {
  currentGraphId: GraphId | undefined;
  effectiveGraphPortRenameResult: PropagateGraphPortRenameResult;
  originalRename: HistoricalGraphPortRename | undefined;
  previousConnections: readonly NodeConnection[];
  previousCurrentNodes: readonly ChartNode[] | undefined;
  project: GraphCommandState['project'];
  currentNodes: readonly ChartNode[];
}): CurrentGraphSnapshot | undefined {
  if (!currentGraphId || !originalRename) {
    return undefined;
  }

  const metadata = project.graphs[currentGraphId]?.metadata ?? {
    id: currentGraphId,
    name: 'Current Graph',
    description: '',
  };

  return {
    graphId: currentGraphId,
    previousGraph: {
      metadata: structuredClone(metadata),
      nodes: cloneNodes(previousCurrentNodes ?? currentNodes),
      connections: cloneConnections(previousConnections),
    },
    nextGraph: {
      metadata: structuredClone(metadata),
      nodes: cloneNodes(effectiveGraphPortRenameResult.nextCurrentNodes),
      connections: cloneConnections(effectiveGraphPortRenameResult.nextCurrentConnections),
    },
  };
}

export function buildEditNodeAppliedData({
  params,
  currentState,
  previousNode,
  previousConnections,
  previousCurrentNodes,
  previousRecoverableConnections,
  currentRecoverableConnections,
  isMergedEdit,
  previousProjectGraphSnapshots,
  projectNodeRegistry,
}: {
  params: EditNodeParams;
  currentState: GraphCommandState;
  previousNode: Partial<ChartNode>;
  previousConnections: readonly NodeConnection[];
  previousCurrentNodes?: readonly ChartNode[];
  previousRecoverableConnections: readonly NodeConnection[];
  currentRecoverableConnections: readonly NodeConnection[];
  isMergedEdit?: boolean;
  previousProjectGraphSnapshots?: GraphPortRenameProjectGraphSnapshots;
  projectNodeRegistry: NodeRegistration<any, any>;
}): EditNodeAppliedData {
  const currentNode = currentState.nodes.find((node) => node.id === params.nodeId);
  const nextNodeType = params.newNode.type ?? currentNode?.type;
  const isCodeEdit = currentNode?.type === 'codeNew' && nextNodeType === 'codeNew' && params.newNode.data !== undefined;
  if (isCodeEdit) {
    params = {
      ...params,
      newNode: {
        ...params.newNode,
        data: prepareCodeOutputEdit(
          (currentNode as CodeNewNode).data,
          params.newNode.data as Partial<CodeNewNode['data']>,
        ),
      },
    };
  }
  const nextNodes = replaceNodeInGraph(currentState.nodes, params.nodeId, params.newNode);
  const { nextConnections, nextRecoverableConnections } = reconcileNodeEditConnections({
    nodeId: params.nodeId,
    newNode: params.newNode,
    nodes: currentState.nodes,
    liveConnections: currentState.connections,
    recoverableConnections: currentRecoverableConnections,
    project: currentState.project,
    referencedProjects: currentState.referencedProjects,
    projectNodeRegistry,
  });
  const graphInputRenameResult = propagateGraphPortRename({
    currentGraphId: currentState.graphId,
    editedNodeId: params.nodeId,
    kind: 'input',
    nextCurrentConnections: nextConnections,
    nextCurrentNodes: nextNodes,
    previousCurrentNodes: currentState.nodes,
    project: currentState.project,
  });
  const graphOutputRenameResult = propagateGraphPortRename({
    currentGraphId: currentState.graphId,
    editedNodeId: params.nodeId,
    kind: 'output',
    nextCurrentConnections: graphInputRenameResult.nextCurrentConnections,
    nextCurrentNodes: graphInputRenameResult.nextCurrentNodes,
    previousCurrentNodes: currentState.nodes,
    project: currentState.project,
  });
  const graphPortRenameResult: PropagateGraphPortRenameResult = {
    nextCurrentConnections: graphOutputRenameResult.nextCurrentConnections,
    nextCurrentNodes: graphOutputRenameResult.nextCurrentNodes,
    projectGraphSnapshots: {
      ...graphInputRenameResult.projectGraphSnapshots,
      ...graphOutputRenameResult.projectGraphSnapshots,
    },
  };
  const originalRename = getOriginalGraphPortRename({
    currentGraphId: currentState.graphId,
    editedNodeId: params.nodeId,
    isMergedEdit,
    nextCurrentNodes: nextNodes,
    previousNode,
  });
  const effectiveGraphPortRenameResult = getMergedGraphPortRenameResult({
    currentGraphId: currentState.graphId,
    graphPortRenameResult,
    isMergedEdit,
    nextNodes,
    originalRename,
    params,
    previousConnections,
    previousCurrentNodes,
    previousNode,
  });
  const currentNodesChangedByRename =
    effectiveGraphPortRenameResult.nextCurrentNodes.length !== nextNodes.length ||
    effectiveGraphPortRenameResult.nextCurrentNodes.some((node, index) => node !== nextNodes[index]);
  const shouldSnapshotCurrentNodes = !!previousCurrentNodes || currentNodesChangedByRename;
  const projectGraphSnapshots = mergeProjectGraphSnapshots({
    currentProject: currentState.project,
    originalRename: isMergedEdit ? originalRename : undefined,
    previousSnapshots: previousProjectGraphSnapshots,
    nextSnapshots: graphPortRenameResult.projectGraphSnapshots,
  });
  const currentGraphSnapshot = getCurrentGraphSnapshot({
    currentGraphId: currentState.graphId,
    effectiveGraphPortRenameResult,
    originalRename,
    previousConnections,
    previousCurrentNodes,
    project: currentState.project,
    currentNodes: currentState.nodes,
  });

  return {
    previousNode: structuredClone(previousNode),
    preparedNode: isCodeEdit ? structuredClone(params.newNode) : undefined,
    previousConnections: cloneConnections(previousConnections),
    previousCurrentNodes: shouldSnapshotCurrentNodes
      ? cloneNodes(previousCurrentNodes ?? currentState.nodes)
      : undefined,
    nextCurrentNodes: shouldSnapshotCurrentNodes
      ? cloneNodes(effectiveGraphPortRenameResult.nextCurrentNodes)
      : undefined,
    nextConnections: cloneConnections(effectiveGraphPortRenameResult.nextCurrentConnections),
    previousRecoverableConnections: cloneConnections(previousRecoverableConnections),
    nextRecoverableConnections: cloneConnections(nextRecoverableConnections),
    currentGraphSnapshot,
    projectGraphSnapshots,
  };
}

function useDefaultEditNodeCommand() {
  const setNodes = useSetAtom(nodesState);
  const setConnections = useSetAtom(connectionsState);
  const setProject = useSetAtom(projectState);
  const setCommandHistories = useSetAtom(commandHistoryStackStatePerGraph);
  const setRecoverableNodeConnections = useSetAtom(recoverableNodeConnectionsStatePerGraph);
  const projectNodeRegistry = useProjectNodeRegistry();

  const applyNodeAndGraphState = (
    params: EditNodeParams,
    nextConnections: readonly NodeConnection[],
    nextRecoverableConnections: readonly NodeConnection[],
    currentState: GraphCommandState,
    appliedData?: EditNodeAppliedData,
  ) => {
    setNodes(
      appliedData?.nextCurrentNodes ??
        replaceNodeInGraph(currentState.nodes, params.nodeId, appliedData?.preparedNode ?? params.newNode),
    );
    setConnections(cloneConnections(nextConnections));
    if (appliedData?.projectGraphSnapshots || appliedData?.currentGraphSnapshot) {
      setProject((project) =>
        getNextProjectFromRenameSnapshots({
          project,
          currentGraphSnapshot: appliedData.currentGraphSnapshot,
          projectGraphSnapshots: appliedData.projectGraphSnapshots,
          snapshotKey: 'nextGraph',
        }),
      );
    }
    setRecoverableNodeConnections((entries) =>
      setRecoverableNodeConnectionsForGraphNode(
        entries,
        currentState.graphId,
        params.nodeId,
        nextRecoverableConnections,
      ),
    );
  };

  return useCommand<EditNodeParams, EditNodeAppliedData>({
    type: 'editNode',
    apply(params, appliedData, currentState) {
      const nodeToEdit = currentState.nodes.find((node) => node.id === params.nodeId);

      if (!nodeToEdit) {
        throw new Error(`Node with id ${params.nodeId} not found`);
      }

      if (appliedData) {
        applyNodeAndGraphState(
          params,
          appliedData.nextConnections,
          appliedData.nextRecoverableConnections,
          currentState,
          appliedData,
        );
        return appliedData;
      }

      const currentRecoverableConnections = getRecoverableNodeConnectionsForNode(
        currentState.recoverableNodeConnections,
        params.nodeId,
      );
      const lastCommand = currentState.commandHistoryStack.at(-1);
      const shouldMerge = params.mergeWithPrevious !== false && shouldMergeEditNodeCommand(lastCommand, params.nodeId);

      if (shouldMerge) {
        setCommandHistories((stacks) => removeLastCommandHistoryEntryForGraph(stacks, currentState.graphId));

        const commandToMergeWith = lastCommand!;
        const nextAppliedData = buildEditNodeAppliedData({
          params,
          currentState,
          previousNode: commandToMergeWith.appliedData.previousNode,
          previousConnections: commandToMergeWith.appliedData.previousConnections,
          previousCurrentNodes: commandToMergeWith.appliedData.previousCurrentNodes,
          previousRecoverableConnections: commandToMergeWith.appliedData.previousRecoverableConnections,
          currentRecoverableConnections,
          isMergedEdit: true,
          previousProjectGraphSnapshots: commandToMergeWith.appliedData.projectGraphSnapshots,
          projectNodeRegistry,
        });

        applyNodeAndGraphState(
          params,
          nextAppliedData.nextConnections,
          nextAppliedData.nextRecoverableConnections,
          currentState,
          nextAppliedData,
        );

        return nextAppliedData;
      }

      const nextAppliedData = buildEditNodeAppliedData({
        params,
        currentState,
        previousNode: params.previousNodeOverride ?? nodeToEdit,
        previousConnections: currentState.connections,
        previousRecoverableConnections: currentRecoverableConnections,
        currentRecoverableConnections,
        projectNodeRegistry,
      });

      applyNodeAndGraphState(
        params,
        nextAppliedData.nextConnections,
        nextAppliedData.nextRecoverableConnections,
        currentState,
        nextAppliedData,
      );

      return nextAppliedData;
    },
    undo({ nodeId }, appliedData, currentState) {
      setNodes(
        appliedData.previousCurrentNodes ??
          produce(currentState.nodes, (draft) => {
            const index = draft.findIndex((node) => node.id === nodeId);

            if (index < 0) {
              throw new Error(`Node with id ${nodeId} not found`);
            }

            draft[index] = {
              ...draft[index],
              ...structuredClone(appliedData.previousNode),
            } as ChartNode;
          }),
      );
      setConnections(cloneConnections(appliedData.previousConnections));
      if (appliedData.projectGraphSnapshots || appliedData.currentGraphSnapshot) {
        setProject((project) =>
          getNextProjectFromRenameSnapshots({
            project,
            currentGraphSnapshot: appliedData.currentGraphSnapshot,
            projectGraphSnapshots: appliedData.projectGraphSnapshots,
            snapshotKey: 'previousGraph',
          }),
        );
      }
      setRecoverableNodeConnections((entries) =>
        setRecoverableNodeConnectionsForGraphNode(
          entries,
          currentState.graphId,
          nodeId,
          appliedData.previousRecoverableConnections,
        ),
      );
    },
  });
}

export function useEditNodeCommand() {
  const override = useContext(EditNodeCommandOverrideContext);
  const defaultEditNode = useDefaultEditNodeCommand();

  return useStableCallback((params: EditNodeParams) => {
    if (override) {
      return override(params);
    }

    return defaultEditNode(params);
  });
}
