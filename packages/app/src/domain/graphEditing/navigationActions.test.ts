import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId } from '@valerypopoff/rivet2-core';
import {
  createRootGraphViewContext,
  createInitialGraphNavigationStack,
  getGraphNavigationAvailability,
  resolveNavigationTarget,
} from './navigationActions';

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
  assert.deepEqual(
    resolveNavigationTarget({ direction: 'forward', navigationStack, project }),
    {
      nextStack: { ...navigationStack, index: 2 },
      targetGraphId: graphB,
      targetView: createRootGraphViewContext(graphB),
    },
  );
});
