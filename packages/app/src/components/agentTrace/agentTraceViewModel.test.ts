import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  AgentTraceEvent,
  ChartNode,
  GraphExecutionMetadata,
  GraphId,
  GraphRunId,
  NodeId,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode } from '../../state/dataFlow.js';
import { buildLlmInvocationTrace } from './agentTraceViewModel.js';

const node = { id: 'llm-node' as NodeId, type: 'llmChatV2' } as ChartNode;
const execution: GraphExecutionMetadata = {
  graphId: 'graph' as GraphId,
  graphRunId: 'graph-run' as GraphRunId,
  rootRunId: 'root-run' as RootRunId,
};

function modelEvent(processId: ProcessId): AgentTraceEvent {
  return {
    type: 'llm-call-finished',
    execution,
    callId: `call-${processId}` as never,
    attemptIndex: 0,
    nodeId: node.id,
    processId,
    provider: 'openai',
    model: 'gpt-test',
    outcome: 'success',
    pricing: { status: 'unknown' },
  };
}

void describe('agentTraceViewModel', () => {
  void it('isolates the selected LLM process while retaining its delegated tools', () => {
    const selectedProcessId = 'selected' as ProcessId;
    const otherProcessId = 'other' as ProcessId;
    const selectedModelCall = modelEvent(selectedProcessId);
    const selectedToolCall = {
      type: 'tool-call-finished',
      execution,
      toolCallId: 'tool-call',
      toolName: 'search',
      sourceNodeId: node.id,
      sourceProcessId: selectedProcessId,
      handlerKind: 'graph',
      outcome: 'success',
    } satisfies AgentTraceEvent;
    const selectedProfileAttempt = {
      type: 'llm-profile-attempt',
      execution,
      eventId: 'profile-attempt-1',
      roundIndex: 0,
      profileIndex: 0,
      nodeId: node.id,
      processId: selectedProcessId,
      provider: 'openai',
      model: 'gpt-test',
      stage: 'health-gate',
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
      retryAt: 10_000,
    } satisfies AgentTraceEvent;
    const processData = {
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      processId: selectedProcessId,
      data: {
        status: { type: 'ok' },
        startedAt: 100,
        finishedAt: 140,
        agentTraceEvents: [
          selectedModelCall,
          { ...selectedModelCall, durationMs: 12 },
          modelEvent(otherProcessId),
          selectedToolCall,
          { ...selectedToolCall, durationMs: 4 },
          selectedProfileAttempt,
        ],
      },
    } as unknown as ProcessDataForNode;

    const trace = buildLlmInvocationTrace(node, processData);

    assert.equal(trace?.processId, selectedProcessId);
    assert.equal(trace?.modelCalls.length, 1);
    assert.equal(trace?.modelCalls[0]?.processId, selectedProcessId);
    assert.equal(trace?.modelCalls[0]?.durationMs, 12);
    assert.equal(trace?.toolCalls.length, 1);
    assert.equal(trace?.toolCalls[0]?.durationMs, 4);
    assert.equal(trace?.profileAttempts?.length, 1);
    assert.equal(trace?.profileAttempts?.[0]?.healthDisposition, 'deny');
    assert.equal(trace?.durationMs, 40);
  });

  void it('returns unavailable data for legacy or frozen runs without physical-call events', () => {
    const processData = {
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      processId: 'legacy' as ProcessId,
      data: { status: { type: 'ok' } },
    } as unknown as ProcessDataForNode;

    assert.equal(buildLlmInvocationTrace(node, processData), undefined);
  });
});
