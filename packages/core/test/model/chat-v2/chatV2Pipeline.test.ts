import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { NoObjectGeneratedError } from 'ai';
import type { LanguageModelUsage } from 'ai';
import type { Outputs } from '../../../src/model/GraphProcessor.js';
import type { PortId } from '../../../src/model/NodeBase.js';
import type {
  ChatV2GenerateExecutor,
  ChatV2Model,
  ChatV2ProviderMetadata,
  ChatV2StreamExecutor,
  ChatV2StreamPart,
} from '../../../src/model/chat-v2/chatV2Types.js';
import { runChatV2Pipeline } from '../../../src/model/chat-v2/chatV2Pipeline.js';
import { streamChatV2 } from '../../../src/model/chat-v2/aiSdkBridge.js';
import { calculateChatV2Cost } from '../../../src/model/chat-v2/modelRegistry.js';

async function* mockStream(parts: ChatV2StreamPart[]): AsyncGenerator<ChatV2StreamPart> {
  for (const part of parts) {
    yield part;
  }
}

function createMockModel(): ChatV2Model {
  return {} as ChatV2Model;
}

function createTextStreamExecutor({
  text = 'Hello',
  onArgs,
  includeFinish = false,
}: {
  text?: string;
  onArgs?: (args: Record<string, unknown>) => void;
  includeFinish?: boolean;
} = {}): ChatV2StreamExecutor {
  return async (args) => {
    onArgs?.(args as Record<string, unknown>);

    return {
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text },
        { type: 'text-end', id: 'text_1' },
        ...(includeFinish
          ? [
              {
                type: 'finish' as const,
                finishReason: 'stop' as const,
                rawFinishReason: undefined,
              },
            ]
          : []),
      ]),
    };
  };
}

void describe('streamChatV2', () => {
  void it('adapts a mocked stream executor into Rivet-friendly results', async () => {
    const usage: LanguageModelUsage = {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      inputTokenDetails: {
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        noCacheTokens: 7,
      },
      outputTokenDetails: {
        reasoningTokens: 1,
        textTokens: 3,
      },
    };
    const providerMetadata: ChatV2ProviderMetadata = {
      openai: {
        responseId: 'resp_123',
      },
    };
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Hello' },
        { type: 'text-end', id: 'text_1' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: undefined,
          totalUsage: usage,
        },
      ]),
      finishReason: 'stop',
      providerMetadata,
      requestStatus: 201,
    });

    const result = await streamChatV2({
      model: createMockModel(),
      messages: [],
      executeStream,
    });

    assert.equal(result.responseText, 'Hello');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.providerMetadata, providerMetadata);
    assert.equal(result.usage?.inputTokens, 10);
    assert.equal(result.requestStatus, 201);
  });

  void it('handles unused AI SDK metadata promise rejections when the stream fails', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const executeStream: ChatV2StreamExecutor = async () => ({
        fullStream: mockStream([
          {
            type: 'error',
            error: new TypeError('Failed to fetch'),
          } as ChatV2StreamPart,
        ]),
        finishReason: Promise.reject(new Error('No output generated. Check the stream for errors.')),
        usage: Promise.reject(new Error('No usage generated. Check the stream for errors.')),
      });

      await assert.rejects(
        () =>
          streamChatV2({
            model: createMockModel(),
            messages: [],
            executeStream,
          }),
        /Failed to fetch/,
      );
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  void it('forwards request-shaping options to the AI SDK stream executor', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const providerOptions = {
      openai: {
        parallelToolCalls: false,
      },
    };
    const responseOutput = { name: 'json' };
    const executeStream = createTextStreamExecutor({
      text: '{}',
      onArgs: (args) => {
        capturedArgs = args;
      },
    });

    await streamChatV2({
      model: createMockModel(),
      messages: [],
      toolChoice: 'required',
      providerOptions,
      maxTokens: 100,
      temperature: 0.4,
      topP: 0.8,
      topK: 20,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      stopSequences: ['END'],
      seed: 123,
      responseOutput,
      executeStream,
    });

    assert.equal(capturedArgs?.toolChoice, 'required');
    assert.deepEqual(capturedArgs?.providerOptions, providerOptions);
    assert.equal(capturedArgs?.maxOutputTokens, 100);
    assert.equal(capturedArgs?.temperature, 0.4);
    assert.equal(capturedArgs?.topP, 0.8);
    assert.equal(capturedArgs?.topK, 20);
    assert.equal(capturedArgs?.presencePenalty, 0.2);
    assert.equal(capturedArgs?.frequencyPenalty, 0.3);
    assert.deepEqual(capturedArgs?.stopSequences, ['END']);
    assert.equal(capturedArgs?.seed, 123);
    assert.equal(capturedArgs?.output, responseOutput);
    assert.equal(capturedArgs?.maxRetries, 0);
    assert.equal('tools' in capturedArgs!, false);
  });

  void it('returns parsed structured output from the AI SDK stream result', async () => {
    const responseOutput = { name: 'json' };
    const structuredOutput = { answer: 'Hello', score: 1 };
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: JSON.stringify(structuredOutput) },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: structuredOutput,
    });

    const result = await streamChatV2({
      model: createMockModel(),
      messages: [],
      responseOutput,
      executeStream,
    });

    assert.deepEqual(result.structuredOutput, structuredOutput);
    assert.equal(result.responseText, JSON.stringify(structuredOutput));
  });

  void it('treats structured-output parse failures as missing parsed output', async () => {
    const responseOutput = { name: 'json' };
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'plain text' },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: Promise.reject(new Error('No object generated: could not parse the response.')),
    });

    const result = await streamChatV2({
      model: createMockModel(),
      messages: [],
      responseOutput,
      executeStream,
    });

    assert.equal(result.structuredOutput, undefined);
    assert.equal(result.responseText, 'plain text');
  });

  void it('collapses repeated parseable JSON text when structured response format is set', async () => {
    const responseOutput = { name: 'json' };
    const responseText = '{"movie":"The Matrix"}';
    const partialTexts: string[] = [];
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: Promise.reject(new Error('No object generated: could not parse the response.')),
    });

    const result = await streamChatV2({
      model: createMockModel(),
      messages: [],
      responseOutput,
      responseFormat: 'json',
      executeStream,
      onPartialOutput: ({ text }) => {
        partialTexts.push(text);
      },
    });

    assert.equal(result.structuredOutput, undefined);
    assert.equal(result.responseText, responseText);
    assert.deepEqual(partialTexts, [responseText, responseText]);
  });

  void it('does not collapse repeated scalar JSON-shaped text', async () => {
    const responseOutput = { name: 'json' };
    const responseText = '1111';
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: Promise.reject(new Error('No object generated: could not parse the response.')),
    });

    const result = await streamChatV2({
      model: createMockModel(),
      messages: [],
      responseOutput,
      responseFormat: 'json',
      executeStream,
    });

    assert.equal(result.responseText, responseText);
  });

  void it('omits undefined optional AI SDK arguments instead of forwarding empty request-shape hints', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const executeStream: ChatV2StreamExecutor = async (args) => {
      capturedArgs = args as Record<string, unknown>;

      return {
        fullStream: mockStream([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', text: 'Hello' },
          { type: 'text-end', id: 'text_1' },
        ]),
      };
    };

    await streamChatV2({
      model: createMockModel(),
      messages: [],
      executeStream,
    });

    assert.ok(capturedArgs);
    assert.equal('tools' in capturedArgs, false);
    assert.equal('toolChoice' in capturedArgs, false);
    assert.equal('output' in capturedArgs, false);
    assert.equal('providerOptions' in capturedArgs, false);
    assert.equal('maxOutputTokens' in capturedArgs, false);
    assert.equal(capturedArgs.maxRetries, 0);
  });
});

void describe('runChatV2Pipeline', () => {
  void it('retries Vercel provider stream errors with non-200 status codes before succeeding', async () => {
    let attempt = 0;
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;

      if (attempt === 1) {
        const error = new Error('Provider unavailable') as Error & { statusCode: number };
        error.name = 'AI_APICallError';
        error.statusCode = 503;

        return {
          fullStream: mockStream([
            {
              type: 'error',
              error,
            } as ChatV2StreamPart,
          ]),
        };
      }

      return {
        fullStream: mockStream([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', text: 'Recovered' },
          { type: 'text-end', id: 'text_1' },
        ]),
      };
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 1,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(attempt, 2);
    assert.equal(result.response, 'Recovered');
    assert.equal(result.requestStatus, 200);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [503, 200],
    });
    assert.equal('requestStatuses' in result.commonOutputs, false);
    const requestErrors = result.commonOutputs['requestError' as PortId];
    assert.equal(requestErrors?.type, 'string[]');
    assert.ok(Array.isArray(requestErrors?.value));
    assert.equal(requestErrors.value.length, 1);
    assert.match(requestErrors.value[0]!, /503 HTTP error/);
    assert.equal('requestErrors' in result.commonOutputs, false);
  });

  void it('normalizes the final Vercel status error after retry attempts are exhausted', async () => {
    let attempt = 0;
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;
      const error = new Error('Rate limited') as Error & { statusCode: number };
      error.name = 'AI_APICallError';
      error.statusCode = 429;

      throw error;
    };

    await assert.rejects(
      () =>
        runChatV2Pipeline({
          provider: 'anthropic',
          model: createMockModel(),
          modelId: 'claude-sonnet-4',
          prompt: { type: 'string', value: 'Hello' },
          retryOnNon200: true,
          retryOnNon200RepeatTimes: 1,
          context: {
            signal: new AbortController().signal,
          },
          executeStream,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'LLM Chat error');
        assert.match(error.message, /429 Rate Limited/);
        assert.equal((error as Error & { statusCode?: number }).statusCode, 429);
        return true;
      },
    );

    assert.equal(attempt, 2);
  });

  void it('does not start a zero-cooldown retry after cancellation', async () => {
    let attempt = 0;
    const abortController = new AbortController();
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;
      const error = new Error('Provider unavailable') as Error & { statusCode: number };
      error.name = 'AI_APICallError';
      error.statusCode = 503;
      throw error;
    };

    abortController.abort();

    await assert.rejects(
      () =>
        runChatV2Pipeline({
          provider: 'openai',
          model: createMockModel(),
          modelId: 'gpt-5',
          prompt: { type: 'string', value: 'Hello' },
          retryOnNon200: true,
          retryOnNon200RepeatTimes: 1,
          retryOnNon200CooldownMs: 0,
          context: {
            signal: abortController.signal,
          },
          executeStream,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'AbortError');
        return true;
      },
    );

    assert.equal(attempt, 1);
  });

  void it('returns request status outputs for Vercel status failures when requested', async () => {
    let attempt = 0;
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;
      const error = new Error('Rate limited') as Error & { statusCode: number };
      error.name = 'AI_APICallError';
      error.statusCode = 429;

      throw error;
    };

    const result = await runChatV2Pipeline({
      provider: 'anthropic',
      model: createMockModel(),
      modelId: 'claude-sonnet-4',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 1,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(attempt, 2);
    assert.equal(result.requestStatus, 429);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [429, 429],
    });
    assert.equal('requestStatuses' in result.commonOutputs, false);
    const requestErrors = result.commonOutputs['requestError' as PortId];
    assert.equal(requestErrors?.type, 'string[]');
    assert.ok(Array.isArray(requestErrors?.value));
    assert.equal(requestErrors.value.length, 2);
    assert.match(requestErrors.value[0]!, /429 Rate Limited/);
    assert.match(requestErrors.value[1]!, /429 Rate Limited/);
    assert.equal('requestErrors' in result.commonOutputs, false);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('returns the final response error when a stream completes with a non-200 status after retries', async () => {
    let attempt = 0;
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;

      return {
        fullStream: mockStream([
          { type: 'text-start', id: 'text_1' },
          { type: 'text-delta', id: 'text_1', text: `Still failing ${attempt}` },
          { type: 'text-end', id: 'text_1' },
        ]),
        requestStatus: 503,
      };
    };

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'custom-model',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 1,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(attempt, 2);
    assert.equal(result.response, 'Still failing 2');
    assert.equal(result.requestStatus, 503);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [503, 503],
    });
    assert.equal('requestStatuses' in result.commonOutputs, false);
    const requestErrors = result.commonOutputs['requestError' as PortId];
    assert.equal(requestErrors?.type, 'string[]');
    assert.ok(Array.isArray(requestErrors?.value));
    assert.equal(requestErrors.value.length, 2);
    assert.match(requestErrors.value[0]!, /503 HTTP error/);
    assert.match(requestErrors.value[1]!, /503 HTTP error/);
    assert.equal('requestErrors' in result.commonOutputs, false);
  });

  void it('returns per-attempt request status and error outputs for retried string-shaped Vercel status failures', async () => {
    let attempt = 0;
    const executeStream: ChatV2StreamExecutor = async () => {
      attempt += 1;
      const error = new Error(`Incorrect API key on attempt ${attempt}`) as Error & {
        responseBody: string;
        statusCode: string;
        url: string;
      };
      error.name = 'AI_APICallError';
      error.statusCode = '401';
      error.url = 'https://api.openai.com/v1/responses';
      error.responseBody = JSON.stringify({
        error: {
          message: `Incorrect API key provided on attempt ${attempt}.`,
        },
      });

      throw error;
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5.4-mini',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 1,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(attempt, 2);
    assert.equal(result.requestStatus, 401);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number[]',
      value: [401, 401],
    });
    assert.equal('requestStatuses' in result.commonOutputs, false);
    const requestErrors = result.commonOutputs['requestError' as PortId];
    assert.equal(requestErrors?.type, 'string[]');
    assert.ok(Array.isArray(requestErrors?.value));
    assert.equal(requestErrors.value.length, 2);
    assert.match(requestErrors.value[0]!, /401 Unauthorized/);
    assert.match(requestErrors.value[0]!, /attempt 1/);
    assert.match(requestErrors.value[1]!, /401 Unauthorized/);
    assert.match(requestErrors.value[1]!, /attempt 2/);
    assert.equal('requestErrors' in result.commonOutputs, false);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('returns request status outputs for string-shaped Vercel status failures when requested', async () => {
    const executeStream: ChatV2StreamExecutor = async () => {
      const error = new Error('Incorrect API key') as Error & {
        responseBody: string;
        statusCode: string;
        url: string;
      };
      error.name = 'AI_APICallError';
      error.statusCode = '401';
      error.url = 'https://api.openai.com/v1/responses';
      error.responseBody = JSON.stringify({
        error: {
          message: 'Incorrect API key provided.',
        },
      });

      throw error;
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5.4-mini',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.requestStatus, 401);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number',
      value: 401,
    });
    assert.equal(result.commonOutputs['requestError' as PortId]?.type, 'string');
    assert.match(String(result.commonOutputs['requestError' as PortId]?.value), /401 Unauthorized/);
    assert.match(String(result.commonOutputs['requestError' as PortId]?.value), /API key source/);
    assert.match(
      String(result.commonOutputs['requestError' as PortId]?.value),
      /Provider message: Incorrect API key provided/,
    );
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('returns request-error output for browser fetch failures when status output is requested', async () => {
    const executeStream: ChatV2StreamExecutor = async () => {
      throw new TypeError('Failed to fetch');
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5.4-mini',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.requestStatus, undefined);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.equal(result.commonOutputs['requestError' as PortId]?.type, 'string');
    assert.match(
      String(result.commonOutputs['requestError' as PortId]?.value),
      /before Rivet could read an HTTP response/,
    );
    assert.match(String(result.commonOutputs['requestError' as PortId]?.value), /API key source/);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('returns request-error output for status-less Vercel API call failures when requested', async () => {
    const executeStream: ChatV2StreamExecutor = async () => {
      const error = new Error('Provider request failed') as Error & { url: string };
      error.name = 'AI_APICallError';
      error.url = 'https://api.openai.com/v1/responses';
      throw error;
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5.4-mini',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.requestStatus, undefined);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.equal(result.commonOutputs['requestError' as PortId]?.type, 'string');
    assert.match(String(result.commonOutputs['requestError' as PortId]?.value), /request failed/);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('keeps non-request SDK setup errors as node failures when request outputs are enabled', async () => {
    const executeStream: ChatV2StreamExecutor = async () => {
      const error = new Error('Missing API key.');
      error.name = 'LoadAPIKeyError';
      throw error;
    };

    await assert.rejects(
      () =>
        runChatV2Pipeline({
          provider: 'openai',
          model: createMockModel(),
          modelId: 'gpt-5.4-mini',
          prompt: { type: 'string', value: 'Hello' },
          outputRequestStatus: true,
          context: {
            signal: new AbortController().signal,
          },
          executeStream,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'LLM Chat error');
        assert.match(error.message, /LLM API key could not be loaded/);
        return true;
      },
    );
  });

  void it('outputs the final provider request status when requested', async () => {
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Accepted' },
        { type: 'text-end', id: 'text_1' },
      ]),
      requestStatus: 202,
    });

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'custom-model',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.requestStatus, 202);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number',
      value: 202,
    });
    assert.deepEqual(result.commonOutputs['requestError' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('defaults successful Vercel provider calls to request status 200 when no raw status is exposed', async () => {
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'OK' },
        { type: 'text-end', id: 'text_1' },
      ]),
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Hello' },
      outputRequestStatus: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.requestStatus, 200);
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number',
      value: 200,
    });
    assert.deepEqual(result.commonOutputs['requestError' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('builds common outputs from a mocked streamed response', async () => {
    const partialOutputs: Outputs[] = [];
    const usage: LanguageModelUsage = {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      inputTokenDetails: {
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        noCacheTokens: 8,
      },
      outputTokenDetails: {
        reasoningTokens: 2,
        textTokens: 6,
      },
    };
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Hello' },
        { type: 'text-delta', id: 'text_1', text: ' world' },
        { type: 'text-end', id: 'text_1' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'lookup_weather',
          input: { city: 'Paris' },
        } as ChatV2StreamPart,
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: undefined,
          totalUsage: usage,
        },
      ]),
      finishReason: 'tool-calls',
      providerMetadata: {
        openai: {
          responseId: 'resp_456',
        },
      },
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-4o',
      prompt: { type: 'string', value: 'Tell me the weather.' },
      systemPrompt: { type: 'string', value: 'Be concise.' },
      outputUsage: true,
      context: {
        signal: new AbortController().signal,
        onPartialOutputs: (outputs) => {
          partialOutputs.push(outputs);
        },
      },
      executeStream,
    });

    assert.equal(result.response, 'Hello world');
    assert.equal(result.reasoning, '');
    assert.equal(result.finishReason, 'tool-calls');
    assert.equal(result.requestMessages.length, 2);
    assert.equal(result.requestMessages[0]?.type, 'system');
    assert.equal(result.requestMessages[1]?.type, 'user');
    assert.equal(result.functionCalls.length, 1);
    assert.equal(result.functionCalls[0]?.name, 'lookup_weather');
    assert.equal(result.allMessages.length, 3);

    assert.equal(result.commonOutputs['response' as PortId]?.type, 'string');
    assert.equal(result.commonOutputs['response' as PortId]?.value, 'Hello world');
    assert.equal(result.commonOutputs['responseTokens' as PortId]?.value, 8);
    assert.deepEqual(result.commonOutputs['function-calls' as PortId]?.value, [
      {
        name: 'lookup_weather',
        arguments: { city: 'Paris' },
        id: 'call_1',
      },
    ]);

    assert.deepEqual(result.usage, {
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      cachedTokens: 4,
      reasoningTokens: 2,
      totalCost: calculateChatV2Cost('openai', 'gpt-4o', 12, 8),
    });
    assert.deepEqual(result.commonOutputs['usage' as PortId]?.value, result.usage);

    assert.equal(partialOutputs.length, 3);
    assert.equal(partialOutputs[0]?.['response' as PortId]?.value, 'Hello');
    assert.equal(partialOutputs[1]?.['response' as PortId]?.value, 'Hello world');
    assert.deepEqual(partialOutputs[2]?.['function-calls' as PortId]?.value, [
      {
        name: 'lookup_weather',
        arguments: { city: 'Paris' },
        id: 'call_1',
      },
    ]);
  });

  void it('uses a non-streaming provider call when partial output streaming is disabled', async () => {
    let streamCalls = 0;
    let generateCalls = 0;
    let capturedGenerateArgs: Record<string, unknown> | undefined;
    const model = createMockModel();
    const executeStream: ChatV2StreamExecutor = async () => {
      streamCalls += 1;
      throw new Error('stream executor should not be used');
    };
    const executeGenerate: ChatV2GenerateExecutor = async (args) => {
      generateCalls += 1;
      capturedGenerateArgs = args as Record<string, unknown>;

      return {
        text: 'Generated answer',
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'lookup_weather',
            input: { city: 'Paris' },
          },
        ],
        totalUsage: {
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
        },
        reasoning: [{ text: 'reasoned' }],
        finishReason: 'tool-calls',
        providerMetadata: {
          custom: {
            responseId: 'resp_generate_1',
          },
        },
      };
    };

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model,
      modelId: 'custom-model',
      prompt: { type: 'string', value: 'Tell me the weather.' },
      outputUsage: true,
      outputReasoning: true,
      outputRequestStatus: true,
      emitPartialOutputs: false,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
      executeGenerate,
    });

    assert.equal(streamCalls, 0);
    assert.equal(generateCalls, 1);
    assert.equal(capturedGenerateArgs?.model, model);
    assert.equal(capturedGenerateArgs?.maxRetries, 0);
    assert.equal('stream' in capturedGenerateArgs!, false);
    assert.equal(result.response, 'Generated answer');
    assert.equal(result.requestStatus, 200);
    assert.equal(result.reasoning, 'reasoned');
    assert.equal(result.finishReason, 'tool-calls');
    assert.equal(result.functionCalls.length, 1);
    assert.deepEqual(result.commonOutputs['function-calls' as PortId]?.value, [
      {
        name: 'lookup_weather',
        arguments: { city: 'Paris' },
        id: 'call_1',
      },
    ]);
    assert.equal(result.commonOutputs['responseTokens' as PortId]?.value, 4);
    assert.deepEqual(result.commonOutputs['reasoning' as PortId], {
      type: 'string',
      value: 'reasoned',
    });
    assert.deepEqual(result.commonOutputs['requestStatus' as PortId], {
      type: 'number',
      value: 200,
    });
    assert.deepEqual(result.commonOutputs['requestError' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(result.providerMetadata, {
      custom: {
        responseId: 'resp_generate_1',
      },
    });
  });

  void it('keeps non-streaming tool-call-only responses when structured output is not complete', async () => {
    let generateCalls = 0;
    const generateResult: ChatV2GenerateHandle = {
      text: '',
      toolCalls: [
        {
          toolCallId: 'call_1',
          toolName: 'lookup_movie',
          input: { query: 'favorite movie' },
        },
      ],
      totalUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      finishReason: 'tool-calls',
    };
    Object.defineProperty(generateResult, 'output', {
      get() {
        throw new Error('No output generated.');
      },
    });
    const executeGenerate: ChatV2GenerateExecutor = async () => {
      generateCalls += 1;
      return generateResult;
    };

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'custom-tool-model',
      prompt: { type: 'string', value: 'Use the tool.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      outputUsage: true,
      includeFunctionCalls: true,
      emitPartialOutputs: false,
      context: {
        signal: new AbortController().signal,
      },
      executeGenerate,
    });

    assert.equal(generateCalls, 1);
    assert.equal(result.response, '');
    assert.equal(result.finishReason, 'tool-calls');
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'string',
      value: '',
    });
    assert.deepEqual(result.commonOutputs['function-calls' as PortId]?.value, [
      {
        name: 'lookup_movie',
        arguments: { query: 'favorite movie' },
        id: 'call_1',
      },
    ]);
    assert.equal(result.commonOutputs['responseTokens' as PortId]?.value, 2);
  });

  void it('keeps parsed structured output from completed non-streaming responses', async () => {
    const structuredOutput = { answer: 'Paris', confidence: 0.9 };
    const responseText = JSON.stringify(structuredOutput);
    const executeGenerate: ChatV2GenerateExecutor = async () => ({
      text: responseText,
      output: structuredOutput,
      finishReason: 'stop',
    });

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'custom-json-model',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      emitPartialOutputs: false,
      context: {
        signal: new AbortController().signal,
      },
      executeGenerate,
    });

    assert.equal(result.response, responseText);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'object',
      value: structuredOutput,
    });
  });

  void it('falls back to raw text when non-streaming structured output parsing fails', async () => {
    const responseText = 'not json';
    const usage: LanguageModelUsage = {
      inputTokens: 4,
      inputTokenDetails: {
        noCacheTokens: 4,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 2,
      outputTokenDetails: {
        textTokens: 2,
        reasoningTokens: undefined,
      },
      totalTokens: 6,
    };
    const executeGenerate: ChatV2GenerateExecutor = async (args) => {
      await (args as { onStepFinish?: (event: unknown) => unknown }).onStepFinish?.({
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'lookup_movie',
            input: { query: 'favorite movie' },
          },
        ],
      });

      throw new NoObjectGeneratedError({
        message: 'No object generated: response did not match schema.',
        text: responseText,
        response: {
          id: 'response-1',
          timestamp: new Date(0),
          modelId: 'gpt-5',
        },
        usage,
        finishReason: 'stop',
      });
    };

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      includeFunctionCalls: true,
      emitPartialOutputs: false,
      context: {
        signal: new AbortController().signal,
      },
      executeGenerate,
    });

    assert.equal(result.response, responseText);
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'string',
      value: responseText,
    });
    assert.deepEqual(result.commonOutputs['function-calls' as PortId]?.value, [
      {
        name: 'lookup_movie',
        arguments: { query: 'favorite movie' },
        id: 'call_1',
      },
    ]);
    assert.equal(result.commonOutputs['responseTokens' as PortId]?.value, 2);
    assert.equal((result.allMessages.at(-1) as any)?.message, responseText);
  });

  void it('does not recover no-text non-streaming structured output errors as empty responses', async () => {
    const usage: LanguageModelUsage = {
      inputTokens: 4,
      inputTokenDetails: {
        noCacheTokens: 4,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: undefined,
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
      totalTokens: 4,
    };
    const expectedError = new NoObjectGeneratedError({
      message: 'No object generated: the model did not return a response.',
      response: {
        id: 'response-1',
        timestamp: new Date(0),
        modelId: 'gpt-5',
      },
      usage,
      finishReason: 'stop',
    });
    const executeGenerate: ChatV2GenerateExecutor = async () => {
      throw expectedError;
    };

    await assert.rejects(
      () =>
        runChatV2Pipeline({
          provider: 'openai',
          model: createMockModel(),
          modelId: 'gpt-5',
          prompt: { type: 'string', value: 'Answer as JSON.' },
          responseOutput: { name: 'json' },
          responseFormat: 'json',
          emitPartialOutputs: false,
          context: {
            signal: new AbortController().signal,
          },
          executeGenerate,
        }),
      (error) => error === expectedError,
    );
  });

  void it('excludes the function-calls output when tools are enabled but the model returns no tool calls', async () => {
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Final answer' },
        { type: 'text-end', id: 'text_1' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: undefined,
        },
      ]),
      finishReason: 'stop',
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-4o',
      prompt: { type: 'string', value: 'Answer normally.' },
      includeFunctionCalls: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.response, 'Final answer');
    assert.equal(result.functionCalls.length, 0);
    assert.equal((result.allMessages.at(-1) as any)?.function_calls, undefined);
    assert.deepEqual(result.commonOutputs['function-calls' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('emits reasoning output when requested and the stream exposes reasoning text', async () => {
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'reasoning-start', id: 'reasoning_1' } as ChatV2StreamPart,
        { type: 'reasoning-delta', id: 'reasoning_1', text: 'Think first.' } as ChatV2StreamPart,
        { type: 'reasoning-end', id: 'reasoning_1' } as ChatV2StreamPart,
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Final answer' },
        { type: 'text-end', id: 'text_1' },
      ]),
    });

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'reasoning-model',
      prompt: { type: 'string', value: 'Think.' },
      outputReasoning: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.reasoning, 'Think first.');
    assert.deepEqual(result.commonOutputs['reasoning' as PortId], {
      type: 'string',
      value: 'Think first.',
    });
  });

  void it('excludes reasoning output when requested but the stream has no reasoning text', async () => {
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'Final answer' },
        { type: 'text-end', id: 'text_1' },
      ]),
    });

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'reasoning-model',
      prompt: { type: 'string', value: 'Think.' },
      outputReasoning: true,
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.reasoning, '');
    assert.deepEqual(result.commonOutputs['reasoning' as PortId], {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void it('forwards pipeline request-shaping options to the stream executor', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const responseOutput = { name: 'json' };
    const executeStream = createTextStreamExecutor({
      text: '{}',
      includeFinish: true,
      onArgs: (args) => {
        capturedArgs = args;
      },
    });

    await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-4o',
      prompt: { type: 'string', value: 'Use the lookup tool.' },
      maxTokens: 100,
      temperature: 0.4,
      topP: 0.8,
      topK: 20,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      stopSequences: ['END'],
      seed: 123,
      responseOutput,
      functions: [
        {
          name: 'lookup_weather',
          description: 'Looks up weather.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      ],
      toolChoice: {
        type: 'tool',
        toolName: 'lookup_weather',
      },
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.deepEqual(capturedArgs?.toolChoice, {
      type: 'tool',
      toolName: 'lookup_weather',
    });
    assert.equal(capturedArgs?.maxOutputTokens, 100);
    assert.equal(capturedArgs?.temperature, 0.4);
    assert.equal(capturedArgs?.topP, 0.8);
    assert.equal(capturedArgs?.topK, 20);
    assert.equal(capturedArgs?.presencePenalty, 0.2);
    assert.equal(capturedArgs?.frequencyPenalty, 0.3);
    assert.deepEqual(capturedArgs?.stopSequences, ['END']);
    assert.equal(capturedArgs?.seed, 123);
    assert.equal(capturedArgs?.output, responseOutput);
    assert.equal(capturedArgs?.maxRetries, 0);
  });

  void it('emits parsed object response output for structured response formats', async () => {
    const structuredOutput = {
      answer: 'Paris',
      confidence: 0.9,
    };
    const responseText = JSON.stringify(structuredOutput);
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: structuredOutput,
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.response, responseText);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'object',
      value: structuredOutput,
    });
    assert.equal((result.allMessages.at(-1) as any)?.message, responseText);
  });

  void it('falls back to parsing streamed text for structured response outputs from custom executors', async () => {
    const structuredOutput = { answer: 'Fallback' };
    const responseText = JSON.stringify(structuredOutput);
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
      ]),
    });

    const result = await runChatV2Pipeline({
      provider: 'custom',
      model: createMockModel(),
      modelId: 'custom-json-model',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'object',
      value: structuredOutput,
    });
  });

  void it('emits parsed scalar and array values for structured response formats', async () => {
    const booleanStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: 'true' },
        { type: 'text-end', id: 'text_1' },
      ]),
    });
    const stringArrayStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: '["alpha","beta"]' },
        { type: 'text-end', id: 'text_1' },
      ]),
    });

    const booleanResult = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream: booleanStream,
    });
    const stringArrayResult = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream: stringArrayStream,
    });

    assert.deepEqual(booleanResult.commonOutputs['response' as PortId], {
      type: 'boolean',
      value: true,
    });
    assert.deepEqual(stringArrayResult.commonOutputs['response' as PortId], {
      type: 'string[]',
      value: ['alpha', 'beta'],
    });
  });

  void it('de-duplicates repeated structured text blocks before fallback parsing', async () => {
    const structuredOutput = { movie: 'The Matrix', description: 'A sci-fi action film.' };
    const responseText = JSON.stringify(structuredOutput);
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
        { type: 'text-start', id: 'text_2' },
        { type: 'text-delta', id: 'text_2', text: responseText },
        { type: 'text-end', id: 'text_2' },
      ]),
      output: Promise.reject(new Error('No object generated: could not parse the response.')),
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.equal(result.response, responseText);
    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'object',
      value: structuredOutput,
    });
    assert.equal((result.allMessages.at(-1) as any)?.message, responseText);
  });

  void it('falls back to string response output when structured parsing fails', async () => {
    const responseText = 'not json';
    const executeStream: ChatV2StreamExecutor = async () => ({
      fullStream: mockStream([
        { type: 'text-start', id: 'text_1' },
        { type: 'text-delta', id: 'text_1', text: responseText },
        { type: 'text-end', id: 'text_1' },
      ]),
      output: Promise.reject(new Error('No object generated: could not parse the response.')),
    });

    const result = await runChatV2Pipeline({
      provider: 'openai',
      model: createMockModel(),
      modelId: 'gpt-5',
      prompt: { type: 'string', value: 'Answer as JSON.' },
      responseOutput: { name: 'json' },
      responseFormat: 'json',
      context: {
        signal: new AbortController().signal,
      },
      executeStream,
    });

    assert.deepEqual(result.commonOutputs['response' as PortId], {
      type: 'string',
      value: responseText,
    });
    assert.equal((result.allMessages.at(-1) as any)?.message, responseText);
  });
});
