import test from 'node:test';
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import {
  assertCaughtTextRequestFailure,
  assertRetryAttemptOutputs,
  createContext,
  createNode,
  installHttpCallNodeTestHooks,
} from './HttpCallNode.testUtils.js';

installHttpCallNodeTestHooks();
const nativeFetch = globalThis.fetch;
const url = 'https://example.com';

function observedResponse(
  status: number,
  text = 'unfinished',
  complete = false,
  onCancel: () => void | Promise<void> = () => {},
) {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (complete) controller.close();
    },
    cancel: onCancel,
  });
  const cancel = body.cancel.bind(body);
  body.cancel = (reason) => {
    cancellations++;
    return cancel(reason);
  };
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', 'x-attempt': String(status) },
  });
  return { response, cancellations: () => cancellations };
}

void test('discards every replaced response once and consumes the final response', async () => {
  const attempts = [observedResponse(503), observedResponse(503), observedResponse(200, 'ok', true)];
  let requests = 0;
  globalThis.fetch = async () => {
    if (requests > 0) assert.equal(attempts[requests - 1]!.cancellations(), 1);
    return attempts[requests++]!.response;
  };
  const result = await createNode({ url, retryOnNon200: true, retryOnNon200RepeatTimes: 2 }).process(
    {},
    createContext(),
  );
  assert.equal(requests, 3);
  assert.deepEqual(
    attempts.map((attempt) => attempt.cancellations()),
    [1, 1, 0],
  );
  assert.deepEqual(result.res_body, { type: 'string', value: 'ok' });
  assert.deepEqual(result.res_headers, {
    type: 'object[]',
    value: attempts.map(({ response }) => Object.fromEntries(response.headers.entries())),
  });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [503, 503, 200],
    requestFailedValues: [true, true, false],
    requestErrorParts: [[/503/], [/503/]],
  });
});

for (const catchRequestFailed of [false, true]) {
  void test(`discards the final rejected response (catch=${catchRequestFailed})`, async () => {
    const attempt = observedResponse(503);
    globalThis.fetch = async () => attempt.response;
    const running = createNode({ url, errorOnNon200: true, catchRequestFailed }).process({}, createContext());
    if (catchRequestFailed) {
      assertCaughtTextRequestFailure(await running, [/HTTP call returned non-2XX status code: 503/]);
    } else {
      await assert.rejects(running, /HTTP call returned non-2XX status code: 503/);
    }
    assert.equal(attempt.cancellations(), 1);
  });
}

for (const isBinaryOutput of [false, true]) {
  void test(`consumes an allowed final error body (binary=${isBinaryOutput})`, async () => {
    const discarded = observedResponse(503);
    const final = observedResponse(503, 'still unavailable', true);
    let requests = 0;
    globalThis.fetch = async () => (requests++ === 0 ? discarded.response : final.response);
    const result = await createNode({
      url,
      errorOnNon200: false,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 1,
      isBinaryOutput,
    }).process({}, createContext());
    assert.deepEqual(result[isBinaryOutput ? 'binary' : 'res_body'], {
      type: isBinaryOutput ? 'binary' : 'string',
      value: isBinaryOutput ? new TextEncoder().encode('still unavailable') : 'still unavailable',
    });
    assert.equal(discarded.cancellations(), 1);
    assert.equal(final.cancellations(), 0);
    assert.equal(final.response.bodyUsed, true);
  });
}

void test('discards before cooldown and does not retry after cancellation', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const discarded = Promise.withResolvers<void>();
  const attempt = observedResponse(503, 'unfinished', false, discarded.resolve);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return attempt.response;
  };
  const controller = new AbortController();
  const running = createNode({
    url,
    catchRequestFailed: true,
    retryOnNon200: true,
    retryOnNon200CooldownMs: 60_000,
  }).process({}, createContext({ signal: controller.signal }));
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await discarded.promise;
  controller.abort();
  await rejected;
  assert.equal(requests, 1);
  assert.equal(attempt.cancellations(), 1);
});

void test(
  'a network failure during retry preserves the error and does not wait for or repeat cleanup',
  { timeout: 3_000 },
  async () => {
    const attempt = observedResponse(503, 'unfinished', false, () => new Promise<void>(() => {}));
    let requests = 0;
    globalThis.fetch = async () => {
      if (requests++ === 0) return attempt.response;
      throw new TypeError('connection failed before headers');
    };
    const result = await createNode({
      url,
      retryOnNon200: true,
      retryOnNon200RepeatTimes: 4,
      catchRequestFailed: true,
    }).process({}, createContext());
    assert.equal(requests, 2);
    assert.equal(attempt.cancellations(), 1);
    assertRetryAttemptOutputs(result, {
      statusCodeValues: [503],
      requestFailedValues: [true, true],
      requestErrorParts: [[/503/], [/connection failed before headers/]],
    });
  },
);

void test(
  'cleanup failures and pending cancellation cannot replace or delay the original error',
  { timeout: 3_000 },
  async () => {
    for (const mode of ['throw', 'reject', 'pending', 'locked']) {
      const attempt = observedResponse(503);
      let calls = 0;
      Object.defineProperty(attempt.response.body, 'cancel', {
        value: () => {
          calls++;
          if (mode === 'throw') throw new Error('cleanup failure');
          if (mode === 'reject') return Promise.reject(new Error('cleanup failure'));
          return new Promise<void>(() => {});
        },
      });
      const reader = mode === 'locked' ? attempt.response.body!.getReader() : undefined;
      globalThis.fetch = async () => attempt.response;
      try {
        await assert.rejects(
          createNode({ url, errorOnNon200: true }).process({}, createContext()),
          /HTTP call returned non-2XX status code: 503/,
        );
        assert.equal(calls, mode === 'locked' ? 0 : 1, mode);
        assert.equal(attempt.response.body!.locked, mode === 'locked');
      } finally {
        reader?.releaseLock();
      }
    }
  },
);

void test('owns the response before metadata and failure callbacks can throw', async () => {
  for (const mode of ['metadata', 'retry-metadata', 'failure-callback']) {
    const attempt = observedResponse(503);
    const originalError = new Error(mode);
    if (mode !== 'failure-callback') {
      Object.defineProperty(attempt.response.headers, 'entries', {
        value: () => {
          throw originalError;
        },
      });
    }
    globalThis.fetch = async () => attempt.response;
    await assert.rejects(
      createNode({ url, errorOnNon200: true, retryOnNon200: mode === 'retry-metadata' }).process(
        {},
        {
          ...createContext(),
          setFailureOutputs: () => {
            throw originalError;
          },
        },
      ),
      (error) => error === originalError,
    );
    assert.equal(attempt.cancellations(), 1, mode);
  }
});

void test('does not discard an already consumed body when JSON parsing fails', async () => {
  const attempt = observedResponse(200, '{', true);
  attempt.response.headers.set('content-type', 'application/json');
  globalThis.fetch = async () => attempt.response;
  await assert.rejects(createNode({ url }).process({}, createContext()), SyntaxError);
  assert.equal(attempt.response.bodyUsed, true);
  assert.equal(attempt.cancellations(), 0);
});

void test('discards a partly read body after its reader releases the lock', async () => {
  const attempt = observedResponse(503);
  const reader = attempt.response.body!.getReader();
  await reader.read();
  reader.releaseLock();
  assert.equal(attempt.response.bodyUsed, true);
  globalThis.fetch = async () => attempt.response;
  await assert.rejects(createNode({ url, errorOnNon200: true }).process({}, createContext()), /503/);
  assert.equal(attempt.cancellations(), 1);
});

void test('preserves empty HEAD and 204 bodies, including the existing empty-JSON error', async () => {
  for (const status of [200, 204]) {
    for (const json of [false, true]) {
      globalThis.fetch = async () =>
        new Response(null, {
          status,
          headers: { 'content-type': json ? 'application/json' : 'text/plain' },
        });
      const running = createNode({ url, method: 'HEAD' }).process({}, createContext());
      if (json) await assert.rejects(running, SyntaxError);
      else assert.deepEqual((await running).res_body, { type: 'string', value: '' });
    }
  }
});

void test('discarding one invocation does not abort another or their shared workflow signal', async () => {
  let finishSlow!: () => void;
  const slowResponse = new Response(
    new ReadableStream({
      start(controller) {
        finishSlow = () => {
          controller.enqueue(new TextEncoder().encode('slow result'));
          controller.close();
        };
      },
    }),
  );
  const discarded = observedResponse(503);
  const controller = new AbortController();
  const context = createContext({ signal: controller.signal });
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.signal, controller.signal);
    return String(input).endsWith('/slow') ? slowResponse : discarded.response;
  };
  const slow = createNode({ url: `${url}/slow` }).process({}, context);
  try {
    await assert.rejects(createNode({ url, errorOnNon200: true }).process({}, context), /503/);
    assert.equal(discarded.cancellations(), 1);
    assert.equal(controller.signal.aborted, false);
  } finally {
    finishSlow();
  }
  assert.deepEqual((await slow).res_body, { type: 'string', value: 'slow result' });
});

function deadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Response did not close before fixture teardown')), 3_000);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

void test(
  'native Fetch releases unfinished responses on retry, failure, abort and truncation',
  { timeout: 20_000 },
  async (t) => {
    const unfinished: { response: ServerResponse; closed: Promise<void> }[] = [];
    let requests = 0;
    let mode = '';
    const server = createServer((_request, response) => {
      requests++;
      if (mode === 'retry' && requests === 3) {
        response.end('ok');
        return;
      }
      const closed = new Promise<void>((resolve) => response.once('close', resolve));
      unfinished.push({ response, closed });
      response.writeHead(mode === 'abort' || mode === 'truncated' ? 200 : 503, {
        'content-type': 'text/plain',
        'content-length': '1048576',
      });
      response.flushHeaders();
      response.write('partial');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const loopbackUrl = `http://127.0.0.1:${address.port}`;

    for (mode of ['retry', 'thrown', 'caught', 'abort', 'truncated']) {
      await t.test(mode, async () => {
        requests = 0;
        unfinished.length = 0;
        const controller = new AbortController();
        const reading = Promise.withResolvers<void>();
        globalThis.fetch = async (input, init) => {
          const response = await nativeFetch(input, init);
          const readText = response.text.bind(response);
          response.text = () => {
            const result = readText();
            reading.resolve();
            return result;
          };
          return response;
        };
        const running = createNode({
          url: loopbackUrl,
          retryOnNon200: mode === 'retry',
          retryOnNon200RepeatTimes: 2,
          errorOnNon200: true,
          catchRequestFailed: mode === 'caught' || mode === 'abort',
        }).process({}, createContext({ signal: controller.signal }));
        // Observe early failures while waiting for the read-start signal.
        void running.catch(() => undefined);
        try {
          if (mode === 'abort' || mode === 'truncated') {
            await deadline(reading.promise);
            if (mode === 'abort') controller.abort();
            else unfinished[0]!.response.destroy();
          }
          if (mode === 'retry') {
            assert.deepEqual((await running).res_body, { type: 'string', value: 'ok' });
          } else if (mode === 'caught') {
            assertCaughtTextRequestFailure(await running, [/503/]);
          } else {
            await assert.rejects(
              running,
              mode === 'thrown'
                ? /503/
                : {
                    name: mode === 'abort' ? 'AbortError' : 'TypeError',
                  },
            );
          }
          await deadline(Promise.all(unfinished.map(({ closed }) => closed)));
          assert.equal(requests, mode === 'retry' ? 3 : 1);
          assert.equal(unfinished.length, mode === 'retry' ? 2 : 1);
          assert.ok(unfinished.every(({ response }) => !response.writableFinished));
        } finally {
          // Assertions above must prove closure first. Abort only afterward to
          // clean up a failing fixture without leaking work into the next case.
          controller.abort();
          await running.catch(() => undefined);
        }
      });
    }
  },
);
