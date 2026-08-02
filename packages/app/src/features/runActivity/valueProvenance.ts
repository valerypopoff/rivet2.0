import {
  compileDataBusTopology,
  type ChartNode,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type ProcessId,
} from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../../state/dataFlow.js';
import type { RunActivityNodeInvocation, RunActivityRoot } from './runActivityJournal.js';
import { previewStoredDataValue } from './storedValuePreview.js';

const MAX_PROVENANCE_DEPTH = 12;

export type ValueProvenanceState =
  | 'connected'
  | 'source-invocation-unavailable'
  | 'unconnected'
  | 'not-supplied'
  | 'cycle'
  | 'depth-limit';

export type ValueProvenanceSource = {
  nodeId: NodeId;
  nodeTitle: string;
  outputPortId: PortId;
  processId?: ProcessId;
  resultOrigin?: RunActivityNodeInvocation['resultOrigin'];
  status?: RunActivityNodeInvocation['status'];
  inputs?: ValueProvenanceInput[];
};

export type ValueProvenanceInput = {
  inputPortId: PortId;
  valuePreview?: string;
  valuePreviewRedacted?: boolean;
  state: ValueProvenanceState;
  message: string;
  source?: ValueProvenanceSource;
};

export type ValueProvenanceReport = {
  targetNodeTitle: string;
  inputs: ValueProvenanceInput[];
  partialReason?: string;
};

/**
 * Reconstructs a conservative, run-scoped explanation of where an invocation's
 * recorded inputs came from. It never compares or copies full values: the
 * graph topology supplies the edge, and a producer process is selected from
 * the latest compatible record preceding the consumer invocation.
 */
export function buildValueProvenanceReport(options: {
  graph: NodeGraph;
  root: RunActivityRoot;
  target: RunActivityNodeInvocation;
  runDataByNode: RunDataByNodeId;
}): ValueProvenanceReport {
  const nodesById = new Map(options.graph.nodes.map((node) => [node.id, node]));
  const targetNode = nodesById.get(options.target.nodeId);
  const { connections, partialReason } = getEffectiveConnections(options.graph);
  const topologyState = { usedCurrentTopology: false };
  const targetRunData = getRunData(options.runDataByNode, options.target);
  const targetConnections = getInvocationConnections(options.target, connections, topologyState);
  const inputIds = new Set<PortId>([
    ...Object.keys(targetRunData?.data.inputData ?? {}),
    ...targetConnections
      .filter((connection) => connection.inputNodeId === options.target.nodeId)
      .map((connection) => connection.inputId),
  ] as PortId[]);

  const reportPartialReason = joinPartialReasons(
    partialReason,
    topologyState.usedCurrentTopology
      ? 'Some invocation wiring was not captured; current graph wiring was used for those edges.'
      : undefined,
  );

  return {
    targetNodeTitle: targetNode?.title ?? options.target.nodeTitle ?? 'Deleted or unavailable node',
    inputs: [...inputIds].map((inputPortId) =>
      buildInputProvenance({
        root: options.root,
        runDataByNode: options.runDataByNode,
        connections,
        topologyState,
        nodesById,
        invocation: options.target,
        inputPortId,
        depth: 0,
        seen: new Set(),
      }),
    ),
    ...(reportPartialReason ? { partialReason: reportPartialReason } : {}),
  };
}

type BuildInputOptions = {
  root: RunActivityRoot;
  runDataByNode: RunDataByNodeId;
  connections: readonly NodeConnection[];
  topologyState: { usedCurrentTopology: boolean };
  nodesById: ReadonlyMap<NodeId, ChartNode>;
  invocation: RunActivityNodeInvocation;
  inputPortId: PortId;
  depth: number;
  seen: Set<string>;
};

function buildInputProvenance(options: BuildInputOptions): ValueProvenanceInput {
  const inputValue = getRunData(options.runDataByNode, options.invocation)?.data.inputData?.[options.inputPortId];
  const valuePreviewRedacted = inputValue != null && isSensitiveInputPortId(options.inputPortId);
  const valuePreview = inputValue && !valuePreviewRedacted ? previewStoredDataValue(inputValue) : undefined;
  const connection = getInvocationConnections(options.invocation, options.connections, options.topologyState).find(
    (candidate) => candidate.inputNodeId === options.invocation.nodeId && candidate.inputId === options.inputPortId,
  );

  if (!connection) {
    return {
      inputPortId: options.inputPortId,
      ...(valuePreview ? { valuePreview } : {}),
      ...(valuePreviewRedacted ? { valuePreviewRedacted: true } : {}),
      state: inputValue ? 'unconnected' : 'not-supplied',
      message: inputValue
        ? 'No graph connection recorded. The value was supplied outside ordinary graph wiring, such as node configuration or a port default.'
        : 'No value was supplied to this port in this invocation.',
    };
  }

  const sourceNode = options.nodesById.get(connection.outputNodeId);
  const sourceKey = `${options.invocation.graphRunId}:${connection.outputNodeId}:${connection.outputId}`;
  if (options.seen.has(sourceKey)) {
    return {
      inputPortId: options.inputPortId,
      ...(valuePreview ? { valuePreview } : {}),
      ...(valuePreviewRedacted ? { valuePreviewRedacted: true } : {}),
      state: 'cycle',
      message: 'The upstream provenance chain loops back to a previously visited source.',
    };
  }
  if (options.depth >= MAX_PROVENANCE_DEPTH) {
    return {
      inputPortId: options.inputPortId,
      ...(valuePreview ? { valuePreview } : {}),
      ...(valuePreviewRedacted ? { valuePreviewRedacted: true } : {}),
      state: 'depth-limit',
      message: `The upstream provenance chain was limited to ${MAX_PROVENANCE_DEPTH} hops.`,
    };
  }

  const sourceInvocation = findSourceInvocation(options.root, options.invocation, connection);
  const base = {
    inputPortId: options.inputPortId,
    ...(valuePreview ? { valuePreview } : {}),
    ...(valuePreviewRedacted ? { valuePreviewRedacted: true } : {}),
  };
  if (!sourceInvocation) {
    return {
      ...base,
      state: 'source-invocation-unavailable',
      message: `Connected from ${sourceNode?.title ?? connection.outputNodeId} / ${connection.outputId}, but its producing invocation is unavailable in this run record.`,
      source: {
        nodeId: connection.outputNodeId,
        nodeTitle: sourceNode?.title ?? 'Deleted or unavailable node',
        outputPortId: connection.outputId,
      },
    };
  }

  const nextSeen = new Set(options.seen);
  nextSeen.add(sourceKey);
  const sourceInputs = getInputPortIds(
    options.connections,
    options.runDataByNode,
    sourceInvocation,
    options.topologyState,
  );
  return {
    ...base,
    state: 'connected',
    message: `Connected from ${sourceNode?.title ?? connection.outputNodeId} / ${connection.outputId}.`,
    source: {
      nodeId: connection.outputNodeId,
      nodeTitle: sourceNode?.title ?? sourceInvocation.nodeTitle ?? 'Deleted or unavailable node',
      outputPortId: connection.outputId,
      processId: sourceInvocation.processId,
      resultOrigin: sourceInvocation.resultOrigin,
      status: sourceInvocation.status,
      ...(sourceInputs.length === 0
        ? {}
        : {
            inputs: sourceInputs.map((sourceInputPortId) =>
              buildInputProvenance({
                ...options,
                invocation: sourceInvocation,
                inputPortId: sourceInputPortId,
                depth: options.depth + 1,
                seen: nextSeen,
              }),
            ),
          }),
    },
  };
}

/**
 * Input IDs are user-authored, so this is intentionally conservative. The
 * inspector must not widen editor-only history into an easy secret viewer.
 */
function isSensitiveInputPortId(portId: PortId): boolean {
  const compact = String(portId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return (
    compact === 'token' ||
    compact.endsWith('token') ||
    [
      'apikey',
      'authorization',
      'authentication',
      'bearer',
      'cookie',
      'credential',
      'header',
      'password',
      'privatekey',
      'secret',
    ].some((fragment) => compact.includes(fragment))
  );
}

function getInputPortIds(
  connections: readonly NodeConnection[],
  runDataByNode: RunDataByNodeId,
  invocation: RunActivityNodeInvocation,
  topologyState: { usedCurrentTopology: boolean },
): PortId[] {
  return [
    ...new Set<PortId>([
      ...getInvocationConnections(invocation, connections, topologyState).map((connection) => connection.inputId),
      ...Object.keys(getRunData(runDataByNode, invocation)?.data.inputData ?? {}),
    ] as PortId[]),
  ];
}

function getInvocationConnections(
  invocation: RunActivityNodeInvocation,
  currentConnections: readonly NodeConnection[],
  topologyState: { usedCurrentTopology: boolean },
): readonly NodeConnection[] {
  if (invocation.inputConnections != null) return invocation.inputConnections;
  const fallbackConnections = currentConnections.filter((connection) => connection.inputNodeId === invocation.nodeId);
  if (fallbackConnections.length > 0) topologyState.usedCurrentTopology = true;
  return fallbackConnections;
}

function joinPartialReasons(...reasons: Array<string | undefined>): string | undefined {
  const present = reasons.filter((reason): reason is string => reason != null);
  return present.length > 0 ? present.join(' ') : undefined;
}

function findSourceInvocation(
  root: RunActivityRoot,
  target: RunActivityNodeInvocation,
  connection: NodeConnection,
): RunActivityNodeInvocation | undefined {
  const candidates = root.nodeInvocationOrder
    .map((key) => root.nodeInvocationsByKey[key])
    .filter((candidate): candidate is RunActivityNodeInvocation => candidate != null)
    .filter(
      (candidate) =>
        candidate.graphRunId === target.graphRunId &&
        candidate.nodeId === connection.outputNodeId &&
        candidate.sequence < target.sequence &&
        (candidate.outputPortIds.includes(connection.outputId) ||
          Object.values(candidate.splitOutputPortIds).some((portIds) => portIds.includes(connection.outputId))),
    );
  return candidates.sort((left, right) => right.sequence - left.sequence)[0];
}

function getRunData(runDataByNode: RunDataByNodeId, invocation: RunActivityNodeInvocation) {
  return runDataByNode[invocation.nodeId]?.find(
    (process) =>
      process.processId === invocation.processId &&
      process.rootRunId === invocation.rootRunId &&
      process.graphRunId === invocation.graphRunId &&
      (process.graphId == null || process.graphId === invocation.graphId),
  );
}

function getEffectiveConnections(graph: NodeGraph): { connections: NodeConnection[]; partialReason?: string } {
  try {
    return {
      connections: compileDataBusTopology({ connections: graph.connections, graphNodes: graph.nodes }).connections,
    };
  } catch {
    // A graph may have changed after the recorded run. Keep direct wiring
    // inspectable and make the reduced confidence explicit in the UI.
    return {
      connections: graph.connections,
      partialReason: 'Current graph topology could not be fully compiled; Data Bus provenance may be incomplete.',
    };
  }
}
