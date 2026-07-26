import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatV2CallFinishedEvent } from '@valerypopoff/rivet2-core';
import {
  assertLegacyGraphBuilderFinished,
  formatLegacyGraphBuilderAccounting,
  LegacyGraphBuilderAccounting,
  summarizeLegacyGraphBuilderArguments,
  summarizeLegacyGraphBuilderResult,
} from './legacyGraphBuilderLogging.js';

function accountingEvent(overrides: Partial<ChatV2CallFinishedEvent> = {}): ChatV2CallFinishedEvent {
  return {
    callId: 'call' as ChatV2CallFinishedEvent['callId'],
    attemptIndex: 0,
    nodeId: 'node' as ChatV2CallFinishedEvent['nodeId'],
    processId: 'process' as ChatV2CallFinishedEvent['processId'],
    provider: 'openai',
    model: 'private-model-label',
    outcome: 'success',
    normalizedUsage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    pricing: { status: 'known', costUsd: 0.01 },
    ...overrides,
  };
}

test('legacy Graph Builder diagnostics report shape without value contents', () => {
  const secret = 'super-secret-provider-key';

  const argumentsSummary = summarizeLegacyGraphBuilderArguments([
    secret,
    { apiKey: secret, nested: { prompt: secret } },
    [secret, secret],
  ]);
  const resultSummary = summarizeLegacyGraphBuilderResult({
    type: 'object',
    value: { apiKey: secret },
  });

  assert.equal(argumentsSummary, 'arg1=string(25 chars), arg2=object(2 keys), arg3=array(2 items)');
  assert.equal(resultSummary, 'DataValue(object, object(1 keys))');
  assert.doesNotMatch(`${argumentsSummary} ${resultSummary}`, /super-secret|apiKey|prompt/);
});

test('legacy Graph Builder diagnostics do not echo malformed data-value types', () => {
  const summary = summarizeLegacyGraphBuilderResult({
    type: 'secret-value\nraw-secret',
    value: 'raw-secret',
  });

  assert.equal(summary, 'DataValue(unknown, string(10 chars))');
  assert.doesNotMatch(summary, /raw-secret|secret-value/);
});

test('legacy Graph Builder requires its explicit terminal event', () => {
  assert.doesNotThrow(() => assertLegacyGraphBuilderFinished(true));
  assert.throws(() => assertLegacyGraphBuilderFinished(false), /before reporting a completed result/);
});

test('legacy Graph Builder accounting aggregates physical attempts without retaining event contents', () => {
  const accounting = new LegacyGraphBuilderAccounting();
  accounting.record(accountingEvent());
  accounting.record(
    accountingEvent({
      callId: 'call-2' as ChatV2CallFinishedEvent['callId'],
      attemptIndex: 1,
      outcome: 'provider-failure',
      finishReason: 'raw-secret-finish-reason',
      normalizedUsage: {
        promptTokens: 20,
        completionTokens: 2,
        totalTokens: 22,
      },
      pricing: { status: 'known', costUsd: 0.02 },
    }),
  );

  const summary = accounting.snapshot();
  assert.deepEqual(summary, {
    physicalAttempts: 2,
    successfulAttempts: 1,
    failedAttempts: 1,
    abortedAttempts: 0,
    usageCompleteness: 'complete',
    promptTokens: 30,
    completionTokens: 7,
    totalTokens: 37,
    pricingCompleteness: 'complete',
    costUsd: 0.03,
  });
  const formatted = formatLegacyGraphBuilderAccounting(summary);
  assert.doesNotMatch(formatted, /private-model|raw-secret|openai|finish/i);
});

test('legacy Graph Builder accounting leaves incomplete token and cost totals nullable', () => {
  const accounting = new LegacyGraphBuilderAccounting();
  accounting.record(accountingEvent());
  accounting.record(
    accountingEvent({
      callId: 'call-2' as ChatV2CallFinishedEvent['callId'],
      normalizedUsage: undefined,
      pricing: { status: 'unknown' },
      outcome: 'aborted',
    }),
  );

  assert.deepEqual(accounting.snapshot(), {
    physicalAttempts: 2,
    successfulAttempts: 1,
    failedAttempts: 0,
    abortedAttempts: 1,
    usageCompleteness: 'partial',
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    pricingCompleteness: 'partial',
    costUsd: null,
  });
});
