import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { LanguageModelUsage } from 'ai';
import type { ChatMessage } from '../../../src/model/DataValue.js';
import type { PortId } from '../../../src/model/NodeBase.js';
import type { StreamedFunctionCall } from '../../../src/model/chat/streamChatResponse.js';
import {
  createChatV2CommonOutputs,
  createChatV2ProviderFailureOutputs,
  normalizeChatV2Usage,
} from '../../../src/model/chat-v2/chatV2Outputs.js';
import { calculateChatV2Cost } from '../../../src/model/chat-v2/modelRegistry.js';

const requestMessages: ChatMessage[] = [
  {
    type: 'user',
    message: 'Hello',
  },
];

function createFunctionCall(overrides: Partial<StreamedFunctionCall> = {}): StreamedFunctionCall {
  return {
    type: 'function',
    id: 'call-1',
    name: 'lookup',
    arguments: '{"city":"Paris"}',
    ...overrides,
  };
}

describe('chatV2Outputs', () => {
  it('normalizes token usage and cost in one provider-neutral policy', () => {
    const usage: LanguageModelUsage = {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 25,
      inputTokenDetails: {
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        noCacheTokens: 7,
      },
      outputTokenDetails: {
        reasoningTokens: 4,
        textTokens: 4,
      },
    };

    assert.deepEqual(normalizeChatV2Usage(usage, { provider: 'openai', modelId: 'gpt-4o' }), {
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 25,
      cachedTokens: 5,
      reasoningTokens: 4,
      totalCost: calculateChatV2Cost('openai', 'gpt-4o', 12, 8),
    });
  });

  it('keeps a Usage cost unknown when the provider omitted one billable token count', () => {
    assert.deepEqual(
      normalizeChatV2Usage(
        {
          inputTokens: 12,
        },
        { provider: 'openai', modelId: 'gpt-5.6-luna' },
      ),
      {
        promptTokens: 12,
        completionTokens: 0,
        totalTokens: 12,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalCost: undefined,
      },
    );
  });

  it('drops malformed provider token metadata instead of leaking it into Usage', () => {
    assert.deepEqual(
      normalizeChatV2Usage(
        {
          inputTokens: Number.NaN,
          outputTokens: 8,
          totalTokens: Number.POSITIVE_INFINITY,
          inputTokenDetails: {
            cacheReadTokens: -2,
            cacheWriteTokens: 3,
          },
          outputTokenDetails: {
            reasoningTokens: -1,
          },
        },
        { provider: 'openai', modelId: 'gpt-5.6-luna' },
      ),
      {
        promptTokens: 0,
        completionTokens: 8,
        totalTokens: 8,
        cachedTokens: 3,
        reasoningTokens: 0,
        totalCost: undefined,
      },
    );
  });

  it('uses the same normalized pricing for GPT-5.6 Luna Usage output', () => {
    assert.equal(
      normalizeChatV2Usage(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        },
        { provider: 'openai', modelId: 'gpt-5.6-luna' },
      )?.totalCost,
      1.4,
    );
  });

  it('builds successful common outputs including structured response, usage, reasoning, tools, and retry status', () => {
    const usage = normalizeChatV2Usage(
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      { provider: 'openai', modelId: 'gpt-4o' },
    );
    const functionCall = createFunctionCall();

    const outputs = createChatV2CommonOutputs({
      requestMessages,
      response: '{"answer":"Paris"}',
      structuredOutput: { answer: 'Paris' },
      functionCalls: [functionCall],
      usage,
      reasoning: ['  ', 'Because it is the capital.'],
      requestStatus: 200,
      responseError: undefined,
      requestStatuses: [503, 200],
      requestErrors: ['503 HTTP error'],
      requestBodies: [{ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }],
      outputUsage: true,
      outputReasoning: true,
      outputRequestStatus: true,
      includeFunctionCalls: true,
      retryOnNon200: true,
      responseFormat: 'json',
    });

    assert.deepEqual(outputs['response' as PortId], {
      type: 'object',
      value: { answer: 'Paris' },
    });
    assert.deepEqual(outputs['function-calls' as PortId], {
      type: 'object[]',
      value: [{ name: 'lookup', arguments: { city: 'Paris' }, id: 'call-1' }],
    });
    assert.deepEqual(outputs['usage' as PortId]?.value, usage);
    assert.deepEqual(outputs['reasoning' as PortId], {
      type: 'string[]',
      value: ['Because it is the capital.'],
    });
    assert.deepEqual(outputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [503, 200],
    });
    assert.deepEqual(outputs['requestError' as PortId], {
      type: 'string[]',
      value: ['503 HTTP error'],
    });
    assert.deepEqual(outputs['requestBody' as PortId], {
      type: 'object',
      value: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
    });
  });

  it('keeps optional successful outputs excluded when the provider returns no value for them', () => {
    const outputs = createChatV2CommonOutputs({
      requestMessages,
      response: 'Done',
      structuredOutput: undefined,
      functionCalls: [],
      usage: undefined,
      reasoning: '',
      requestStatus: undefined,
      responseError: undefined,
      requestStatuses: [],
      requestErrors: [],
      requestBodies: [],
      outputUsage: true,
      outputReasoning: true,
      outputRequestStatus: true,
      includeFunctionCalls: true,
      retryOnNon200: false,
      responseFormat: undefined,
    });

    assert.deepEqual(outputs['response' as PortId], {
      type: 'string',
      value: 'Done',
    });
    assert.deepEqual(outputs['function-calls' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputs['reasoning' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputs['requestStatus' as PortId], {
      type: 'number',
      value: 200,
    });
    assert.deepEqual(outputs['requestError' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputs['requestBody' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  it('keeps response status, response error, and request body independently optional', () => {
    const outputs = createChatV2CommonOutputs({
      requestMessages,
      response: 'Done',
      structuredOutput: undefined,
      functionCalls: [],
      usage: undefined,
      reasoning: '',
      requestStatus: 202,
      responseError: 'provider warning',
      requestStatuses: [],
      requestErrors: [],
      requestBodies: [{ model: 'test' }],
      outputUsage: false,
      outputReasoning: false,
      outputRequestStatus: true,
      outputRequestError: false,
      outputRequestBody: false,
      includeFunctionCalls: false,
      retryOnNon200: false,
      responseFormat: undefined,
    });

    assert.deepEqual(outputs['requestStatus' as PortId], { type: 'number', value: 202 });
    assert.equal('requestError' in outputs, false);
    assert.equal('requestBody' in outputs, false);
  });

  it('does not emit tool calls when Tool use did not declare that output', () => {
    const outputs = createChatV2CommonOutputs({
      requestMessages,
      response: 'Done',
      structuredOutput: undefined,
      functionCalls: [createFunctionCall()],
      usage: undefined,
      reasoning: '',
      requestStatus: 200,
      responseError: undefined,
      requestStatuses: [],
      requestErrors: [],
      outputUsage: false,
      outputReasoning: false,
      outputRequestStatus: false,
      includeFunctionCalls: false,
      retryOnNon200: false,
      responseFormat: undefined,
    });

    assert.equal('function-calls' in outputs, false);
  });

  it('builds provider failure outputs without successful response side effects', () => {
    const outputs = createChatV2ProviderFailureOutputs({
      requestMessages,
      responseStatus: 429,
      responseError: '429 Rate Limited',
      requestStatuses: [429, 429],
      requestErrors: ['first 429', 'second 429'],
      requestBodies: [{ attempt: 1 }, { attempt: 2 }],
      outputUsage: true,
      outputReasoning: true,
      outputRequestStatus: true,
      outputRequestError: true,
      outputRequestBody: true,
      includeFunctionCalls: true,
      retryOnNon200: true,
    });

    assert.deepEqual(outputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [429, 429],
    });
    assert.deepEqual(outputs['requestError' as PortId], {
      type: 'string[]',
      value: ['first 429', 'second 429'],
    });
    assert.deepEqual(outputs['requestBody' as PortId], {
      type: 'object[]',
      value: [{ attempt: 1 }, { attempt: 2 }],
    });
    assert.deepEqual(outputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputs['usage' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputs['function-calls' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  it('can return only Response Error for a provider failure', () => {
    const outputs = createChatV2ProviderFailureOutputs({
      requestMessages,
      responseStatus: 503,
      responseError: '503 Service Unavailable',
      requestStatuses: [503],
      requestErrors: ['503 Service Unavailable'],
      outputUsage: false,
      outputReasoning: false,
      outputRequestStatus: false,
      outputRequestError: true,
      outputRequestBody: false,
      includeFunctionCalls: false,
      retryOnNon200: false,
    });

    assert.deepEqual(outputs['requestError' as PortId], {
      type: 'string',
      value: '503 Service Unavailable',
    });
    assert.equal('requestStatus' in outputs, false);
    assert.equal('requestBody' in outputs, false);
    assert.deepEqual(outputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });
});
