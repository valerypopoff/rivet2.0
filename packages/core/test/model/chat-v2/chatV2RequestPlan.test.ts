import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChatV2RequestPlan, summarizeChatV2RequestPlan } from '../../../src/model/chat-v2/chatV2RequestPlan.js';

const model = {} as never;

describe('buildChatV2RequestPlan', () => {
  it('selects streaming only when partial output is enabled and disables hidden SDK retries', () => {
    const streaming = buildChatV2RequestPlan({
      provider: 'openai',
      model,
      modelId: 'gpt-test',
      messages: [],
      emitPartialOutputs: true,
      retryOnNon200: false,
    });
    const generating = buildChatV2RequestPlan({
      provider: 'openai',
      model,
      modelId: 'gpt-test',
      messages: [],
      emitPartialOutputs: false,
      retryOnNon200: false,
    });

    assert.equal(streaming.transportMode, 'stream');
    assert.equal(generating.transportMode, 'generate');
    assert.equal(streaming.retry.repeatTimes, 0);
  });

  it('normalizes Rivet retry policy and preserves request/output policy', () => {
    const plan = buildChatV2RequestPlan({
      provider: 'custom',
      model,
      modelId: 'custom-model',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: { lookup: {} as never },
      responseFormat: 'json_schema',
      providerOptions: { custom: { structuredOutputs: true } },
      temperature: 0.2,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 2,
      retryOnNon200CooldownMs: 25,
      outputUsage: true,
      outputRequestBody: true,
      includeFunctionCalls: true,
    });

    assert.deepEqual(plan.retry, { enabled: true, repeatTimes: 2, cooldownMs: 25 });
    assert.equal(plan.request.responseFormat, 'json_schema');
    assert.deepEqual(plan.request.providerOptions, { custom: { structuredOutputs: true } });
    assert.equal(plan.output.outputUsage, true);
    assert.equal(plan.output.outputRequestBody, true);
    assert.equal(plan.output.outputResponseBody, false);
  });

  it('keeps response-body capture explicitly opt-in', () => {
    const plan = buildChatV2RequestPlan({
      provider: 'openai',
      model,
      modelId: 'gpt-test',
      messages: [],
      outputResponseBody: true,
    });

    assert.equal(plan.output.outputResponseBody, true);
  });

  it('produces an inspectable summary without model objects, messages, or credentials', () => {
    const plan = buildChatV2RequestPlan({
      provider: 'openai',
      model,
      modelId: 'gpt-test',
      messages: [{ role: 'user', content: 'private prompt' }],
      retryOnNon200: false,
      emitPartialOutputs: false,
    });
    const summary = summarizeChatV2RequestPlan(plan);
    const serialized = JSON.stringify(summary);

    assert.equal(summary.messageCount, 1);
    assert.equal(summary.transportMode, 'generate');
    assert.doesNotMatch(serialized, /private prompt/);
    assert.equal('model' in summary, false);
    assert.equal('messages' in summary, false);
  });
});
