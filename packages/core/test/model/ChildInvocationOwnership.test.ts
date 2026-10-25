import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChildInvocationOwnership } from '../../src/model/ChildInvocationOwnership.js';
import { GraphInvocationState } from '../../src/model/GraphExecutionState.js';
import type { GraphRunId, RootRunId } from '../../src/model/ProcessContext.js';

test('branch modes explicitly preserve their different identity, cancellation and state aliases', () => {
  const run = new GraphInvocationState();
  run.rootRunId = 'root-run' as RootRunId;
  run.graphRunId = 'parent-run' as GraphRunId;
  run.parentGraphRunId = 'ancestor-run' as GraphRunId;
  run.graphOutputs = {};
  run.graphInputNodeValues = { input: { type: 'string', value: 'snapshot' } };
  run.attachedNodeData = new Map();
  const context = {
    parent: {},
    root: {},
    abortOwner: {},
    sameGraphOwner: {},
    rootGraphOrigin: false,
    run,
    rootIdentity: run,
    sameGraphIdentity: run,
    newGraphRunId: () => 'async-run' as GraphRunId,
  };
  const overlay = {};
  const continuation = resolveChildInvocationOwnership({ kind: 'continuation', graphOutputs: overlay }, context);
  assert.equal(continuation.abortOwner, context.abortOwner);
  assert.equal(continuation.sameGraphOwner, context.sameGraphOwner);
  assert.equal(continuation.state.graphOutputs, overlay);
  assert.equal(continuation.state.attachedNodeData, run.attachedNodeData);
  assert.equal(continuation.identity.graphRunId, run.graphRunId);
  assert.equal(continuation.suppressPartialOutputs, false);

  const branch = resolveChildInvocationOwnership({ kind: 'async' }, context);
  assert.equal(branch.parent, context.sameGraphOwner);
  assert.equal(branch.abortOwner, context.root);
  assert.equal(branch.state.graphInputNodeValues, run.graphInputNodeValues);
  assert.notEqual(branch.state.graphOutputs, run.graphOutputs);
  assert.equal(branch.identity.graphRunId, 'async-run');
  assert.equal(branch.identity.parentGraphRunId, run.graphRunId);
  assert.equal(branch.suppressLifecycle, false);
  const rootBranch = resolveChildInvocationOwnership({ kind: 'async' }, { ...context, rootGraphOrigin: true });
  assert.equal(rootBranch.identity.graphRunId, run.graphRunId);
  assert.equal(rootBranch.suppressLifecycle, true);

  const watch = resolveChildInvocationOwnership({ kind: 'watch', graphRunId: 'watch-run' as GraphRunId }, context);
  assert.equal(watch.parent, context.parent);
  assert.equal(watch.abortOwner, context.root);
  assert.notEqual(watch.state.attachedNodeData, run.attachedNodeData);
  assert.notEqual(watch.state.graphInputNodeValues, run.graphInputNodeValues);
  assert.deepEqual(watch.state.graphInputNodeValues, run.graphInputNodeValues);
  assert.notEqual(watch.state.graphOutputs, run.graphOutputs);
  assert.equal(watch.identity.graphRunId, 'watch-run');
  assert.equal(watch.suppressLifecycle, true);
  assert.equal(watch.suppressPartialOutputs, true);
});
