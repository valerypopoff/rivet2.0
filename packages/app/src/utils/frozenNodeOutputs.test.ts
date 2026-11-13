import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeDebuggerTransportSentinels,
  type DataValue,
  type GraphId,
  type NodeId,
  type PortId,
} from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { ProcessDataForNode } from '../state/dataFlow.js';
import {
  assertFrozenNodeOutputsSerializableForInternalExecutor,
  captureFrozenNodeOutputs,
  getFrozenNodePreloadOutput,
  prepareFrozenNodeOutputsForInternalExecutorTransport,
  removeFrozenNodeOutputsForGraphs,
  removeFrozenNodeOutputsForNode,
  setFrozenNodeOutputsForNode,
} from './frozenNodeOutputs.js';

function createDataRefStore(initialValues?: Record<string, DataValue>): DataRefReader {
  const values = new Map<string, DataValue>(Object.entries(initialValues ?? {}));
  return {
    get: (key) => values.get(key),
  };
}

const graphId = 'graph-1' as GraphId;
const nodeId = 'node-1' as NodeId;

test('freezing cannot silently omit incomplete invocations from the selected outputs', () => {
  const processData = [
    {
      graphId,
      processId: 'first',
      data: { status: { type: 'ok' }, outputData: { output: { type: 'string', storage: 'inline', value: 'old' } } },
    },
    { graphId, processId: 'second', data: { status: { type: 'ok' }, diagnosticsIncomplete: true, outputData: {} } },
  ] as ProcessDataForNode[];
  assert.throws(
    () => captureFrozenNodeOutputs({ dataRefs: createDataRefStore(), graphId, nodeId, processData, selection: {} }),
    /no successful output/,
  );
});

test('captureFrozenNodeOutputs restores ref-backed output values and clones captured outputs', () => {
  const processData = [
    {
      graphId,
      processId: 'process-1',
      data: {
        status: { type: 'ok' },
        outputData: {
          ['output' as PortId]: {
            type: 'object',
            storage: 'ref',
            refId: 'object-ref',
            preview: {
              kind: 'json',
              excerpt: '{"value":1}',
              totalChars: 11,
            },
          },
        },
      },
    },
  ] as unknown as ProcessDataForNode[];

  const outputs = captureFrozenNodeOutputs({
    dataRefs: createDataRefStore({
      'object-ref': { type: 'object', value: { nested: { value: 1 } } },
    }),
    graphId,
    nodeId,
    processData,
    selection: {},
  });

  assert.deepEqual(outputs, [
    {
      ['output' as PortId]: { type: 'object', value: { nested: { value: 1 } } },
    },
  ]);

  ((outputs[0]!['output' as PortId] as Extract<DataValue, { type: 'object' }>).value as any).nested.value = 2;

  const outputsAgain = captureFrozenNodeOutputs({
    dataRefs: createDataRefStore({
      'object-ref': { type: 'object', value: { nested: { value: 1 } } },
    }),
    graphId,
    nodeId,
    processData,
    selection: {},
  });

  assert.deepEqual(outputsAgain[0]!['output' as PortId], { type: 'object', value: { nested: { value: 1 } } });
});

test('frozen output helpers clone on set and preload read', () => {
  const previous = setFrozenNodeOutputsForNode({}, graphId, nodeId, [
    {
      ['output' as PortId]: { type: 'object', value: { nested: { value: 1 } } },
    },
  ]);
  const preloaded = getFrozenNodePreloadOutput(previous, graphId, nodeId)!;

  ((preloaded['output' as PortId] as Extract<DataValue, { type: 'object' }>).value as any).nested.value = 2;

  assert.deepEqual(getFrozenNodePreloadOutput(previous, graphId, nodeId), {
    ['output' as PortId]: { type: 'object', value: { nested: { value: 1 } } },
  });
});

test('frozen output removal prunes empty graph entries', () => {
  const withNode = setFrozenNodeOutputsForNode({}, graphId, nodeId, [
    {
      ['output' as PortId]: { type: 'string', value: 'frozen' },
    },
  ]);

  assert.deepEqual(removeFrozenNodeOutputsForNode(withNode, graphId, nodeId), {});
  assert.deepEqual(removeFrozenNodeOutputsForGraphs(withNode, [graphId]), {});
});

test('internal executor serialization guard accepts JSON-safe frozen outputs', () => {
  assert.doesNotThrow(() =>
    assertFrozenNodeOutputsSerializableForInternalExecutor([
      {
        ['output' as PortId]: {
          type: 'object',
          value: {
            array: [1, 'two', true, null],
            nested: { ok: true },
          },
        },
      },
    ]),
  );
});

test('internal executor transport preserves explicit undefined in frozen outputs', () => {
  const frozenOutputs = [
    {
      ['output' as PortId]: {
        type: 'object',
        value: {
          messages: [
            { role: 'system', text: 'hello' },
            { isCacheBreakpoint: undefined, role: 'user', text: 'hi' },
          ],
        },
      },
      ['any-output' as PortId]: {
        type: 'any',
        value: undefined,
      },
    },
  ];

  const prepared = prepareFrozenNodeOutputsForInternalExecutorTransport(frozenOutputs);
  const roundTripped = decodeDebuggerTransportSentinels(JSON.parse(JSON.stringify(prepared)));

  assert.deepEqual(roundTripped, frozenOutputs);
  assert.notDeepEqual(prepared, frozenOutputs);
});

test('internal executor transport preserves user values shaped like debugger sentinels', () => {
  const sentinelShapedUserValue = {
    __rivetDebuggerTransportSentinel: {
      type: 'undefined',
      version: 1,
    },
  };
  const frozenOutputs = [
    {
      ['output' as PortId]: {
        type: 'object',
        value: sentinelShapedUserValue,
      },
    },
  ];

  const prepared = prepareFrozenNodeOutputsForInternalExecutorTransport(frozenOutputs);
  const roundTripped = decodeDebuggerTransportSentinels(JSON.parse(JSON.stringify(prepared)));

  assert.deepEqual(roundTripped, frozenOutputs);
});

test('internal executor serialization guard rejects values the run message cannot represent', () => {
  const circular: any = {};
  circular.self = circular;

  const invalidValues = [
    { reason: /BigInt/, value: { type: 'object', value: { id: BigInt(1) } } },
    { reason: /Infinity/, value: { type: 'number', value: Infinity } },
    { reason: /NaN/, value: { type: 'number', value: Number.NaN } },
    { reason: /circular reference/, value: { type: 'object', value: circular } },
    { reason: /non-plain object/, value: { type: 'binary', value: Uint8Array.from([1, 2, 3]) } },
    { reason: /non-plain object/, value: { type: 'object', value: new Date('2026-01-01T00:00:00.000Z') } },
  ];

  for (const { reason, value } of invalidValues) {
    assert.throws(
      () =>
        assertFrozenNodeOutputsSerializableForInternalExecutor([
          {
            ['output' as PortId]: value,
          },
        ]),
      reason,
    );
  }
});
