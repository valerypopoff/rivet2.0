import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { executeLLMInvocation } from '../../../src/model/chat-v2/llmInvocationCoordinator.js';
import { LLMInvocationJournal } from '../../../src/model/chat-v2/llmInvocationJournal.js';
import type { LLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';

describe('LLM invocation coordinator', () => {
  it('records a failed terminal disposition without changing the thrown error', async () => {
    const journal = new LLMInvocationJournal();
    const expected = new Error('provider setup failed');

    await assert.rejects(
      executeLLMInvocation({
        context: { signal: new AbortController().signal } as never,
        journal,
        runtime: failingRuntime(expected),
        toolCallContinuation: undefined,
      }),
      expected,
    );

    assert.deepEqual(journal.events, [{ type: 'terminal', kind: 'failed' }]);
  });

  it('classifies a thrown cancellation from the root signal as cancelled', async () => {
    const controller = new AbortController();
    const journal = new LLMInvocationJournal();
    const expected = new Error('cancelled');
    controller.abort(expected);

    await assert.rejects(
      executeLLMInvocation({
        context: { signal: controller.signal } as never,
        journal,
        runtime: failingRuntime(expected),
        toolCallContinuation: undefined,
      }),
      expected,
    );

    assert.deepEqual(journal.events, [{ type: 'terminal', kind: 'cancelled' }]);
  });

  it('classifies a diagnostic provider failure even when it carries partial response text', async () => {
    const journal = new LLMInvocationJournal();
    const result = {
      commonOutputs: {
        response: { type: 'string', value: 'partial provider response' },
      },
      requestMessages: [],
      allMessages: [],
      response: '',
      functionCalls: [],
      reasoning: undefined,
      usage: undefined,
      rawUsage: undefined,
      finishReason: undefined,
      providerMetadata: undefined,
      requestStatus: 503,
      terminalOutcome: 'provider-failure',
    } as never;

    const actual = await executeLLMInvocation({
      context: { signal: new AbortController().signal } as never,
      journal,
      runtime: succeedingRuntime(result),
      toolCallContinuation: undefined,
    });

    assert.strictEqual(actual, result);
    assert.deepEqual(journal.events, [{ type: 'terminal', kind: 'failed' }]);
  });
});

function failingRuntime(error: Error): LLMChatV2RuntimeConfig {
  return {
    runOptions: {} as never,
    runPipeline: async () => {
      throw error;
    },
    functions: undefined,
    cacheKey: undefined,
    cachedOutputs: undefined,
    editorCache: undefined,
    shouldAutoContinueToolCalls: false,
    maxToolRounds: 3,
    outputLLMAttempts: false,
    getProfileSummary: undefined,
    isProfileFallbackExhausted: () => false,
  };
}

function succeedingRuntime(result: Awaited<ReturnType<LLMChatV2RuntimeConfig['runPipeline']>>): LLMChatV2RuntimeConfig {
  return {
    ...failingRuntime(new Error('unused')),
    runPipeline: async () => result,
  };
}
