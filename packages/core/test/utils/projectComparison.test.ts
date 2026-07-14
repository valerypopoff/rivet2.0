import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareProjects,
  getProjectConnectionComparisonKey,
  getProjectNodeFieldComparisons,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
  type UiComponentId,
  type UiGraphId,
} from '../../src/index.js';
import { compareConnections } from '../../src/utils/projectComparison/connections.js';
import { compareGraphs } from '../../src/utils/projectComparison/graphs.js';
import { compareNodes, getComparableGraphNodes } from '../../src/utils/projectComparison/nodes.js';
import { summarizeGraphComparison } from '../../src/utils/projectComparison/summaries.js';
import { getChangedValueComparisons } from '../../src/utils/projectComparison/values.js';

function node(id: string, data: unknown = { value: id }): ChartNode {
  return {
    id: id as NodeId,
    type: 'text',
    title: id,
    visualData: { x: 0, y: 0, width: 200 },
    data,
  };
}

function commentNode(id: string, text = id): ChartNode {
  return {
    id: id as NodeId,
    type: 'comment',
    title: id,
    visualData: { x: 0, y: 0, width: 200 },
    data: { height: 100, text },
  } as ChartNode;
}

function connection(outputNodeId: string, inputNodeId: string, outputId = 'output', inputId = 'input'): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    inputNodeId: inputNodeId as NodeId,
    outputId: outputId as PortId,
    inputId: inputId as PortId,
  };
}

function graph(id: string, nodes: ChartNode[], connections: NodeConnection[] = [], name = id): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name,
      description: '',
    },
    nodes,
    connections,
  };
}

function project(graphs: NodeGraph[]): Project {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: graphs[0]?.metadata?.id,
    },
    graphs: Object.fromEntries(graphs.map((item) => [item.metadata!.id!, item])) as Record<GraphId, NodeGraph>,
  };
}

test('compareProjects detects added, removed, and changed nodes by id', () => {
  const result = compareProjects(
    project([graph('main', [node('same'), node('changed', { value: 'before' }), node('removed')])]),
    project([graph('main', [node('same'), node('changed', { value: 'after' }), node('added')])]),
  );

  const main = result.graphs['main' as GraphId]!;

  assert.equal(main.kind, 'changed');
  assert.equal(main.nodes['same' as NodeId]?.kind, 'unchanged');
  assert.equal(main.nodes['changed' as NodeId]?.kind, 'changed');
  assert.equal(main.nodes['removed' as NodeId]?.kind, 'removed');
  assert.equal(main.nodes['added' as NodeId]?.kind, 'added');
  assert.deepEqual(main.summary, {
    addedNodes: 1,
    removedNodes: 1,
    changedNodes: 1,
    addedConnections: 0,
    removedConnections: 0,
    changedConnections: 0,
  });
});

test('compareProjects ignores comment node additions, removals, changes, and comment connections', () => {
  const result = compareProjects(
    project([
      graph(
        'main',
        [node('same'), node('source'), commentNode('changed-comment', 'before'), commentNode('removed-comment')],
        [connection('source', 'changed-comment')],
      ),
    ]),
    project([
      graph(
        'main',
        [node('same'), node('source'), commentNode('changed-comment', 'after'), commentNode('added-comment')],
        [connection('source', 'added-comment')],
      ),
    ]),
  );

  const main = result.graphs['main' as GraphId]!;

  assert.equal(main.kind, 'unchanged');
  assert.equal(main.nodes['same' as NodeId]?.kind, 'unchanged');
  assert.equal(main.nodes['source' as NodeId]?.kind, 'unchanged');
  assert.equal(main.nodes['changed-comment' as NodeId], undefined);
  assert.equal(main.nodes['removed-comment' as NodeId], undefined);
  assert.equal(main.nodes['added-comment' as NodeId], undefined);
  assert.deepEqual(main.connections, {});
  assert.deepEqual(main.summary, {
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedConnections: 0,
    removedConnections: 0,
    changedConnections: 0,
  });
});

test('project comparison node policy filters comments before node diffing', () => {
  const comparableNodes = getComparableGraphNodes([node('kept'), commentNode('comment')]);
  const nodeComparisons = compareNodes([node('same'), node('removed')], [node('same'), node('added')]);

  assert.deepEqual(
    comparableNodes.map((item) => item.id),
    ['kept' as NodeId],
  );
  assert.equal(nodeComparisons['same' as NodeId]?.kind, 'unchanged');
  assert.equal(nodeComparisons['removed' as NodeId]?.kind, 'removed');
  assert.equal(nodeComparisons['added' as NodeId]?.kind, 'added');
});

test('compareProjects ignores node visualData-only changes', () => {
  const before = {
    ...node('same'),
    visualData: { x: 10, y: 20, width: 200, zIndex: 1, color: { bg: 'red', border: 'transparent' } },
  };
  const after = {
    ...node('same'),
    visualData: { x: 800, y: 900, width: 200, zIndex: 99, color: { bg: 'blue', border: 'transparent' } },
  };
  const result = compareProjects(project([graph('main', [before])]), project([graph('main', [after])]));

  const main = result.graphs['main' as GraphId]!;

  assert.equal(main.kind, 'unchanged');
  assert.equal(main.nodes['same' as NodeId]?.kind, 'unchanged');
  assert.deepEqual(main.summary, {
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedConnections: 0,
    removedConnections: 0,
    changedConnections: 0,
  });
});

test('getProjectNodeFieldComparisons omits visualData changes but keeps semantic node data changes', () => {
  const before = {
    ...node('changed', { value: 'before' }),
    visualData: { x: 10, y: 20, width: 200, zIndex: 1, color: { bg: 'red', border: 'transparent' } },
  };
  const after = {
    ...node('changed', { value: 'after' }),
    visualData: { x: 800, y: 900, width: 240, zIndex: 99, color: { bg: 'blue', border: 'transparent' } },
  };
  const result = compareProjects(project([graph('main', [before])]), project([graph('main', [after])]));

  const changedNode = result.graphs['main' as GraphId]!.nodes['changed' as NodeId]!;
  const fieldComparisons = getProjectNodeFieldComparisons(changedNode);

  assert.equal(changedNode.kind, 'changed');
  assert.deepEqual(
    fieldComparisons.map((field) => field.field),
    ['data.value'],
  );
});

test('compareProjects ignores subgraph port order-only changes', () => {
  const before = {
    ...node('subgraph', {
      graphId: 'child',
      inputPortOrder: ['first', 'second'],
      outputPortOrder: ['result-a', 'result-b'],
    }),
    type: 'subGraph',
  };
  const after = {
    ...node('subgraph', {
      graphId: 'child',
      inputPortOrder: ['second', 'first'],
      outputPortOrder: ['result-b', 'result-a'],
    }),
    type: 'subGraph',
  };
  const result = compareProjects(project([graph('main', [before])]), project([graph('main', [after])]));

  const main = result.graphs['main' as GraphId]!;

  assert.equal(main.kind, 'unchanged');
  assert.equal(main.nodes['subgraph' as NodeId]?.kind, 'unchanged');
  assert.deepEqual(main.summary, {
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedConnections: 0,
    removedConnections: 0,
    changedConnections: 0,
  });
});

test('getProjectNodeFieldComparisons omits subgraph port order but keeps semantic subgraph data changes', () => {
  const before = {
    ...node('subgraph', {
      graphId: 'before-child',
      inputPortOrder: ['first', 'second'],
      outputPortOrder: ['result-a', 'result-b'],
    }),
    type: 'subGraph',
  };
  const after = {
    ...node('subgraph', {
      graphId: 'after-child',
      inputPortOrder: ['second', 'first'],
      outputPortOrder: ['result-b', 'result-a'],
    }),
    type: 'subGraph',
  };
  const result = compareProjects(project([graph('main', [before])]), project([graph('main', [after])]));

  const changedNode = result.graphs['main' as GraphId]!.nodes['subgraph' as NodeId]!;
  const fieldComparisons = getProjectNodeFieldComparisons(changedNode);

  assert.equal(changedNode.kind, 'changed');
  assert.deepEqual(
    fieldComparisons.map((field) => field.field),
    ['data.graphId'],
  );
});

test('compareProjects detects added, removed, and metadata-changed graphs', () => {
  const result = compareProjects(
    project([graph('renamed', [], [], 'Before'), graph('removed', [])]),
    project([graph('renamed', [], [], 'After'), graph('added', [])]),
  );

  assert.equal(result.graphs['renamed' as GraphId]?.kind, 'changed');
  assert.equal(result.graphs['renamed' as GraphId]?.metadataChanged, true);
  assert.equal(result.graphs['removed' as GraphId]?.kind, 'removed');
  assert.equal(result.graphs['added' as GraphId]?.kind, 'added');
  assert.equal(result.summary.addedGraphs, 1);
  assert.equal(result.summary.removedGraphs, 1);
  assert.equal(result.summary.changedGraphs, 1);
});

test('compareProjects compares connections exactly and marks port rewires as changed pairs', () => {
  const beforeRewired = connection('a', 'b', 'old-output', 'input');
  const afterRewired = connection('a', 'b', 'new-output', 'input');
  const beforeRemoved = connection('c', 'd');
  const afterAdded = connection('e', 'f');
  const result = compareProjects(
    project([
      graph('main', [node('a'), node('b'), node('c'), node('d'), node('e'), node('f')], [beforeRewired, beforeRemoved]),
    ]),
    project([
      graph('main', [node('a'), node('b'), node('c'), node('d'), node('e'), node('f')], [afterRewired, afterAdded]),
    ]),
  );

  const main = result.graphs['main' as GraphId]!;

  assert.equal(main.connections[getProjectConnectionComparisonKey(beforeRewired)]?.kind, 'changed');
  assert.equal(main.connections[getProjectConnectionComparisonKey(afterRewired)]?.kind, 'changed');
  assert.equal(main.connections[getProjectConnectionComparisonKey(beforeRemoved)]?.kind, 'removed');
  assert.equal(main.connections[getProjectConnectionComparisonKey(afterAdded)]?.kind, 'added');
  assert.equal(main.summary.changedConnections, 1);
  assert.equal(main.summary.removedConnections, 1);
  assert.equal(main.summary.addedConnections, 1);
});

test('project comparison connection policy pairs rewires before summarizing added and removed wires', () => {
  const beforeRewired = connection('source', 'target', 'old-output', 'input');
  const afterRewired = connection('source', 'target', 'new-output', 'input');
  const removed = connection('removed-source', 'removed-target');
  const added = connection('added-source', 'added-target');
  const comparisons = compareConnections([beforeRewired, removed], [afterRewired, added]);
  const summary = summarizeGraphComparison({}, comparisons);

  assert.equal(comparisons[getProjectConnectionComparisonKey(beforeRewired)]?.kind, 'changed');
  assert.equal(comparisons[getProjectConnectionComparisonKey(afterRewired)]?.kind, 'changed');
  assert.equal(comparisons[getProjectConnectionComparisonKey(removed)]?.kind, 'removed');
  assert.equal(comparisons[getProjectConnectionComparisonKey(added)]?.kind, 'added');
  assert.deepEqual(summary, {
    addedNodes: 0,
    removedNodes: 0,
    changedNodes: 0,
    addedConnections: 1,
    removedConnections: 1,
    changedConnections: 1,
  });
});

test('project comparison graph policy combines metadata, node, and connection changes', () => {
  const beforeGraph = graph('main', [node('same')], [], 'Before');
  const afterGraph = graph('main', [node('same'), node('added')], [connection('same', 'added')], 'After');
  const comparison = compareGraphs('main' as GraphId, beforeGraph, afterGraph);

  assert.equal(comparison.kind, 'changed');
  assert.equal(comparison.metadataChanged, true);
  assert.equal(comparison.nodes['same' as NodeId]?.kind, 'unchanged');
  assert.equal(comparison.nodes['added' as NodeId]?.kind, 'added');
  assert.equal(Object.values(comparison.connections)[0]?.kind, 'added');
});

test('project comparison one-sided graph connection entries preserve optional side shape', () => {
  const addedConnection = connection('source', 'target');
  const addedComparison = compareGraphs(
    'added' as GraphId,
    undefined,
    graph('added', [node('source'), node('target')], [addedConnection]),
  );
  const removedComparison = compareGraphs(
    'removed' as GraphId,
    graph('removed', [node('source'), node('target')], [addedConnection]),
    undefined,
  );

  assert.equal('before' in Object.values(addedComparison.connections)[0]!, false);
  assert.equal('after' in Object.values(removedComparison.connections)[0]!, false);
});

test('compareProjects summarizes added and removed graph contents through the shared graph summary path', () => {
  const beforeProject = project([
    graph('old', [node('old-source'), node('old-target')], [connection('old-source', 'old-target')]),
  ]);
  const afterProject = project([
    graph('new', [node('new-source'), node('new-target')], [connection('new-source', 'new-target')]),
  ]);
  const comparison = compareProjects(beforeProject, afterProject);

  assert.deepEqual(comparison.summary, {
    addedGraphs: 1,
    removedGraphs: 1,
    changedGraphs: 0,
    addedNodes: 2,
    removedNodes: 2,
    changedNodes: 0,
    addedConnections: 1,
    removedConnections: 1,
    changedConnections: 0,
  });
});

test('compareProjects summarizes added, removed, and changed UI graphs', () => {
  const removedUiGraphId = 'removed-ui-graph' as UiGraphId;
  const changedUiGraphId = 'changed-ui-graph' as UiGraphId;
  const addedUiGraphId = 'added-ui-graph' as UiGraphId;
  const beforeProject = {
    ...project([graph('main', [])]),
    uiGraphs: {
      [removedUiGraphId]: {
        id: removedUiGraphId,
        name: 'Removed app',
        components: [],
      },
      [changedUiGraphId]: {
        id: changedUiGraphId,
        name: 'Changed app',
        components: [],
      },
    },
  } satisfies Project;
  const afterProject = {
    ...project([graph('main', [])]),
    uiGraphs: {
      [changedUiGraphId]: {
        id: changedUiGraphId,
        name: 'Changed app',
        components: [{ id: 'text' as UiComponentId, text: 'Updated', type: 'text' }],
      },
      [addedUiGraphId]: {
        id: addedUiGraphId,
        name: 'Added app',
        components: [],
      },
    },
  } satisfies Project;
  const comparison = compareProjects(beforeProject, afterProject);

  assert.equal(comparison.uiGraphs?.[removedUiGraphId]?.kind, 'removed');
  assert.equal(comparison.uiGraphs?.[changedUiGraphId]?.kind, 'changed');
  assert.equal(comparison.uiGraphs?.[addedUiGraphId]?.kind, 'added');
  assert.equal(comparison.summary.removedUiGraphs, 1);
  assert.equal(comparison.summary.changedUiGraphs, 1);
  assert.equal(comparison.summary.addedUiGraphs, 1);
});

test('compareProjects ignores connection bend-point-only changes', () => {
  const beforeConnection = connection('a', 'b');
  const afterConnection = { ...beforeConnection, bendPoint: { x: 120, y: 240 } };
  const result = compareProjects(
    project([graph('main', [node('a'), node('b')], [beforeConnection])]),
    project([graph('main', [node('a'), node('b')], [afterConnection])]),
  );

  const main = result.graphs['main' as GraphId]!;
  const comparison = main.connections[getProjectConnectionComparisonKey(beforeConnection)]!;

  assert.equal(main.kind, 'unchanged');
  assert.equal(comparison.kind, 'unchanged');
  assert.equal(main.summary.changedConnections, 0);
});

test('getProjectNodeFieldComparisons reports changed node config fields', () => {
  const result = compareProjects(
    project([graph('main', [node('changed', { value: 'before' })])]),
    project([graph('main', [{ ...node('changed', { value: 'after' }), title: 'Renamed' }])]),
  );

  const changedNode = result.graphs['main' as GraphId]!.nodes['changed' as NodeId]!;
  const fieldComparisons = getProjectNodeFieldComparisons(changedNode);

  assert.deepEqual(
    fieldComparisons.map((field) => field.field),
    ['data.value', 'title'],
  );
  assert.deepEqual(
    fieldComparisons.find((field) => field.field === 'title'),
    {
      after: 'Renamed',
      before: 'changed',
      field: 'title',
      path: ['title'],
    },
  );
});

test('getProjectNodeFieldComparisons reports only nested attributes that changed', () => {
  const result = compareProjects(
    project([graph('main', [node('changed', { nested: { changed: 'before', same: 'same' } })])]),
    project([graph('main', [node('changed', { nested: { changed: 'after', same: 'same' } })])]),
  );

  const changedNode = result.graphs['main' as GraphId]!.nodes['changed' as NodeId]!;
  const fieldComparisons = getProjectNodeFieldComparisons(changedNode);

  assert.deepEqual(fieldComparisons, [
    {
      after: 'after',
      before: 'before',
      field: 'data.nested.changed',
      path: ['data', 'nested', 'changed'],
    },
  ]);
});

test('getProjectNodeFieldComparisons reports array item changes by index', () => {
  const result = compareProjects(
    project([graph('main', [node('changed', { items: ['same', 'before'] })])]),
    project([graph('main', [node('changed', { items: ['same', 'after'] })])]),
  );

  const changedNode = result.graphs['main' as GraphId]!.nodes['changed' as NodeId]!;
  const fieldComparisons = getProjectNodeFieldComparisons(changedNode);

  assert.deepEqual(fieldComparisons, [
    {
      after: 'after',
      before: 'before',
      field: 'data.items[1]',
      path: ['data', 'items', '1'],
    },
  ]);
});

test('project comparison field-path policy formats nested keys and array indexes', () => {
  assert.deepEqual(
    getChangedValueComparisons([], { data: { 'spaced key': ['before'] } }, { data: { 'spaced key': ['after'] } }),
    [
      {
        before: 'before',
        after: 'after',
        field: 'data["spaced key"][0]',
        path: ['data', 'spaced key', '0'],
      },
    ],
  );
});
