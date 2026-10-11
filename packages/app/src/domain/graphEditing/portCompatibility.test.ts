import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getConnectedInputWarnings,
  getConnectedInputWarningDetails,
  getPortCompatibilityStatus,
} from './portCompatibility.js';
import type {
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '@valerypopoff/rivet2-core';

test('getPortCompatibilityStatus returns none when the port data type is unavailable', () => {
  assert.equal(
    getPortCompatibilityStatus({
      draggingDataType: 'string',
      portDataType: undefined,
      canCoerce: true,
      isInput: true,
    }),
    'none',
  );
});

test('getPortCompatibilityStatus reports coerced compatibility when coercion is allowed', () => {
  assert.equal(
    getPortCompatibilityStatus({
      draggingDataType: 'number[]',
      portDataType: 'string',
      canCoerce: true,
      isInput: true,
    }),
    'coerced',
  );
});

test('getPortCompatibilityStatus reports incompatibility when coercion is not allowed', () => {
  assert.equal(
    getPortCompatibilityStatus({
      draggingDataType: 'binary',
      portDataType: 'string',
      canCoerce: false,
      isInput: true,
    }),
    'incompatible',
  );
});

const target = 'target' as NodeId;
const source = 'source' as NodeId;
const input = (id: string, dataType: NodeInputDefinition['dataType'], coerced?: boolean): NodeInputDefinition => ({
  id: id as PortId,
  title: id,
  dataType,
  coerced,
});
const output = (id: string, dataType: NodeOutputDefinition['dataType']): NodeOutputDefinition => ({
  id: id as PortId,
  title: id,
  dataType,
});
const wire = (inputId: string, outputId: string): NodeConnection => ({
  inputNodeId: target,
  inputId: inputId as PortId,
  outputNodeId: source,
  outputId: outputId as PortId,
});

test('established connections warn only on input ports needing coercion or having incompatible types', () => {
  const connections = [
    wire('exact', 'text'),
    wire('coerced', 'number'),
    wire('strict', 'number'),
    wire('any', 'number'),
    wire('union', 'text'),
  ];
  const original = structuredClone(connections);
  const warnings = getConnectedInputWarnings({
    nodeId: target,
    connections,
    inputDefinitions: [
      input('exact', 'string'),
      input('coerced', 'string'),
      input('strict', 'string', false),
      input('any', 'any'),
      input('union', ['string', 'number']),
    ],
    getOutputDefinitions: () => [output('text', 'string'), output('number', 'number')],
  });
  assert.deepEqual([...warnings], ['coerced', 'strict']);
  assert.deepEqual(connections, original, 'Warnings must not mutate graph connections');
  assert.deepEqual(
    [
      ...getConnectedInputWarnings({
        nodeId: source,
        connections,
        inputDefinitions: [],
        getOutputDefinitions: () => assert.fail('Source-only ports do not need warning resolution'),
      }),
    ],
    [],
  );
});

test('missing endpoints and unavailable definitions stay neutral and sources are indexed only once', () => {
  let reads = 0;
  const warnings = getConnectedInputWarnings({
    nodeId: target,
    connections: [wire('a', 'missing'), wire('b', 'number'), wire('missing', 'number'), wire('c', 'number')],
    inputDefinitions: [input('a', 'string'), input('b', 'string'), input('c', 'string')],
    getOutputDefinitions: () => {
      reads++;
      return [output('number', 'number')];
    },
  });
  assert.deepEqual([...warnings], ['b', 'c']);
  assert.equal(reads, 1);
  assert.deepEqual(
    [
      ...getConnectedInputWarnings({
        nodeId: target,
        connections: [wire('b', 'number')],
        inputDefinitions: [input('b', 'string')],
        getOutputDefinitions: () => [],
      }),
    ],
    [],
  );
});

test('a warning survives a second compatible edge to the same input without affecting other destinations', () => {
  const warnings = getConnectedInputWarnings({
    nodeId: target,
    connections: [
      wire('input', 'number'),
      wire('input', 'text'),
      { ...wire('input', 'number'), inputNodeId: 'another-target' as NodeId },
    ],
    inputDefinitions: [input('input', 'string')],
    getOutputDefinitions: () => [output('number', 'number'), output('text', 'string')],
  });
  assert.deepEqual([...warnings], ['input']);
});

test('warning details preserve source unions and distinguish coercion from strict incompatibility', () => {
  const details = getConnectedInputWarningDetails({
    nodeId: target,
    connections: [
      wire('converted', 'union'),
      wire('strict', 'union'),
      wire('converted', 'text'),
      wire('missing', 'gone'),
    ],
    inputDefinitions: [input('converted', 'string'), input('strict', 'string', false), input('missing', 'string')],
    getOutputDefinitions: () => [output('union', ['number', 'boolean']), output('text', 'string')],
  });
  assert.deepEqual(
    [...details],
    [
      ['converted', [{ status: 'coerced', sourceType: ['number', 'boolean'], targetType: 'string' }]],
      ['strict', [{ status: 'incompatible', sourceType: ['number', 'boolean'], targetType: 'string' }]],
    ],
  );
});
