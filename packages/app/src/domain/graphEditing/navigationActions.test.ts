import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type ProjectId, type NodeId } from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  createInitialGraphNavigationStack,
  getGraphNavigationAvailability,
  resolveNavigationTarget,
  appendCrossProjectGraphNavigation,
  createSubgraphGraphViewContext,
} from './navigationActions';

test('cross-project history preserves caller context and truncates forward history', () => {
  const caller = createSubgraphGraphViewContext({
    graphId: 'shared' as GraphId,
    parentGraphId: 'root' as GraphId,
    parentNodeId: 'call' as NodeId,
  });
  const source = {
    stack: [createRootGraphViewContext('root' as GraphId), caller, createRootGraphViewContext('discarded' as GraphId)],
    index: 1,
  };
  const trail = appendCrossProjectGraphNavigation({
    navigationStack: source,
    sourceProjectId: 'a' as ProjectId,
    sourceGraphId: 'shared' as GraphId,
    targetProjectId: 'b' as ProjectId,
    targetGraphId: 'shared' as GraphId,
  });
  assert.equal(source.stack.length, 3);
  assert.equal(trail.stack.length, 3);
  assert.equal(trail.index, 2);
  assert.deepEqual(trail.stack[1], { ...caller, projectId: 'a' });
  const project = { graphs: { shared: {} as never } };
  const back = resolveNavigationTarget({
    direction: 'backward',
    navigationStack: trail,
    project,
    getProject: () => project,
  });
  assert.equal(back?.targetView.projectId, 'a');
  assert.deepEqual(back?.targetView.parent, caller.parent);
  const forward = resolveNavigationTarget({
    direction: 'forward',
    navigationStack: back!.nextStack,
    project,
    getProject: () => project,
  });
  assert.equal(forward?.targetView.projectId, 'b');
  assert.equal(
    resolveNavigationTarget({
      direction: 'backward',
      navigationStack: trail,
      project,
      getProject: (view) => (view.projectId === 'b' ? project : undefined),
    }),
    undefined,
  );
  const next = appendCrossProjectGraphNavigation({
    navigationStack: trail,
    sourceProjectId: 'b' as ProjectId,
    sourceGraphId: 'shared' as GraphId,
    targetProjectId: 'c' as ProjectId,
    targetGraphId: 'third' as GraphId,
  });
  assert.deepEqual(
    next.stack.map((view) => view.projectId),
    ['a', 'a', 'b', 'c'],
  );
});

test('createInitialGraphNavigationStack seeds history for the current graph once', () => {
  const result = createInitialGraphNavigationStack({
    currentGraphId: 'graph-1' as GraphId,
    availableGraphIds: ['graph-1' as GraphId, 'graph-2' as GraphId],
    existingStack: { stack: [], index: undefined },
  });

  assert.deepEqual(result, { stack: [createRootGraphViewContext('graph-1' as GraphId)], index: 0 });
});

test('getGraphNavigationAvailability reports forward and backward navigation correctly', () => {
  assert.deepEqual(
    getGraphNavigationAvailability({
      stack: [createRootGraphViewContext('a' as GraphId), createRootGraphViewContext('b' as GraphId)],
      index: 0,
    }),
    {
      hasBackward: false,
      hasForward: true,
    },
  );

  assert.deepEqual(
    getGraphNavigationAvailability({
      stack: [createRootGraphViewContext('a' as GraphId), createRootGraphViewContext('b' as GraphId)],
      index: 1,
    }),
    {
      hasBackward: true,
      hasForward: false,
    },
  );
});

test('resolveNavigationTarget returns the next backward target and stack mutation', () => {
  const graphA = 'a' as GraphId;
  const graphB = 'b' as GraphId;

  const target = resolveNavigationTarget({
    direction: 'backward',
    navigationStack: {
      stack: [createRootGraphViewContext(graphA), createRootGraphViewContext(graphB)],
      index: 1,
    },
    project: { graphs: { [graphA]: {} as any, [graphB]: {} as any } },
  });

  assert.deepEqual(target, {
    nextStack: {
      stack: [createRootGraphViewContext('a' as GraphId), createRootGraphViewContext('b' as GraphId)],
      index: 0,
    },
    targetGraphId: 'a',
    targetView: createRootGraphViewContext('a' as GraphId),
  });
});

test('graph history skips entries for deleted graphs', () => {
  const graphA = 'a' as GraphId;
  const deletedGraph = 'deleted' as GraphId;
  const graphB = 'b' as GraphId;
  const navigationStack = {
    stack: [
      createRootGraphViewContext(graphA),
      createRootGraphViewContext(deletedGraph),
      createRootGraphViewContext(graphB),
    ],
    index: 0,
  };
  const project = { graphs: { [graphA]: {} as never, [graphB]: {} as never } };

  assert.deepEqual(getGraphNavigationAvailability(navigationStack, project), {
    hasBackward: false,
    hasForward: true,
  });
  assert.deepEqual(resolveNavigationTarget({ direction: 'forward', navigationStack, project }), {
    nextStack: { ...navigationStack, index: 2 },
    targetGraphId: graphB,
    targetView: createRootGraphViewContext(graphB),
  });
});
