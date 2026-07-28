import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createToolCallContinuationBranchPlanner } from '../../src/model/ToolCallContinuationBranchPlanner.js';
import type { ChartNode, NodeConnection, NodeId, PortId } from '../../src/model/NodeBase.js';
import type { NodeGraph } from '../../src/model/NodeGraph.js';
import type { Outputs } from '../../src/model/GraphProcessor.js';

describe('ToolCallContinuationBranchPlanner', () => {
  it('uses effective connections and preloads ready boundary outputs', () => {
    const source = makeNode('delegate', 'delegateToolCall', 'Delegate Tool Call');
    const boundary = makeNode('book', 'graphInput', 'Book');
    const consumer = makeNode('consumer', 'text', 'Consumer');
    const staleBlocker = makeNode('stale', 'text', 'Stale blocker');
    const sourceConnection = connect(source, 'message', consumer, 'message');
    const boundaryConnection = connect(boundary, 'output', consumer, 'book');
    const staleConnection = connect(staleBlocker, 'output', consumer, 'ignored');
    const graph = makeGraph(
      [source, boundary, consumer, staleBlocker],
      [sourceConnection, boundaryConnection, staleConnection],
    );
    const boundaryOutputs = stringOutputs('output', 'book text');
    const planner = createPlanner(graph, [sourceConnection, boundaryConnection]);

    const plan = planner.plan({
      activeOutputPortIds: new Set(['message' as PortId]),
      availableNodeOutputs: new Map(),
      excludedNodeIds: new Set(),
      sourceNode: source,
      sourceOutputs: stringOutputs('message', 'Working on it'),
      state: makeState(new Map([[boundary.id, boundaryOutputs]])),
    });

    assert.ok(plan);
    assert.deepEqual(
      plan.graph.nodes.map((node) => node.id),
      [source.id, boundary.id, consumer.id],
    );
    assert.deepEqual(plan.graph.connections, [sourceConnection, boundaryConnection]);
    assert.equal(plan.preloadedOutputs.get(source.id)?.['message' as PortId]?.value, 'Working on it');
    assert.equal(plan.preloadedOutputs.get(boundary.id), boundaryOutputs);
  });

  it('rejects an unsafe ready branch node before tool work begins', () => {
    const source = makeNode('delegate', 'delegateToolCall', 'Delegate Tool Call');
    const race = makeNode('race', 'raceInputs', 'Race Inputs');
    const connection = connect(source, 'message', race, 'input');
    const planner = createPlanner(makeGraph([source, race], [connection]), [connection]);

    assert.throws(
      () =>
        planner.plan({
          activeOutputPortIds: new Set(['message' as PortId]),
          availableNodeOutputs: new Map(),
          excludedNodeIds: new Set(),
          failOnUnsafeReadyNode: true,
          sourceNode: source,
          sourceOutputs: stringOutputs('message', 'Working on it'),
          state: makeState(),
        }),
      /cannot fire its pre-tool Message branch through unsupported node "Race Inputs"/,
    );
  });

  it('includes the preplanned async branch without duplicating its trigger connection', () => {
    const source = makeNode('delegate', 'delegateToolCall', 'Delegate Tool Call');
    const trigger = makeNode('trigger', 'startBackgroundBranch', 'Start Async Branch');
    const worker = makeNode('worker', 'externalCall', 'Publish status');
    const sourceConnection = connect(source, 'message', trigger, 'input1');
    const asyncConnection = connect(trigger, 'output1', worker, 'arguments');
    const graph = makeGraph([source, trigger, worker], [sourceConnection, asyncConnection]);
    const planner = createPlanner(
      graph,
      [sourceConnection],
      new Map([[trigger.id, makeGraph([trigger, worker], [asyncConnection])]]),
    );

    const plan = planner.plan({
      activeOutputPortIds: new Set(['message' as PortId]),
      availableNodeOutputs: new Map(),
      excludedNodeIds: new Set(),
      sourceNode: source,
      sourceOutputs: stringOutputs('message', 'Working on it'),
      state: makeState(),
    });

    assert.ok(plan);
    assert.deepEqual(
      plan.graph.nodes.map((node) => node.id),
      [source.id, trigger.id, worker.id],
    );
    assert.deepEqual(plan.graph.connections, [sourceConnection, asyncConnection]);
  });
});

function makeNode(id: string, type: string, title: string): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title,
    type,
    visualData: { x: 0, y: 0, width: 200 },
  } as ChartNode;
}

function connect(outputNode: ChartNode, outputId: string, inputNode: ChartNode, inputId: string): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId: inputNode.id,
    outputId: outputId as PortId,
    outputNodeId: outputNode.id,
  };
}

function makeGraph(nodes: ChartNode[], connections: NodeConnection[]): NodeGraph {
  return { connections, nodes };
}

function createPlanner(
  graph: NodeGraph,
  effectiveConnections: NodeConnection[],
  asyncGraphs = new Map<NodeId, NodeGraph>(),
) {
  const nodesById = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
  return createToolCallContinuationBranchPlanner({
    asyncBranchPlansByTriggerNodeId: new Map(
      [...asyncGraphs].map(([nodeId, asyncGraph]) => [
        nodeId,
        { graph: asyncGraph, nodeIds: new Set(asyncGraph.nodes.map((node) => node.id)) },
      ]),
    ),
    attachedNodeDataByNodeId: new Map(),
    effectiveConnections,
    graph,
    isDefinitionValidConnection: () => true,
    nodesById,
    stronglyConnectedComponents: [],
  });
}

function makeState(nodeOutputs = new Map<NodeId, Outputs>()) {
  return {
    erroredNodeIds: new Set<NodeId>(),
    nodeOutputs,
    runToRelevantNodeIds: undefined,
    visitedNodeIds: new Set<NodeId>(),
  };
}

function stringOutputs(portId: string, value: string): Outputs {
  return {
    [portId as PortId]: {
      type: 'string',
      value,
    },
  };
}
