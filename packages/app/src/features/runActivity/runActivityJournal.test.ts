import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ChartNode,
  type GraphExecutionMetadata,
  type GraphId,
  type GraphRunId,
  type NodeGraph,
  type NodeId,
  type PortId,
  type ProcessId,
  type Project,
  type ProjectId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import {
  createRunActivityJournal,
  createRunActivityNodeKey,
  reduceRunActivityEvents,
  reduceRunActivityJournal,
  type RunActivityEvent,
} from './runActivityJournal.js';

const rootRunId = 'root-1' as RootRunId;
const graphId = 'graph-1' as GraphId;
const graphRunId = 'graph-run-1' as GraphRunId;
const nodeId = 'node-1' as NodeId;
const processId = 'process-1' as ProcessId;

const execution = {
  rootRunId,
  graphId,
  graphRunId,
} satisfies GraphExecutionMetadata;

const graph: NodeGraph = {
  metadata: { id: graphId, name: 'Main graph' },
  nodes: [],
  connections: [],
};

const node: ChartNode = {
  id: nodeId,
  type: 'llmChatV2',
  title: 'Answer the user',
  description: 'Not retained by the journal',
  visualData: { x: 0, y: 0 },
  data: { secretNodeSetting: 'DO_NOT_COPY_NODE_DATA' },
};

const project: Project = {
  metadata: {
    id: 'project-1' as ProjectId,
    title: 'Activity fixture',
    description: '',
    mainGraphId: graphId,
  },
  graphs: { [graphId]: graph },
};

test('projects a complete lifecycle without retaining DataValues or node data', () => {
  let journal = createRunActivityJournal();
  journal = apply(journal, 'start', { project, startGraph: graph, inputs: {}, contextValues: {}, execution }, 10);
  journal = apply(journal, 'graphStart', { graph, inputs: {}, execution }, 11);
  journal = apply(
    journal,
    'nodeStart',
    {
      node,
      processId,
      execution,
      inputs: { ['prompt' as PortId]: { type: 'string', value: 'DO_NOT_COPY_INPUT_VALUE' } },
    },
    12,
  );
  journal = apply(
    journal,
    'partialOutput',
    {
      node,
      processId,
      execution,
      index: 0,
      outputs: { ['response' as PortId]: { type: 'string', value: 'DO_NOT_COPY_PARTIAL_VALUE' } },
    },
    15,
  );
  journal = apply(
    journal,
    'partialOutput',
    {
      node,
      processId,
      execution,
      index: 0,
      outputs: { ['usage' as PortId]: { type: 'number', value: 7 } },
    },
    16,
  );
  journal = apply(
    journal,
    'graphOutputsReady',
    {
      graph,
      execution,
      outputs: { final: { type: 'string', value: 'DO_NOT_COPY_GRAPH_OUTPUT' } },
    },
    17,
  );

  const outputsReadyRoot = journal.rootsById[rootRunId]!;
  assert.equal(outputsReadyRoot.status, 'outputs-ready');
  assert.equal(outputsReadyRoot.graphOutputsReadyAt, 17);
  assert.equal(outputsReadyRoot.finishedAt, undefined);

  journal = apply(
    journal,
    'nodeFinish',
    {
      node,
      processId,
      execution,
      durationMs: 6,
      outputs: { ['response' as PortId]: { type: 'string', value: 'DO_NOT_COPY_FINAL_VALUE' } },
    },
    18,
  );
  journal = apply(
    journal,
    'graphFinish',
    { graph, execution, outputs: { final: { type: 'string', value: 'DO_NOT_COPY_FINISH_VALUE' } } },
    20,
  );

  const root = journal.rootsById[rootRunId]!;
  const key = createRunActivityNodeKey({ rootRunId, graphRunId, nodeId, processId });
  const invocation = root.nodeInvocationsByKey[key]!;

  assert.equal(root.projectTitle, 'Activity fixture');
  assert.equal(root.rootGraphName, 'Main graph');
  assert.equal(root.status, 'completed');
  assert.equal(root.finishedAt, 20);
  assert.equal(invocation.nodeTitle, 'Answer the user');
  assert.equal(invocation.nodeType, 'llmChatV2');
  assert.equal(invocation.status, 'completed');
  assert.equal(invocation.durationMs, 6);
  assert.equal(invocation.partialOutputCount, 2);
  assert.equal(invocation.outputRevision, 3);
  assert.deepEqual(invocation.inputPortIds, ['prompt']);
  assert.deepEqual(invocation.outputPortIds, ['response', 'usage']);
  assert.equal(invocation.firstOutputAt, 15);
  assert.equal(invocation.latestOutputAt, 18);

  const serialized = JSON.stringify(journal);
  for (const forbidden of [
    'DO_NOT_COPY_NODE_DATA',
    'DO_NOT_COPY_INPUT_VALUE',
    'DO_NOT_COPY_PARTIAL_VALUE',
    'DO_NOT_COPY_GRAPH_OUTPUT',
    'DO_NOT_COPY_FINAL_VALUE',
    'DO_NOT_COPY_FINISH_VALUE',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('keeps first-seen invocation order while parallel nodes finish out of order', () => {
  const firstNode = node;
  const secondNode = { ...node, id: 'node-2' as NodeId, title: 'Second node' };
  const firstProcess = processId;
  const secondProcess = 'process-2' as ProcessId;

  const journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('start', { project, startGraph: graph, inputs: {}, contextValues: {}, execution }, 1),
    event('nodeStart', { node: firstNode, processId: firstProcess, inputs: {}, execution }, 2),
    event('nodeStart', { node: secondNode, processId: secondProcess, inputs: {}, execution }, 3),
    event('nodeFinish', { node: secondNode, processId: secondProcess, outputs: {}, execution }, 4),
    event('nodeFinish', { node: firstNode, processId: firstProcess, outputs: {}, execution }, 5),
  ]);

  const root = journal.rootsById[rootRunId]!;
  assert.deepEqual(root.nodeInvocationOrder, [
    createRunActivityNodeKey({ rootRunId, graphRunId, nodeId: firstNode.id, processId: firstProcess }),
    createRunActivityNodeKey({ rootRunId, graphRunId, nodeId: secondNode.id, processId: secondProcess }),
  ]);
  assert.ok(
    root.nodeInvocationsByKey[root.nodeInvocationOrder[0]!]!.sequence <
      root.nodeInvocationsByKey[root.nodeInvocationOrder[1]!]!.sequence,
  );
});

test('keys identical node and process IDs independently for each exact graph invocation', () => {
  const secondGraphRunId = 'graph-run-2' as GraphRunId;
  const secondExecution = { ...execution, graphRunId: secondGraphRunId };
  const journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('nodeStart', { node, processId, inputs: {}, execution }, 1),
    event('nodeStart', { node, processId, inputs: {}, execution: secondExecution }, 2),
  ]);
  const root = journal.rootsById[rootRunId]!;

  assert.equal(root.nodeInvocationOrder.length, 2);
  assert.notEqual(root.nodeInvocationOrder[0], root.nodeInvocationOrder[1]);
  assert.equal(root.nodeInvocationsByKey[root.nodeInvocationOrder[0]!]!.graphRunId, graphRunId);
  assert.equal(root.nodeInvocationsByKey[root.nodeInvocationOrder[1]!]!.graphRunId, secondGraphRunId);
});

test('coalesces split partial outputs into one invocation and tracks output availability', () => {
  const splitNode = { ...node, isSplitRun: true };
  let journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('nodeStart', { node: splitNode, processId, inputs: {}, execution }, 1),
    event(
      'partialOutput',
      {
        node: splitNode,
        processId,
        index: 4,
        outputs: { ['response' as PortId]: { type: 'string', value: 'four' } },
        execution,
      },
      2,
    ),
    event(
      'partialOutput',
      {
        node: splitNode,
        processId,
        index: 1,
        outputs: { ['response' as PortId]: { type: 'string', value: 'one' } },
        execution,
      },
      3,
    ),
    event(
      'partialOutput',
      {
        node: splitNode,
        processId,
        index: 4,
        outputs: { ['usage' as PortId]: { type: 'number', value: 3 } },
        execution,
      },
      4,
    ),
  ]);

  const key = createRunActivityNodeKey({ rootRunId, graphRunId, nodeId, processId });
  let invocation = journal.rootsById[rootRunId]!.nodeInvocationsByKey[key]!;
  assert.equal(journal.rootsById[rootRunId]!.nodeInvocationOrder.length, 1);
  assert.equal(invocation.partialOutputCount, 3);
  assert.deepEqual(invocation.splitOutputIndices, [1, 4]);
  assert.deepEqual(invocation.splitOutputPortIds[4], ['response', 'usage']);
  assert.equal(invocation.outputsAvailable, true);

  journal = apply(journal, 'nodeOutputsCleared', { node: splitNode, processId, execution }, 5);
  invocation = journal.rootsById[rootRunId]!.nodeInvocationsByKey[key]!;
  assert.equal(invocation.outputsAvailable, false);
  assert.equal(invocation.outputsClearedAt, 5);
  assert.equal(invocation.outputRevision, 4);
});

test('attaches bounded model and tool traces without duplicating identified events', () => {
  let journal = createRunActivityJournal({ modelCallsPerInvocation: 1, toolCallsPerInvocation: 2 });
  journal = apply(
    journal,
    'llmCallFinished',
    {
      execution,
      callId: 'call-1' as never,
      nodeId,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      outcome: 'success',
      attemptIndex: 0,
      pricing: { status: 'unknown' },
      durationMs: 10,
    },
    1,
  );
  journal = apply(
    journal,
    'llmCallFinished',
    {
      execution,
      callId: 'call-1' as never,
      nodeId,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      outcome: 'success',
      attemptIndex: 0,
      pricing: { status: 'unknown' },
      durationMs: 12,
    },
    2,
  );
  journal = apply(
    journal,
    'llmCallFinished',
    {
      execution,
      callId: 'call-2' as never,
      nodeId,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      outcome: 'provider-failure',
      attemptIndex: 1,
      pricing: { status: 'unknown' },
    },
    3,
  );
  journal = apply(
    journal,
    'toolCallFinished',
    {
      execution,
      toolCallId: 'tool-1',
      toolName: 'search',
      sourceNodeId: nodeId,
      sourceProcessId: processId,
      handlerKind: 'graph',
      outcome: 'success',
      durationMs: 5,
    },
    4,
  );
  journal = apply(
    journal,
    'toolCallFinished',
    {
      execution,
      toolCallId: 'tool-1',
      toolName: 'search',
      sourceNodeId: nodeId,
      sourceProcessId: processId,
      handlerKind: 'graph',
      outcome: 'success',
      durationMs: 6,
    },
    5,
  );
  journal = apply(
    journal,
    'toolCallFinished',
    {
      execution,
      toolName: 'anonymous',
      sourceNodeId: nodeId,
      sourceProcessId: processId,
      handlerKind: 'external',
      outcome: 'success',
    },
    6,
  );
  journal = apply(
    journal,
    'toolCallFinished',
    {
      execution,
      toolName: 'overflow',
      sourceNodeId: nodeId,
      sourceProcessId: processId,
      handlerKind: 'external',
      outcome: 'failure',
    },
    7,
  );

  const key = createRunActivityNodeKey({ rootRunId, graphRunId, nodeId, processId });
  const invocation = journal.rootsById[rootRunId]!.nodeInvocationsByKey[key]!;
  assert.equal(invocation.modelCallCount, 2);
  assert.equal(invocation.modelCalls.length, 1);
  assert.equal(invocation.modelCalls[0]!.durationMs, 12);
  assert.equal(invocation.omittedModelCallCount, 1);
  assert.equal(invocation.toolCallCount, 3);
  assert.equal(invocation.toolCalls.length, 2);
  assert.equal(invocation.toolCalls[0]!.durationMs, 6);
  assert.equal(invocation.omittedToolCallCount, 1);
});

test('does not invent exact node identities for legacy events with missing execution metadata', () => {
  let journal = apply(
    createRunActivityJournal(),
    'start',
    { project, startGraph: graph, inputs: {}, contextValues: {}, execution },
    1,
  );

  journal = apply(journal, 'nodeStart', { node, processId, inputs: {}, execution: undefined }, 2);

  const root = journal.rootsById[rootRunId]!;
  assert.equal(root.nodeInvocationOrder.length, 0);
  assert.equal(root.omittedLegacyEventCount, 1);

  journal = apply(journal, 'done', { results: {} }, 3);
  assert.equal(journal.rootsById[rootRunId]!.status, 'completed');
});

test('keeps all active roots and only the configured number of completed roots', () => {
  const root2 = 'root-2' as RootRunId;
  const run2 = 'graph-run-2' as GraphRunId;
  const execution2 = { ...execution, rootRunId: root2, graphRunId: run2 };
  let journal = createRunActivityJournal({ completedRootCount: 1 });

  journal = apply(journal, 'graphStart', { graph, inputs: {}, execution }, 1);
  journal = apply(journal, 'graphFinish', { graph, outputs: {}, execution }, 2);
  journal = apply(journal, 'graphStart', { graph, inputs: {}, execution: execution2 }, 3);
  journal = apply(journal, 'graphFinish', { graph, outputs: {}, execution: execution2 }, 4);

  assert.equal(journal.rootsById[rootRunId], undefined);
  assert.equal(journal.rootsById[root2]!.status, 'completed');
  assert.deepEqual(journal.rootOrder, [root2]);
  assert.equal(journal.latestCompletedRootRunId, root2);
});

test('treats processor done after an exact root graph finish as an idempotent confirmation', () => {
  let journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('graphStart', { graph, inputs: {}, execution }, 1),
    event('graphFinish', { graph, outputs: {}, execution }, 2),
  ]);

  journal = apply(journal, 'done', { results: {} }, 3);
  assert.equal(journal.rootsById[rootRunId]!.status, 'completed');
  assert.equal(journal.rootsById[rootRunId]!.finishedAt, 2);
  assert.equal(journal.ignoredLegacyEventCount, 0);
});

test('does not let an exact root terminal confirmation settle another concurrent root', () => {
  const root2 = 'root-2' as RootRunId;
  const run2 = 'graph-run-2' as GraphRunId;
  const execution2 = { ...execution, rootRunId: root2, graphRunId: run2 };
  let journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('graphStart', { graph, inputs: {}, execution }, 1),
    event('graphStart', { graph, inputs: {}, execution: execution2 }, 2),
    event('graphFinish', { graph, outputs: {}, execution }, 3),
  ]);

  // The processor emits this unscoped confirmation immediately after its
  // exact graphFinish. Root 2 is now the only active run, but does not own it.
  journal = apply(journal, 'done', { results: {} }, 4);

  assert.equal(journal.rootsById[rootRunId]!.status, 'completed');
  assert.equal(journal.rootsById[root2]!.status, 'running');
  assert.deepEqual(journal.activeRootRunIds, [root2]);
  assert.equal(journal.pendingUnscopedTerminalConfirmations, 0);
});

test('marks invocations with missing terminal events truthfully when their root settles', () => {
  let journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('graphStart', { graph, inputs: {}, execution }, 1),
    event('nodeStart', { node, processId, inputs: {}, execution }, 2),
    event('graphFinish', { graph, outputs: {}, execution }, 6),
  ]);
  const key = createRunActivityNodeKey({ rootRunId, graphRunId, nodeId, processId });
  let invocation = journal.rootsById[rootRunId]!.nodeInvocationsByKey[key]!;
  assert.equal(invocation.status, 'unknown');
  assert.equal(invocation.terminalEventMissing, true);
  assert.equal(invocation.finishedAt, 6);
  assert.equal(invocation.durationMs, 4);

  const abortedRoot = 'aborted-root' as RootRunId;
  const abortedRun = 'aborted-run' as GraphRunId;
  const abortedExecution = { ...execution, rootRunId: abortedRoot, graphRunId: abortedRun };
  journal = reduceRunActivityEvents(journal, [
    event('graphStart', { graph, inputs: {}, execution: abortedExecution }, 7),
    event('nodeStart', { node, processId, inputs: {}, execution: abortedExecution }, 8),
    event('graphAbort', { graph, successful: false, execution: abortedExecution }, 9),
  ]);
  invocation =
    journal.rootsById[abortedRoot]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ rootRunId: abortedRoot, graphRunId: abortedRun, nodeId, processId })
    ]!;
  assert.equal(invocation.status, 'aborted');
  assert.equal(invocation.terminalEventMissing, true);

  journal = apply(
    journal,
    'nodeFinish',
    { node, processId, outputs: {}, execution: abortedExecution, durationMs: 2 },
    10,
  );
  invocation =
    journal.rootsById[abortedRoot]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ rootRunId: abortedRoot, graphRunId: abortedRun, nodeId, processId })
    ]!;
  assert.equal(invocation.status, 'completed');
  assert.equal(invocation.terminalEventMissing, undefined);
  assert.equal(invocation.durationMs, 2);
});

test('does not mislabel a root graph when the first exact event belongs to a subgraph', () => {
  const subgraphId = 'subgraph' as GraphId;
  const subgraphRunId = 'subgraph-run' as GraphRunId;
  const subgraph: NodeGraph = {
    metadata: { id: subgraphId, name: 'Child graph' },
    nodes: [],
    connections: [],
  };
  const subgraphExecution: GraphExecutionMetadata = {
    rootRunId,
    graphRunId: subgraphRunId,
    graphId: subgraphId,
    parentGraphRunId: graphRunId,
  };
  let journal = apply(
    createRunActivityJournal(),
    'graphStart',
    { graph: subgraph, inputs: {}, execution: subgraphExecution },
    1,
  );
  assert.equal(journal.rootsById[rootRunId]!.rootGraphId, undefined);

  journal = apply(journal, 'graphStart', { graph, inputs: {}, execution }, 2);
  assert.equal(journal.rootsById[rootRunId]!.rootGraphId, graphId);
  assert.equal(journal.rootsById[rootRunId]!.rootGraphName, 'Main graph');
});

test('does not attach an unscoped terminal event when multiple roots are active', () => {
  const root2 = 'root-2' as RootRunId;
  const run2 = 'graph-run-2' as GraphRunId;
  const execution2 = { ...execution, rootRunId: root2, graphRunId: run2 };
  let journal = reduceRunActivityEvents(createRunActivityJournal(), [
    event('graphStart', { graph, inputs: {}, execution }, 1),
    event('graphStart', { graph, inputs: {}, execution: execution2 }, 2),
  ]);

  journal = apply(journal, 'abort', { successful: false, error: 'ambiguous abort' }, 3);
  assert.equal(journal.rootsById[rootRunId]!.status, 'running');
  assert.equal(journal.rootsById[root2]!.status, 'running');
  assert.equal(journal.ignoredLegacyEventCount, 1);
});

function event<TType extends RunActivityEvent['type']>(
  type: TType,
  data: Extract<RunActivityEvent, { type: TType }>['data'],
  occurredAt: number,
): Extract<RunActivityEvent, { type: TType }> {
  return { type, data, occurredAt } as Extract<RunActivityEvent, { type: TType }>;
}

function apply<TType extends RunActivityEvent['type']>(
  journal: ReturnType<typeof createRunActivityJournal>,
  type: TType,
  data: Extract<RunActivityEvent, { type: TType }>['data'],
  occurredAt: number,
) {
  return reduceRunActivityJournal(journal, { type, data, occurredAt } as RunActivityEvent);
}
