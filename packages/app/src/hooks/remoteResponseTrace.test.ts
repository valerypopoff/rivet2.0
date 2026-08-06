import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AgentResponseTrace,
  AgentTraceEvent,
  GraphExecutionMetadata,
  GraphId,
  GraphRunId,
  NodeId,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import {
  captureRemoteResponseTraceRootExecution,
  collectRemoteAgentTraceEvent,
  emitRemoteResponseTrace,
  type RemoteResponseTraceState,
} from './remoteResponseTrace.js';

const rootExecution: GraphExecutionMetadata = {
  graphId: 'root-graph' as GraphId,
  graphRunId: 'root-graph-run' as GraphRunId,
  rootRunId: 'root-run' as RootRunId,
};

const nestedExecution: GraphExecutionMetadata = {
  graphId: 'nested-graph' as GraphId,
  graphRunId: 'nested-graph-run' as GraphRunId,
  rootRunId: rootExecution.rootRunId,
  parentGraphRunId: rootExecution.graphRunId,
};

void describe('remote response traces', () => {
  void it('uses only root lifecycle events for trace identity and finalization while retaining nested call rows', () => {
    const deliveredTraces: AgentResponseTrace[] = [];
    const traces = new Map<string, RemoteResponseTraceState>([
      [
        'request',
        {
          callback: (trace) => {
            deliveredTraces.push(trace);
          },
          delivered: false,
          events: [],
          startedAt: 100,
        },
      ],
    ]);

    assert.equal(captureRemoteResponseTraceRootExecution(traces, 'request', { execution: nestedExecution }), false);
    assert.equal(traces.get('request')?.execution, undefined);
    assert.equal(captureRemoteResponseTraceRootExecution(traces, 'request', { execution: rootExecution }), true);

    const nestedModelCall = {
      callId: 'call-1' as never,
      attemptIndex: 0,
      execution: nestedExecution,
      model: 'test-model',
      nodeId: 'nested-llm' as NodeId,
      outcome: 'success',
      pricing: { status: 'unknown' as const },
      processId: 'nested-process' as ProcessId,
      provider: 'custom',
      customProviderApi: 'responses',
    } satisfies Omit<Extract<AgentTraceEvent, { type: 'llm-call-finished' }>, 'type'>;
    collectRemoteAgentTraceEvent(traces, 'request', 'llm-call-finished', nestedModelCall);

    emitRemoteResponseTrace(traces, 'request', { execution: nestedExecution }, false);
    assert.equal(deliveredTraces.length, 0);
    assert.equal(traces.get('request')?.delivered, false);

    emitRemoteResponseTrace(traces, 'request', { execution: rootExecution }, false);
    const deliveredTrace = deliveredTraces[0];
    assert.ok(deliveredTrace);
    assert.equal(deliveredTrace?.graphId, rootExecution.graphId);
    assert.equal(deliveredTrace?.graphRunId, rootExecution.graphRunId);
    assert.equal(deliveredTrace?.summary.modelCallCount, 1);
    assert.equal(deliveredTrace?.modelCalls[0]?.nodeId, nestedModelCall.nodeId);
    assert.equal(deliveredTrace?.modelCalls[0]?.customProviderApi, 'responses');
  });
});
