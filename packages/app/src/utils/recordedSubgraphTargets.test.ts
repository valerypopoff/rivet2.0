import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecordedEvents, SubGraphNode } from '@valerypopoff/rivet2-core';
import { buildRecordedSubgraphTargetIndex, getRecordedSubgraphTarget } from './recordedSubgraphTargets.js';

const target = {
  nodeId: 'node',
  targetProjectId: 'target',
  targetVersion: 'latest',
  targetGraphId: 'graph',
  projectName: 'Historical project',
  graphName: 'folder/Historical graph',
};
const node = { id: 'node', data: { targetProjectId: 'target', graphId: 'graph' } } as SubGraphNode;
const start = { type: 'start', data: { projectId: 'source', execution: { projectId: 'source' } } };
function graph(targets: unknown, execution: unknown = { projectId: 'source' }, graphId = 'caller') {
  return { type: 'graphStart', data: { graphId, inputs: {}, execution, subgraphTargets: targets } };
}
function index(events: unknown[]) {
  return buildRecordedSubgraphTargetIndex(events as RecordedEvents[]);
}

test('recorded labels match source graph, node, target and version without borrowing another project scope', () => {
  const values = index([
    start,
    graph([target, { ...target, targetVersion: 'published', projectName: 'Published project' }]),
    graph([{ ...target, projectName: 'Other graph' }], undefined, 'other-graph'),
    graph([{ ...target, projectName: 'Other source' }], { projectId: 'other-source' }),
    graph([{ ...target, projectName: 'Other version of same source' }], {
      projectId: 'source',
      projectScope: 'child-scope',
    }),
  ]);
  assert.equal(getRecordedSubgraphTarget(values, 'caller', node)?.projectName, 'Historical project');
  assert.equal(
    getRecordedSubgraphTarget(values, 'caller', { ...node, data: { ...node.data, targetVersion: 'published' } })
      ?.projectName,
    'Published project',
  );
  assert.equal(getRecordedSubgraphTarget(values, 'other-graph', node)?.projectName, 'Other graph');
  for (const changed of [
    { ...node, id: 'different' },
    { ...node, data: { ...node.data, graphId: 'other' } },
    { ...node, data: { ...node.data, targetProjectId: 'other' } },
  ]) {
    assert.equal(getRecordedSubgraphTarget(values, 'caller', changed as SubGraphNode), undefined);
  }
  assert.equal(getRecordedSubgraphTarget(values, 'missing', node), undefined);
});

test('standalone child recordings derive their owner from graphStart and preserve partial historical names', () => {
  const values = index([
    graph([{ ...target, projectName: '  ', graphName: 'Only graph' }], {
      projectId: 'child',
      projectScope: 'child-scope',
    }),
    graph([{ ...target, projectName: 'Wrong scope' }], { projectId: 'child' }),
  ]);
  const result = getRecordedSubgraphTarget(values, 'caller', node)!;
  assert.equal(result.projectName, undefined);
  assert.equal(result.graphName, 'Only graph');
});

test('conflicting labels stay unavailable regardless of duplicate ordering', () => {
  const conflicting = { ...target, graphName: 'Different graph' };
  for (const targets of [
    [target, target, conflicting, target],
    [conflicting, target, target],
    [target, conflicting, conflicting],
  ]) {
    assert.equal(getRecordedSubgraphTarget(index([start, graph(targets)]), 'caller', node), undefined);
    assert.equal(
      getRecordedSubgraphTarget(index([start, ...targets.map((entry) => graph([entry]))]), 'caller', node),
      undefined,
    );
  }
  assert.equal(
    getRecordedSubgraphTarget(index([start, graph([target, target])]), 'caller', node)?.graphName,
    target.graphName,
  );
});

test('legacy, malformed and contradictory owner data cannot supply labels', () => {
  for (const events of [
    [],
    [start],
    [start, graph(undefined)],
    [graph([target], {})],
    [{ ...start, data: { projectId: 'source', execution: { projectId: 'different' } } }, graph([target])],
    [start, graph({})],
  ]) {
    assert.equal(getRecordedSubgraphTarget(index(events), 'caller', node), undefined);
  }
  // Field validation belongs to Core; this boundary must still retain a valid
  // sibling when a recording also contains an invalid optional entry.
  const values = index([start, graph([null, target])]);
  assert.equal(getRecordedSubgraphTarget(values, 'caller', node)?.projectName, target.projectName);
  assert.equal(getRecordedSubgraphTarget(undefined, 'caller', node), undefined);
});

test('index tuple keys do not collide with delimiters or object prototype names', () => {
  const unusual = { ...target, nodeId: '__proto__', targetGraphId: 'graph|path', projectName: '<b>literal name</b>' };
  const values = index([start, graph([unusual], undefined, 'caller|other')]);
  assert.equal(
    getRecordedSubgraphTarget(values, 'caller|other', {
      ...node,
      id: '__proto__',
      data: { ...node.data, graphId: 'graph|path' },
    } as SubGraphNode)?.projectName,
    '<b>literal name</b>',
  );
  assert.equal(
    getRecordedSubgraphTarget(values, 'caller', {
      ...node,
      id: 'other|__proto__',
      data: { ...node.data, graphId: 'graph|path' },
    } as SubGraphNode),
    undefined,
  );
});
