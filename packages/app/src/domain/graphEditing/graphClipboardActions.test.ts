import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';
import { buildPastedGraphs, copyFolderToClipboard, copyGraphToClipboard } from './graphClipboardActions.js';

function node(id: string, type = 'comment', data: Record<string, unknown> = {}): ChartNode {
  return { id: id as NodeId, type, title: type, visualData: { x: 0, y: 0 }, data } as ChartNode;
}

function graph(id: string, name: string, nodes: ChartNode[] = []): NodeGraph {
  return { metadata: { id: id as GraphId, name }, nodes, connections: [] };
}

test('graph copy captures the active unsaved graph and isolates the snapshot', () => {
  const saved = graph('a', 'Folder/Active', [node('saved')]);
  const active = graph('a', 'Folder/Active', [node('unsaved')]);
  const clipboard = copyGraphToClipboard(saved, active)!;
  active.nodes[0]!.title = 'changed after copy';

  assert.equal(clipboard.source, 'graph');
  assert.equal(clipboard.graphs[0]!.nodes[0]!.id, 'unsaved');
  assert.equal(clipboard.graphs[0]!.nodes[0]!.title, 'comment');
  assert.equal(saved.nodes[0]!.id, 'saved');
});

test('folder copy includes nested graphs and the active unsaved graph, but not siblings', () => {
  const saved = [graph('a', 'Folder/A', [node('saved')]), graph('b', 'Folder/Nested/B'), graph('c', 'Elsewhere/C')];
  const active = graph('a', 'Folder/A', [node('unsaved')]);
  const clipboard = copyFolderToClipboard('Folder', saved, active)!;

  assert.deepEqual(clipboard.graphs.map((item) => item.metadata!.name), ['Folder/A', 'Folder/Nested/B']);
  assert.equal(clipboard.graphs[0]!.nodes[0]!.id, 'unsaved');
  assert.equal(copyFolderToClipboard('Empty', saved, active), undefined);
});

test('single graph paste uses its leaf name and resolves collisions without changing the clipboard', () => {
  const clipboard = copyGraphToClipboard(graph('source', 'Source/Leaf'), graph('other', 'Other'))!;
  const original = structuredClone(clipboard);
  const destinationGraphs = [graph('existing', 'Target/Leaf'), graph('copy', 'Target/Leaf (Copy)')];
  const pasted = buildPastedGraphs({
    clipboard,
    destinationFolderPath: 'Target',
    destinationGraphs,
    destinationFolderPaths: ['Target'],
  });

  assert.equal(pasted[0]!.metadata!.name, 'Target/Leaf (Copy 2)');
  assert.notEqual(pasted[0]!.metadata!.id, 'source');
  assert.deepEqual(clipboard, original);
  assert.deepEqual(destinationGraphs.map((item) => item.metadata!.name), ['Target/Leaf', 'Target/Leaf (Copy)']);
});

test('folder paste preserves nested hierarchy and chooses one collision-free folder name', () => {
  const clipboard = copyFolderToClipboard(
    'Source/Folder',
    [graph('a', 'Source/Folder/A'), graph('b', 'Source/Folder/Nested/B')],
    graph('other', 'Other'),
  )!;
  const pasted = buildPastedGraphs({
    clipboard,
    destinationGraphs: [graph('existing', 'Folder/A')],
    destinationFolderPaths: ['Folder', 'Folder (Copy)'],
  });

  assert.deepEqual(pasted.map((item) => item.metadata!.name), ['Folder (Copy 2)/A', 'Folder (Copy 2)/Nested/B']);
});

test('paste remaps copied graph calls and node connections, but leaves outside references unchanged', () => {
  const first = graph('first', 'Folder/First', [
    node('from', 'subGraph', { graphId: 'second' }),
    node('to', 'graphReference', { graphId: 'outside' }),
    node('alias', 'referencedGraphAlias', { projectId: 'external', graphId: 'second' }),
    node('handler', 'delegateFunctionCall', { handlers: [null, { key: 'tool', value: 'second' }] }),
  ]);
  first.nodes[0]!.variants = [{ id: 'legacy', data: null }, { id: 'valid', data: { graphId: 'second' } }];
  first.connections.push({
    outputNodeId: 'from' as NodeId,
    inputNodeId: 'to' as NodeId,
  } as NodeGraph['connections'][number]);
  const second = graph('second', 'Folder/Second', [node('loop', 'loopUntil', { targetGraph: 'first' })]);
  const clipboard = copyFolderToClipboard('Folder', [first, second], graph('other', 'Other'))!;
  const pasted = buildPastedGraphs({
    clipboard,
    destinationGraphs: [graph('destination', 'Main', [node('existing')])],
    destinationFolderPaths: [],
  });
  const [pastedFirst, pastedSecond] = pasted;

  assert.equal(pasted.length, 2);
  assert.notEqual(pastedFirst!.metadata!.id, 'first');
  assert.notEqual(pastedSecond!.metadata!.id, 'second');
  assert.equal((pastedFirst!.nodes[0]!.data as { graphId: string }).graphId, pastedSecond!.metadata!.id);
  assert.equal((pastedFirst!.nodes[1]!.data as { graphId: string }).graphId, 'outside');
  assert.equal((pastedFirst!.nodes[2]!.data as { graphId: string }).graphId, 'second');
  assert.equal(pastedFirst!.nodes[0]!.variants?.[0]?.data, null);
  assert.equal((pastedFirst!.nodes[0]!.variants?.[1]?.data as { graphId: string }).graphId, pastedSecond!.metadata!.id);
  assert.equal(
    (pastedFirst!.nodes[3]!.data as { handlers: Array<null | { value: string }> }).handlers[1]?.value,
    pastedSecond!.metadata!.id,
  );
  assert.equal((pastedSecond!.nodes[0]!.data as { targetGraph: string }).targetGraph, pastedFirst!.metadata!.id);
  assert.equal(pastedFirst!.connections[0]!.outputNodeId, pastedFirst!.nodes[0]!.id);
  assert.equal(pastedFirst!.connections[0]!.inputNodeId, pastedFirst!.nodes[1]!.id);
  assert.notEqual(pastedFirst!.nodes[0]!.id, 'from');
  assert.notEqual(pastedFirst!.nodes[1]!.id, 'to');
  assert.notEqual(pastedFirst!.nodes[1]!.id, 'existing');
  assert.notEqual(pastedFirst!.nodes[0]!.id, pastedSecond!.nodes[0]!.id);
  assert.deepEqual(clipboard.graphs.map((item) => item.metadata!.id), ['first', 'second']);
});
