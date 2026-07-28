import type { NodeGraph } from '@valerypopoff/rivet2-core';
import {
  canonicalGraphBuilderStringify,
  compareGraphBuilderStrings,
  parsePortableJson,
  type PortableJsonObject,
  type PortableJsonValue,
} from '../graphBuilderDomain.js';

export type NormalizedGraphBuilderEvaluationNode = Readonly<{
  id: string;
  type: string;
  title: string;
  semantic: PortableJsonObject;
}>;

export type NormalizedGraphBuilderEvaluationConnection = Readonly<{
  outputNodeId: string;
  outputId: string;
  inputNodeId: string;
  inputId: string;
}>;

export type NormalizedGraphBuilderEvaluationGraph = Readonly<{
  metadata: PortableJsonObject;
  nodes: readonly NormalizedGraphBuilderEvaluationNode[];
  connections: readonly NormalizedGraphBuilderEvaluationConnection[];
}>;

type SourceNode = NodeGraph['nodes'][number];
type SourceConnection = NormalizedGraphBuilderEvaluationConnection;
type NodePartition = string[][];

const MAX_CANONICAL_SEARCH_STATES = 50_000;
const MAX_CANONICAL_SEARCH_DEPTH = 256;

/**
 * Produces a semantic comparison artifact. Runtime IDs and canvas-only geometry
 * are deliberately absent; envelope, node data, variants, tests, graph text,
 * and non-positional visual metadata remain observable.
 */
export function normalizeGraphBuilderEvaluationGraph(input: unknown): NormalizedGraphBuilderEvaluationGraph {
  if (!isRecord(input) || !Array.isArray(input.nodes) || !Array.isArray(input.connections)) {
    throw new Error('Graph Builder evaluation expected a graph with node and connection arrays.');
  }

  const graph = input as unknown as NodeGraph;
  const sourceNodes = graph.nodes.map((node, index) => parseSourceNode(node, index));
  const nodesById = new Map(sourceNodes.map((node) => [String(node.id), node]));
  if (nodesById.size !== sourceNodes.length) {
    throw new Error('Graph Builder evaluation cannot normalize a graph with duplicate node IDs.');
  }

  const sourceConnections = graph.connections.map((connection, index) => {
    const outputNodeId = String(connection.outputNodeId);
    const inputNodeId = String(connection.inputNodeId);
    if (!nodesById.has(outputNodeId) || !nodesById.has(inputNodeId)) {
      throw new Error(`Graph Builder evaluation connection ${index} references a missing node.`);
    }
    return {
      outputNodeId,
      outputId: String(connection.outputId),
      inputNodeId,
      inputId: String(connection.inputId),
    };
  });

  const orderedNodeIds = findCanonicalNodeOrder(sourceNodes, sourceConnections);
  const orderedNodes = orderedNodeIds.map((nodeId) => nodesById.get(nodeId)!);
  const normalizedIds = new Map(
    orderedNodes.map((node, index) => [String(node.id), `node:${String(index + 1).padStart(4, '0')}`] as const),
  );

  const nodes = orderedNodes.map((node) => ({
    id: normalizedIds.get(String(node.id))!,
    type: node.type,
    title: node.title,
    semantic: node.semantic,
  }));
  const connections = sourceConnections
    .map((connection) => ({
      outputNodeId: normalizedIds.get(connection.outputNodeId)!,
      outputId: connection.outputId,
      inputNodeId: normalizedIds.get(connection.inputNodeId)!,
      inputId: connection.inputId,
    }))
    .sort(compareCanonical);

  return {
    metadata: normalizeGraphMetadata(graph.metadata),
    nodes,
    connections,
  };
}

function findCanonicalNodeOrder(
  sourceNodes: readonly (SourceNode & { semantic: PortableJsonObject })[],
  connections: readonly SourceConnection[],
): string[] {
  if (sourceNodes.length === 0) {
    return [];
  }
  const nodesById = new Map(sourceNodes.map((node) => [String(node.id), node]));
  const initialGroups = new Map<string, string[]>();
  for (const node of sourceNodes) {
    const semanticIdentity = canonicalGraphBuilderStringify(node.semantic);
    const group = initialGroups.get(semanticIdentity) ?? [];
    group.push(String(node.id));
    initialGroups.set(semanticIdentity, group);
  }
  const initialPartition = [...initialGroups.entries()]
    .sort(([left], [right]) => compareGraphBuilderStrings(left, right))
    .map(([, nodeIds]) => nodeIds);
  const incomingByNode = groupConnectionsByNode(connections, 'inputNodeId');
  const outgoingByNode = groupConnectionsByNode(connections, 'outputNodeId');
  let visitedStates = 0;

  const search = (rawPartition: NodePartition, depth: number): { canonical: string; order: string[] } => {
    visitedStates += 1;
    if (visitedStates > MAX_CANONICAL_SEARCH_STATES || depth > MAX_CANONICAL_SEARCH_DEPTH) {
      throw new Error(
        'Graph Builder evaluation canonicalization exceeded its safe search bound for a symmetric graph.',
      );
    }
    const partition = refinePartition(rawPartition, incomingByNode, outgoingByNode, sourceNodes.length);
    const target = chooseIndividualizationCell(partition, connections);
    if (!target) {
      const order = partition.flat();
      return {
        canonical: canonicalCandidate(order, nodesById, connections),
        order,
      };
    }

    let best: { canonical: string; order: string[] } | undefined;
    for (const nodeId of target.cell) {
      const remainder = target.cell.filter((candidate) => candidate !== nodeId);
      const individualized = [
        ...partition.slice(0, target.index),
        [nodeId],
        remainder,
        ...partition.slice(target.index + 1),
      ];
      const candidate = search(individualized, depth + 1);
      if (!best || candidate.canonical < best.canonical) {
        best = candidate;
      }
    }
    return best!;
  };

  return search(initialPartition, 0).order;
}

function refinePartition(
  initial: NodePartition,
  incomingByNode: ReadonlyMap<string, readonly SourceConnection[]>,
  outgoingByNode: ReadonlyMap<string, readonly SourceConnection[]>,
  nodeCount: number,
): NodePartition {
  let partition = initial.map((cell) => [...cell]);
  for (let round = 0; round <= nodeCount; round += 1) {
    const classByNode = new Map(partition.flatMap((cell, index) => cell.map((nodeId) => [nodeId, index] as const)));
    let split = false;
    const next: NodePartition = [];
    for (const cell of partition) {
      const groups = new Map<string, string[]>();
      for (const nodeId of cell) {
        const signature = canonicalGraphBuilderStringify(
          parsePortableJson({
            incoming: (incomingByNode.get(nodeId) ?? [])
              .map((connection) => ({
                inputId: connection.inputId,
                outputId: connection.outputId,
                neighborClass: classByNode.get(connection.outputNodeId)!,
              }))
              .sort(compareCanonical),
            outgoing: (outgoingByNode.get(nodeId) ?? [])
              .map((connection) => ({
                outputId: connection.outputId,
                inputId: connection.inputId,
                neighborClass: classByNode.get(connection.inputNodeId)!,
              }))
              .sort(compareCanonical),
          }),
        );
        const group = groups.get(signature) ?? [];
        group.push(nodeId);
        groups.set(signature, group);
      }
      const refinedCells = [...groups.entries()]
        .sort(([left], [right]) => compareGraphBuilderStrings(left, right))
        .map(([, nodeIds]) => nodeIds);
      split ||= refinedCells.length > 1;
      next.push(...refinedCells);
    }
    if (!split) {
      return next;
    }
    partition = next;
  }
  throw new Error('Graph Builder evaluation partition refinement did not converge within its safe bound.');
}

function chooseIndividualizationCell(
  partition: NodePartition,
  connections: readonly SourceConnection[],
): { cell: string[]; index: number } | undefined {
  return partition
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.length > 1 && !isFreelyPermutableCell(cell, partition, connections))
    .sort((left, right) => left.cell.length - right.cell.length || left.index - right.index)[0];
}

function isFreelyPermutableCell(
  cell: readonly string[],
  partition: NodePartition,
  connections: readonly SourceConnection[],
): boolean {
  if (cell.length < 2) {
    return true;
  }
  const cellSet = new Set(cell);
  const outsideNodeIds = partition.flat().filter((nodeId) => !cellSet.has(nodeId));
  const first = cell[0]!;
  const selfSignature = edgeSignature(first, first, connections);
  const distinctSignature = edgeSignature(first, cell[1]!, connections);

  for (const nodeId of cell) {
    if (edgeSignature(nodeId, nodeId, connections) !== selfSignature) {
      return false;
    }
    for (const otherNodeId of cell) {
      if (nodeId !== otherNodeId && edgeSignature(nodeId, otherNodeId, connections) !== distinctSignature) {
        return false;
      }
    }
    for (const outsideNodeId of outsideNodeIds) {
      if (
        edgeSignature(nodeId, outsideNodeId, connections) !== edgeSignature(first, outsideNodeId, connections) ||
        edgeSignature(outsideNodeId, nodeId, connections) !== edgeSignature(outsideNodeId, first, connections)
      ) {
        return false;
      }
    }
  }
  return true;
}

function edgeSignature(outputNodeId: string, inputNodeId: string, connections: readonly SourceConnection[]): string {
  return canonicalGraphBuilderStringify(
    connections
      .filter((connection) => connection.outputNodeId === outputNodeId && connection.inputNodeId === inputNodeId)
      .map((connection) => ({ outputId: connection.outputId, inputId: connection.inputId }))
      .sort(compareCanonical),
  );
}

function canonicalCandidate(
  order: readonly string[],
  nodesById: ReadonlyMap<string, SourceNode & { semantic: PortableJsonObject }>,
  connections: readonly SourceConnection[],
): string {
  const normalizedIds = new Map(
    order.map((nodeId, index) => [nodeId, `node:${String(index + 1).padStart(4, '0')}`] as const),
  );
  return canonicalGraphBuilderStringify(
    parsePortableJson({
      nodes: order.map((nodeId) => {
        const node = nodesById.get(nodeId)!;
        return {
          id: normalizedIds.get(nodeId)!,
          type: node.type,
          title: node.title,
          semantic: node.semantic,
        };
      }),
      connections: connections
        .map((connection) => ({
          outputNodeId: normalizedIds.get(connection.outputNodeId)!,
          outputId: connection.outputId,
          inputNodeId: normalizedIds.get(connection.inputNodeId)!,
          inputId: connection.inputId,
        }))
        .sort(compareCanonical),
    }),
  );
}

function groupConnectionsByNode(
  connections: readonly SourceConnection[],
  key: 'inputNodeId' | 'outputNodeId',
): ReadonlyMap<string, readonly SourceConnection[]> {
  const grouped = new Map<string, SourceConnection[]>();
  for (const connection of connections) {
    const nodeId = connection[key];
    const entries = grouped.get(nodeId) ?? [];
    entries.push(connection);
    grouped.set(nodeId, entries);
  }
  return grouped;
}

export function canonicalizeNormalizedGraphBuilderEvaluationGraph(
  graph: NormalizedGraphBuilderEvaluationGraph,
): string {
  return canonicalGraphBuilderStringify(graph as unknown as PortableJsonValue);
}

function parseSourceNode(node: unknown, index: number): SourceNode & { semantic: PortableJsonObject } {
  if (!isRecord(node) || typeof node.id !== 'string' || node.id.length === 0) {
    throw new Error(`Graph Builder evaluation node ${index} has no stable source ID.`);
  }
  if (typeof node.type !== 'string' || node.type.length === 0 || typeof node.title !== 'string') {
    throw new Error(`Graph Builder evaluation node ${index} has an invalid type or title.`);
  }

  const { id: _id, visualData, ...semanticFields } = node;
  const semanticVisualData = isRecord(visualData)
    ? Object.fromEntries(Object.entries(visualData).filter(([key]) => !['x', 'y', 'width', 'zIndex'].includes(key)))
    : {};
  const semantic = parsePortableJson(
    createEvaluationJsonSnapshot({
      ...semanticFields,
      visualData: semanticVisualData,
    }),
  );
  if (!isRecord(semantic)) {
    throw new Error(`Graph Builder evaluation node ${index} did not normalize to an object.`);
  }

  return {
    ...(node as unknown as SourceNode),
    semantic,
  };
}

function normalizeGraphMetadata(metadata: NodeGraph['metadata']): PortableJsonObject {
  if (!metadata) {
    return Object.create(null) as PortableJsonObject;
  }
  const { id: _id, ...semanticMetadata } = metadata;
  const normalized = parsePortableJson(createEvaluationJsonSnapshot(semanticMetadata));
  if (!isRecord(normalized)) {
    throw new Error('Graph Builder evaluation graph metadata did not normalize to an object.');
  }
  return normalized;
}

function compareCanonical(left: unknown, right: unknown): number {
  return compareGraphBuilderStrings(
    canonicalGraphBuilderStringify(parsePortableJson(left)),
    canonicalGraphBuilderStringify(parsePortableJson(right)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const omittedValue = Symbol('omitted-evaluation-value');

function createEvaluationJsonSnapshot(value: unknown): unknown {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, inArray: boolean): unknown | typeof omittedValue => {
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      return inArray ? null : omittedValue;
    }
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'number'
    ) {
      return current;
    }
    if (typeof current === 'bigint') {
      throw new Error('Graph Builder evaluation cannot normalize bigint node data.');
    }
    if (typeof current !== 'object') {
      throw new Error(`Graph Builder evaluation cannot normalize ${typeof current} node data.`);
    }
    if (ancestors.has(current)) {
      throw new Error('Graph Builder evaluation cannot normalize cyclic node data.');
    }
    ancestors.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      result = current.map((child) => visit(child, true));
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Graph Builder evaluation accepts only serialized plain-object node data.');
      }
      result = Object.fromEntries(
        Object.entries(current).flatMap(([key, child]) => {
          const normalizedChild = visit(child, false);
          return normalizedChild === omittedValue ? [] : [[key, normalizedChild]];
        }),
      );
    }
    ancestors.delete(current);
    return result;
  };

  const result = visit(value, false);
  if (result === omittedValue) {
    throw new Error('Graph Builder evaluation cannot normalize an omitted root value.');
  }
  return result;
}
