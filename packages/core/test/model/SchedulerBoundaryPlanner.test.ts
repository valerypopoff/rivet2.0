import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '../../src/model/NodeBase.js';
import type { NodeGraph } from '../../src/model/NodeGraph.js';
import { planAsyncBranchTopology, planStreamingWatchTopology } from '../../src/model/SchedulerBoundaryPlanner.js';

function node(id: string, type = 'text'): ChartNode {
  return { id: id as NodeId, type, title: id, data: {}, visualData: { x: 0, y: 0 } };
}
function wire(output: ChartNode, input: ChartNode, inputId = 'input', outputId = 'output'): NodeConnection {
  return { outputNodeId: output.id, inputNodeId: input.id, inputId: inputId as PortId, outputId: outputId as PortId };
}
function options(nodes: ChartNode[], connections: NodeConnection[]) {
  const graph: NodeGraph = { nodes, connections };
  return {
    graph,
    executionNodes: nodes,
    nodesById: Object.fromEntries(nodes.map((n) => [n.id, n])),
    connections,
    preloadedNodes: new Set<NodeId>(),
  };
}

void test('Watch planning retains definition identities, authored order and the Stop boundary without mutating the source', () => {
  const source = node('source'),
    watch = node('watch', 'watchStreamingOutput'),
    branch = node('branch');
  const stop = node('stop', 'stopWatchingStreamingOutput'),
    after = node('after', 'graphOutput');
  const input = options(
    [source, watch, branch, stop, after],
    [
      wire(source, watch, 'stream'),
      wire(watch, branch, 'input', 'allStreamedOutput'),
      wire(branch, stop),
      wire(stop, after),
    ],
  );
  const before = JSON.stringify(input.graph);
  const [plan] = [...planStreamingWatchTopology(input)];
  assert.equal(plan?.kind, 'watch');
  if (plan?.kind !== 'watch') throw new Error('Missing Watch plan');
  assert.deepEqual(plan.graph.nodes, [watch, branch, stop]);
  assert.equal(plan.graph.nodes[1], branch);
  assert.deepEqual([...plan.branchNodeIds], [branch.id, stop.id]);
  assert.equal(plan.includeAllStreamedOutput, true);
  assert.equal(plan.stopNodeId, stop.id);
  assert.equal(JSON.stringify(input.graph), before);
});

void test('Watch planning stays lazy: an earlier dormant boundary is yielded before a later invalid one', () => {
  const dormant = node('dormant', 'watchStreamingOutput'),
    invalid = node('invalid', 'watchStreamingOutput'),
    source = node('source');
  const iterator = planStreamingWatchTopology(options([dormant, invalid, source], [wire(source, invalid, 'wrong')]));
  assert.deepEqual(iterator.next().value, { kind: 'dormant', watchNode: dormant });
  assert.throws(() => iterator.next(), /exactly one Streaming Output input/);
});

void test('consumed, disabled and irrelevant Watch definitions do not create new boundaries', () => {
  const consumed = node('consumed', 'watchStreamingOutput'),
    disabled = { ...node('disabled', 'watchStreamingOutput'), disabled: true };
  const irrelevant = node('irrelevant', 'watchStreamingOutput');
  assert.deepEqual(
    [
      ...planStreamingWatchTopology({
        ...options([consumed, disabled, irrelevant], []),
        consumedWatchNodeId: consumed.id,
        relevantNodeIds: new Set([consumed.id, disabled.id]),
      }),
    ],
    [],
  );
});

void test('Watch external inputs and Stop reentry remain invalid', () => {
  const source = node('source'),
    watch = node('watch', 'watchStreamingOutput'),
    branch = node('branch'),
    stop = node('stop', 'stopWatchingStreamingOutput');
  const base = [wire(source, watch, 'stream'), wire(watch, branch), wire(branch, stop)];
  assert.throws(
    () => [...planStreamingWatchTopology(options([source, watch, branch, stop], [...base, wire(source, branch)]))],
    /outside the watch branch/,
  );
  assert.throws(
    () => [...planStreamingWatchTopology(options([source, watch, branch, stop], [...base, wire(stop, branch)]))],
    /cannot reconnect to its own/,
  );
});

void test('async planning includes shallow input anchors without scheduling an outer trigger again', () => {
  const outer = node('outer', 'startBackgroundBranch'),
    trigger = node('trigger', 'startBackgroundBranch'),
    work = node('work');
  const input = options([outer, trigger, work], [wire(outer, trigger), wire(trigger, work)]);
  const [plan] = [...planAsyncBranchTopology({ ...input, inputAnchorNodeIds: new Set([outer.id]) })];
  assert.equal(plan?.triggerNode, trigger);
  assert.deepEqual(plan?.graph.nodes, [outer, trigger, work]);
  assert.deepEqual([...plan!.nodeIds], [work.id]);
});

void test('async preloading and nested Watch guards preserve their distinct error boundaries', () => {
  const trigger = node('trigger', 'startBackgroundBranch'),
    work = node('work'),
    watch = node('watch', 'watchStreamingOutput');
  const input = options([trigger, work], [wire(trigger, work)]);
  assert.throws(
    () => [...planAsyncBranchTopology({ ...input, preloadedNodes: new Set([trigger.id]) })],
    /repeat async side effects/,
  );
  assert.throws(
    () => [
      ...planAsyncBranchTopology({ ...input, consumedTriggerNodeId: trigger.id, preloadedNodes: new Set([work.id]) }),
    ],
    /bypass the trigger boundary/,
  );
  assert.throws(
    () => [...planAsyncBranchTopology({ ...input, enclosingWatchNode: watch })],
    /must keep all work within the Watch scheduler/,
  );
});

void test('async slices stop at disabled descendants and exclude irrelevant work', () => {
  const trigger = node('trigger', 'startBackgroundBranch'),
    disabled = { ...node('disabled'), disabled: true },
    work = node('work');
  const input = options([trigger, disabled, work], [wire(trigger, disabled), wire(disabled, work)]);
  assert.deepEqual([...planAsyncBranchTopology(input)], []);
  assert.deepEqual(
    [
      ...planAsyncBranchTopology({
        ...options([trigger, work], [wire(trigger, work)]),
        relevantNodeIds: new Set([trigger.id]),
      }),
    ],
    [],
  );
});

void test('async planning yields earlier valid slices before later failures and preserves incoming edge order', () => {
  const first = node('first', 'startBackgroundBranch');
  const firstWork = node('first-work');
  const second = node('second', 'startBackgroundBranch');
  const secondWork = node('second-work');
  const externalA = node('external-a');
  const externalB = node('external-b');
  const input = options(
    [first, firstWork, second, secondWork, externalA, externalB],
    [wire(first, firstWork), wire(second, secondWork), wire(externalA, secondWork), wire(externalB, secondWork)],
  );
  const before = JSON.stringify(input.graph);
  const iterator = planAsyncBranchTopology(input);
  const plan = iterator.next().value;
  assert.equal(plan?.triggerNode, first);
  assert.deepEqual(plan?.graph.nodes, [first, firstWork]);
  assert.equal(plan?.graph.connections[0], input.connections[0]);
  assert.throws(() => iterator.next(), /"external-a" outside the async branch/);
  assert.equal(JSON.stringify(input.graph), before);
});

void test('async planning rejects trigger reentry and graph outputs rather than admitting unsafe slices', () => {
  const trigger = node('trigger', 'startBackgroundBranch');
  const work = node('work');
  const output = node('output', 'graphOutput');
  assert.throws(
    () => [...planAsyncBranchTopology(options([trigger, work], [wire(trigger, work), wire(work, trigger)]))],
    /cannot be part of a cycle/,
  );
  assert.throws(
    () => [...planAsyncBranchTopology(options([trigger, work, output], [wire(trigger, work), wire(work, output)]))],
    /side-effect-only/,
  );
});
