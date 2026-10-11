import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeLLMInvocationFailureOutputs,
  projectLLMInvocationDiagnostics,
  projectLLMInvocationResult,
} from '../../../src/model/chat-v2/llmInvocationResultProjector.js';

void describe('LLM invocation result projector', () => {
  void it('accounts known model calls once without Usage details and keeps delegated classifier cost separate', () => {
    for (const outputUsage of [true, false]) {
      const result = { commonOutputs: {}, functionCalls: [] } as never;
      const call = { callId: 'call', pricing: { status: 'known', costUsd: 0.2 } };
      const outputs = projectLLMInvocationResult({
        result,
        outputUsage,
        modelCalls: [call, call, { callId: 'unknown', pricing: { status: 'unknown' } }] as never,
        outputLLMAttempts: false,
        llmAttempts: [],
        toolCost: { llm: 0.1, classifier: 0.03, other: 0 },
      });
      assert.equal(outputs.cost?.value, 0.2 + 0.1 + 0.03);
      assert.deepEqual(outputs.costBreakdown?.value, { llm: 0.2 + 0.1, classifier: 0.03, other: 0 });
      assert.equal(outputs.usage, undefined);
    }
    const outputs = projectLLMInvocationResult({
      result: { commonOutputs: {}, functionCalls: [] } as never,
      modelCalls: [{ callId: 'zero', pricing: { status: 'known', costUsd: 0 } }] as never,
      outputUsage: false,
      outputLLMAttempts: false,
      llmAttempts: [],
    });
    assert.equal(outputs.cost?.value, 0);
  });
  void it('preserves streamed response state while projecting opt-in failure diagnostics', () => {
    const diagnostics = projectLLMInvocationDiagnostics({
      runOptions: {
        outputRequestBody: true,
        outputResponseBody: true,
        requestBodies: [{ prompt: 'preserved request' }],
        responseBodies: [{ partial: 'provider response' }],
      } as never,
      outputLLMAttempts: true,
      outputUsage: true,
      llmAttempts: [
        {
          model: 'test-model',
          outcome: 'failure',
          provider: 'openai',
          roundIndex: 0,
          stage: 'request',
        },
      ],
      modelCalls: [
        {
          attemptIndex: 0,
          callId: 'call-1',
          model: 'test-model',
          nodeId: 'node-1',
          normalizedUsage: { cachedTokens: 0, completionTokens: 2, promptTokens: 3, reasoningTokens: 0 },
          outcome: 'success',
          pricing: { status: 'unknown' },
          processId: 'process-1',
          provider: 'openai',
        },
      ] as never,
      profileSummary: 'fallback profile exhausted',
    });

    const failureOutputs = mergeLLMInvocationFailureOutputs(
      {
        response: { type: 'string', value: 'streamed prefix' },
        ['all-messages']: { type: 'chat-message[]', value: [] },
      },
      diagnostics,
    );

    assert.deepEqual(failureOutputs.response, { type: 'string', value: 'streamed prefix' });
    assert.deepEqual(failureOutputs.requestBody, { type: 'object', value: { prompt: 'preserved request' } });
    assert.deepEqual(failureOutputs.responseBody, { type: 'object', value: { partial: 'provider response' } });
    assert.deepEqual(failureOutputs.usage, {
      type: 'object',
      value: {
        cachedTokens: 0,
        completionTokens: 2,
        promptTokens: 3,
        reasoningTokens: 0,
        totalCost: undefined,
        totalTokens: 5,
      },
    });
    assert.deepEqual(failureOutputs.llmAttempts, { type: 'object[]', value: diagnostics.llmAttempts!.value });
    assert.deepEqual(failureOutputs.llmProfileSummary, { type: 'string', value: 'fallback profile exhausted' });
  });
});
