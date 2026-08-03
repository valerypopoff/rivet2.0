import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LLMInvocationJournal } from '../../../src/model/chat-v2/llmInvocationJournal.js';
import type { ChatV2CallFinishedEvent } from '../../../src/model/ProcessContext.js';

describe('LLM invocation journal', () => {
  it('keeps a snapshot when a later observer mutates its event object', () => {
    const journal = new LLMInvocationJournal();
    const event = makeEvent();
    journal.recordModelCall(event);

    event.pricing.status = 'unknown';
    event.normalizedUsage!.totalTokens = 999;

    assert.equal(journal.modelCalls[0]!.pricing.status, 'known');
    assert.equal(journal.modelCalls[0]!.normalizedUsage!.totalTokens, 3);
  });

  it('keeps profile fallback attempts on the same immutable invocation timeline', () => {
    const journal = new LLMInvocationJournal();
    const attempt = {
      roundIndex: 0,
      profileIndex: 0,
      provider: 'custom' as const,
      model: 'primary',
      stage: 'request' as const,
      outcome: 'failure' as const,
      attemptIndex: 0,
      error: 'Invalid URL',
    };

    journal.recordProfileAttempt(attempt);
    attempt.error = 'mutated after recording';

    assert.deepEqual(journal.profileAttempts, [
      {
        ...attempt,
        error: 'Invalid URL',
      },
    ]);
    assert.equal(journal.events[0]?.type, 'profile-attempt');
  });
});

function makeEvent(): ChatV2CallFinishedEvent {
  return {
    attemptIndex: 0,
    callId: 'call' as ChatV2CallFinishedEvent['callId'],
    nodeId: 'node' as ChatV2CallFinishedEvent['nodeId'],
    processId: 'process' as ChatV2CallFinishedEvent['processId'],
    provider: 'openai',
    model: 'gpt-5',
    outcome: 'success',
    normalizedUsage: {
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    pricing: { status: 'known', costUsd: 0.01 },
  };
}
