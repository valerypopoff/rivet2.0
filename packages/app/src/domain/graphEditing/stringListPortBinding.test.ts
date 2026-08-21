import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChartNode, type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import {
  createEditableStringListRows,
  moveEditableStringListRows,
  prepareStringListPortBindingEdit,
  reconcileEditableStringListRows,
} from './stringListPortBinding.js';

function makeNode<TData extends Record<string, unknown>>(type: string, data: TData): ChartNode<string, TData> {
  return {
    id: 'node-1' as NodeId,
    type,
    title: type,
    visualData: {
      x: 0,
      y: 0,
    },
    data,
  };
}

function makeConnection(overrides: Partial<NodeConnection> = {}): NodeConnection {
  return {
    outputNodeId: 'source' as NodeId,
    outputId: 'source-output' as PortId,
    inputNodeId: 'target' as NodeId,
    inputId: 'target-input' as PortId,
    ...overrides,
  };
}

test('editable string-list rows keep their ui ids stable across typing and reorder', () => {
  const initialRows = createEditableStringListRows(['alpha', 'beta']);
  const typedRows = reconcileEditableStringListRows(initialRows, ['alpha!', 'beta']);
  const reorderedRows = moveEditableStringListRows(typedRows, typedRows[0]!.uiId, typedRows[1]!.uiId);

  assert.equal(typedRows[0]!.uiId, initialRows[0]!.uiId);
  assert.equal(typedRows[1]!.uiId, initialRows[1]!.uiId);
  assert.equal(reorderedRows[0]!.uiId, initialRows[1]!.uiId);
  assert.equal(reorderedRows[1]!.uiId, initialRows[0]!.uiId);
});

test('stored stable ids carry through reorder and rename without changing connected port ids', () => {
  const node = makeNode('destructure', {
    paths: ['$.a', '$.b'],
    pathPortIds: ['path-a', 'path-b'],
  });
  const previousRows = createEditableStringListRows(['$.a', '$.b']);
  const nextRows = [
    { uiId: previousRows[1]!.uiId, value: '$.beta' },
    { uiId: previousRows[0]!.uiId, value: '$.alpha' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'path-a' as PortId,
    }),
    makeConnection({
      outputNodeId: node.id,
      outputId: 'path-b' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'paths',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'pathPortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'match_',
        startIndex: 0,
      },
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.deepEqual(result.nextNode.data.paths, ['$.beta', '$.alpha']);
  assert.deepEqual(result.nextNode.data.pathPortIds, ['path-b', 'path-a']);
  assert.deepEqual(result.nextConnections, connections);
});

test('stored stable ids generate ids for added rows and remove deleted-row connections', () => {
  const node = makeNode('destructure', {
    paths: ['$.a'],
    pathPortIds: ['path-a'],
  });
  const previousRows = createEditableStringListRows(['$.a']);
  const nextRows = [
    { uiId: previousRows[0]!.uiId, value: '$.a' },
    { uiId: 'new-row', value: '$.b' },
  ];

  const addedResult = prepareStringListPortBindingEdit({
    node,
    dataKey: 'paths',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'pathPortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'match_',
        startIndex: 0,
      },
    },
    previousRows,
    nextRows,
    connections: [],
  });

  assert.equal(addedResult.nextNode.data.pathPortIds[0], 'path-a');
  assert.equal(addedResult.nextNode.data.pathPortIds.length, 2);
  assert.notEqual(addedResult.nextNode.data.pathPortIds[1], 'path-a');

  const deletedResult = prepareStringListPortBindingEdit({
    node,
    dataKey: 'paths',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'pathPortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'match_',
        startIndex: 0,
      },
    },
    previousRows,
    nextRows: [],
    connections: [
      makeConnection({
        outputNodeId: node.id,
        outputId: 'path-a' as PortId,
      }),
    ],
  });

  assert.deepEqual(deletedResult.nextNode.data.pathPortIds, []);
  assert.deepEqual(deletedResult.nextConnections, []);
});

test('legacy destructure ids remap to generated stable ids on first edit', () => {
  const node = makeNode<{
    paths: string[];
    pathPortIds?: string[];
  }>('destructure', {
    paths: ['$.a', '$.b'],
  });
  const previousRows = createEditableStringListRows(['$.a', '$.b']);
  const nextRows = [
    { uiId: previousRows[0]!.uiId, value: '$.alpha' },
    { uiId: previousRows[1]!.uiId, value: '$.b' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'match_1' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'paths',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'pathPortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'match_',
        startIndex: 0,
      },
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.ok(result.nextNode.data.pathPortIds);
  assert.equal(result.nextNode.data.pathPortIds.length, 2);
  assert.notEqual(result.nextConnections[0]!.outputId, 'match_1');
  assert.equal(result.nextConnections[0]!.outputId, result.nextNode.data.pathPortIds[1]);
});

test('legacy match ids remap to generated stable ids on first edit', () => {
  const node = makeNode<{
    cases: string[];
    casePortIds?: string[];
  }>('match', {
    cases: ['YES', 'NO'],
  });
  const previousRows = createEditableStringListRows(['YES', 'NO']);
  const nextRows = [
    { uiId: previousRows[0]!.uiId, value: 'YES' },
    { uiId: previousRows[1]!.uiId, value: 'NOPE' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'case2' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'cases',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'casePortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'case',
        startIndex: 1,
      },
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.ok(result.nextNode.data.casePortIds);
  assert.equal(result.nextNode.data.casePortIds.length, 2);
  assert.notEqual(result.nextConnections[0]!.outputId, 'case2');
  assert.equal(result.nextConnections[0]!.outputId, result.nextNode.data.casePortIds[1]);
});

test('paired stable-id bindings keep Regex Match input and output wires with the same case', () => {
  const node = makeNode<{
    cases: string[];
    casePortIds?: string[];
  }>('match', {
    cases: ['YES', 'NO'],
    casePortIds: ['case-yes', 'case-no'],
  });
  const previousRows = createEditableStringListRows(['YES', 'NO']);
  const nextRows = [
    { uiId: previousRows[1]!.uiId, value: 'NOPE' },
    { uiId: previousRows[0]!.uiId, value: 'YEP' },
  ];
  const connections = [
    makeConnection({ outputNodeId: node.id, outputId: 'case-yes' as PortId }),
    makeConnection({ outputNodeId: node.id, outputId: 'case-no' as PortId }),
    makeConnection({ inputNodeId: node.id, inputId: 'value-case-yes' as PortId }),
    makeConnection({ inputNodeId: node.id, inputId: 'value-case-no' as PortId }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'cases',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'casePortIds',
      legacyPortIdPattern: { kind: 'prefix', prefix: 'case', startIndex: 1 },
      companionBindings: [{ side: 'input', prefix: 'value-' }],
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.deepEqual(result.nextNode.data.casePortIds, ['case-no', 'case-yes']);
  assert.deepEqual(result.nextConnections, connections);
});

test('paired stable-id bindings delete the matching input and output wires together', () => {
  const node = makeNode('match', {
    cases: ['YES', 'NO'],
    casePortIds: ['case-yes', 'case-no'],
  });
  const previousRows = createEditableStringListRows(['YES', 'NO']);
  const connections = [
    makeConnection({ outputNodeId: node.id, outputId: 'case-yes' as PortId }),
    makeConnection({ outputNodeId: node.id, outputId: 'case-no' as PortId }),
    makeConnection({ inputNodeId: node.id, inputId: 'value-case-yes' as PortId }),
    makeConnection({ inputNodeId: node.id, inputId: 'value-case-no' as PortId }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'cases',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'casePortIds',
      legacyPortIdPattern: { kind: 'prefix', prefix: 'case', startIndex: 1 },
      companionBindings: [{ side: 'input', prefix: 'value-' }],
    },
    previousRows,
    nextRows: [{ uiId: previousRows[0]!.uiId, value: 'YES' }],
    connections,
  });

  assert.deepEqual(result.nextConnections, [connections[0]!, connections[2]!]);
});

test('paired stable-id bindings migrate legacy Regex Match input and output ids together', () => {
  const node = makeNode<{
    cases: string[];
    casePortIds?: string[];
  }>('match', { cases: ['YES'] });
  const previousRows = createEditableStringListRows(['YES']);
  const connections = [
    makeConnection({ outputNodeId: node.id, outputId: 'case1' as PortId }),
    makeConnection({ inputNodeId: node.id, inputId: 'value-case1' as PortId }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'cases',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'casePortIds',
      legacyPortIdPattern: { kind: 'prefix', prefix: 'case', startIndex: 1 },
      companionBindings: [{ side: 'input', prefix: 'value-' }],
    },
    previousRows,
    nextRows: [{ uiId: previousRows[0]!.uiId, value: 'YEP' }],
    connections,
  });

  const [nextCasePortId] = result.nextNode.data.casePortIds!;
  assert.equal(result.nextConnections[0]!.outputId, nextCasePortId);
  assert.equal(result.nextConnections[1]!.inputId, `value-${nextCasePortId}`);
});

test('paired stable-id bindings retain recoverable Regex Match value wires through case edits', () => {
  const node = makeNode<{
    cases: string[];
    casePortIds?: string[];
  }>('match', { cases: ['YES'] });
  const previousRows = createEditableStringListRows(['YES']);
  const recoverableConnections = [makeConnection({ inputNodeId: node.id, inputId: 'value-case1' as PortId })];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'cases',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'casePortIds',
      legacyPortIdPattern: { kind: 'prefix', prefix: 'case', startIndex: 1 },
      companionBindings: [{ side: 'input', prefix: 'value-' }],
    },
    previousRows,
    nextRows: [{ uiId: previousRows[0]!.uiId, value: 'YEP' }],
    connections: [],
    recoverableConnections,
  });

  assert.equal(result.nextConnections.length, 0);
  assert.equal(result.nextRecoverableConnections.length, 1);
  assert.equal(result.nextRecoverableConnections[0]!.inputId, `value-${result.nextNode.data.casePortIds![0]}`);
});

test('duplicate stored stable ids are treated as legacy and remapped to fresh stable ids', () => {
  const node = makeNode<{
    paths: string[];
    pathPortIds?: string[];
  }>('destructure', {
    paths: ['$.a', '$.b'],
    pathPortIds: ['dup-port', 'dup-port'],
  });
  const previousRows = createEditableStringListRows(['$.a', '$.b']);
  const nextRows = [
    { uiId: previousRows[0]!.uiId, value: '$.alpha' },
    { uiId: previousRows[1]!.uiId, value: '$.b' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'match_1' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'paths',
    portBinding: {
      side: 'output',
      identity: 'stored-stable-id',
      idDataKey: 'pathPortIds',
      legacyPortIdPattern: {
        kind: 'prefix',
        prefix: 'match_',
        startIndex: 0,
      },
    },
    previousRows,
    nextRows,
    connections,
  });

  const nextPathPortIds = result.nextNode.data.pathPortIds;

  assert.ok(nextPathPortIds);
  assert.equal(nextPathPortIds.length, 2);
  assert.notEqual(nextPathPortIds[0], nextPathPortIds[1]);
  assert.equal(result.nextConnections[0]!.outputId, nextPathPortIds[1]);
});

test('code value-derived binding remaps connected input ports on rename', () => {
  const node = makeNode('code', {
    inputNames: ['input1'],
  });
  const previousRows = createEditableStringListRows(['input1']);
  const nextRows = [{ uiId: previousRows[0]!.uiId, value: 'renamed_input' }];
  const connections = [
    makeConnection({
      inputNodeId: node.id,
      inputId: 'input1' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'inputNames',
    portBinding: {
      side: 'input',
      identity: 'value-derived',
      valueToPortId: 'sanitize-identifier',
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.deepEqual(result.nextNode.data.inputNames, ['renamed_input']);
  assert.equal(result.nextConnections[0]!.inputId, 'renamed_input');
});

test('code value-derived binding keeps connections intact on reorder', () => {
  const node = makeNode('code', {
    outputNames: ['alpha', 'beta'],
  });
  const previousRows = createEditableStringListRows(['alpha', 'beta']);
  const nextRows = [
    { uiId: previousRows[1]!.uiId, value: 'beta' },
    { uiId: previousRows[0]!.uiId, value: 'alpha' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'alpha' as PortId,
    }),
    makeConnection({
      outputNodeId: node.id,
      outputId: 'beta' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'outputNames',
    portBinding: {
      side: 'output',
      identity: 'value-derived',
      valueToPortId: 'sanitize-identifier',
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.deepEqual(result.nextNode.data.outputNames, ['beta', 'alpha']);
  assert.deepEqual(result.nextConnections, connections);
});

test('code value-derived binding removes only the deleted port connections', () => {
  const node = makeNode('code', {
    outputNames: ['alpha', 'beta'],
  });
  const previousRows = createEditableStringListRows(['alpha', 'beta']);
  const nextRows = [{ uiId: previousRows[0]!.uiId, value: 'alpha' }];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'alpha' as PortId,
    }),
    makeConnection({
      outputNodeId: node.id,
      outputId: 'beta' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'outputNames',
    portBinding: {
      side: 'output',
      identity: 'value-derived',
      valueToPortId: 'sanitize-identifier',
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.deepEqual(result.nextConnections, [connections[0]!]);
});

test('code value-derived binding preserves existing duplicate-name semantics while remapping surviving rows', () => {
  const node = makeNode('code', {
    outputNames: ['alpha', 'beta'],
  });
  const previousRows = createEditableStringListRows(['alpha', 'beta']);
  const nextRows = [
    { uiId: previousRows[0]!.uiId, value: 'beta' },
    { uiId: previousRows[1]!.uiId, value: 'beta' },
  ];
  const connections = [
    makeConnection({
      outputNodeId: node.id,
      outputId: 'alpha' as PortId,
    }),
    makeConnection({
      outputNodeId: node.id,
      outputId: 'beta' as PortId,
    }),
  ];

  const result = prepareStringListPortBindingEdit({
    node,
    dataKey: 'outputNames',
    portBinding: {
      side: 'output',
      identity: 'value-derived',
      valueToPortId: 'sanitize-identifier',
    },
    previousRows,
    nextRows,
    connections,
  });

  assert.equal(result.nextConnections.length, 1);
  assert.equal(result.nextConnections[0]!.outputId, 'beta');
});
