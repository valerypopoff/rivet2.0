import { useSetAtom } from 'jotai';
import { type GraphCommandState, commandHistoryStackStatePerGraph, type CommandData, useCommand } from './Command';
import {
  type NodeId,
  type NodeConnection,
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type NodeRegistration,
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
  propagateGraphInputRename,
  rewriteSubGraphCallerGraphForGraphInputRename,
} from '../domain/graphEditing/graphInputRenamePropagation';
import {
  propagateGraphOutputRename,
  rewriteSubGraphCallerGraphForGraphOutputRename,
} from '../domain/graphEditing/graphOutputRenamePropagation';
import { projectState } from '../state/savedGraphs';
import { createContext, useContext } from 'react';

const MERGE_WINDOW_MS = 5000;

type GraphRenameProjectGraphSnapshots = Record<
  GraphId,
  {
    previousGraph: NodeGraph;
    nextGraph: NodeGraph;
  }
>;

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
  previousConnections: NodeConnection[];
  previousCurrentNodes?: ChartNode[];
  nextCurrentNodes?: ChartNode[];
  nextConnections: NodeConnection[];
  previousRecoverableConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
  projectGraphSnapshots?: GraphRenameProjectGraphSnapshots;
};

type GraphPortRename = {
  kind: 'input' | 'output';
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

function getGraphInputId(node: Partial<ChartNode> | undefined): string | undefined {
  if ((node as { type?: string } | undefined)?.type !== 'graphInput') {
    return undefined;
  }

  const id = (node?.data as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

function getGraphOutputId(node: Partial<ChartNode> | undefined): string | undefined {
  if ((node as { type?: string } | undefined)?.type !== 'graphOutput') {
    return undefined;
  }

  const id = (node?.data as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
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

function getNextProjectFromGraphSnapshots(
  project: GraphCommandState['project'],
  snapshots: GraphRenameProjectGraphSnapshots | undefined,
  snapshotKey: 'nextGraph' | 'previousGraph',
) {
  if (!snapshots || Object.keys(snapshots).length === 0) {
    return project;
  }

  return produce(project, (draft) => {
    for (const [graphId, snapshot] of Object.entries(snapshots) as Array<
      [GraphId, GraphRenameProjectGraphSnapshots[GraphId]]
    >) {
      draft.graphs[graphId] = structuredClone(snapshot[snapshotKey]);
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
  originalRename: GraphPortRename | undefined;
  previousSnapshots: GraphRenameProjectGraphSnapshots | undefined;
  nextSnapshots: GraphRenameProjectGraphSnapshots;
}): GraphRenameProjectGraphSnapshots | undefined {
  const mergedSnapshots: GraphRenameProjectGraphSnapshots = structuredClone(nextSnapshots);

  for (const [graphId, previousSnapshot] of Object.entries(previousSnapshots ?? {}) as Array<
    [GraphId, GraphRenameProjectGraphSnapshots[GraphId]]
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

function getNextGraphFromOriginalRenameSnapshot(graph: NodeGraph, rename: GraphPortRename): NodeGraph {
  if (rename.oldPortId === rename.newPortId) {
    return structuredClone(graph);
  }

  if (rename.kind === 'input') {
    return rewriteSubGraphCallerGraphForGraphInputRename({
      graph,
      newInputId: rename.newPortId,
      oldInputId: rename.oldPortId,
      targetGraphId: rename.targetGraphId,
    }).graph;
  }

  return rewriteSubGraphCallerGraphForGraphOutputRename({
    graph,
    newOutputId: rename.newPortId,
    oldOutputId: rename.oldPortId,
    targetGraphId: rename.targetGraphId,
  }).graph;
}

function getOriginalGraphPortRename({
  currentGraphId,
  editedNodeId,
  nextCurrentNodes,
  previousNode,
}: {
  currentGraphId: GraphId | undefined;
  editedNodeId: NodeId;
  nextCurrentNodes: readonly ChartNode[];
  previousNode: Partial<ChartNode>;
}): GraphPortRename | undefined {
  if (!currentGraphId) {
    return undefined;
  }

  const oldInputId = getGraphInputId(previousNode);
  const newInputId = getGraphInputId(nextCurrentNodes.find((node) => node.id === editedNodeId));

  if (oldInputId != null && newInputId != null) {
    const oldInputStillExists = nextCurrentNodes.some(
      (node) => node.id !== editedNodeId && getGraphInputId(node) === oldInputId,
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

  const oldOutputId = getGraphOutputId(previousNode);
  const newOutputId = getGraphOutputId(nextCurrentNodes.find((node) => node.id === editedNodeId));

  if (oldOutputId == null || newOutputId == null) {
    return undefined;
  }

  const oldOutputStillExists = nextCurrentNodes.some(
    (node) => node.id !== editedNodeId && getGraphOutputId(node) === oldOutputId,
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

type GraphPortRenameResult = {
  nextCurrentConnections: NodeConnection[];
  nextCurrentNodes: ChartNode[];
  projectGraphSnapshots: GraphRenameProjectGraphSnapshots;
};

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
  graphPortRenameResult: GraphPortRenameResult;
  isMergedEdit: boolean | undefined;
  nextNodes: readonly ChartNode[];
  originalRename: GraphPortRename | undefined;
  params: EditNodeParams;
  previousConnections: readonly NodeConnection[];
  previousCurrentNodes: readonly ChartNode[] | undefined;
  previousNode: Partial<ChartNode>;
}): GraphPortRenameResult {
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
  previousProjectGraphSnapshots?: GraphRenameProjectGraphSnapshots;
  projectNodeRegistry: NodeRegistration<any, any>;
}): EditNodeAppliedData {
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
  const graphInputRenameResult = propagateGraphInputRename({
    currentGraphId: currentState.graphId,
    editedNodeId: params.nodeId,
    nextCurrentConnections: nextConnections,
    nextCurrentNodes: nextNodes,
    previousCurrentNodes: currentState.nodes,
    project: currentState.project,
  });
  const graphOutputRenameResult = propagateGraphOutputRename({
    currentGraphId: currentState.graphId,
    editedNodeId: params.nodeId,
    nextCurrentConnections: graphInputRenameResult.nextCurrentConnections,
    nextCurrentNodes: graphInputRenameResult.nextCurrentNodes,
    previousCurrentNodes: currentState.nodes,
    project: currentState.project,
  });
  const graphPortRenameResult: GraphPortRenameResult = {
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

  return {
    previousNode: structuredClone(previousNode),
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
    setNodes(appliedData?.nextCurrentNodes ?? replaceNodeInGraph(currentState.nodes, params.nodeId, params.newNode));
    setConnections(cloneConnections(nextConnections));
    if (appliedData?.projectGraphSnapshots) {
      setProject((project) =>
        getNextProjectFromGraphSnapshots(project, appliedData.projectGraphSnapshots, 'nextGraph'),
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
      if (appliedData.projectGraphSnapshots) {
        setProject((project) =>
          getNextProjectFromGraphSnapshots(project, appliedData.projectGraphSnapshots, 'previousGraph'),
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
