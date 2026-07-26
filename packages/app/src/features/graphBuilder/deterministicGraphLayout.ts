import type { ChartNode, GraphId, NodeConnection, NodeId } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import type { GraphBuilderAuthoringProject } from '../../domain/graphBuilder/index.js';

const DEFAULT_NODE_WIDTH = 230;
const DEFAULT_NODE_HEIGHT = 180;
const HORIZONTAL_GAP = 140;
const VERTICAL_GAP = 80;
const COLLISION_PADDING = 24;

type PositionedNode = {
  id: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
};

function nodeWidth(node: ChartNode): number {
  return Number.isFinite(node.visualData.width) && (node.visualData.width ?? 0) > 0
    ? node.visualData.width!
    : DEFAULT_NODE_WIDTH;
}

function nodeHeight(_node: ChartNode): number {
  return DEFAULT_NODE_HEIGHT;
}

function positionedNode(node: ChartNode): PositionedNode {
  return {
    id: node.id,
    x: node.visualData.x,
    y: node.visualData.y,
    width: nodeWidth(node),
    height: nodeHeight(node),
  };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!;
}

function overlaps(left: PositionedNode, right: PositionedNode): boolean {
  return (
    left.x < right.x + right.width + COLLISION_PADDING &&
    left.x + left.width + COLLISION_PADDING > right.x &&
    left.y < right.y + right.height + COLLISION_PADDING &&
    left.y + left.height + COLLISION_PADDING > right.y
  );
}

function safeCoordinate(value: number): number {
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
}

function buildCreatedAdjacency(
  createdNodes: readonly ChartNode[],
  connections: readonly NodeConnection[],
): Map<NodeId, NodeId[]> {
  const createdIds = new Set(createdNodes.map((node) => node.id));
  const order = new Map(createdNodes.map((node, index) => [node.id, index]));
  const adjacency = new Map(createdNodes.map((node) => [node.id, [] as NodeId[]]));

  for (const connection of connections) {
    if (createdIds.has(connection.outputNodeId) && createdIds.has(connection.inputNodeId)) {
      adjacency.get(connection.outputNodeId)!.push(connection.inputNodeId);
    }
  }

  for (const targets of adjacency.values()) {
    targets.sort((left, right) => order.get(left)! - order.get(right)!);
  }
  return adjacency;
}

function findStronglyConnectedComponents(
  createdNodes: readonly ChartNode[],
  adjacency: ReadonlyMap<NodeId, readonly NodeId[]>,
): NodeId[][] {
  const order = new Map(createdNodes.map((node, index) => [node.id, index]));
  const indices = new Map<NodeId, number>();
  const lowLinks = new Map<NodeId, number>();
  const stack: NodeId[] = [];
  const inStack = new Set<NodeId>();
  const components: NodeId[][] = [];
  let nextIndex = 0;

  const visit = (nodeId: NodeId): void => {
    indices.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    inStack.add(nodeId);

    for (const targetId of adjacency.get(nodeId) ?? []) {
      if (!indices.has(targetId)) {
        visit(targetId);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(targetId)!));
      } else if (inStack.has(targetId)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indices.get(targetId)!));
      }
    }

    if (lowLinks.get(nodeId) !== indices.get(nodeId)) {
      return;
    }

    const component: NodeId[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      inStack.delete(member);
      component.push(member);
      if (member === nodeId) {
        break;
      }
    }
    component.sort((left, right) => order.get(left)! - order.get(right)!);
    components.push(component);
  };

  for (const node of createdNodes) {
    if (!indices.has(node.id)) {
      visit(node.id);
    }
  }

  components.sort((left, right) => order.get(left[0]!)! - order.get(right[0]!)!);
  return components;
}

function buildComponentTopology(
  components: readonly (readonly NodeId[])[],
  adjacency: ReadonlyMap<NodeId, readonly NodeId[]>,
): {
  componentByNodeId: ReadonlyMap<NodeId, number>;
  outgoing: ReadonlyMap<number, readonly number[]>;
  ranks: readonly number[];
  weakGroups: readonly (readonly number[])[];
} {
  const componentByNodeId = new Map<NodeId, number>();
  components.forEach((component, componentIndex) => {
    component.forEach((nodeId) => componentByNodeId.set(nodeId, componentIndex));
  });

  const outgoingSets = new Map<number, Set<number>>();
  const incomingCount = components.map(() => 0);
  components.forEach((_component, index) => outgoingSets.set(index, new Set()));
  for (const [sourceId, targetIds] of adjacency) {
    const sourceComponent = componentByNodeId.get(sourceId)!;
    for (const targetId of targetIds) {
      const targetComponent = componentByNodeId.get(targetId)!;
      if (sourceComponent === targetComponent || outgoingSets.get(sourceComponent)!.has(targetComponent)) {
        continue;
      }
      outgoingSets.get(sourceComponent)!.add(targetComponent);
      incomingCount[targetComponent]! += 1;
    }
  }

  const outgoing = new Map<number, readonly number[]>(
    [...outgoingSets].map(([index, targets]) => [index, [...targets].sort((left, right) => left - right)]),
  );
  const ranks = components.map(() => 0);
  const ready = incomingCount
    .map((count, index) => ({ count, index }))
    .filter(({ count }) => count === 0)
    .map(({ index }) => index);
  let readyIndex = 0;
  while (readyIndex < ready.length) {
    const component = ready[readyIndex++]!;
    for (const target of outgoing.get(component) ?? []) {
      ranks[target] = Math.max(ranks[target]!, ranks[component]! + 1);
      incomingCount[target]! -= 1;
      if (incomingCount[target] === 0) {
        ready.push(target);
      }
    }
  }

  const undirected = new Map<number, Set<number>>(components.map((_component, index) => [index, new Set<number>()]));
  for (const [source, targets] of outgoing) {
    for (const target of targets) {
      undirected.get(source)!.add(target);
      undirected.get(target)!.add(source);
    }
  }
  const seen = new Set<number>();
  const weakGroups: number[][] = [];
  for (let component = 0; component < components.length; component += 1) {
    if (seen.has(component)) {
      continue;
    }
    const group: number[] = [];
    const queue = [component];
    seen.add(component);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      group.push(current);
      for (const neighbor of [...undirected.get(current)!].sort((left, right) => left - right)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    group.sort((left, right) => left - right);
    weakGroups.push(group);
  }

  return { componentByNodeId, outgoing, ranks, weakGroups };
}

function findCollisionFreeY(candidate: PositionedNode, occupied: readonly PositionedNode[]): number {
  const step = candidate.height + VERTICAL_GAP;
  let y = candidate.y;
  const maximumAttempts = occupied.length + 1;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const positioned = { ...candidate, y };
    if (!occupied.some((other) => overlaps(positioned, other))) {
      return y;
    }
    y += step;
  }

  return occupied.reduce((bottom, node) => Math.max(bottom, node.y + node.height + VERTICAL_GAP), y);
}

export function layoutGraphBuilderCreatedNodes(input: {
  base: GraphBuilderAuthoringProject;
  project: GraphBuilderAuthoringProject;
  graphId: GraphId;
  createdNodeIds: readonly NodeId[];
}): GraphBuilderAuthoringProject {
  const project = cloneDeep(input.project);
  const graph = project.graphs[input.graphId];
  const baseGraph = input.base.graphs[input.graphId];
  if (!graph || !baseGraph) {
    return project;
  }

  const baseNodeIds = new Set(baseGraph.nodes.map((node) => node.id));
  const requestedCreatedIds = new Set(input.createdNodeIds);
  const createdNodes = graph.nodes.filter((node) => requestedCreatedIds.has(node.id) && !baseNodeIds.has(node.id));
  if (createdNodes.length === 0) {
    return project;
  }

  const createdIds = new Set(createdNodes.map((node) => node.id));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const existingNodes = graph.nodes.filter((node) => !createdIds.has(node.id));
  const occupied = existingNodes.map(positionedNode);
  const adjacency = buildCreatedAdjacency(createdNodes, graph.connections);
  const components = findStronglyConnectedComponents(createdNodes, adjacency);
  const topology = buildComponentTopology(components, adjacency);
  const horizontalStep = Math.max(DEFAULT_NODE_WIDTH, ...createdNodes.map(nodeWidth)) + HORIZONTAL_GAP;
  const existingRight =
    existingNodes.length === 0 ? 0 : Math.max(...existingNodes.map((node) => node.visualData.x + nodeWidth(node)));
  const existingTop = existingNodes.length === 0 ? 0 : Math.min(...existingNodes.map((node) => node.visualData.y));
  const externalCentersByComponent = new Map<number, number[]>(components.map((_component, index) => [index, []]));
  const baseXCandidatesByGroup = topology.weakGroups.map(() => [] as number[]);
  const groupByComponent = new Map<number, number>();
  topology.weakGroups.forEach((group, groupIndex) => {
    group.forEach((component) => groupByComponent.set(component, groupIndex));
  });

  for (const connection of graph.connections) {
    const outputCreated = createdIds.has(connection.outputNodeId);
    const inputCreated = createdIds.has(connection.inputNodeId);
    if (outputCreated === inputCreated) {
      continue;
    }

    const createdNodeId = outputCreated ? connection.outputNodeId : connection.inputNodeId;
    const existingNodeId = outputCreated ? connection.inputNodeId : connection.outputNodeId;
    const createdNode = nodesById.get(createdNodeId)!;
    const existingNode = nodesById.get(existingNodeId);
    if (!existingNode) {
      continue;
    }
    const component = topology.componentByNodeId.get(createdNodeId)!;
    const group = groupByComponent.get(component)!;
    const rank = topology.ranks[component]!;
    const desiredNodeX = outputCreated
      ? existingNode.visualData.x - HORIZONTAL_GAP - nodeWidth(createdNode)
      : existingNode.visualData.x + nodeWidth(existingNode) + HORIZONTAL_GAP;
    baseXCandidatesByGroup[group]!.push(desiredNodeX - rank * horizontalStep);
    externalCentersByComponent.get(component)!.push(existingNode.visualData.y + nodeHeight(existingNode) / 2);
  }

  for (const [groupIndex, group] of topology.weakGroups.entries()) {
    const groupBaseX =
      median(baseXCandidatesByGroup[groupIndex]!) ?? (existingNodes.length === 0 ? 0 : existingRight + HORIZONTAL_GAP);
    const componentsByRank = new Map<number, number[]>();
    for (const component of group) {
      const rank = topology.ranks[component]!;
      const atRank = componentsByRank.get(rank) ?? [];
      atRank.push(component);
      componentsByRank.set(rank, atRank);
    }

    for (const [rank, rankedComponents] of [...componentsByRank].sort(([left], [right]) => left - right)) {
      const rankedNodeIds = rankedComponents.flatMap((component) => components[component]!);
      const anchoredCenters = rankedComponents.flatMap((component) => externalCentersByComponent.get(component) ?? []);
      const centerY = median(anchoredCenters) ?? existingTop + DEFAULT_NODE_HEIGHT / 2;
      const totalHeight = rankedNodeIds.reduce(
        (height, nodeId, index) => height + nodeHeight(nodesById.get(nodeId)!) + (index === 0 ? 0 : VERTICAL_GAP),
        0,
      );
      let nextY = centerY - totalHeight / 2;

      for (const nodeId of rankedNodeIds) {
        const node = nodesById.get(nodeId)!;
        const candidate: PositionedNode = {
          id: node.id,
          x: safeCoordinate(groupBaseX + rank * horizontalStep),
          y: safeCoordinate(nextY),
          width: nodeWidth(node),
          height: nodeHeight(node),
        };
        candidate.y = safeCoordinate(findCollisionFreeY(candidate, occupied));
        node.visualData.x = candidate.x;
        node.visualData.y = candidate.y;
        occupied.push(candidate);
        nextY = candidate.y + candidate.height + VERTICAL_GAP;
      }
    }
  }

  return project;
}
