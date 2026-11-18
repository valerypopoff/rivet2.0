import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CallGraphNodeImpl,
  DataBusNodeImpl,
  DelegateFunctionCallNodeImpl,
  getDataBusInputPortId,
  getDataBusOutputPortId,
  GraphReferenceNodeImpl,
  LLMChatV2NodeImpl,
  SubGraphNodeImpl,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import { assertLegacyEndpointCanBeRestored } from '../routes/workflows/endpoint-release-graphs.js';

const main = 'main' as GraphId;
const handler = 'handler' as GraphId;
const unrelated = 'unrelated' as GraphId;

function fixture(nodes: ChartNode[], connections: NodeConnection[], referencedGraph: GraphId): Project {
  const ref = SubGraphNodeImpl.create();
  ref.data.targetProjectId = 'external' as ProjectId;
  ref.data.graphId = main;
  return {
    metadata: { id: 'owner' as ProjectId, mainGraphId: main, title: 'Owner', description: '' },
    graphs: {
      [main]: { metadata: { id: main, name: 'Main' }, nodes, connections },
      [handler]: {
        metadata: { id: handler, name: 'read_book' },
        nodes: referencedGraph === handler ? [ref] : [],
        connections: [],
      },
      [unrelated]: {
        metadata: { id: unrelated, name: 'Unrelated' },
        nodes: referencedGraph === unrelated ? [ref] : [],
        connections: [],
      },
    },
  };
}

function connect(output: ChartNode, outputId: string, input: ChartNode, inputId: string): NodeConnection {
  return {
    outputNodeId: output.id,
    outputId: outputId as PortId,
    inputNodeId: input.id,
    inputId: inputId as PortId,
  };
}

test('history rejects a dependency called by an LLM tool graph', () => {
  const llm = LLMChatV2NodeImpl.create();
  llm.data.useToolCalling = true;
  llm.data.autoContinueToolCalls = true;
  const project = fixture([llm], [], handler);
  assert.throws(() => assertLegacyEndpointCanBeRestored(project), /earlier dependency revisions/);
  llm.data.autoContinueToolCalls = false;
  assert.doesNotThrow(() => assertLegacyEndpointCanBeRestored(project));
});

test('a connected tool delegate limits capture to its configured handler and fallback', () => {
  const llm = LLMChatV2NodeImpl.create();
  llm.data.useToolCalling = true;
  llm.data.autoContinueToolCalls = true;
  const delegate = DelegateFunctionCallNodeImpl.create();
  delegate.data.autoDelegate = false;
  delegate.data.handlers = [{ key: 'read_book', value: handler }];
  const bus = DataBusNodeImpl.create();
  const wires = [
    connect(llm, 'function-calls', bus, getDataBusInputPortId(1)),
    connect(bus, getDataBusOutputPortId(1), delegate, 'function-call'),
  ];
  assert.throws(
    () => assertLegacyEndpointCanBeRestored(fixture([llm, bus, delegate], wires, handler)),
    /earlier dependency revisions/,
  );
  const project = fixture([llm, bus, delegate], wires, unrelated);
  assert.doesNotThrow(() => assertLegacyEndpointCanBeRestored(project));
  delegate.data.unknownHandler = unrelated;
  assert.throws(() => assertLegacyEndpointCanBeRestored(project), /earlier dependency revisions/);
});

test('an unused or fixed Call Graph does not capture unrelated projects', () => {
  const call = CallGraphNodeImpl.create();
  assert.doesNotThrow(() => assertLegacyEndpointCanBeRestored(fixture([call], [], unrelated)));
  const ref = GraphReferenceNodeImpl.create();
  const bus = DataBusNodeImpl.create();
  const wires = [
    connect(ref, 'graph', bus, getDataBusInputPortId(1)),
    connect(bus, getDataBusOutputPortId(1), call, 'graph'),
  ];
  const project = fixture([ref, bus, call], wires, unrelated);
  ref.data.graphId = 'missing-graph' as GraphId;
  assert.doesNotThrow(() => assertLegacyEndpointCanBeRestored(project));
  ref.data.graphId = handler;
  assert.doesNotThrow(() => assertLegacyEndpointCanBeRestored(project));
  ref.data.graphId = unrelated;
  assert.throws(() => assertLegacyEndpointCanBeRestored(project), /earlier dependency revisions/);
});

test('history rejects dependencies in a configured Run Thread callback', () => {
  const callback: ChartNode = {
    ...CallGraphNodeImpl.create(),
    type: 'openaiRunThread',
    data: { onMessageCreationSubgraphId: handler, toolCallHandlers: [] },
  };
  assert.throws(
    () => assertLegacyEndpointCanBeRestored(fixture([callback], [], handler)),
    /earlier dependency revisions/,
  );
});
