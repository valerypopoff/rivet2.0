import { type DataValue, getScalarTypeOf } from './DataValue.js';
import type {
  ChartNode,
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from './NodeBase.js';
import type { Inputs } from './GraphProcessor.js';
import type { GraphExecutionPlan, GraphOutputNodeResult } from './GraphPreprocessor.js';

export type ExecutionState = {
  connections: Record<NodeId, NodeConnection[]>;
  definitions: Record<NodeId, { inputs: NodeInputDefinition[]; outputs: NodeOutputDefinition[] }>;
  erroredNodes: Map<NodeId, Error | string>;
  executionPlan?: GraphExecutionPlan;
  loopControllersSeen: Set<NodeId>;
  nodesById: Record<NodeId, ChartNode>;
  stronglyConnectedComponents: ChartNode[][];
  visitedNodes: Set<NodeId>;
};

export type OutputNodeResult = GraphOutputNodeResult;

export function getStartNodes(
  state: ExecutionState,
  graphNodes: ChartNode[],
  runToNodeIds?: NodeId[],
): ChartNode[] {
  if (runToNodeIds) {
    return graphNodes.filter((node) => runToNodeIds.includes(node.id));
  }

  return state.executionPlan?.startNodes ?? graphNodes.filter((node) => getOutputNodesFrom(state, node).nodes.length === 0);
}

export function getInputNodesTo(state: ExecutionState, node: ChartNode): ChartNode[] {
  const plannedInputNodes = state.executionPlan?.inputNodesByNode[node.id];
  if (plannedInputNodes) {
    return plannedInputNodes;
  }

  const connections = state.connections[node.id];
  if (!connections) {
    return [];
  }

  const inputDefinitions = state.definitions[node.id]?.inputs ?? [];
  const validInputIds = new Set(inputDefinitions.map((definition) => definition.id));
  const inputNodes: ChartNode[] = [];

  for (const connection of connections) {
    if (connection.inputNodeId !== node.id || !validInputIds.has(connection.inputId)) {
      continue;
    }

    const inputNode = state.nodesById[connection.outputNodeId];
    if (inputNode) {
      inputNodes.push(inputNode);
    }
  }

  return inputNodes;
}

export function getOutputNodesFrom(state: ExecutionState, node: ChartNode): OutputNodeResult {
  const plannedOutputNodes = state.executionPlan?.outputNodeResultsByNode[node.id];
  if (plannedOutputNodes) {
    return plannedOutputNodes;
  }

  const connections = state.connections[node.id];
  if (!connections) {
    return { nodes: [], connections: [], connectionsToNodes: [] };
  }

  const outputDefinitions = state.definitions[node.id]?.outputs ?? [];
  const validOutputIds = new Set(outputDefinitions.map((definition) => definition.id));
  const outputConnections: NodeConnection[] = [];
  const outputConnectionsByNode = new Map<NodeId, NodeConnection[]>();
  const outputNodes: ChartNode[] = [];
  const seenOutputNodeIds = new Set<NodeId>();

  for (const connection of connections) {
    if (connection.outputNodeId !== node.id || !validOutputIds.has(connection.outputId)) {
      continue;
    }

    outputConnections.push(connection);

    const outputNode = state.nodesById[connection.inputNodeId];
    if (!outputNode) {
      continue;
    }

    if (!seenOutputNodeIds.has(outputNode.id)) {
      outputNodes.push(outputNode);
      seenOutputNodeIds.add(outputNode.id);
    }

    const nodeConnections = outputConnectionsByNode.get(outputNode.id);
    if (nodeConnections) {
      nodeConnections.push(connection);
    } else {
      outputConnectionsByNode.set(outputNode.id, [connection]);
    }
  }

  const connectionsToNodes = outputNodes.map((outputNode) => ({
    connections: outputConnectionsByNode.get(outputNode.id) ?? [],
    node: outputNode,
  }));

  return { nodes: outputNodes, connections: outputConnections, connectionsToNodes };
}

export function hasErroredInputNode(
  state: ExecutionState,
  node: ChartNode,
  inputNodes: ChartNode[],
  onTrace?: (message: string) => void,
): boolean {
  for (const inputNode of inputNodes) {
    if (state.erroredNodes.has(inputNode.id)) {
      onTrace?.(`Node ${node.title} has errored input node ${inputNode.title}`);
      return true;
    }
  }

  return false;
}

export function getMissingRequiredInputs(state: ExecutionState, node: ChartNode): NodeInputDefinition[] {
  const plannedMissingInputs = state.executionPlan?.missingRequiredInputsByNode[node.id];
  if (plannedMissingInputs) {
    return plannedMissingInputs;
  }

  const connections = state.connections[node.id] ?? [];
  const connectedInputIds = new Set<PortId>();

  for (const connection of connections) {
    if (connection.inputNodeId === node.id) {
      connectedInputIds.add(connection.inputId);
    }
  }

  return state.definitions[node.id]!.inputs.filter((input) => {
    return input.required && !connectedInputIds.has(input.id);
  });
}

export function getWaitingForInputNode(
  state: ExecutionState,
  node: ChartNode,
  inputNodes: ChartNode[],
  inputValues: Inputs,
): ChartNode | undefined {
  let waitingForInputNode: ChartNode | undefined;
  const anyInputIsValid = Object.values(inputValues).some((value) => value && !isControlFlowExcluded(value));

  for (const inputNode of inputNodes) {
    if (
      node.type === 'loopController' &&
      !state.loopControllersSeen.has(node.id) &&
      nodesAreInSameCycle(state, node.id, inputNode.id)
    ) {
      continue;
    }

    if (node.type === 'raceInputs' && state.visitedNodes.has(inputNode.id) && anyInputIsValid) {
      waitingForInputNode = undefined;
      break;
    }

    if (waitingForInputNode === undefined && state.visitedNodes.has(inputNode.id) === false) {
      waitingForInputNode = inputNode;
    }
  }

  return waitingForInputNode;
}

function nodesAreInSameCycle(state: ExecutionState, a: NodeId, b: NodeId) {
  const plannedCycleIndexByNode = state.executionPlan?.cycleIndexByNode;
  if (plannedCycleIndexByNode) {
    return plannedCycleIndexByNode[a] != null && plannedCycleIndexByNode[a] === plannedCycleIndexByNode[b];
  }

  return state.stronglyConnectedComponents.find(
    (cycle) => cycle.find((node) => node.id === a) && cycle.find((node) => node.id === b),
  );
}

function isControlFlowExcluded(value: DataValue | undefined): boolean {
  return value != null && getScalarTypeOf(value.type) === 'control-flow-excluded';
}
