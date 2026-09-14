import assert from 'node:assert/strict';
import test from 'node:test';
import { type ChartNode, type GraphId, type NodeConnection, type NodeId, type PortId } from '@valerypopoff/rivet2-core';
import {
  makeConnection,
  makeGraph,
  makeGraphInputNode,
  makeGraphOutputNode,
  makeProject,
  makeSubGraphNode,
  makeTextNode,
} from './testGraphBuilders.js';
import { getGraphPortId, propagateGraphPortRename } from './graphPortRenamePropagation.js';

const childGraphId = 'child-graph' as GraphId;
const firstParentGraphId = 'first-parent-graph' as GraphId;
const secondParentGraphId = 'second-parent-graph' as GraphId;

test('graph port ID extraction is type-scoped and preserves empty string IDs', () => {
  const input = makeGraphInputNode('input', '');
  const output = makeGraphOutputNode('output', 'result');
  const text = makeTextNode('text');
  const malformed = {
    ...input,
    data: { id: 123 },
  } as unknown as ChartNode;

  assert.equal(getGraphPortId(input, 'input'), '');
  assert.equal(getGraphPortId(input, 'output'), undefined);
  assert.equal(getGraphPortId(output, 'output'), 'result');
  assert.equal(getGraphPortId(text, 'input'), undefined);
  assert.equal(getGraphPortId(malformed, 'input'), undefined);
});

test('shared propagation overlays stale project state with the live recursive caller graph', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const source = makeTextNode('source');
  const recursiveCaller = makeSubGraphNode('recursive-caller', childGraphId);
  const connection = makeConnection({
    outputNodeId: source.id,
    inputNodeId: recursiveCaller.id,
    inputId: 'old' as PortId,
  });
  const staleProjectGraph = makeGraph(childGraphId, [previousInput]);
  const project = makeProject([staleProjectGraph]);

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [connection],
    nextCurrentNodes: [nextInput, source, recursiveCaller],
    previousCurrentNodes: [previousInput, source, recursiveCaller],
    project,
  });

  assert.deepEqual(result.nextCurrentConnections, [{ ...connection, inputId: 'new' as PortId }]);
  assert.deepEqual(result.projectGraphSnapshots, {});
  assert.deepEqual(project.graphs[childGraphId], staleProjectGraph);
});

test('shared propagation snapshots every changed external caller without aliasing the project', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const firstCaller = makeSubGraphNode('first-caller', childGraphId, {
    data: { inputData: { old: { type: 'string', value: 'first' } } },
  });
  const secondCaller = makeSubGraphNode('second-caller', childGraphId);
  const firstConnection = makeConnection({
    inputNodeId: firstCaller.id,
    inputId: 'old' as PortId,
    outputNodeId: 'first-source' as NodeId,
  });
  const secondConnection = makeConnection({
    inputNodeId: secondCaller.id,
    inputId: 'old' as PortId,
    outputNodeId: 'second-source' as NodeId,
  });
  const firstParent = makeGraph(firstParentGraphId, [firstCaller], [firstConnection]);
  const secondParent = makeGraph(secondParentGraphId, [secondCaller], [secondConnection]);
  const project = makeProject([firstParent, secondParent]);

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInput],
    previousCurrentNodes: [previousInput],
    project,
  });

  assert.deepEqual(Object.keys(result.projectGraphSnapshots), [firstParentGraphId, secondParentGraphId]);
  assert.deepEqual(result.projectGraphSnapshots[firstParentGraphId]!.nextGraph.connections, [
    { ...firstConnection, inputId: 'new' as PortId },
  ]);
  assert.deepEqual(result.projectGraphSnapshots[secondParentGraphId]!.nextGraph.connections, [
    { ...secondConnection, inputId: 'new' as PortId },
  ]);
  (result.projectGraphSnapshots[firstParentGraphId]!.previousGraph.nodes[0]!.data as { inputData: Record<string, unknown> }).inputData.old =
    'changed snapshot';
  assert.deepEqual(
    (project.graphs[firstParentGraphId]!.nodes[0]!.data as { inputData: Record<string, unknown> }).inputData.old,
    { type: 'string', value: 'first' },
  );
});

test('shared propagation keeps empty input IDs as ordinary exact rename values', () => {
  const previousInput = makeGraphInputNode('input', '');
  const nextInput = makeGraphInputNode('input', 'next');
  const caller = makeSubGraphNode('caller', childGraphId);
  const connection = makeConnection({ inputNodeId: caller.id, inputId: '' as PortId });
  const parent = makeGraph(firstParentGraphId, [caller], [connection]);

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInput],
    previousCurrentNodes: [previousInput],
    project: makeProject([parent]),
  });

  assert.deepEqual(result.projectGraphSnapshots[firstParentGraphId]!.nextGraph.connections, [
    { ...connection, inputId: 'next' as PortId },
  ]);
});

test('shared propagation leaves type changes and graphless edits untouched', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const replacementOutput = makeGraphOutputNode('input', 'new');
  const caller = makeSubGraphNode('caller', childGraphId);
  const connection = makeConnection({ inputNodeId: caller.id, inputId: 'old' as PortId });
  const parent = makeGraph(firstParentGraphId, [caller], [connection]);
  const project = makeProject([parent]);
  const typeChangeConnections = [connection];
  const typeChangeNodes = [replacementOutput];
  const graphlessConnections = [connection];
  const graphlessNodes = [previousInput];

  const typeChange = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: typeChangeConnections,
    nextCurrentNodes: typeChangeNodes,
    previousCurrentNodes: [previousInput],
    project,
  });
  const graphlessEdit = propagateGraphPortRename({
    currentGraphId: undefined,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: graphlessConnections,
    nextCurrentNodes: graphlessNodes,
    previousCurrentNodes: [previousInput],
    project,
  });

  for (const [result, sourceConnections] of [
    [typeChange, typeChangeConnections],
    [graphlessEdit, graphlessConnections],
  ] as const) {
    assert.deepEqual(result.nextCurrentConnections, sourceConnections);
    assert.deepEqual(result.projectGraphSnapshots, {});
    assert.notEqual(result.nextCurrentConnections, sourceConnections);
  }
  assert.deepEqual(typeChange.nextCurrentNodes, typeChangeNodes);
  assert.notEqual(typeChange.nextCurrentNodes, typeChangeNodes);
  assert.deepEqual(graphlessEdit.nextCurrentNodes, graphlessNodes);
  assert.notEqual(graphlessEdit.nextCurrentNodes, graphlessNodes);
  assert.deepEqual(project.graphs[firstParentGraphId], parent);
});

test('shared propagation synthesizes an absent current graph for a recursive caller', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const source = makeTextNode('source');
  const recursiveCaller = makeSubGraphNode('recursive-caller', childGraphId, {
    data: {
      inputData: { old: 'old default' },
      inputPortOrder: ['old'],
    },
  });
  const connection = makeConnection({
    outputNodeId: source.id,
    inputNodeId: recursiveCaller.id,
    inputId: 'old' as PortId,
  });

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [connection],
    nextCurrentNodes: [nextInput, source, recursiveCaller],
    previousCurrentNodes: [previousInput, source, recursiveCaller],
    project: makeProject(),
  });

  assert.deepEqual(result.nextCurrentConnections, [{ ...connection, inputId: 'new' as PortId }]);
  const nextRecursiveCaller = result.nextCurrentNodes.find((node) => node.id === recursiveCaller.id)!;
  assert.deepEqual((nextRecursiveCaller.data as { inputData?: Record<string, unknown> }).inputData, { new: 'old default' });
  assert.deepEqual((nextRecursiveCaller.data as { inputPortOrder?: string[] }).inputPortOrder, ['new']);
  assert.deepEqual(result.projectGraphSnapshots, {});
});

test('shared propagation keeps whitespace IDs exact and treats equal or disabled duplicate IDs as no-ops', () => {
  const whitespacePreviousInput = makeGraphInputNode('input', ' old ');
  const whitespaceNextInput = makeGraphInputNode('input', ' new ');
  const caller = makeSubGraphNode('caller', childGraphId);
  const connection = makeConnection({ inputNodeId: caller.id, inputId: ' old ' as PortId });
  const parent = makeGraph(firstParentGraphId, [caller], [connection]);

  const whitespaceResult = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: whitespacePreviousInput.id,
    kind: 'input',
    nextCurrentConnections: [],
    nextCurrentNodes: [whitespaceNextInput],
    previousCurrentNodes: [whitespacePreviousInput],
    project: makeProject([parent]),
  });
  assert.deepEqual(whitespaceResult.projectGraphSnapshots[firstParentGraphId]!.nextGraph.connections, [
    { ...connection, inputId: ' new ' as PortId },
  ]);

  const equalInput = makeGraphInputNode('equal-input', 'old');
  const disabledDuplicate = { ...makeGraphInputNode('disabled-input', 'old'), disabled: true } as ChartNode;
  for (const nextCurrentNodes of [[equalInput], [makeGraphInputNode('equal-input', 'new'), disabledDuplicate]]) {
    const result = propagateGraphPortRename({
      currentGraphId: childGraphId,
      editedNodeId: equalInput.id,
      kind: 'input',
      nextCurrentConnections: [connection],
      nextCurrentNodes,
      previousCurrentNodes: [equalInput],
      project: makeProject([parent]),
    });

    assert.deepEqual(result.nextCurrentConnections, [connection]);
    assert.deepEqual(result.projectGraphSnapshots, {});
  }
});

test('shared propagation updates every direct caller in one graph and preserves unrelated graphs', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const firstCaller = makeSubGraphNode('first-caller', childGraphId);
  const secondCaller = makeSubGraphNode('second-caller', childGraphId);
  const firstConnection = makeConnection({
    inputNodeId: firstCaller.id,
    inputId: 'old' as PortId,
    outputNodeId: 'first-source' as NodeId,
  });
  const secondConnection = makeConnection({
    inputNodeId: secondCaller.id,
    inputId: 'old' as PortId,
    outputNodeId: 'second-source' as NodeId,
  });
  const callerGraph = makeGraph(firstParentGraphId, [firstCaller, secondCaller], [firstConnection, secondConnection]);
  const unrelatedGraph = makeGraph(secondParentGraphId, [makeSubGraphNode('unrelated', 'another-graph')]);

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInput],
    previousCurrentNodes: [previousInput],
    project: makeProject([callerGraph, unrelatedGraph]),
  });

  assert.deepEqual(Object.keys(result.projectGraphSnapshots), [firstParentGraphId]);
  assert.deepEqual(result.projectGraphSnapshots[firstParentGraphId]!.nextGraph.connections, [
    { ...firstConnection, inputId: 'new' as PortId },
    { ...secondConnection, inputId: 'new' as PortId },
  ]);
});

test('shared input collision handling keeps the existing connection regardless of order', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const caller = makeSubGraphNode('caller', childGraphId, {
    data: { inputData: { old: 'old default', new: 'new default' } },
  });
  const unrelated = makeConnection({ inputNodeId: 'unrelated' as NodeId, inputId: 'value' as PortId });
  const oldConnection = makeConnection({
    inputNodeId: caller.id,
    inputId: 'old' as PortId,
    outputNodeId: 'old-source' as NodeId,
  });
  const newConnection = makeConnection({
    inputNodeId: caller.id,
    inputId: 'new' as PortId,
    outputNodeId: 'new-source' as NodeId,
  });

  for (const connections of [
    [unrelated, newConnection, oldConnection, { ...newConnection }, { ...oldConnection }],
    [unrelated, oldConnection, { ...oldConnection }, newConnection, { ...newConnection }],
  ]) {
    const result = propagateGraphPortRename({
      currentGraphId: childGraphId,
      editedNodeId: previousInput.id,
      kind: 'input',
      nextCurrentConnections: [],
      nextCurrentNodes: [nextInput],
      previousCurrentNodes: [previousInput],
      project: makeProject([makeGraph(firstParentGraphId, [caller], connections)]),
    });
    const nextCallerGraph = result.projectGraphSnapshots[firstParentGraphId]!.nextGraph;

    assert.deepEqual(nextCallerGraph.connections, [unrelated, newConnection]);
    assert.deepEqual((nextCallerGraph.nodes[0]!.data as { inputData?: Record<string, unknown> }).inputData, {
      new: 'new default',
    });
  }
});

test('shared propagation does not mutate frozen live or stored graph fixtures', () => {
  const previousInput = makeGraphInputNode('input', 'old');
  const nextInput = makeGraphInputNode('input', 'new');
  const caller = makeSubGraphNode('caller', childGraphId, {
    data: { inputData: { old: 'old default' } },
  });
  const connection = makeConnection({ inputNodeId: caller.id, inputId: 'old' as PortId });
  const parent = makeGraph(firstParentGraphId, [caller], [connection]);
  const project = makeProject([parent]);

  for (const value of [
    previousInput.data,
    previousInput,
    nextInput.data,
    nextInput,
    caller.data,
    caller,
    connection,
    parent.nodes,
    parent.connections,
    parent.metadata!,
    parent,
    project.graphs,
    project,
  ]) {
    Object.freeze(value);
  }

  const result = propagateGraphPortRename({
    currentGraphId: childGraphId,
    editedNodeId: previousInput.id,
    kind: 'input',
    nextCurrentConnections: [],
    nextCurrentNodes: [nextInput],
    previousCurrentNodes: [previousInput],
    project,
  });

  assert.deepEqual(result.projectGraphSnapshots[firstParentGraphId]!.nextGraph.connections, [
    { ...connection, inputId: 'new' as PortId },
  ]);
  assert.deepEqual((parent.nodes[0]!.data as { inputData?: Record<string, unknown> }).inputData, {
    old: 'old default',
  });
});
