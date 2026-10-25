import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { classifierProviders, getClassifierProvider } from '../../../src/model/classifier/providers.js';
import { ClassifierEvaluateNodeImpl } from '../../../src/model/nodes/ClassifierEvaluateNode.js';
import { InMemoryRivetLLMProfileHealthStore } from '../../../src/model/chat-v2/llmProfileHealthStore.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const question = { questionId: 'q', type: 'noul' as const, instructions: 'Check evidence' };
const args = (model: string) => ({
  model,
  apiKey: 'private-key',
  state: 'Evidence',
  questions: [question],
  signal: new AbortController().signal,
  timeoutMs: 30_000,
});

test('Response diagnostics cannot repair invalid answers or mutate successful results', async () => {
  const provider = getClassifierProvider('perplexity');
  const body = {
    model: provider.defaultModel,
    answers: { q: { type: 'noul', noul: 0.8 } },
    usage: { input_tokens: 1000, output_tokens: 0 },
  };
  const result = await provider.evaluate({
    ...args(provider.defaultModel),
    fetchImplementation: async () => Response.json(body),
    onResponseBody: (diagnostic) => {
      (diagnostic as any).answers.q.noul = 999;
      (diagnostic as any).usage.input_tokens = 999;
    },
  });
  assert.deepEqual(result.responseBody, body);
  assert.equal((result.response.answers.q as any).noul, 0.8);
  assert.equal(result.response.usage.input_tokens, 1000);
  await assert.rejects(
    provider.evaluate({
      ...args(provider.defaultModel),
      fetchImplementation: async () => Response.json({}),
      onResponseBody: (diagnostic) => Object.assign(diagnostic as object, body),
    }),
    /invalid response shape/,
  );
});

test('Cancellation during rejected body capture preserves the cancellation reason', async () => {
  const provider = getClassifierProvider('perplexity');
  const controller = new AbortController();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const reason = new Error('operator canceled');
  const run = provider.evaluate({
    ...args(provider.defaultModel),
    signal: controller.signal,
    onResponseBody: () => assert.fail('A canceled, incomplete body is not diagnostic evidence'),
    fetchImplementation: async () =>
      new Response(
        new ReadableStream({
          pull() {
            started();
          },
        }),
        { status: 400 },
      ),
  });
  const rejected = assert.rejects(run, (error) => error === reason);
  await reading;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await rejected;
});

for (const observer of ['request', 'success'] as const) {
  test(`Cancellation from the ${observer} observer cannot dispatch or return a late success`, async () => {
    const provider = getClassifierProvider('perplexity');
    const controller = new AbortController();
    const reason = new Error('operator canceled');
    let calls = 0;
    await assert.rejects(
      provider.evaluate({
        ...args(provider.defaultModel),
        signal: controller.signal,
        onRequestBody: observer === 'request' ? () => controller.abort(reason) : undefined,
        onAttempt:
          observer === 'success'
            ? (event) => {
                if (event.outcome === 'success') controller.abort(reason);
              }
            : undefined,
        fetchImplementation: async () => {
          calls++;
          return Response.json({
            model: provider.defaultModel,
            answers: { q: { type: 'noul', noul: 0.8 } },
            usage: { input_tokens: 1000, output_tokens: 0 },
          });
        },
      }),
      (error) => error === reason,
    );
    assert.equal(calls, observer === 'request' ? 0 : 1);
  });
}

test('Inline status suppression cannot swallow cancellation during diagnostic capture', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull() {
          started();
        },
      }),
      { status: 400 },
    );
  const node = ClassifierEvaluateNodeImpl.create();
  const controller = new AbortController();
  Object.assign(node.data, { provider: 'perplexity', timeoutMs: 50, errorOnNon200: false, outputResponseBody: true });
  const run = new ClassifierEvaluateNodeImpl(node).process(
    {
      state: { type: 'string', value: 'Evidence' },
      question1: { type: 'object', value: question },
    },
    {
      executor: 'nodejs',
      signal: controller.signal,
      settings: { classifierProviders: { perplexity: { apiKey: 'private-key' } } },
    } as InternalProcessContext,
  );
  const rejected = assert.rejects(run, /Stopped by user/);
  await reading;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('Stopped by user'));
  await rejected;
});

test('Requests without a deadline keep long Retry-After waits cancellable without timer overflow', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '1e100' } });
  };
  const run = getClassifierProvider('perplexity').evaluate({
    apiKey: 'test',
    model: 'pplx-decider-v1.1-27b',
    questions: [question],
    state: 'Evidence',
    signal: controller.signal,
  });
  const rejected = assert.rejects(run, /cancel|Stopped by user/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(2_147_483_647 - 5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'Crossing a timer boundary must not dispatch a retry');
  controller.abort(new Error('Stopped by user'));
  await rejected;
  assert.equal(calls, 1);
});

for (const source of ['Retry-After', 'configured cooldown'] as const) {
  void test(`Unbounded ${source} waits preserve delays longer than one timer`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const timerLimit = 2_147_483_647;
    const delayMs = timerLimit + 2000;
    let calls = 0;
    const run = getClassifierProvider('perplexity').evaluate({
      apiKey: 'test',
      model: 'pplx-decider-v1.1-27b',
      questions: [question],
      state: 'Evidence',
      signal: new AbortController().signal,
      retryOnNon200: true,
      retryOnNon200CooldownMs: delayMs,
      fetchImplementation: async () => {
        if (++calls === 1)
          return source === 'Retry-After'
            ? new Response('', { status: 429, headers: { 'Retry-After': `${delayMs / 1000}` } })
            : new Response('', { status: 503 });
        return Response.json({
          model: 'pplx-decider-v1.1-27b',
          answers: { q: { type: 'noul', noul: 0.8 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'A long cooldown must not overflow into an immediate retry');
    t.mock.timers.tick(timerLimit - 5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'A long cooldown must not be truncated to the timer limit');
    t.mock.timers.tick(1999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal((await run).response.answers.q?.type, 'noul');
    assert.equal(calls, 2);
  });
}

test('Opt-in rejected response diagnostics are bounded and preserve the original HTTP failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let readStarted!: () => void;
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let cancellations = 0;
  let captured = false;
  const provider = getClassifierProvider('perplexity');
  const run = provider.evaluate({
    ...args(provider.defaultModel),
    onResponseBody: () => {
      captured = true;
    },
    fetchImplementation: async () =>
      new Response(
        new ReadableStream({
          pull() {
            readStarted();
          },
          cancel() {
            cancellations++;
          },
        }),
        { status: 400 },
      ),
  });
  const rejected = assert.rejects(run, (error: any) => error.kind === 'http' && error.statusCode === 400);
  await reading;
  // Let the HTTP boundary receive the response and install its diagnostic timer.
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(captured, false, 'Never fabricate a missing response');
  assert.equal(cancellations, 1);
});

test('Every provider rejects invalid root State before HTTP or attempt observation', async () => {
  for (const provider of classifierProviders) {
    for (const state of [null, true, 42, undefined]) {
      await assert.rejects(
        provider.evaluate({
          ...args(provider.defaultModel),
          state: state as any,
          onAttempt: () => assert.fail('Invalid shared evidence must not start a candidate'),
          fetchImplementation: async () => assert.fail('Invalid shared evidence must not reach HTTP'),
        }),
        /State must be text, a JSON object or an array/,
      );
    }
  }
});

for (const id of ['openrouter', 'perplexity', 'subq']) {
  const provider = getClassifierProvider(id);
  test(`${provider.label} does not retry permanent request rejections or expose rejected bodies`, async () => {
    for (const status of [400, 401, 402, 403, 413, 422]) {
      let calls = 0;
      let cancellations = 0;
      const events: unknown[] = [];
      await assert.rejects(
        provider.evaluate({
          ...args(provider.defaultModel),
          retryOnNon200: true,
          retryOnNon200RepeatTimes: 3,
          onAttempt: (event) => events.push(event),
          fetchImplementation: async () => {
            calls++;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('private-key'));
                },
                cancel() {
                  cancellations++;
                },
              }),
              { status },
            );
          },
        }),
        (error: any) => error.kind === 'http' && error.statusCode === status && !error.message.includes('private-key'),
      );
      assert.equal(calls, 1, `HTTP ${status} must not be retried`);
      assert.equal(cancellations, 1);
      assert.doesNotMatch(JSON.stringify(events), /private-key/);
    }
  });

  test(`${provider.label} permanent access/credit/payload rejection allows fallback without suspending the profile`, async () => {
    for (const status of [401, 402, 403, 413]) {
      const store = new InMemoryRivetLLMProfileHealthStore();
      const calls: string[] = [];
      globalThis.fetch = async (url, init) => {
        calls.push(String(url));
        if (!String(url).includes('typesafe.ai')) return new Response('private-key', { status });
        const body = JSON.parse(String(init?.body));
        return Response.json({
          model: body.model,
          answers: { q: { type: 'noul', noul: 0.8 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        });
      };
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, {
        configurationMode: 'profile',
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 3,
        outputClassifierAttempts: true,
      });
      const result = await new ClassifierEvaluateNodeImpl(node).process(
        {
          question1: { type: 'object', value: question },
          classifierProfile: {
            type: 'classifier-config[]',
            value: [id, 'jev'].map((providerId) => ({
              version: 1,
              configuration: {
                provider: providerId,
                model: getClassifierProvider(providerId).defaultModel,
                enableCircuitBreaker: providerId === id,
                circuitBreakerFailureThreshold: 1,
              },
              credential: { value: 'private-key' },
              sourceNodeId: `profile-${providerId}`,
            })),
          },
        },
        {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: {},
          project: { metadata: { id: 'project' }, graphs: {} },
          llmProfileHealthStore: store,
        } as InternalProcessContext,
      );
      assert.equal(calls.length, 2);
      assert.equal(store.list()[0]!.failureCount, 0);
      assert.equal(store.list()[0]!.state, 'closed');
      assert.equal(result.answers!.type, 'object');
      assert.doesNotMatch(JSON.stringify(result.classifierAttempts), /private-key/);
    }
  });

  test(`${provider.label} cancellation discards a late transport response without retrying`, async () => {
    const controller = new AbortController();
    let resolveResponse!: (response: Response) => void;
    let started!: () => void;
    let cancelled!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancelledPromise = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let calls = 0;
    const pending = provider.evaluate({
      ...args(provider.defaultModel),
      signal: controller.signal,
      fetchImplementation: () => {
        calls++;
        started();
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
      },
    });
    await startedPromise;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    resolveResponse(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled();
          },
        }),
      ),
    );
    await cancelledPromise;
    assert.equal(calls, 1);
  });
}
