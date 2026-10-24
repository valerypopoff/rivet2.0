import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAgentProfileAttemptInspectorRows,
  type AgentLLMProfileAttemptTrace,
  type NodeId,
  type ProcessId,
} from '@valerypopoff/rivet2-core';

const baseAttempt = {
  roundIndex: 0,
  profileIndex: 0,
  profileName: 'Primary route',
  nodeId: 'chat' as NodeId,
  processId: 'chat-process' as ProcessId,
  provider: 'custom',
  customProviderApi: 'responses',
  model: 'fast-provider',
} satisfies Pick<
  AgentLLMProfileAttemptTrace,
  'roundIndex' | 'profileIndex' | 'profileName' | 'nodeId' | 'processId' | 'provider' | 'customProviderApi' | 'model'
>;

test('profile labels alias only exact Decision AI defaults and never mutate retained diagnostics or authored names', () => {
  for (const [family, name, expected] of [
    ['classifier', 'Classifier Profile', 'Decision AI Profile'],
    ['classifier', 'My Classifier route', 'My Classifier route'],
    ['classifier', ' Classifier Profile ', 'Classifier Profile'],
    [undefined, 'Classifier Profile', 'Classifier Profile'],
    ['llm', 'Classifier Profile', 'Classifier Profile'],
  ] as const) {
    const attempt: AgentLLMProfileAttemptTrace = {
      ...baseAttempt,
      family,
      profileName: name,
      eventId: 'name-check',
      stage: 'configuration',
      outcome: 'failure',
      error: 'Classifier Profile: original provider diagnostic',
    };
    const [row] = buildAgentProfileAttemptInspectorRows([attempt]);
    assert.equal(row!.providerAndModel, `Profile: ${expected} · Custom Responses / fast-provider`);
    assert.equal(row!.error, attempt.error);
    assert.equal(attempt.profileName, name);
  }
});

test('presents classifier response timeouts without streaming terminology', () => {
  const [row] = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      family: 'classifier',
      provider: 'liquid',
      model: 'd1',
      customProviderApi: undefined,
      eventId: 'classifier-timeout',
      stage: 'request',
      outcome: 'failure',
      timeoutKind: 'response',
      durationMs: 500,
      error: 'Perplexity request timed out after 500 ms.',
    },
  ]);
  assert.equal(row?.providerAndModel, 'Profile: Primary route · liquid / d1');
  assert.equal(row?.context, 'request / response timed out / profile 1 / 0.50 sec');
  assert.equal(row?.error, 'Perplexity request timed out after 500 ms.');
});

test('classifier failure categories are readable without interpreting provider error strings', () => {
  const [row] = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      family: 'classifier',
      eventId: 'parse-failure',
      stage: 'response-validation',
      outcome: 'failure',
      failureKind: 'response-parsing',
    },
  ]);
  assert.equal(row?.context, 'response parsing / failure / profile 1');
});

test('unreached candidates are not presented as suspended profiles', () => {
  const [row] = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      family: 'classifier',
      eventId: 'unreached',
      stage: 'configuration',
      outcome: 'skipped',
      skipReason: 'unreached',
    },
  ]);
  assert.equal(row?.context, 'configuration / not reached / profile 1');
});

test('classifier receipts preserve failed usage and explicitly identify unpriced costs', () => {
  const attempts = [0.00004, undefined].map((estimatedCostUsd, index) => ({
    ...baseAttempt,
    family: 'classifier' as const,
    eventId: `receipt-${index}`,
    stage: 'response-validation' as const,
    outcome: 'failure' as const,
    failureKind: 'response-validation' as const,
    attemptIndex: 0,
    classifierUsage: {
      inputTokens: 1000,
      outputTokens: 0,
      ...(estimatedCostUsd == null ? {} : { estimatedCostUsd }),
    },
  }));
  const rows = buildAgentProfileAttemptInspectorRows(attempts);
  assert.match(rows[0]!.context, /1000 input \/ 0 output tokens \/ estimated \$0\.00004000$/);
  assert.match(rows[1]!.context, /1000 input \/ 0 output tokens \/ cost unknown$/);
});

test('physical classifier requests identify unavailable timing, usage and cost without inventing health receipts', () => {
  const rows = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      family: 'classifier',
      eventId: 'no-receipt',
      stage: 'request',
      outcome: 'failure',
      attemptIndex: 0,
    },
    {
      ...baseAttempt,
      family: 'classifier',
      eventId: 'gate',
      stage: 'health-gate',
      outcome: 'skipped',
      healthDisposition: 'deny',
    },
  ]);
  assert.match(rows[0]!.context, /usage not reported \/ cost unknown$/);
  assert.match(rows[0]!.context, /duration unavailable/);
  assert.doesNotMatch(rows[1]!.context, /usage|cost/);
});

test('presents suspension skips, reliability-service decisions, and timeout failures for Response Inspector', () => {
  const rows = buildAgentProfileAttemptInspectorRows([
    {
      ...baseAttempt,
      eventId: 'open-gate',
      stage: 'health-gate',
      outcome: 'skipped',
      healthState: 'open',
      healthDisposition: 'deny',
    },
    {
      ...baseAttempt,
      eventId: 'store-fail-open',
      stage: 'health-gate',
      outcome: 'failure',
      healthDisposition: 'fail-open',
      error: 'Health store unavailable',
    },
    {
      ...baseAttempt,
      eventId: 'first-output-timeout',
      stage: 'request',
      outcome: 'failure',
      timeoutKind: 'first-output',
    },
  ]);

  assert.deepEqual(rows, [
    {
      eventId: 'open-gate',
      providerAndModel: 'Profile: Primary route · Custom Responses / fast-provider',
      context: 'reliability check / profile suspended; skipped / profile 1 / round 1',
    },
    {
      eventId: 'store-fail-open',
      providerAndModel: 'Profile: Primary route · Custom Responses / fast-provider',
      context: 'reliability check / reliability service unavailable; profile request continued / profile 1 / round 1',
      error: 'Health store unavailable',
    },
    {
      eventId: 'first-output-timeout',
      providerAndModel: 'Profile: Primary route · Custom Responses / fast-provider',
      context: 'request / first output timed out / profile 1 / round 1',
    },
  ]);
});
