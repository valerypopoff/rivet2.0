import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { runChatV2Pipeline } from '../../../src/model/chat-v2/chatV2Pipeline.js';
import {
  isChatV2ProviderTimeoutError,
  type ChatV2Model,
  type ChatV2StreamPart,
  type RunChatV2PipelineOptions,
} from '../../../src/model/chat-v2/chatV2Types.js';

function baseOptions(overrides: Partial<RunChatV2PipelineOptions>): RunChatV2PipelineOptions {
  return {
    provider: 'custom',
    model: {} as ChatV2Model,
    modelId: 'deadline-model',
    prompt: { type: 'string', value: 'Hello' },
    context: { signal: new AbortController().signal },
    ...overrides,
  };
}

describe('Chat V2 provider deadlines', () => {
  it('actively aborts a timed-out generate request and never applies non-200 retries', async () => {
    let calls = 0;
    let providerWasAborted = false;
    let waitedForPendingDiagnostics: boolean | undefined;
    const options = baseOptions({
      emitPartialOutputs: false,
      firstOutputTimeoutMs: 15,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 3,
      retryOnNon200CooldownMs: 1,
      responseBodyCapture: {
        bodies: [],
        capture: () => undefined,
        flush: ({ waitForPending } = {}) => {
          waitedForPendingDiagnostics = waitForPending;
          return waitForPending === false ? Promise.resolve() : new Promise<void>(() => undefined);
        },
      },
      executeGenerate: (args) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          args.abortSignal?.addEventListener(
            'abort',
            () => {
              providerWasAborted = true;
              const error = new Error('generic provider abort');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    });

    await assert.rejects(
      () => runChatV2Pipeline(options),
      (error) => isChatV2ProviderTimeoutError(error) && error.timeoutKind === 'first-output',
    );
    assert.equal(calls, 1);
    assert.equal(providerWasAborted, true);
    assert.equal(waitedForPendingDiagnostics, false);
  });

  it('times out metadata-only streams and does not wait for a hanging iterator return', async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const never = new Promise<IteratorResult<ChatV2StreamPart>>(() => undefined);
    const startedAt = Date.now();
    const options = baseOptions({
      emitPartialOutputs: true,
      firstOutputTimeoutMs: 15,
      streamInactivityTimeoutMs: 15,
      executeStream: () => ({
        fullStream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                nextCalls += 1;
                return nextCalls === 1
                  ? Promise.resolve({
                      done: false as const,
                      value: { type: 'start' } as unknown as ChatV2StreamPart,
                    })
                  : never;
              },
              return: () => {
                returnCalls += 1;
                return new Promise<IteratorResult<ChatV2StreamPart>>(() => undefined);
              },
            };
          },
        },
      }),
    });

    await assert.rejects(
      () => runChatV2Pipeline(options),
      (error) => isChatV2ProviderTimeoutError(error) && error.timeoutKind === 'first-output',
    );
    assert.equal(returnCalls, 1);
    assert.ok(Date.now() - startedAt < 500, 'hanging iterator cleanup must not delay fallback');
  });

  it('bounds post-stream finalization promises after useful output', async () => {
    let providerWasAborted = false;
    const options = baseOptions({
      emitPartialOutputs: true,
      firstOutputTimeoutMs: 20,
      streamInactivityTimeoutMs: 15,
      executeStream: (args) => {
        args.abortSignal?.addEventListener('abort', () => {
          providerWasAborted = true;
        });
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'ok' } as ChatV2StreamPart;
          })(),
          usage: new Promise(() => undefined),
        };
      },
    });

    await assert.rejects(
      () => runChatV2Pipeline(options),
      (error) => isChatV2ProviderTimeoutError(error) && error.timeoutKind === 'stream-inactivity',
    );
    assert.equal(providerWasAborted, true);
  });

  it('bounds hostile generate-result metadata promises', async () => {
    const options = baseOptions({
      emitPartialOutputs: false,
      firstOutputTimeoutMs: 20,
      streamInactivityTimeoutMs: 15,
      executeGenerate: async () => ({
        text: 'ok',
        totalUsage: new Promise(() => undefined),
      }),
    });

    await assert.rejects(
      () => runChatV2Pipeline(options),
      (error) => isChatV2ProviderTimeoutError(error) && error.timeoutKind === 'stream-inactivity',
    );
  });
});
