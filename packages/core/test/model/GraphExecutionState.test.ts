import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphInvocationState, GraphSharedExecutionState } from '../../src/model/GraphExecutionState.js';
import { GraphSchedulerBoundaryState } from '../../src/model/GraphSchedulerBoundaryState.js';
import type { NodeId } from '../../src/model/NodeBase.js';
import type { GraphInputStreamRelay } from '../../src/model/GraphInputStream.js';
import PQueue from '../../src/utils/pQueueCompat.js';

test('invocation initialization retains explicit continuation aliases and clears transient results', () => {
  const invocation = new GraphInvocationState();
  const override = { graphOutputs: {}, attachedNodeData: new Map(), graphInputNodeValues: {} };
  const reset = () =>
    invocation.initialize({
      preloadedNodeResults: new Map(),
      remainingNodeIds: [],
      processingQueue: new PQueue(),
      createAbortController: () => new AbortController(),
      loadedProjects: {},
      sharedOverride: override,
    });
  reset();
  const previousAbort = invocation.abortController;
  invocation.totalCost = 5;
  invocation.visitedNodes.add('old' as NodeId);
  reset();
  assert.equal(invocation.graphOutputs, override.graphOutputs);
  assert.equal(invocation.attachedNodeData, override.attachedNodeData);
  assert.equal(invocation.graphInputNodeValues, override.graphInputNodeValues);
  assert.notEqual(invocation.abortController, previousAbort);
  assert.equal(invocation.totalCost, 0);
  assert.equal(invocation.visitedNodes.size, 0);
});

test('input stream teardown releases every resource once even after a disposer throws', () => {
  const boundaries = new GraphSchedulerBoundaryState();
  let disposed = 0;
  let finished = 0;
  boundaries.inputStreamDisposers.push(
    () => {
      throw new Error('host cleanup');
    },
    () => {
      disposed += 1;
    },
  );
  boundaries.callerInputStreams.set('caller' as NodeId, {
    input: {
      finish: () => {
        finished += 1;
      },
    } as unknown as GraphInputStreamRelay,
  });
  assert.throws(() => boundaries.releaseInputStreams(), AggregateError);
  boundaries.releaseInputStreams();
  assert.equal(disposed, 1);
  assert.equal(finished, 1);
  assert.equal(boundaries.inputStreamDisposers.length, 0);
  assert.equal(boundaries.callerInputStreams.size, 0);
});

test('root scopes retain intentional globals/cache without rebinding old child target caches', () => {
  const previous = new GraphSharedExecutionState();
  previous.globals = new Map();
  previous.executionCache = new Map([['retained', 1]]);
  const next = previous.nextRootRun();
  assert.equal(next.executionCache, previous.executionCache);
  assert.equal(next.globals, previous.globals);
  assert.notEqual(next.subgraphTargetCache, previous.subgraphTargetCache);
  assert.equal(previous.executionCache.get('retained'), 1);
});

test('ordinary invocation holders do not share mutable input or abort-controller collections', () => {
  const a = new GraphInvocationState();
  const b = new GraphInvocationState();
  assert.notEqual(a.nodeAbortControllers, b.nodeAbortControllers);
  assert.notEqual(a.graphInputNodeValues, b.graphInputNodeValues);
});

test('catch drain includes work admitted while an earlier boundary finishes', async () => {
  const boundaries = new GraphSchedulerBoundaryState();
  let waits = 0;
  let completed = 0;
  const add = () => {
    const task = Promise.resolve().then(() => {
      boundaries.streamingCatchTasks.delete(task);
      completed += 1;
    });
    boundaries.streamingCatchTasks.add(task);
  };
  add();
  await boundaries.drainCatchTasks(async () => {
    waits += 1;
    if (waits === 1) add();
  });
  assert.ok(waits >= 1);
  assert.equal(completed, 2);
  assert.equal(boundaries.streamingCatchTasks.size, 0);
});
