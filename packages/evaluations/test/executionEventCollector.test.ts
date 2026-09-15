import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ChatV2CallId,
  ChatV2CallTraceEvent,
  GraphId,
  LLMProfileAttemptTraceEvent,
  NodeId,
  PortId,
  ProcessId,
  ToolCallFinishedEvent,
} from '@valerypopoff/rivet2-core';

import { createEvaluationEventCollector } from '../src/index.js';

const nodeId = 'node-id' as NodeId;
const processId = 'process-id' as ProcessId;

function providerCall(overrides: Partial<ChatV2CallTraceEvent> = {}): ChatV2CallTraceEvent {
  return {
    callId: 'call-id' as ChatV2CallId,
    attemptIndex: 3,
    profileIndex: 2,
    profileName: 'Preferred profile',
    profileHealthKey: 'profile-health-key',
    profileHealthState: 'closed',
    roundIndex: 4,
    nodeId,
    processId,
    provider: 'openai',
    model: 'gpt-test',
    customProviderApi: undefined,
    outcome: 'success',
    finishReason: 'stop',
    normalizedUsage: {
      promptTokens: 10,
      completionTokens: 20,
      cachedTokens: 3,
      reasoningTokens: 5,
    },
    pricing: { status: 'known', costUsd: 0.125 },
    startedAt: 1_000,
    durationMs: 125,
    ...overrides,
  };
}

function profileDecision(overrides: Partial<LLMProfileAttemptTraceEvent> = {}): LLMProfileAttemptTraceEvent {
  return {
    eventId: 'profile-decision-id',
    roundIndex: 4,
    profileIndex: 2,
    profileName: 'Preferred profile',
    nodeId,
    processId,
    provider: 'openai',
    model: 'gpt-test',
    customProviderApi: undefined,
    stage: 'health-update',
    outcome: 'success',
    attemptIndex: 3,
    status: 200,
    error: 'ignored because it is not retained',
    profileHealthKey: 'profile-health-key',
    healthState: 'closed',
    healthDisposition: 'allow',
    healthOutcome: 'healthy',
    retryAt: 2_000,
    timeoutKind: 'first-output',
    ...overrides,
  };
}

function toolCall(
  outcome: ToolCallFinishedEvent['outcome'],
  overrides: Partial<ToolCallFinishedEvent> = {},
): ToolCallFinishedEvent {
  return {
    toolCallId: 'tool-call-id',
    toolName: 'lookup',
    sourceNodeId: nodeId,
    sourceProcessId: processId,
    resultOwner: { nodeId, processId, outputPortId: 'result' as PortId },
    handlerKind: 'graph',
    handlerGraphId: 'tool-graph' as GraphId,
    handlerName: 'Lookup tool',
    outcome,
    startedAt: 3_000,
    durationMs: 10,
    ...overrides,
  };
}

test('initializes one independent collector per graph invocation', () => {
  const first = createEvaluationEventCollector('full');
  const second = createEvaluationEventCollector('full');

  assert.deepEqual(first.metrics, {
    durationMs: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
  });
  assert.deepEqual(first.providerAttempts, []);
  assert.equal('inputTokens' in first.metrics, false);
  assert.equal('costUsd' in first.metrics, false);
  assert.equal('hasUnknownCost' in first.metrics, false);

  first.toolCallFinished(toolCall('aborted'));
  assert.deepEqual(second.metrics, {
    durationMs: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
  });
  assert.deepEqual(second.providerAttempts, []);
});

test('projects the exact full and CLI evidence formats', () => {
  const full = createEvaluationEventCollector('full');
  const cli = createEvaluationEventCollector('cli');
  const call = providerCall({
    customProviderApi: undefined,
    finishReason: undefined,
    profileIndex: undefined,
    profileName: undefined,
    roundIndex: undefined,
    durationMs: undefined,
  });
  const profile = profileDecision({
    customProviderApi: undefined,
    profileIndex: undefined,
    profileName: undefined,
    attemptIndex: undefined,
    status: undefined,
    healthState: undefined,
    healthDisposition: undefined,
    timeoutKind: undefined,
  });

  full.llmCallFinished(call);
  full.llmProfileAttempt(profile);
  cli.llmCallFinished(call);
  cli.llmProfileAttempt(profile);

  const expectedFull = [
    {
      kind: 'provider-call',
      provider: 'openai',
      model: 'gpt-test',
      customProviderApi: null,
      outcome: 'success',
      finishReason: null,
      profileIndex: null,
      profileName: null,
      attemptIndex: 3,
      roundIndex: null,
      durationMs: null,
    },
    {
      kind: 'profile-decision',
      provider: 'openai',
      model: 'gpt-test',
      customProviderApi: null,
      stage: 'health-update',
      outcome: 'success',
      profileIndex: null,
      profileName: null,
      attemptIndex: null,
      roundIndex: 4,
      status: null,
      healthState: null,
      healthDisposition: null,
      timeoutKind: null,
    },
  ];
  const expectedCli = [
    {
      kind: 'provider-call',
      provider: 'openai',
      model: 'gpt-test',
      customProviderApi: null,
      outcome: 'success',
      profileIndex: null,
      attemptIndex: 3,
      roundIndex: null,
      durationMs: null,
    },
    {
      kind: 'profile-decision',
      provider: 'openai',
      model: 'gpt-test',
      customProviderApi: null,
      stage: 'health-update',
      outcome: 'success',
      profileIndex: null,
      attemptIndex: null,
      roundIndex: 4,
      status: null,
      healthState: null,
      healthDisposition: null,
      timeoutKind: null,
    },
  ];

  assert.deepEqual(full.providerAttempts, expectedFull);
  assert.deepEqual(cli.providerAttempts, expectedCli);
  assert.equal(
    JSON.stringify(full.providerAttempts),
    '[{"kind":"provider-call","provider":"openai","model":"gpt-test","customProviderApi":null,"outcome":"success","finishReason":null,"profileIndex":null,"profileName":null,"attemptIndex":3,"roundIndex":null,"durationMs":null},{"kind":"profile-decision","provider":"openai","model":"gpt-test","customProviderApi":null,"stage":"health-update","outcome":"success","profileIndex":null,"profileName":null,"attemptIndex":null,"roundIndex":4,"status":null,"healthState":null,"healthDisposition":null,"timeoutKind":null}]',
  );
  assert.equal(
    JSON.stringify(cli.providerAttempts),
    '[{"kind":"provider-call","provider":"openai","model":"gpt-test","customProviderApi":null,"outcome":"success","profileIndex":null,"attemptIndex":3,"roundIndex":null,"durationMs":null},{"kind":"profile-decision","provider":"openai","model":"gpt-test","customProviderApi":null,"stage":"health-update","outcome":"success","profileIndex":null,"attemptIndex":null,"roundIndex":4,"status":null,"healthState":null,"healthDisposition":null,"timeoutKind":null}]',
  );
});

test('materializes zero usage and cost only after a known-priced call with absent details', () => {
  const collector = createEvaluationEventCollector('full');

  collector.llmCallFinished(
    providerCall({
      normalizedUsage: undefined,
      pricing: { status: 'known' },
    }),
  );

  assert.deepEqual(collector.metrics, {
    durationMs: 0,
    modelCallCount: 1,
    toolCallCount: 0,
    toolFailureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  });
});

test('counts every physical model event and accumulates complete and missing accounting', () => {
  const collector = createEvaluationEventCollector('full');

  collector.llmCallFinished(
    providerCall({
      callId: 'known-cost' as ChatV2CallId,
      pricing: { status: 'known', costUsd: 0.125 },
    }),
  );
  collector.llmCallFinished(
    providerCall({
      callId: 'missing-usage' as ChatV2CallId,
      normalizedUsage: undefined,
      pricing: { status: 'known' },
      outcome: 'provider-failure',
    }),
  );
  collector.llmCallFinished(
    providerCall({
      callId: 'aborted' as ChatV2CallId,
      normalizedUsage: { promptTokens: 1, completionTokens: 2 },
      pricing: { status: 'known', costUsd: 0.25 },
      outcome: 'aborted',
    }),
  );

  assert.deepEqual(collector.metrics, {
    durationMs: 0,
    modelCallCount: 3,
    toolCallCount: 0,
    toolFailureCount: 0,
    inputTokens: 11,
    outputTokens: 22,
    cachedInputTokens: 3,
    reasoningTokens: 5,
    costUsd: 0.375,
  });
  assert.deepEqual(
    collector.providerAttempts.map((attempt) => (attempt as { outcome: string }).outcome),
    ['success', 'provider-failure', 'aborted'],
  );
});

test('keeps unavailable pricing distinct from known costs', () => {
  const collector = createEvaluationEventCollector('full');

  collector.llmCallFinished(providerCall({ pricing: { status: 'unknown' } }));
  assert.equal('costUsd' in collector.metrics, false);
  assert.equal(collector.metrics.hasUnknownCost, true);

  collector.llmCallFinished(providerCall({ callId: 'priced-after-unknown' as ChatV2CallId }));
  assert.equal(collector.metrics.costUsd, 0.125);
  assert.equal(collector.metrics.hasUnknownCost, true);
});

test('does not let profile decisions change physical model or tool metrics', () => {
  const collector = createEvaluationEventCollector('full');

  collector.llmProfileAttempt(profileDecision({ outcome: 'failure', stage: 'request' }));

  assert.deepEqual(collector.metrics, {
    durationMs: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    toolFailureCount: 0,
  });
  assert.equal(collector.providerAttempts.length, 1);
  assert.equal((collector.providerAttempts[0] as { kind: string }).kind, 'profile-decision');
});

test('counts repeated event identifiers and all tool outcomes in arrival order', () => {
  const collector = createEvaluationEventCollector('full');
  const repeated = providerCall({ callId: 'repeated' as ChatV2CallId });

  collector.llmCallFinished(repeated);
  collector.toolCallFinished(toolCall('success'));
  collector.llmProfileAttempt(profileDecision());
  collector.llmCallFinished(repeated);
  collector.toolCallFinished(toolCall('failure'));
  collector.toolCallFinished(toolCall('passthrough-error'));
  collector.toolCallFinished(toolCall('aborted'));

  assert.equal(collector.metrics.modelCallCount, 2);
  assert.equal(collector.metrics.toolCallCount, 4);
  assert.equal(collector.metrics.toolFailureCount, 3);
  assert.deepEqual(
    collector.providerAttempts.map((attempt) => (attempt as { kind: string }).kind),
    ['provider-call', 'profile-decision', 'provider-call'],
  );
});

test('preserves caller-owned duration and never retains or mutates source-only event fields', () => {
  const collector = createEvaluationEventCollector('full');
  const event = Object.freeze({
    ...providerCall(),
    rawUsage: { inputTokens: 1000 },
    secret: 'must-not-be-retained',
  });
  const before = structuredClone(event);
  const addProviderCall = collector.llmCallFinished;
  const addProfileDecision = collector.llmProfileAttempt;
  const addToolCall = collector.toolCallFinished;

  collector.metrics.durationMs = 987;
  addProviderCall(event);
  addProfileDecision(profileDecision());
  addToolCall(toolCall('success'));

  assert.equal(collector.metrics.durationMs, 987);
  assert.deepEqual(event, before);
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(Object.keys(collector.providerAttempts[0] as object), [
    'kind',
    'provider',
    'model',
    'customProviderApi',
    'outcome',
    'finishReason',
    'profileIndex',
    'profileName',
    'attemptIndex',
    'roundIndex',
    'durationMs',
  ]);
  assert.equal(JSON.stringify(collector.providerAttempts).includes('must-not-be-retained'), false);
  assert.equal(JSON.stringify(collector.providerAttempts).includes('rawUsage'), false);
});
