import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { buildAgentResponseTrace } from '@valerypopoff/rivet2-core';
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
import { buildModelInvocationTrace, hasModelResponseInspector } from './agentTraceViewModel.js';
import { AgentResponseInspector } from './AgentResponseInspector.js';

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
    profileName: 'Primary route',
    outcome: 'success',
    pricing: { status: 'unknown' },
  };
}

void describe('agentTraceViewModel', () => {
  void it('capped legacy classifier traces distinguish retained counts and combined request/decision omissions', () => {
    const trace = buildAgentResponseTrace({
      scope: 'classifier-invocation',
      execution,
      status: 'completed',
      events: [],
    });
    trace.omittedProfileAttemptCount = 5;
    const document = new JSDOM(
      renderToStaticMarkup(React.createElement(AgentResponseInspector, { trace, onClose() {} })),
    );
    assert.match(document.window.document.body.textContent!, /0 \(retained evidence only\)/);
    const sections = [...document.window.document.querySelectorAll('details')];
    assert.equal(
      sections.some((section) => section.textContent?.includes('omitted')),
      false,
    );
    assert.match(
      document.window.document.body.textContent!,
      /5 additional profile-attempt rows \(requests or decisions\) omitted/,
    );
    document.window.close();
    trace.summary.classifierRequestCount = 10;
    const exact = new JSDOM(renderToStaticMarkup(React.createElement(AgentResponseInspector, { trace, onClose() {} })));
    const count = [...exact.window.document.querySelectorAll('dt')].find(
      (label) => label.textContent === 'Decision AI requests',
    )!;
    assert.equal(count.nextElementSibling?.textContent, '10');
    exact.window.close();
  });

  void it('renders legacy mixed classifier metadata and empty classifier decisions without chat-only metrics', () => {
    const classifierAttempt: AgentTraceEvent = {
      type: 'llm-profile-attempt',
      execution,
      eventId: 'legacy-request',
      family: 'classifier',
      nodeId: node.id,
      processId: 'process' as ProcessId,
      roundIndex: 0,
      attemptIndex: 0,
      provider: 'perplexity',
      model: 'decider',
      profileName: 'Legacy classifier',
      stage: 'request',
      outcome: 'failure',
      failureKind: 'authentication',
      status: 401,
      error: 'Authentication failed.',
      durationMs: 250,
    };
    const mixed = buildAgentResponseTrace({
      scope: 'response',
      execution,
      status: 'error',
      events: [classifierAttempt],
    });
    delete mixed.summary.classifierRequestCount;
    const legacyHtml = renderToStaticMarkup(
      React.createElement(AgentResponseInspector, { trace: mixed, onClose() {} }),
    );
    const legacyDom = new JSDOM(legacyHtml);
    const legacyText = legacyDom.window.document.body.textContent!;
    assert.match(legacyText, /Decision AI requests/);
    assert.match(legacyText, /Profile: Legacy classifier/);
    assert.match(legacyText, /HTTP 401/);
    assert.match(legacyText, /0.25 sec/);
    assert.match(legacyText, /Authentication failed/);
    assert.doesNotMatch(legacyText, /\bround \d/);
    legacyDom.window.close();
    const empty = buildAgentResponseTrace({ scope: 'classifier-invocation', execution, status: 'error', events: [] });
    const emptyDom = new JSDOM(
      renderToStaticMarkup(React.createElement(AgentResponseInspector, { trace: empty, onClose() {} })),
    );
    const emptyText = emptyDom.window.document.body.textContent!;
    assert.match(emptyText, /No Decision AI requests recorded/);
    assert.match(emptyText, /No profile fallback or suspension decisions recorded/);
    assert.doesNotMatch(emptyText, /Tool calls|Cached input tokens|Reasoning tokens|Model calls/);
    emptyDom.window.close();
  });

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
      profileName: 'Primary route',
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
        // Live node duration metadata does not replace local lifecycle timing.
        durationMs: 12,
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

    const trace = buildModelInvocationTrace(node, processData);

    assert.equal(trace?.processId, selectedProcessId);
    assert.equal(trace?.modelCalls.length, 1);
    assert.equal(trace?.modelCalls[0]?.processId, selectedProcessId);
    assert.equal(trace?.modelCalls[0]?.durationMs, 12);
    assert.equal(trace?.modelCalls[0]?.profileName, 'Primary route');
    assert.equal(trace?.toolCalls.length, 1);
    assert.equal(trace?.toolCalls[0]?.durationMs, 4);
    assert.equal(trace?.profileAttempts?.length, 1);
    assert.equal(trace?.profileAttempts?.[0]?.healthDisposition, 'deny');
    assert.equal(trace?.profileAttempts?.[0]?.profileName, 'Primary route');
    assert.equal(trace?.durationMs, 40);
  });

  void it('uses recorded node timing and duration instead of the replay receipt clock', () => {
    const processData = {
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      processId: 'recorded' as ProcessId,
      data: {
        status: { type: 'ok' },
        // The player delivered these events one millisecond apart.
        startedAt: 1_000_000,
        finishedAt: 1_000_001,
        // This is the recorded whole-node duration, including non-provider work.
        durationMs: 96_000,
        recordedTiming: { startedAt: 50_000, finishedAt: 146_000 },
        agentTraceEvents: [
          modelEvent('recorded' as ProcessId),
          { ...modelEvent('recorded' as ProcessId), callId: 'fallback' as never, durationMs: 40_000 },
          { ...modelEvent('recorded' as ProcessId), callId: 'success' as never, durationMs: 15_000 },
        ],
      },
    } as unknown as ProcessDataForNode;

    const trace = buildModelInvocationTrace(node, processData);

    assert.equal(trace?.startedAt, 50_000);
    assert.equal(trace?.finishedAt, 146_000);
    assert.equal(trace?.durationMs, 96_000);
    assert.deepEqual(
      trace?.modelCalls.map((call) => call.durationMs),
      [undefined, 40_000, 15_000],
    );
  });

  void it('does not combine a partial recorded clock with the local replay receipt clock', () => {
    const processData = {
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      processId: 'partially-recorded' as ProcessId,
      data: {
        status: { type: 'ok' },
        startedAt: 1_000_000,
        finishedAt: 1_000_001,
        recordedTiming: { startedAt: 50_000 },
        agentTraceEvents: [modelEvent('partially-recorded' as ProcessId)],
      },
    } as unknown as ProcessDataForNode;

    const trace = buildModelInvocationTrace(node, processData);

    assert.equal(trace?.startedAt, 50_000);
    assert.equal(trace?.finishedAt, undefined);
    assert.equal(trace?.durationMs, undefined);
  });

  void it('returns unavailable data for legacy or frozen runs without physical-call events', () => {
    const processData = {
      graphId: execution.graphId,
      graphRunId: execution.graphRunId,
      rootRunId: execution.rootRunId,
      processId: 'legacy' as ProcessId,
      data: { status: { type: 'ok' } },
    } as unknown as ProcessDataForNode;

    assert.equal(buildModelInvocationTrace(node, processData), undefined);
  });

  void it('offers the same inspector for classifiers and isolates failed and split invocations', () => {
    const classifier = { ...node, type: 'classifierEvaluate' } as ChartNode;
    assert.equal(hasModelResponseInspector(classifier), true);
    assert.equal(hasModelResponseInspector({ ...node, type: 'text' } as ChartNode), false);
    const processId = 'classifier-selected' as ProcessId;
    const attempt: AgentTraceEvent = {
      type: 'llm-profile-attempt',
      execution,
      eventId: 'request',
      nodeId: node.id,
      processId,
      family: 'classifier',
      provider: 'perplexity',
      model: 'decider',
      profileName: 'Fast classifier',
      profileIndex: 0,
      roundIndex: 0,
      attemptIndex: 0,
      stage: 'request',
      outcome: 'failure',
      status: 401,
      failureKind: 'authentication',
      error: 'Authentication failed.',
    };
    const processData = {
      ...execution,
      processId,
      data: {
        status: { type: 'error' },
        durationMs: 500,
        recordedTiming: { startedAt: 100, finishedAt: 600 },
        agentTraceEvents: [
          attempt,
          { ...attempt },
          { ...attempt, processId: 'other' as ProcessId },
          { ...attempt, execution: { ...execution, graphRunId: 'neighbor' as GraphRunId } },
        ],
      },
    } as unknown as ProcessDataForNode;
    const trace = buildModelInvocationTrace(classifier, processData)!;
    assert.equal(trace.scope, 'classifier-invocation');
    assert.equal(trace.status, 'error');
    assert.equal(trace.durationMs, 500);
    assert.equal(trace.summary.classifierRequestCount, 1);
    assert.equal(trace.summary.modelCallCount, 0);
    assert.equal(trace.summary.costStatus, 'unknown');
    assert.equal(trace.profileAttempts?.length, 1);
    assert.equal(trace.profileAttempts?.[0]?.profileName, 'Fast classifier');
    assert.equal(
      buildModelInvocationTrace(classifier, { ...processData, data: { status: { type: 'ok' } } }),
      undefined,
    );
  });
});
