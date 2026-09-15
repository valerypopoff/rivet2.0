import {
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
} from '@valerypopoff/rivet2-core';
import { getSubGraphPortOrderKey, renameSubGraphPortOrder } from './subGraphPortOrder.js';

export type GraphPortRenameKind = 'input' | 'output';

export type GraphPortRenameProjectGraphSnapshots = Record<
  GraphId,
  {
    previousGraph: NodeGraph;
    nextGraph: NodeGraph;
  }
>;

export type PropagateGraphPortRenameResult = {
  nextCurrentConnections: NodeConnection[];
  nextCurrentNodes: ChartNode[];
  projectGraphSnapshots: GraphPortRenameProjectGraphSnapshots;
};

type GraphPortRename = {
  oldPortId: string;
  newPortId: string;
};

export function getGraphPortId(
  node: Partial<ChartNode> | undefined,
  kind: GraphPortRenameKind,
): string | undefined {
  if ((node as { type?: string } | undefined)?.type !== (kind === 'input' ? 'graphInput' : 'graphOutput')) {
    return undefined;
  }

  const id = (node?.data as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

function getGraphPortRename({
  editedNodeId,
  kind,
  previousCurrentNodes,
  nextCurrentNodes,
}: {
  editedNodeId: NodeId;
  kind: GraphPortRenameKind;
  previousCurrentNodes: readonly ChartNode[];
  nextCurrentNodes: readonly ChartNode[];
}): GraphPortRename | undefined {
  const oldPortId = getGraphPortId(previousCurrentNodes.find((node) => node.id === editedNodeId), kind);
  const newPortId = getGraphPortId(nextCurrentNodes.find((node) => node.id === editedNodeId), kind);

  if (oldPortId == null || newPortId == null || oldPortId === newPortId) {
    return undefined;
  }

  const oldPortStillExists = nextCurrentNodes.some(
    (node) => node.id !== editedNodeId && getGraphPortId(node, kind) === oldPortId,
  );

  return oldPortStillExists ? undefined : { oldPortId, newPortId };
}

function renameSubGraphInputData(
  node: ChartNode,
  oldPortId: string,
  newPortId: string,
): { node: ChartNode; changed: boolean } {
  if (node.type !== 'subGraph') {
    return { node, changed: false };
  }

  const nodeData = node.data as Record<string, unknown> & { inputData?: Record<string, unknown> };
  const inputData = nodeData.inputData;

  if (!inputData || !(oldPortId in inputData)) {
    return { node, changed: false };
  }

  const nextInputData = { ...inputData };
  if (!(newPortId in nextInputData)) {
    nextInputData[newPortId] = nextInputData[oldPortId];
  }
  delete nextInputData[oldPortId];

  return {
    node: {
      ...node,
      data: {
        ...nodeData,
        inputData: nextInputData,
      },
    } as ChartNode,
    changed: true,
  };
}

function rewriteConnectionsForSubGraphInputRename({
  connections,
  newPortId,
  oldPortId,
  subGraphNodeId,
}: {
  connections: readonly NodeConnection[];
  newPortId: string;
  oldPortId: string;
  subGraphNodeId: NodeId;
}): { connections: NodeConnection[]; changed: boolean } {
  const hasExistingNewConnection = connections.some(
    (connection) => connection.inputNodeId === subGraphNodeId && connection.inputId === newPortId,
  );
  let keptNewConnection = false;
  let movedOldConnection = false;
  let changed = false;
  const nextConnections: NodeConnection[] = [];

  for (const connection of connections) {
    const isTargetConnection =
      connection.inputNodeId === subGraphNodeId && (connection.inputId === oldPortId || connection.inputId === newPortId);

    if (!isTargetConnection) {
      nextConnections.push(connection);
      continue;
    }

    if (connection.inputId === newPortId) {
      if (keptNewConnection) {
        changed = true;
        continue;
      }

      keptNewConnection = true;
      nextConnections.push(connection);
      continue;
    }

    if (hasExistingNewConnection || movedOldConnection) {
      changed = true;
      continue;
    }

    movedOldConnection = true;
    changed = true;
    nextConnections.push({ ...connection, inputId: newPortId as PortId });
  }

  return { connections: changed ? nextConnections : [...connections], changed };
}

function getConnectionKey(connection: NodeConnection): string {
  return `${connection.outputNodeId}|${connection.outputId}|${connection.inputNodeId}|${connection.inputId}`;
}

function rewriteConnectionsForSubGraphOutputRename({
  connections,
  newPortId,
  oldPortId,
  subGraphNodeId,
}: {
  connections: readonly NodeConnection[];
  newPortId: string;
  oldPortId: string;
  subGraphNodeId: NodeId;
}): { connections: NodeConnection[]; changed: boolean } {
  let changed = false;
  const seenKeys = new Map<string, { rewritten: boolean }>();
  const nextConnections: NodeConnection[] = [];

  for (const connection of connections) {
    const rewritten = connection.outputNodeId === subGraphNodeId && connection.outputId === oldPortId;
    const nextConnection = rewritten ? { ...connection, outputId: newPortId as PortId } : connection;
    const connectionKey = getConnectionKey(nextConnection);
    const existingConnection = seenKeys.get(connectionKey);

    if (existingConnection && (existingConnection.rewritten || rewritten)) {
      changed = true;
      continue;
    }

    seenKeys.set(connectionKey, { rewritten });
    nextConnections.push(nextConnection);
    changed ||= nextConnection !== connection;
  }

  return { connections: changed ? nextConnections : [...connections], changed };
}

function reconcileGraph({
  graph,
  kind,
  newPortId,
  oldPortId,
  targetGraphId,
}: {
  graph: NodeGraph;
  kind: GraphPortRenameKind;
  newPortId: string;
  oldPortId: string;
  targetGraphId: GraphId;
}): { graph: NodeGraph; changed: boolean } {
  let changed = false;
  let nextConnections = [...graph.connections];
  const nextNodes = graph.nodes.map((node) => {
    if (node.type !== 'subGraph' || (node.data as { graphId?: GraphId }).graphId !== targetGraphId) {
      return node;
    }

    const connectionResult =
      kind === 'input'
        ? rewriteConnectionsForSubGraphInputRename({
            connections: nextConnections,
            newPortId,
            oldPortId,
            subGraphNodeId: node.id,
          })
        : rewriteConnectionsForSubGraphOutputRename({
            connections: nextConnections,
            newPortId,
            oldPortId,
            subGraphNodeId: node.id,
          });
    nextConnections = connectionResult.connections;

    const inputDataResult =
      kind === 'input' ? renameSubGraphInputData(node, oldPortId, newPortId) : { node, changed: false };
    const orderResult = renameSubGraphPortOrder(
      inputDataResult.node,
      getSubGraphPortOrderKey(kind),
      oldPortId,
      newPortId,
    );
    changed ||= connectionResult.changed || inputDataResult.changed || orderResult.changed;
    return orderResult.node;
  });

  return {
    graph: {
      ...graph,
      nodes: changed ? nextNodes : [...graph.nodes],
      connections: changed ? nextConnections : [...graph.connections],
    },
    changed,
  };
}

export function rewriteSubGraphCallerGraphForGraphPortRename({
  graph,
  kind,
  newPortId,
  oldPortId,
  targetGraphId,
}: {
  graph: NodeGraph;
  kind: GraphPortRenameKind;
  newPortId: string;
  oldPortId: string;
  targetGraphId: GraphId;
}): { graph: NodeGraph; changed: boolean } {
  return reconcileGraph({ graph, kind, newPortId, oldPortId, targetGraphId });
}

export function propagateGraphPortRename({
  currentGraphId,
  editedNodeId,
  kind,
  nextCurrentConnections,
  nextCurrentNodes,
  previousCurrentNodes,
  project,
}: {
  currentGraphId: GraphId | undefined;
  editedNodeId: NodeId;
  kind: GraphPortRenameKind;
  nextCurrentConnections: readonly NodeConnection[];
  nextCurrentNodes: readonly ChartNode[];
  previousCurrentNodes: readonly ChartNode[];
  project: Project;
}): PropagateGraphPortRenameResult {
  const fallbackResult: PropagateGraphPortRenameResult = {
    nextCurrentConnections: [...nextCurrentConnections],
    nextCurrentNodes: [...nextCurrentNodes],
    projectGraphSnapshots: {},
  };
  const rename = currentGraphId
    ? getGraphPortRename({ editedNodeId, kind, previousCurrentNodes, nextCurrentNodes })
    : undefined;

  if (!currentGraphId || !rename) {
    return fallbackResult;
  }

  const currentGraph: NodeGraph = {
    metadata: project.graphs[currentGraphId]?.metadata ?? {
      id: currentGraphId,
      name: 'Current Graph',
      description: '',
    },
    nodes: [...nextCurrentNodes],
    connections: [...nextCurrentConnections],
  };
  const graphEntries: Array<[GraphId, NodeGraph]> = Object.entries(project.graphs).map(([graphId, graph]) => [
    graphId as GraphId,
    graphId === currentGraphId ? currentGraph : graph,
  ]);

  if (!graphEntries.some(([graphId]) => graphId === currentGraphId)) {
    graphEntries.push([currentGraphId, currentGraph]);
  }

  const projectGraphSnapshots: GraphPortRenameProjectGraphSnapshots = {};
  let resolvedCurrentGraph = currentGraph;

  for (const [graphId, graph] of graphEntries) {
    const result = reconcileGraph({
      graph,
      kind,
      newPortId: rename.newPortId,
      oldPortId: rename.oldPortId,
      targetGraphId: currentGraphId,
    });

    if (!result.changed) {
      continue;
    }

    if (graphId === currentGraphId) {
      resolvedCurrentGraph = result.graph;
      continue;
    }

    projectGraphSnapshots[graphId] = {
      previousGraph: structuredClone(project.graphs[graphId]!),
      nextGraph: result.graph,
    };
  }

  return {
    nextCurrentConnections: resolvedCurrentGraph.connections,
    nextCurrentNodes: resolvedCurrentGraph.nodes,
    projectGraphSnapshots,
  };
}
