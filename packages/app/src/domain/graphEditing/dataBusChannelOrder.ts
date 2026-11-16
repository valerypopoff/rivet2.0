import {
  canRenderDataBusNode,
  getDataBusInputChannelIndex,
  getDataBusOutputChannelIndex,
  resolveNodePrefabInstance,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type Project,
} from '@valerypopoff/rivet2-core';

export type DataBusChannelOrderChange = {
  nodeId: NodeId;
  before: number[] | undefined;
  after: number[];
};

/** Ignore stale/duplicate saved entries; newly active channels follow the saved ones. */
export function getDataBusChannelOrder(activeIndices: readonly number[], preferred: readonly number[] = []): number[] {
  const remaining = new Set(activeIndices);
  const order: number[] = [];
  for (const index of Array.isArray(preferred) ? preferred : []) {
    if (remaining.delete(index)) order.push(index);
  }
  return [...order, ...remaining];
}

export function getConnectedDataBusChannelOrder(node: ChartNode, connections: readonly NodeConnection[]): number[] {
  const active = new Set<number>();
  for (const connection of connections) {
    const input = connection.inputNodeId === node.id ? getDataBusInputChannelIndex(connection.inputId) : undefined;
    const output = connection.outputNodeId === node.id ? getDataBusOutputChannelIndex(connection.outputId) : undefined;
    if (input != null) active.add(input);
    if (output != null) active.add(output);
  }
  return getDataBusChannelOrder(
    [...active].sort((a, b) => a - b),
    node.visualData.dataBusChannelOrder,
  );
}

/** Freeze existing positions before adding a channel, including when a vacant port ID is reused. */
export function captureDataBusChannelOrders(options: {
  nodes: readonly ChartNode[];
  project: Project;
  previousConnections: readonly NodeConnection[];
  nextConnections: readonly NodeConnection[];
  newConnection: NodeConnection;
}): DataBusChannelOrderChange[] {
  const ids = new Set([options.newConnection.inputNodeId, options.newConnection.outputNodeId]);
  return options.nodes.flatMap((node) => {
    if (!ids.has(node.id) || !canRenderDataBusNode(resolveNodePrefabInstance(options.project, node))) return [];
    const previous = getConnectedDataBusChannelOrder(node, options.previousConnections);
    const next = getConnectedDataBusChannelOrder(node, options.nextConnections);
    // Only an added channel needs bookkeeping. Provider replacement and new receivers retain their positions.
    const previousSet = new Set(previous);
    if (next.every((index) => previousSet.has(index))) return [];
    return [
      { nodeId: node.id, before: node.visualData.dataBusChannelOrder, after: getDataBusChannelOrder(next, previous) },
    ];
  });
}

export function applyDataBusChannelOrders(
  nodes: ChartNode[],
  changes: readonly DataBusChannelOrderChange[],
  undo = false,
): ChartNode[] {
  if (changes.length === 0) return nodes;
  const changesById = new Map(changes.map((change) => [change.nodeId, change]));
  return nodes.map((node) => {
    const change = changesById.get(node.id);
    if (!change) return node;
    const visualData = { ...node.visualData };
    const order = undo ? change.before : change.after;
    if (order == null) delete visualData.dataBusChannelOrder;
    else visualData.dataBusChannelOrder = [...order];
    return { ...node, visualData };
  });
}

export type ReorderDataBusChannelsParams = {
  nodeId: NodeId;
  channelIndex: number;
  targetChannelIndex: number;
  side: 'before' | 'after';
};

/** Undefined means a stale target or a move that would leave the order unchanged. */
export function moveDataBusChannel(order: readonly number[], move: ReorderDataBusChannelsParams): number[] | undefined {
  const from = order.indexOf(move.channelIndex);
  const target = order.indexOf(move.targetChannelIndex);
  if (from < 0 || target < 0) return undefined;
  let to = target + (move.side === 'after' ? 1 : 0);
  if (from < to) to--;
  if (from === to) return undefined;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, move.channelIndex);
  return next;
}
