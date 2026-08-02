import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { NodeId } from '../../../src/model/NodeBase.js';
import type { ChatV2CallFinishedEvent, ProcessId } from '../../../src/model/ProcessContext.js';
import { summarizeChatV2PhysicalCallUsage } from '../../../src/model/chat-v2/chatV2UsageAccounting.js';

function makeCall(callId: string, overrides: Partial<ChatV2CallFinishedEvent> = {}): ChatV2CallFinishedEvent {
  return {
    callId: callId as ChatV2CallFinishedEvent['callId'],
    attemptIndex: 0,
    nodeId: 'llm' as NodeId,
    processId: 'process' as ProcessId,
    provider: 'openai',
    model: 'gpt-5.6-luna',
    outcome: 'success',
    pricing: { status: 'known', costUsd: 0.001 },
    ...overrides,
  };
}

void describe('Chat V2 physical-call usage accounting', () => {
  void it('sums every priceable retry or fallback call into one exact Usage value', () => {
    const usage = summarizeChatV2PhysicalCallUsage([
      makeCall('primary-503', {
        outcome: 'provider-failure',
        normalizedUsage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cachedTokens: 3,
          reasoningTokens: 1,
        },
        pricing: { status: 'known', costUsd: 0.001 },
      }),
      makeCall('backup-200', {
        profileIndex: 1,
        normalizedUsage: {
          promptTokens: 20,
          completionTokens: 5,
          totalTokens: 25,
          cachedTokens: 4,
          reasoningTokens: 2,
        },
        pricing: { status: 'known', costUsd: 0.004 },
      }),
    ]);

    assert.deepEqual(usage, {
      promptTokens: 30,
      completionTokens: 7,
      totalTokens: 37,
      cachedTokens: 7,
      reasoningTokens: 3,
      totalCost: 0.005,
    });
  });

  void it('does not turn an unreported failed attempt into zero cost', () => {
    const usage = summarizeChatV2PhysicalCallUsage([
      makeCall('invalid-url', {
        outcome: 'provider-failure',
        pricing: { status: 'known' },
      }),
      makeCall('backup-200', {
        profileIndex: 1,
        normalizedUsage: {
          promptTokens: 20,
          completionTokens: 5,
          totalTokens: 25,
          cachedTokens: 0,
          reasoningTokens: 0,
        },
        pricing: { status: 'known', costUsd: 0.004 },
      }),
    ]);

    assert.deepEqual(usage, {
      promptTokens: 20,
      completionTokens: 5,
      totalTokens: 25,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalCost: undefined,
    });
  });

  void it('derives a total from a partially reported physical call without inventing its cost', () => {
    const usage = summarizeChatV2PhysicalCallUsage([
      makeCall('partial-usage', {
        normalizedUsage: {
          promptTokens: 12,
        },
        pricing: { status: 'known' },
      }),
    ]);

    assert.deepEqual(usage, {
      promptTokens: 12,
      completionTokens: 0,
      totalTokens: 12,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalCost: undefined,
    });
  });

  void it('uses the latest redelivery for one physical call and rejects malformed values', () => {
    const usage = summarizeChatV2PhysicalCallUsage([
      makeCall('call-1', {
        normalizedUsage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          reasoningTokens: 0,
        },
        pricing: { status: 'known', costUsd: 0.001 },
      }),
      makeCall('call-1', {
        normalizedUsage: {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          cachedTokens: Number.NaN,
          reasoningTokens: -1,
        },
        pricing: { status: 'known', costUsd: Number.POSITIVE_INFINITY },
      }),
    ]);

    assert.deepEqual(usage, {
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalCost: undefined,
    });
  });
});
