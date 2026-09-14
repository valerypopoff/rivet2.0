import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChatV2CallId,
  GraphId,
  GraphRunId,
  NodeId,
  ProcessEventMessageMap,
  ProcessId,
  RemoteRunRequestId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import { createEvaluationEventCollector } from '@valerypopoff/rivet2-evaluations';

import { withRemoteEvaluationAccounting } from './remoteEvaluationEventCollection.js';
import {
  createUnscopedRemoteExecutionRoutingState,
  getRemoteExecutionEventDispatchDecision,
  sendPendingRemoteGraphRunRequest,
} from './remoteExecutorRunRequest.js';

const nodeId = 'node' as NodeId;
const processId = 'process' as ProcessId;
const execution = {
  graphId: 'graph' as GraphId,
  graphRunId: 'graph-run' as GraphRunId,
  rootRunId: 'root-run' as RootRunId,
};

function llmCall(): ProcessEventMessageMap['llmCallFinished'] {
  return {
    callId: 'call' as ChatV2CallId,
    attemptIndex: 0,
    execution,
    nodeId,
    outcome: 'success',
    pricing: { status: 'unknown' },
    processId,
    provider: 'custom',
    model: 'fixture',
    startedAt: 1,
  };
}

function profileAttempt(): ProcessEventMessageMap['llmProfileAttempt'] {
  return {
    eventId: 'profile',
    execution,
    nodeId,
    outcome: 'success',
    processId,
    provider: 'custom',
    model: 'fixture',
    roundIndex: 0,
    stage: 'request',
  };
}

function toolCall(
  outcome: ProcessEventMessageMap['toolCallFinished']['outcome'],
): ProcessEventMessageMap['toolCallFinished'] {
  return {
    handlerKind: 'graph',
    outcome,
    execution,
    sourceNodeId: nodeId,
    sourceProcessId: processId,
    toolCallId: 'tool-call',
    toolName: 'fixture',
  };
}

function collect<K extends keyof ProcessEventMessageMap>(
  collectorsByRequestId: ReadonlyMap<RemoteRunRequestId, ReturnType<typeof createEvaluationEventCollector>>,
  requestId: string | undefined,
  message: K,
  data: ProcessEventMessageMap[K],
) {
  withRemoteEvaluationAccounting(collectorsByRequestId, () => {})(
    message,
    data,
    requestId as RemoteRunRequestId | undefined,
  );
}

test('remote evaluation accounting stays request-scoped when UI routing ignores concurrent events', () => {
  const first = createEvaluationEventCollector('full');
  const second = createEvaluationEventCollector('full');
  const collectorsByRequestId = new Map<RemoteRunRequestId, ReturnType<typeof createEvaluationEventCollector>>([
    ['first' as RemoteRunRequestId, first],
    ['second' as RemoteRunRequestId, second],
  ]);

  // These events model a second request whose canvas events are deliberately
  // not dispatched because another request owns the active editor run.
  collect(collectorsByRequestId, 'second', 'llmProfileAttempt', profileAttempt());
  collect(collectorsByRequestId, 'first', 'llmCallFinished', llmCall());
  collect(collectorsByRequestId, 'second', 'toolCallFinished', toolCall('failure'));
  collect(collectorsByRequestId, 'second', 'llmCallFinished', llmCall());
  collect(collectorsByRequestId, 'unknown', 'llmCallFinished', llmCall());
  collect(collectorsByRequestId, undefined, 'toolCallFinished', toolCall('failure'));

  assert.equal(first.metrics.modelCallCount, 1);
  assert.equal(first.metrics.toolCallCount, 0);
  assert.deepEqual(
    first.providerAttempts.map((attempt) => (attempt as { kind: string }).kind),
    ['provider-call'],
  );

  assert.deepEqual(second.metrics, {
    durationMs: 0,
    modelCallCount: 1,
    toolCallCount: 1,
    toolFailureCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    hasUnknownCost: true,
  });
  assert.deepEqual(
    second.providerAttempts.map((attempt) => (attempt as { kind: string }).kind),
    ['profile-decision', 'provider-call'],
  );
});

test('the subscription accounts before project and active-request routing, including synchronous send events', async () => {
  const first = createEvaluationEventCollector('full');
  const second = createEvaluationEventCollector('full');
  const collectors = new Map<RemoteRunRequestId, typeof first>();
  let projectChanged = false;
  const painted: string[] = [];
  const routing = createUnscopedRemoteExecutionRoutingState();
  const receive = withRemoteEvaluationAccounting(collectors, (message, data, requestId) => {
    if (projectChanged) return;
    const decision = getRemoteExecutionEventDispatchDecision({
      activeRequestId: 'first' as RemoteRunRequestId,
      currentProjectId: undefined,
      message,
      data,
      requestId,
      unscopedRoutingState: routing,
    });
    if (decision.shouldDispatch) painted.push(String(requestId));
  });
  for (const [id, collector] of [
    ['first', first],
    ['second', second],
  ] as const) {
    const requestId = id as RemoteRunRequestId;
    await sendPendingRemoteGraphRunRequest({
      disconnectErrorMessage: 'disconnected',
      executorSession: {
        createPendingGraphExecution: () => ({ requestId, promise: Promise.resolve({}) }),
        rejectPendingGraphExecution: () => {
          throw new Error('Unexpected rejection');
        },
      },
      payload: { graphId: 'graph' as GraphId, contextValues: {} },
      onRequestCreated: (createdId) => collectors.set(createdId, collector),
      sendRun: () => {
        receive('llmCallFinished', llmCall(), requestId);
        return true;
      },
    });
  }
  assert.deepEqual(painted, ['first']);
  assert.equal(first.metrics.modelCallCount, 1);
  assert.equal(second.metrics.modelCallCount, 1);
  projectChanged = true;
  receive('toolCallFinished', toolCall('failure'), 'second' as RemoteRunRequestId);
  assert.equal(second.metrics.toolFailureCount, 1);
  assert.deepEqual(painted, ['first']);
  collectors.delete('second' as RemoteRunRequestId);
  receive('llmCallFinished', llmCall(), 'second' as RemoteRunRequestId);
  receive('llmCallFinished', llmCall(), undefined);
  assert.equal(second.metrics.modelCallCount, 1);
  assert.equal(first.metrics.modelCallCount, 1);
});
