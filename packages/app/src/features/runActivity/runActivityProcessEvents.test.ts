import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChartNode,
  GraphExecutionMetadata,
  GraphId,
  GraphRunId,
  NodeId,
  ProcessEventMessageMap,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import { createRunActivityNodeKey, createRunActivityJournal } from './runActivityJournal.js';
import { applyProcessEventToRunActivityJournal } from './runActivityProcessEvents.js';

const execution: GraphExecutionMetadata = {
  rootRunId: 'root' as RootRunId,
  graphRunId: 'graph-run' as GraphRunId,
  graphId: 'graph' as GraphId,
};
const node: ChartNode = {
  id: 'node' as NodeId,
  type: 'text',
  title: 'Text',
  data: {},
  visualData: { x: 0, y: 0 },
};

test('preserves explicit runtime provenance and leaves legacy provenance unknown', () => {
  const explicitProcessId = 'explicit' as ProcessId;
  const legacyProcessId = 'legacy' as ProcessId;
  let journal = createRunActivityJournal();

  journal = applyProcessEventToRunActivityJournal({
    journal,
    message: 'nodeStart',
    occurredAt: 1,
    data: {
      node,
      processId: explicitProcessId,
      inputs: {},
      resultOrigin: 'executed',
      execution,
    } satisfies ProcessEventMessageMap['nodeStart'],
  });
  journal = applyProcessEventToRunActivityJournal({
    journal,
    message: 'nodeStart',
    occurredAt: 2,
    data: {
      node,
      processId: legacyProcessId,
      inputs: {},
      execution,
    } satisfies ProcessEventMessageMap['nodeStart'],
  });

  const root = journal.rootsById[execution.rootRunId]!;
  assert.equal(
    root.nodeInvocationsByKey[createRunActivityNodeKey({ ...execution, nodeId: node.id, processId: explicitProcessId })]
      ?.resultOrigin,
    'executed',
  );
  assert.equal(
    root.nodeInvocationsByKey[createRunActivityNodeKey({ ...execution, nodeId: node.id, processId: legacyProcessId })]
      ?.resultOrigin,
    'unknown',
  );
});

test('recognizes the reserved legacy preload process identity', () => {
  const processId = 'preload' as ProcessId;
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'nodeFinish',
    occurredAt: 1,
    data: {
      node,
      processId,
      outputs: {},
      execution,
    } satisfies ProcessEventMessageMap['nodeFinish'],
  });

  assert.equal(
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]?.resultOrigin,
    'preloaded',
  );
});

test('uses a deferred event occurrence time instead of its later delivery time', () => {
  const processId = 'deferred-watch-finish' as ProcessId;
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'nodeFinish',
    // The UI received this retained Watch event much later than it occurred.
    occurredAt: 20_000,
    data: {
      node,
      processId,
      outputs: {},
      eventOccurredAt: 10_070,
      execution,
    } satisfies ProcessEventMessageMap['nodeFinish'],
  });

  assert.equal(
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]?.finishedAt,
    10_070,
  );
});

test('projects user-input and progress events through the process-event boundary', () => {
  const processId = 'interactive' as ProcessId;
  let journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'userInput',
    occurredAt: 1,
    data: {
      node,
      processId,
      inputs: {},
      inputStrings: ['Choose one'],
      renderingType: 'markdown',
      execution,
    } satisfies ProcessEventMessageMap['userInput'],
  });
  journal = applyProcessEventToRunActivityJournal({
    journal,
    message: 'progress',
    occurredAt: 2,
    data: {
      node,
      processId,
      progress: { percent: 50, message: 'Preparing choices' },
      execution,
    } satisfies ProcessEventMessageMap['progress'],
  });

  const invocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]!;
  assert.equal(invocation.status, 'waiting');
  assert.deepEqual(invocation.waitingForUserInput, { questionCount: 1, renderingType: 'markdown' });
  assert.deepEqual(invocation.progress, { percent: 50, message: 'Preparing choices' });
});

test('projects LLM profile health events through the process-event boundary', () => {
  const processId = 'profile-health' as ProcessId;
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'llmProfileAttempt',
    occurredAt: 7,
    data: {
      eventId: 'health-gate-1',
      roundIndex: 0,
      profileIndex: 1,
      profileName: 'Recovery profile',
      nodeId: node.id,
      processId,
      provider: 'openai',
      model: 'gpt-test',
      stage: 'health-gate',
      outcome: 'failure',
      healthDisposition: 'fail-open',
      healthState: 'closed',
      error: 'Shared health store unavailable',
      execution,
    } satisfies ProcessEventMessageMap['llmProfileAttempt'],
  });

  const invocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({ ...execution, nodeId: node.id, processId })
    ]!;
  assert.equal(invocation.profileAttempts?.[0]?.healthDisposition, 'fail-open');
  assert.equal(invocation.profileAttempts?.[0]?.error, 'Shared health store unavailable');
  assert.equal(invocation.profileAttempts?.[0]?.profileName, 'Recovery profile');
});

test('projects each Watch Streaming Output summary as one compact terminal activity row', () => {
  const watchNode = { ...node, id: 'watch' as NodeId, title: 'Watch response', type: 'watchStreamingOutput' };
  const summary = {
    receivedUpdates: 6,
    coalescedUpdates: 1,
    droppedUpdates: 2,
    maximumQueuedUpdates: 3,
    completedIterations: 4,
    failedIterations: 0,
    cancelledIterations: 0,
    omittedIterations: 2,
    retainedIterationUpdateIndexes: [1, 2, 3, 6],
    selectedIteration: { updateIndex: 6, reason: 'latest' as const },
  };
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'streamingOutputWatchSummary',
    occurredAt: 7,
    data: { watchNode, summary, execution } satisfies ProcessEventMessageMap['streamingOutputWatchSummary'],
  });

  const invocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({
        ...execution,
        nodeId: watchNode.id,
        processId: `streaming-watch-summary:${watchNode.id}` as ProcessId,
      })
    ]!;
  assert.equal(invocation.status, 'completed');
  assert.deepEqual(invocation.streamingOutputWatchSummary, summary);
});

test('marks the compact Watch activity row as errored when its summary contains a failed iteration', () => {
  const watchNode = { ...node, id: 'failed-watch' as NodeId, title: 'Failed watch', type: 'watchStreamingOutput' };
  const summary = {
    receivedUpdates: 4,
    coalescedUpdates: 0,
    droppedUpdates: 0,
    maximumQueuedUpdates: 1,
    completedIterations: 2,
    failedIterations: 0,
    cancelledIterations: 0,
    omittedIterations: 0,
    retainedIterationUpdateIndexes: [1, 2, 3],
    selectedIteration: { updateIndex: 3, reason: 'latest' as const },
    failureKind: 'queue-overflow' as const,
  };
  const journal = applyProcessEventToRunActivityJournal({
    journal: createRunActivityJournal(),
    message: 'streamingOutputWatchSummary',
    occurredAt: 8,
    data: { watchNode, summary, execution } satisfies ProcessEventMessageMap['streamingOutputWatchSummary'],
  });
  const invocation =
    journal.rootsById[execution.rootRunId]!.nodeInvocationsByKey[
      createRunActivityNodeKey({
        ...execution,
        nodeId: watchNode.id,
        processId: `streaming-watch-summary:${watchNode.id}` as ProcessId,
      })
    ]!;

  assert.equal(invocation.status, 'error');
  assert.deepEqual(invocation.streamingOutputWatchSummary, summary);
});
