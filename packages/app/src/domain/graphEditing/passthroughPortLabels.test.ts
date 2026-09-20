import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { applyPassthroughConnectionLabels } from './passthroughPortLabels.js';

const node = (id: string, type: string): ChartNode =>
  ({
    data: {},
    id: id as NodeId,
    title: id,
    type,
    visualData: { x: 0, y: 0, width: 100 },
  }) as ChartNode;

const connection = (outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection => ({
  inputId: inputId as PortId,
  inputNodeId: inputNodeId as NodeId,
  outputId: outputId as PortId,
  outputNodeId: outputNodeId as NodeId,
});

const input = (id: string, title: string): NodeInputDefinition => ({
  dataType: 'any',
  id: id as PortId,
  title,
});

const output = (id: string, title: string): NodeOutputDefinition => ({
  dataType: 'any',
  id: id as PortId,
  title,
});

function apply(options: {
  connections: NodeConnection[];
  definitions?: Record<string, { inputs?: NodeInputDefinition[]; outputs?: NodeOutputDefinition[] }>;
  inputDefinitions?: NodeInputDefinition[];
  nodes: ChartNode[];
  outputDefinitions?: NodeOutputDefinition[];
  target?: string;
}) {
  const target = (options.target ?? 'relay') as NodeId;
  return applyPassthroughConnectionLabels({
    connections: options.connections,
    getNodeIoDefinitions: (nodeId) => ({
      inputDefinitions: options.definitions?.[nodeId]?.inputs ?? [],
      outputDefinitions: options.definitions?.[nodeId]?.outputs ?? [],
    }),
    inputDefinitions: options.inputDefinitions ?? [input('input1', 'Input 1'), input('input2', 'Input 2')],
    nodeId: target,
    nodesById: Object.fromEntries(options.nodes.map((candidate) => [candidate.id, candidate])),
    outputDefinitions: options.outputDefinitions ?? [output('output1', 'Output 1')],
  });
}

test('uses the connected upstream output title for both sides of a Passthrough slot', () => {
  const result = apply({
    connections: [connection('source', 'response', 'relay', 'input1')],
    definitions: { source: { outputs: [output('response', 'Response')] } },
    nodes: [node('source', 'llmChatV2'), node('relay', 'passthrough')],
  });

  assert.deepEqual(
    result.inputDefinitions.map(({ title }) => title),
    ['Response', 'Input 2'],
  );
  assert.deepEqual(
    result.outputDefinitions.map(({ title }) => title),
    ['Response'],
  );
});

test('preserves a nonempty connected port title verbatim', () => {
  const result = apply({
    connections: [connection('source', 'response', 'relay', 'input1')],
    definitions: { source: { outputs: [output('response', '  Raw response  ')] } },
    nodes: [node('source', 'llmChatV2'), node('relay', 'passthrough')],
  });

  assert.equal(result.inputDefinitions[0]?.title, '  Raw response  ');
  assert.equal(result.outputDefinitions[0]?.title, '  Raw response  ');
});

test('labels each Passthrough slot from its own upstream output', () => {
  const result = apply({
    connections: [
      connection('first-source', 'first', 'relay', 'input1'),
      connection('second-source', 'second', 'relay', 'input2'),
    ],
    definitions: {
      'first-source': { outputs: [output('first', 'First value')] },
      'second-source': { outputs: [output('second', 'Second value')] },
    },
    nodes: [node('first-source', 'text'), node('second-source', 'text'), node('relay', 'passthrough')],
    outputDefinitions: [output('output1', 'Output 1'), output('output2', 'Output 2')],
  });

  assert.deepEqual(
    result.inputDefinitions.map(({ title }) => title),
    ['First value', 'Second value'],
  );
  assert.deepEqual(
    result.outputDefinitions.map(({ title }) => title),
    ['First value', 'Second value'],
  );
});

test('follows Passthrough chains to the original named output', () => {
  const nodes = [node('source', 'number'), node('first', 'passthrough'), node('relay', 'passthrough')];
  const result = apply({
    connections: [connection('source', 'value', 'first', 'input1'), connection('first', 'output1', 'relay', 'input1')],
    definitions: { source: { outputs: [output('value', 'Value')] } },
    nodes,
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Value');
  assert.equal(result.outputDefinitions[0]?.title, 'Value');
});

test('uses one unambiguous downstream input title for an output-only repair slot', () => {
  const result = apply({
    connections: [connection('relay', 'output1', 'target', 'prompt')],
    definitions: { target: { inputs: [input('prompt', 'Prompt')] } },
    nodes: [node('relay', 'passthrough'), node('target', 'llmChatV2')],
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Prompt');
  assert.equal(result.outputDefinitions[0]?.title, 'Prompt');
});

test('keeps numbered fallbacks for conflicting fanout names and relay cycles', () => {
  const conflicting = apply({
    connections: [
      connection('relay', 'output1', 'first-target', 'prompt'),
      connection('relay', 'output1', 'second-target', 'context'),
    ],
    definitions: {
      'first-target': { inputs: [input('prompt', 'Prompt')] },
      'second-target': { inputs: [input('context', 'Context')] },
    },
    nodes: [node('relay', 'passthrough'), node('first-target', 'text'), node('second-target', 'text')],
  });
  assert.equal(conflicting.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(conflicting.outputDefinitions[0]?.title, 'Output 1');

  const cyclic = apply({
    connections: [connection('other', 'output1', 'relay', 'input1'), connection('relay', 'output1', 'other', 'input1')],
    nodes: [node('relay', 'passthrough'), node('other', 'passthrough')],
  });
  assert.equal(cyclic.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(cyclic.outputDefinitions[0]?.title, 'Output 1');
});

test('keeps numbered fallbacks when any downstream port title is unavailable', () => {
  const result = apply({
    connections: [
      connection('relay', 'output1', 'named-target', 'prompt'),
      connection('relay', 'output1', 'unknown-target', 'missing'),
    ],
    definitions: { 'named-target': { inputs: [input('prompt', 'Prompt')] } },
    nodes: [node('relay', 'passthrough'), node('named-target', 'text'), node('unknown-target', 'unavailablePlugin')],
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(result.outputDefinitions[0]?.title, 'Output 1');
});

test('keeps numbered fallbacks when an upstream provider is ambiguous or unavailable', () => {
  const ambiguous = apply({
    connections: [
      connection('first-source', 'first', 'relay', 'input1'),
      connection('second-source', 'second', 'relay', 'input1'),
      connection('relay', 'output1', 'target', 'prompt'),
    ],
    definitions: {
      'first-source': { outputs: [output('first', 'First')] },
      'second-source': { outputs: [output('second', 'Second')] },
      target: { inputs: [input('prompt', 'Prompt')] },
    },
    nodes: [
      node('first-source', 'text'),
      node('second-source', 'text'),
      node('relay', 'passthrough'),
      node('target', 'llmChatV2'),
    ],
  });

  assert.equal(ambiguous.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(ambiguous.outputDefinitions[0]?.title, 'Output 1');

  const unavailable = apply({
    connections: [
      connection('missing-source', 'response', 'relay', 'input1'),
      connection('relay', 'output1', 'target', 'prompt'),
    ],
    definitions: { target: { inputs: [input('prompt', 'Prompt')] } },
    nodes: [node('relay', 'passthrough'), node('target', 'llmChatV2')],
  });

  assert.equal(unavailable.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(unavailable.outputDefinitions[0]?.title, 'Output 1');
});

test('keeps numbered fallbacks for malformed upstream port titles', () => {
  const result = apply({
    connections: [connection('source', 'response', 'relay', 'input1')],
    definitions: {
      source: {
        outputs: [
          {
            dataType: 'any',
            id: 'response' as PortId,
            title: 42,
          } as unknown as NodeOutputDefinition,
        ],
      },
    },
    nodes: [node('source', 'unavailablePlugin'), node('relay', 'passthrough')],
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(result.outputDefinitions[0]?.title, 'Output 1');
});

test('keeps numbered fallbacks when a downstream fanout contains a cycle', () => {
  const result = apply({
    connections: [
      connection('relay', 'output1', 'target', 'prompt'),
      connection('relay', 'output1', 'other', 'input1'),
      connection('other', 'output1', 'relay', 'input1'),
    ],
    definitions: { target: { inputs: [input('prompt', 'Prompt')] } },
    nodes: [node('relay', 'passthrough'), node('other', 'passthrough'), node('target', 'text')],
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Input 1');
  assert.equal(result.outputDefinitions[0]?.title, 'Output 1');
});

test('resolves a long Passthrough chain without recursive traversal', () => {
  const relayCount = 12_000;
  const nodes = [node('source', 'number')];
  const connections: NodeConnection[] = [];
  for (let index = 0; index < relayCount; index += 1) {
    const current = `relay-${index}`;
    const previous = index === 0 ? 'source' : `relay-${index - 1}`;
    nodes.push(node(current, 'passthrough'));
    connections.push(connection(previous, index === 0 ? 'value' : 'output1', current, 'input1'));
  }

  const result = apply({
    connections,
    definitions: { source: { outputs: [output('value', 'Value')] } },
    nodes,
    target: `relay-${relayCount - 1}`,
  });

  assert.equal(result.inputDefinitions[0]?.title, 'Value');
  assert.equal(result.outputDefinitions[0]?.title, 'Value');
});
