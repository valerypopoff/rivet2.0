import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS,
  AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS,
  buildAgentResponseTrace,
  isAgentResponseTrace,
  type AgentTraceEvent,
  type GraphExecutionMetadata,
  type GraphId,
  type GraphRunId,
  type NodeId,
  type PortId,
  type ProcessId,
  type RootRunId,
} from '../../src/index.js';

const execution: GraphExecutionMetadata = {
  graphId: 'graph' as GraphId,
  graphRunId: 'graph-run' as GraphRunId,
  rootRunId: 'root-run' as RootRunId,
};

const modelEvent = (overrides: Partial<Extract<AgentTraceEvent, { type: 'llm-call-finished' }>> = {}) =>
  ({
    type: 'llm-call-finished',
    execution,
    callId: crypto.randomUUID() as never,
    attemptIndex: 0,
    nodeId: 'llm' as NodeId,
    processId: 'process' as ProcessId,
    provider: 'openai',
    model: 'gpt-test',
    outcome: 'success',
    pricing: { status: 'known', costUsd: 0.01 },
    ...overrides,
  }) satisfies Extract<AgentTraceEvent, { type: 'llm-call-finished' }>;

const toolEvent = (overrides: Partial<Extract<AgentTraceEvent, { type: 'tool-call-finished' }>> = {}) =>
  ({
    type: 'tool-call-finished',
    execution,
    toolCallId: crypto.randomUUID(),
    toolName: 'search',
    sourceNodeId: 'llm' as NodeId,
    sourceProcessId: 'process' as ProcessId,
    handlerKind: 'graph',
    handlerGraphId: 'tool-graph' as GraphId,
    handlerName: 'Search',
    outcome: 'success',
    ...overrides,
  }) satisfies Extract<AgentTraceEvent, { type: 'tool-call-finished' }>;

const profileAttemptEvent = (
  overrides: Partial<Extract<AgentTraceEvent, { type: 'llm-profile-attempt' }>> = {},
) =>
  ({
    type: 'llm-profile-attempt',
    execution,
    eventId: crypto.randomUUID(),
    roundIndex: 0,
    profileIndex: 0,
    nodeId: 'llm' as NodeId,
    processId: 'process' as ProcessId,
    provider: 'custom',
    model: 'model',
    stage: 'health-gate',
    outcome: 'success',
    ...overrides,
  }) satisfies Extract<AgentTraceEvent, { type: 'llm-profile-attempt' }>;

void describe('AgentResponseTrace', () => {
  void it('aggregates physical calls without confusing unrelated profiles or parallel tools with fallbacks', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [
        modelEvent({ profileIndex: 0, roundIndex: 0, normalizedUsage: { promptTokens: 10, completionTokens: 2 } }),
        modelEvent({
          profileIndex: 0,
          roundIndex: 0,
          nodeId: 'nested-llm' as NodeId,
          processId: 'nested' as ProcessId,
        }),
        modelEvent({ profileIndex: 1, roundIndex: 0, outcome: 'success', normalizedUsage: { cachedTokens: 4 } }),
        modelEvent({ profileIndex: 1, roundIndex: 1, attemptIndex: 1, pricing: { status: 'unknown' } }),
        toolEvent({ toolCallId: 'parallel-a' }),
        toolEvent({ toolCallId: 'parallel-b' }),
      ],
      startedAt: 100,
      responseReadyAt: 160,
      status: 'response-ready',
      backgroundWorkPending: true,
    });

    assert.deepEqual(trace.summary, {
      modelCallCount: 4,
      toolCallCount: 2,
      retryCount: 1,
      fallbackCount: 1,
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 4,
      knownCostUsd: 0.03,
      costStatus: 'partial',
    });
    assert.equal(trace.durationMs, 60);
    assert.equal(trace.backgroundWorkPending, true);
  });

  void it('deduplicates redelivered identified calls without double-counting usage or cost', () => {
    const firstModelCall = modelEvent({
      callId: 'model-round-1' as never,
      roundIndex: 0,
      durationMs: 100,
      normalizedUsage: { promptTokens: 10, completionTokens: 2 },
      pricing: { status: 'known', costUsd: 0.01 },
    });
    const secondModelCall = modelEvent({
      callId: 'model-round-2' as never,
      roundIndex: 1,
      durationMs: 200,
      normalizedUsage: { promptTokens: 20, completionTokens: 3 },
      pricing: { status: 'known', costUsd: 0.02 },
    });
    const delegatedToolCall = toolEvent({
      toolCallId: 'delegated-tool',
      durationMs: 5,
      resultOwner: {
        nodeId: 'delegate' as NodeId,
        processId: 'delegate-process' as ProcessId,
        outputPortId: 'output' as PortId,
      },
    });

    const trace = buildAgentResponseTrace({
      scope: 'llm-invocation',
      execution,
      nodeId: 'llm' as NodeId,
      processId: 'process' as ProcessId,
      events: [
        firstModelCall,
        delegatedToolCall,
        secondModelCall,
        { ...firstModelCall, durationMs: 110 },
        { ...delegatedToolCall, durationMs: 6 },
        { ...secondModelCall, durationMs: 210 },
      ],
      status: 'completed',
    });

    assert.equal(trace.summary.modelCallCount, 2);
    assert.equal(trace.summary.toolCallCount, 1);
    assert.equal(trace.summary.promptTokens, 30);
    assert.equal(trace.summary.completionTokens, 5);
    assert.equal(trace.summary.knownCostUsd, 0.03);
    assert.deepEqual(
      trace.modelCalls.map((call) => [call.callId, call.durationMs]),
      [
        ['model-round-1', 110],
        ['model-round-2', 210],
      ],
    );
    assert.equal(trace.toolCalls[0]?.durationMs, 6);
    // Remote/local redelivery from an older executor may not have the newly
    // optional pointer. Preserve an observed exact result owner instead of
    // silently removing the Run Activity navigation target.
    assert.deepEqual(trace.toolCalls[0]?.resultOwner, {
      nodeId: 'delegate',
      processId: 'delegate-process',
      outputPortId: 'output',
    });
  });

  void it('keeps identical call ids from separate graph runs distinct in a response trace', () => {
    const nestedExecution = {
      ...execution,
      graphId: 'nested-graph' as GraphId,
      graphRunId: 'nested-graph-run' as GraphRunId,
      parentGraphRunId: execution.graphRunId,
    };
    const sharedModelIdentity = {
      callId: 'shared-model-call' as never,
      nodeId: 'shared-llm' as NodeId,
      processId: 'shared-process' as ProcessId,
    };
    const sharedToolIdentity = {
      toolCallId: 'shared-tool-call',
      sourceNodeId: 'shared-llm' as NodeId,
      sourceProcessId: 'shared-process' as ProcessId,
    };

    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [
        modelEvent(sharedModelIdentity),
        modelEvent({ ...sharedModelIdentity, execution: nestedExecution }),
        toolEvent(sharedToolIdentity),
        toolEvent({ ...sharedToolIdentity, execution: nestedExecution }),
      ],
      status: 'completed',
    });

    assert.equal(trace.summary.modelCallCount, 2);
    assert.equal(trace.summary.toolCallCount, 2);
  });

  void it('limits invocation traces to the selected graph run', () => {
    const otherExecution = {
      ...execution,
      graphRunId: 'other-graph-run' as GraphRunId,
    };
    const trace = buildAgentResponseTrace({
      scope: 'llm-invocation',
      execution,
      nodeId: 'llm' as NodeId,
      processId: 'process' as ProcessId,
      events: [
        modelEvent(),
        modelEvent({ execution: otherExecution }),
        toolEvent(),
        toolEvent({ execution: otherExecution }),
      ],
      status: 'completed',
    });

    assert.equal(trace.summary.modelCallCount, 1);
    assert.equal(trace.summary.toolCallCount, 1);
  });

  void it('keeps anonymous tool events distinct because they have no stable identity', () => {
    const { toolCallId: _firstId, ...firstAnonymousToolCall } = toolEvent();
    const { toolCallId: _secondId, ...secondAnonymousToolCall } = toolEvent();
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [firstAnonymousToolCall, secondAnonymousToolCall],
      status: 'completed',
    });

    assert.equal(trace.summary.toolCallCount, 2);
  });

  void it('preserves a tool-result owner pointer without accepting result payloads', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [
        toolEvent({
          resultOwner: {
            nodeId: 'delegate' as NodeId,
            processId: 'delegate-process' as ProcessId,
            outputPortId: 'output' as PortId,
          },
        }),
      ],
      status: 'completed',
    });

    assert.deepEqual(trace.toolCalls[0]?.resultOwner, {
      nodeId: 'delegate',
      processId: 'delegate-process',
      outputPortId: 'output',
    });
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        toolCalls: [{ ...trace.toolCalls[0], resultOwner: { nodeId: 'delegate' } }],
      }),
      false,
    );
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        toolCalls: [{ ...trace.toolCalls[0], outcome: 'failure' }],
      }),
      false,
    );
  });

  void it('keeps aggregate totals while bounding rendered rows', () => {
    const modelCalls = Array.from({ length: AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS + 3 }, () => modelEvent());
    const toolCalls = Array.from({ length: AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS + 2 }, () => toolEvent());
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [...modelCalls, ...toolCalls],
      status: 'completed',
    });

    assert.equal(trace.summary.modelCallCount, AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS + 3);
    assert.equal(trace.summary.toolCallCount, AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS + 2);
    assert.equal(trace.modelCalls.length, AGENT_RESPONSE_TRACE_MAX_MODEL_CALLS);
    assert.equal(trace.toolCalls.length, AGENT_RESPONSE_TRACE_MAX_TOOL_CALLS);
    assert.equal(trace.omittedModelCallCount, 3);
    assert.equal(trace.omittedToolCallCount, 2);
  });

  void it('rejects unknown or sensitive transport fields at every trace level', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [modelEvent(), toolEvent()],
      status: 'completed',
    });
    assert.equal(isAgentResponseTrace(trace), true);

    for (const forbidden of ['messages', 'prompt', 'reasoning', 'rawBody', 'credentials']) {
      assert.equal(isAgentResponseTrace({ ...trace, [forbidden]: 'secret' }), false);
    }
    assert.equal(
      isAgentResponseTrace({ ...trace, modelCalls: [{ ...trace.modelCalls[0], messages: ['secret'] }] }),
      false,
    );
    assert.equal(
      isAgentResponseTrace({ ...trace, toolCalls: [{ ...trace.toolCalls[0], arguments: { secret: true } }] }),
      false,
    );
    assert.equal(isAgentResponseTrace({ ...trace, toolCalls: [{ ...trace.toolCalls[0], result: 'secret' }] }), false);
    assert.equal(isAgentResponseTrace({ ...trace, durationMs: -1 }), false);
    assert.equal(isAgentResponseTrace({ ...trace, modelCalls: [{ ...trace.modelCalls[0], durationMs: -1 }] }), false);
  });

  void it('preserves optional Custom API identity while accepting legacy traces without it', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [modelEvent({ provider: 'custom', model: 'shared-model', customProviderApi: 'responses' })],
      status: 'completed',
    });

    assert.equal(trace.modelCalls[0]?.customProviderApi, 'responses');
    assert.equal(isAgentResponseTrace(trace), true);
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        modelCalls: trace.modelCalls.map(({ customProviderApi: _customProviderApi, ...call }) => call),
      }),
      true,
    );
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        modelCalls: [{ ...trace.modelCalls[0], customProviderApi: 'response' }],
      }),
      false,
    );
  });

  void it('preserves privacy-bounded profile health metadata in recorded model calls', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [
        modelEvent({
          profileIndex: 1,
          profileHealthKey: 'llm-profile:sha256:test',
          profileHealthState: 'half-open',
        }),
      ],
      status: 'completed',
    });

    assert.equal(trace.modelCalls[0]?.profileHealthKey, 'llm-profile:sha256:test');
    assert.equal(trace.modelCalls[0]?.profileHealthState, 'half-open');
    assert.equal(isAgentResponseTrace(trace), true);
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        modelCalls: [{ ...trace.modelCalls[0], profileHealthState: 'recovering' }],
      }),
      false,
    );

    const originalEvent = modelEvent({
      callId: 'health-redelivery' as never,
      profileHealthKey: 'llm-profile:sha256:redelivery',
      profileHealthState: 'open',
    });
    const {
      profileHealthKey: _profileHealthKey,
      profileHealthState: _profileHealthState,
      ...legacyRedelivery
    } = originalEvent;
    const redeliveredTrace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [originalEvent, legacyRedelivery],
      status: 'completed',
    });
    assert.equal(redeliveredTrace.modelCalls[0]?.profileHealthKey, 'llm-profile:sha256:redelivery');
    assert.equal(redeliveredTrace.modelCalls[0]?.profileHealthState, 'open');
  });

  void it('preserves profile skips without physical calls and counts their fallback transition', () => {
    const skipped = profileAttemptEvent({
      eventId: 'skip-primary',
      profileIndex: 0,
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
      retryAt: 123_456,
      profileHealthKey: 'llm-profile:sha256:primary',
    });
    const admitted = profileAttemptEvent({
      eventId: 'allow-backup',
      profileIndex: 1,
      healthState: 'closed',
      healthDisposition: 'allow',
      profileHealthKey: 'llm-profile:sha256:backup',
    });
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [skipped, admitted],
      status: 'error',
    });

    assert.equal(trace.summary.modelCallCount, 0);
    assert.equal(trace.summary.fallbackCount, 1);
    assert.deepEqual(
      trace.profileAttempts?.map((attempt) => [attempt.eventId, attempt.outcome, attempt.healthDisposition]),
      [
        ['skip-primary', 'skipped', 'deny'],
        ['allow-backup', 'success', 'allow'],
      ],
    );
    assert.equal(isAgentResponseTrace(trace), true);
    assert.equal(
      isAgentResponseTrace({
        ...trace,
        profileAttempts: [{ ...trace.profileAttempts![0], healthDisposition: 'unknown' }],
      }),
      false,
    );

    const { profileAttempts: _profileAttempts, omittedProfileAttemptCount: _omitted, ...legacyTrace } = trace;
    assert.equal(isAgentResponseTrace(legacyTrace), true);
  });

  void it('reports entirely unknown pricing as unknown rather than zero cost', () => {
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      events: [modelEvent({ pricing: { status: 'unknown' } })],
      status: 'completed',
    });

    assert.equal(trace.summary.costStatus, 'unknown');
    assert.equal(trace.summary.knownCostUsd, 0);
  });

  void it('keeps fallback-chain traces valid across retries, skipped profiles, and sticky rounds', () => {
    const trace = buildAgentResponseTrace({
      scope: 'llm-invocation',
      execution,
      nodeId: 'llm' as NodeId,
      processId: 'process' as ProcessId,
      events: [
        modelEvent({
          profileIndex: 0,
          roundIndex: 0,
          outcome: 'provider-failure',
          pricing: { status: 'known' },
        }),
        modelEvent({
          profileIndex: 0,
          roundIndex: 0,
          attemptIndex: 1,
          outcome: 'provider-failure',
          pricing: { status: 'unknown' },
        }),
        // Profile 1 failed during configuration, so the next physical call is profile 2.
        modelEvent({ profileIndex: 2, roundIndex: 0, pricing: { status: 'known', costUsd: 0.02 } }),
        // Auto-continuation stays on the successful fallback profile without another fallback.
        modelEvent({ profileIndex: 2, roundIndex: 1, pricing: { status: 'known', costUsd: 0.01 } }),
        modelEvent({
          profileIndex: 2,
          roundIndex: 2,
          outcome: 'provider-failure',
          pricing: { status: 'known' },
        }),
        modelEvent({ profileIndex: 3, roundIndex: 2, pricing: { status: 'known', costUsd: 0.01 } }),
        // A separate invocation must not inherit this invocation's selected profile.
        modelEvent({
          nodeId: 'other-llm' as NodeId,
          processId: 'other-process' as ProcessId,
          profileIndex: 0,
          roundIndex: 0,
        }),
      ],
      status: 'completed',
    });

    assert.equal(trace.summary.modelCallCount, 6);
    assert.equal(trace.summary.retryCount, 1);
    assert.equal(trace.summary.fallbackCount, 3);
    assert.equal(trace.summary.knownCostUsd, 0.04);
    assert.equal(trace.summary.costStatus, 'partial');
    assert.equal(isAgentResponseTrace(trace), true);
    assert.deepEqual(
      trace.modelCalls.map((call) => [call.profileIndex, call.roundIndex, call.attemptIndex]),
      [
        [0, 0, 0],
        [0, 0, 1],
        [2, 0, 0],
        [2, 1, 0],
        [2, 2, 0],
        [3, 2, 0],
      ],
    );
  });
});
