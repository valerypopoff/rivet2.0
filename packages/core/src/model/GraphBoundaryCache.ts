import type { DataType, DataValue } from './DataValue.js';
import type { Inputs, Outputs } from './GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from './NodeBase.js';
import type { GraphId, NodeGraph } from './NodeGraph.js';
import type { Project } from './Project.js';
import type { DynamicEditorEditor } from './EditorDefinition.js';
import type { GraphInputNode } from './nodes/GraphInputNode.js';
import type { GraphOutputNode } from './nodes/GraphOutputNode.js';

export type GraphBoundaryInput = {
  dataType: DataType;
  editor?: DynamicEditorEditor;
  id: string;
  portId: PortId;
};

export type GraphBoundaryOutput = {
  dataType: DataType;
  id: string;
  nodeId: NodeId;
  portId: PortId;
};

export type GraphBoundary = {
  inputs: readonly GraphBoundaryInput[];
  outputs: readonly GraphBoundaryOutput[];
};

export type GraphBoundaryCache = WeakMap<NodeGraph, GraphBoundary>;

export function getGraphBoundary(
  project: Project,
  graphId: GraphId | undefined,
  cache?: GraphBoundaryCache,
): GraphBoundary | undefined {
  if (!graphId) {
    return undefined;
  }

  const graph = project.graphs[graphId];
  if (!graph) {
    return undefined;
  }

  if (!cache) {
    return deriveGraphBoundary(graph);
  }

  const cached = cache.get(graph);
  if (cached) {
    return cached;
  }

  const boundary = deriveGraphBoundary(graph);
  cache.set(graph, boundary);
  return boundary;
}

export function applyGraphBoundaryPortOrder<T extends { id: string }>(
  boundaryItems: readonly T[],
  portOrder: readonly string[] | undefined,
): T[] {
  if (!portOrder?.length) {
    return [...boundaryItems];
  }

  const itemsById = new Map(boundaryItems.map((item) => [item.id, item]));
  const usedIds = new Set<string>();
  const orderedItems: T[] = [];

  for (const id of portOrder) {
    if (usedIds.has(id)) {
      continue;
    }

    const item = itemsById.get(id);
    if (!item) {
      continue;
    }

    orderedItems.push(item);
    usedIds.add(id);
  }

  for (const item of boundaryItems) {
    if (!usedIds.has(item.id)) {
      orderedItems.push(item);
    }
  }

  return orderedItems;
}

export function getGraphBoundaryInputDefinitions(
  boundary: GraphBoundary,
  inputPortOrder?: readonly string[],
): NodeInputDefinition[] {
  return applyGraphBoundaryPortOrder(boundary.inputs, inputPortOrder).map(
    (input): NodeInputDefinition => ({
      id: input.portId,
      title: input.id,
      dataType: input.dataType,
    }),
  );
}

export function getGraphBoundaryOutputDefinitions(
  boundary: GraphBoundary,
  outputPortOrder?: readonly string[],
): NodeOutputDefinition[] {
  return applyGraphBoundaryPortOrder(boundary.outputs, outputPortOrder).map(
    (output): NodeOutputDefinition => ({
      id: output.portId,
      title: output.id,
      dataType: output.dataType,
    }),
  );
}

export function buildGraphBoundaryInputData(
  boundary: GraphBoundary,
  inputs: Inputs,
  defaults: Record<string, DataValue> | undefined,
): Inputs {
  const inputData: Inputs = {};

  for (const input of boundary.inputs) {
    const inputValue = inputs[input.portId];
    if (inputValue != null) {
      inputData[input.portId] = inputValue;
      continue;
    }

    const defaultValue = defaults?.[input.id];
    if (defaultValue != null) {
      inputData[input.portId] = defaultValue;
    }
  }

  return inputData;
}

export function buildExcludedGraphBoundaryOutputs(boundary: GraphBoundary): Outputs {
  const outputs: Outputs = {};

  for (const output of boundary.outputs) {
    outputs[output.portId] = {
      type: 'control-flow-excluded',
      value: undefined,
    };
  }

  return outputs;
}

function deriveGraphBoundary(graph: NodeGraph): GraphBoundary {
  const inputsById = new Map<string, GraphBoundaryInput>();
  const outputsById = new Map<string, GraphBoundaryOutput>();

  for (const node of graph.nodes) {
    if (node.type === 'graphInput' && !inputsById.has(getBoundaryNodeId(node))) {
      const inputNode = node as GraphInputNode;
      inputsById.set(inputNode.data.id, {
        dataType: inputNode.data.dataType,
        editor: inputNode.data.editor,
        id: inputNode.data.id,
        portId: inputNode.data.id as PortId,
      });
    } else if (node.type === 'graphOutput' && !outputsById.has(getBoundaryNodeId(node))) {
      const outputNode = node as GraphOutputNode;
      outputsById.set(outputNode.data.id, {
        dataType: outputNode.data.dataType,
        id: outputNode.data.id,
        nodeId: outputNode.id,
        portId: outputNode.data.id as PortId,
      });
    }
  }

  return {
    inputs: Array.from(inputsById.keys())
      .sort()
      .map((id) => inputsById.get(id)!),
    outputs: Array.from(outputsById.keys())
      .sort()
      .map((id) => outputsById.get(id)!),
  };
}

function getBoundaryNodeId(node: ChartNode): string {
  return (node.data as { id: string }).id;
}
