import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, createServer, request as createRequest } from 'node:http';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';

import express from 'express';
import type { Request, Response } from 'express';

import {
  closeResponseConnectionAfterFlush,
  createAdmittedJsonBodyParser,
  createAdmittedBodyParser,
  HttpBodyAdmissionController,
  MAX_CONCURRENT_HTTP_BODY_PARSERS,
  retainParsedRequestBody,
  sendRejectedBodyResponse,
  type BodyReservation,
} from '../middleware/body-admission.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseBoundedBody } from '../middleware/body-reader.js';
import { createJsonBodyParser } from '../middleware/body-parsers.js';
import { configureStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';
import { listenTestServer } from './helpers/http-server-harness.js';

test('JSON media admission matches the parser rather than accepting arbitrary +json types', async () => {
  const app = express();
  let handled = 0;
  app.post('/input', createJsonBodyParser(() => 128), (req, res) => {
    handled += 1;
    res.json(req.body);
  });
  app.use((error: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).json({ code: error.code });
  });
  const server = await startTestServer(app);
  try {
    for (const type of ['text/custom+json', 'image/custom+json', 'application/bad/type+json']) {
      const rejected = await requestBody(`${server.baseUrl}/input`, {
        headers: { 'content-type': type }, body: '{"value":1}',
      });
      assert.equal(rejected.status, 415);
      assert.equal(rejected.headers.connection, 'close');
      assert.deepEqual(JSON.parse(rejected.body), { code: 'unsupported_media_type' });
      assert.equal(handled, 0, 'unsupported representations must not reach the handler');
    }
    const response = await requestBody(`${server.baseUrl}/input`, {
      headers: { 'content-type': 'application/custom+json' }, body: '{"value":1}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { value: 1 });
    assert.equal(handled, 1);
  } finally { await server.close(); }
});

test('a reader rejects an already destroyed request without waiting for its receive deadline', async () => {
  const req = new PassThrough() as unknown as Request;
  req.headers = { 'content-type': 'application/json' };
  req.destroy();
  const cancellation = new AbortController();
  try {
    const result = await new Promise<unknown>((resolve) => {
      parseBoundedBody(req, {} as Response, resolve, 128, cancellation.signal, () => {});
    });
    assert.equal((result as { status?: number } | undefined)?.status, 400);
    assert.equal(req.listenerCount('data'), 0);
  } finally { cancellation.abort(new Error('test cleanup')); }
});

function requestWithHeaders(headers: Record<string, string | undefined>): Request {
  return Object.assign(new EventEmitter(), {
    pause() { return this; },
    resume() { return this; },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  }) as Request;
}

function reserve(controller: HttpBodyAdmissionController, headers: Record<string, string> = {}, limit = 100): BodyReservation {
  const reservation = controller.admit(requestWithHeaders(headers), limit);
  assert.ok(!(reservation instanceof Promise), 'fixture requires an immediate reservation');
  return reservation;
}

async function startTestServer(app: express.Express) {
  const server = createServer(app);
  return { ...await listenTestServer(server), server };
}

async function requestBody(
  url: string,
  options: { agent?: Agent; body?: Buffer | string; headers?: Record<string, string>; leaveOpen?: boolean; method?: string } = {},
): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; localPort: number | undefined; status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let localPort: number | undefined;
    const request = createRequest({
      agent: options.agent,
      hostname: target.hostname,
      method: options.method ?? 'POST',
      path: target.pathname,
      port: target.port,
      headers: options.headers,
      signal: AbortSignal.timeout(5_000),
    });
    request.once('error', reject);
    request.once('socket', (socket) => {
      const rememberPort = () => {
        localPort = socket.localPort;
      };
      if (socket.connecting) {
        socket.once('connect', rememberPort);
      } else {
        rememberPort();
      }
    });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        if (options.leaveOpen) request.destroy();
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          localPort,
          status: response.statusCode ?? 0,
        });
      });
    });
    if (options.body != null) request.write(options.body);
    if (!options.leaveOpen) request.end();
  });
}

test('HTTP JSON body admission bounds concurrent reservations and releases them exactly once', () => {
  const controller = new HttpBodyAdmissionController({ maxQueuedRequests: 0 });
  const reservations = Array.from({ length: MAX_CONCURRENT_HTTP_BODY_PARSERS }, () =>
    reserve(controller, { 'content-length': '32' }),
  );

  assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_HTTP_BODY_PARSERS);
  assert.throws(() => controller.admit(requestWithHeaders({ 'content-length': '32' }), 100), { status: 503 });

  const first = reservations[0];
  assert.ok(first);
  first.release();
  first.release();
  assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_HTTP_BODY_PARSERS - 1);
  reservations.push(reserve(controller, { 'content-length': '32' }));
  reservations.forEach((reservation) => reservation.release());
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('reader waiters are FIFO, bounded, cancellable, and do not consume byte reservations', async () => {
  const controller = new HttpBodyAdmissionController({ maxQueuedRequests: 2 });
  const held = Array.from({ length: 4 }, () => reserve(controller, { 'content-length': '2' }));
  const first = controller.admit(requestWithHeaders({ 'content-length': '3' }), 100);
  assert.ok(first instanceof Promise);
  const abort = new AbortController();
  const cancelled = controller.admit(requestWithHeaders({ 'content-length': '4' }), 100, { signal: abort.signal });
  assert.ok(cancelled instanceof Promise);
  const cancellation = assert.rejects(cancelled, /cancel waiter/);
  assert.equal(controller.getSnapshot().reservedBytes, 8);
  assert.equal(controller.getSnapshot().queuedRequests, 2);
  assert.throws(() => controller.admit(requestWithHeaders({}), 100), { status: 503 });
  abort.abort(new Error('cancel waiter'));
  await cancellation;
  held[0]!.release();
  const last = controller.admit(requestWithHeaders({ 'content-length': '5' }), 100);
  assert.ok(last instanceof Promise, 'new arrival must not bypass the first waiter');
  const admittedFirst = await first;
  assert.equal(controller.getSnapshot().reservedBytes, 9);
  assert.equal(controller.getSnapshot().queuedRequests, 1);
  admittedFirst.release();
  const admittedLast = await last;
  held.forEach((reservation) => reservation.release());
  admittedLast.release();
  assert.equal(controller.getSnapshot().queuedRequests, 0);
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('the default queue holds 64 requests for at most one second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const controller = new HttpBodyAdmissionController({ now: () => now });
  const held = Array.from({ length: 4 }, () => reserve(controller));
  const cancellations = Array.from({ length: 64 }, () => new AbortController());
  const rejected = cancellations.map((cancellation) => {
    const waiting = controller.admit(requestWithHeaders({}), 100, { signal: cancellation.signal });
    assert.ok(waiting instanceof Promise);
    return assert.rejects(waiting, { status: 503, code: 'body_capacity_exhausted', retryAfterSeconds: 1 });
  });
  try {
    assert.equal(controller.getSnapshot().reservedBytes, 400);
    assert.throws(() => controller.admit(requestWithHeaders({}), 100), { status: 503 });
    now = 999;
    t.mock.timers.tick(999);
    assert.equal(controller.getSnapshot().queuedRequests, 64);
    now = 1000;
    t.mock.timers.tick(1);
    assert.equal(controller.getSnapshot().queuedRequests, 0);
    await Promise.all(rejected);
    assert.equal(controller.getSnapshot().reservedBytes, 400, 'expiry must leave active readers alone');
  } finally {
    cancellations.forEach((cancellation) => cancellation.abort());
    held.forEach((reservation) => reservation.release());
    await Promise.allSettled(rejected);
  }
});

test('queued byte budgets are rechecked without blocking a smaller waiter', async () => {
  const controller = new HttpBodyAdmissionController();
  const held = Array.from({ length: 4 }, () => reserve(controller, { 'content-length': '2' }));
  const mib = 1024 * 1024;
  const first = controller.admit(requestWithHeaders({}), 700 * mib);
  const second = controller.admit(requestWithHeaders({}), 800 * mib);
  const small = controller.admit(requestWithHeaders({ 'content-length': '2' }), 100);
  const rejected = assert.rejects(Promise.resolve(second), { status: 503, code: 'body_capacity_exhausted' });
  held[0]!.release(); held[1]!.release();
  const firstReservation = await first;
  const smallReservation = await small;
  await rejected;
  assert.equal(controller.getSnapshot().activeParsers, 4);
  assert.throws(() => controller.admit(requestWithHeaders({}), 800 * mib), { status: 503 });
  held.forEach((reservation) => reservation.release());
  firstReservation.release(); smallReservation.release();
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('deadline checks preserve the first expiry when timer callbacks are delayed', async (t) => {
  for (const receiveFirst of [false, true]) {
    for (const trigger of ['boundary', 'both expired', 'receive signal', 'timer']) {
      await t.test(`${receiveFirst ? 'receive' : 'queue'} first: ${trigger}`, async (child) => {
        child.mock.timers.enable({ apis: ['setTimeout'] });
        const metrics = configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
        child.after(resetStudioMetricsForTests);
        let now = 0;
        const controller = new HttpBodyAdmissionController({ now: () => now, waitMs: 100 });
        const held = Array.from({ length: 4 }, () => reserve(controller));
        const cancellation = new AbortController();
        const waiting = controller.admit(requestWithHeaders({}), 100, {
          receiveDeadline: receiveFirst ? 50 : 200,
          signal: cancellation.signal,
        });
        assert.ok(waiting instanceof Promise);
        const rejected = assert.rejects(waiting, {
          status: receiveFirst ? 408 : 503,
          code: receiveFirst ? 'body_receive_timeout' : 'body_capacity_exhausted',
        });
        now = trigger === 'boundary' ? (receiveFirst ? 50 : 100) : 300;
        if (trigger === 'receive signal') {
          cancellation.abort(Object.assign(new Error('receive timeout'), { status: 408, code: 'body_receive_timeout' }));
        }
        if (trigger === 'timer') child.mock.timers.tick(now);
        else held[0]!.release();
        try { await rejected; } finally { held.forEach((reservation) => reservation.release()); }
        assert.equal(controller.getSnapshot().queuedRequests, 0);
        assert.equal(controller.getSnapshot().reservedBytes, 0);
        const outcome = receiveFirst ? 'receive_timeout' : 'wait_expired';
        assert.ok(metrics.render().split('\n').includes(
          `rivet_http_body_admission_wait_seconds_count{outcome="${outcome}",profile="control"} 1`,
        ));
      });
    }
  }
});

test('invalid admission limits are rejected at construction', () => {
  for (const options of [{ maxQueuedRequests: -1 }, { maxQueuedRequests: Infinity }, { waitMs: NaN }, { waitMs: 0 }]) {
    assert.throws(() => new HttpBodyAdmissionController(options), /queue limits/);
  }
});

test('decoded byte finalization only releases verified unused allowance once', () => {
  const controller = new HttpBodyAdmissionController();
  const reservation = reserve(controller);
  reservation.retain();
  for (const invalid of [-1, 101, NaN, 1.2]) assert.throws(() => reservation.finalizeDecodedBytes(invalid));
  assert.equal(controller.getSnapshot().reservedBytes, 100);
  reservation.finalizeDecodedBytes(2);
  reservation.finalizeDecodedBytes(2);
  assert.throws(() => reservation.finalizeDecodedBytes(1), /already finalized/);
  assert.equal(controller.getSnapshot().reservedBytes, 2);
  reservation.releaseParserSlot(); reservation.release(); reservation.release();
  assert.equal(controller.getSnapshot().reservedBytes, 0);
  assert.equal(controller.getSnapshot().retainedBodies, 0);
});

test('queued parser resumes in its own context and a finished response never starts parsing', async () => {
  const controller = new HttpBodyAdmissionController();
  const held = Array.from({ length: 4 }, () => reserve(controller));
  const context = new AsyncLocalStorage<string>();
  const observed: Array<string | undefined> = [];
  const parser = createAdmittedJsonBodyParser({
    controller, getLimitBytes: () => 100,
    parse: (_req, _res, next, _limit, _signal, received) => {
      observed.push(context.getStore()); received(2); next();
    },
  });
  const req = requestWithHeaders({ 'content-type': 'application/json', 'content-length': '2' });
  const res = new EventEmitter() as Response;
  const completed = new Promise<void>((resolve, reject) => context.run('waiting request', () => {
    parser(req, res, (error) => {
      if (error) { reject(error); return; }
      observed.push(context.getStore());
      res.emit('finish'); resolve();
    });
  }));
  const closed = new EventEmitter() as Response;
  parser(requestWithHeaders({ 'content-type': 'application/json' }), closed, () => assert.fail('closed waiter ran'));
  Object.assign(closed, { writableEnded: true });
  closed.emit('finish');
  context.run('releasing request', () => held[0]!.release());
  await completed;
  assert.deepEqual(observed, ['waiting request', 'waiting request']);
  held.forEach((reservation) => reservation.release());
  assert.equal(controller.getSnapshot().queuedRequests, 0);
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('a response finishing after a queued grant releases the reservation without parsing', async (t) => {
  const controller = new HttpBodyAdmissionController();
  const held = Array.from({ length: 4 }, () => reserve(controller));
  const res = new EventEmitter() as Response;
  const admit = controller.admit.bind(controller);
  t.mock.method(controller, 'admit', (...args: Parameters<typeof admit>) => {
    const result = admit(...args);
    if (result instanceof Promise) void result.then(() => {
      Object.assign(res, { writableEnded: true });
      res.emit('finish');
    });
    return result;
  });
  const parser = createAdmittedJsonBodyParser({
    controller, getLimitBytes: () => 100,
    parse: () => assert.fail('finished response must not start parsing'),
  });
  try {
    parser(requestWithHeaders({ 'content-type': 'application/json' }), res,
      () => assert.fail('finished response must not start a handler'));
    assert.equal(controller.getSnapshot().queuedRequests, 1);
    held[0]!.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getSnapshot().queuedRequests, 0);
    assert.equal(controller.getSnapshot().activeParsers, 3);
    assert.equal(controller.getSnapshot().reservedBytes, 300);
  } finally { held.forEach((reservation) => reservation.release()); }
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('receipt ends its deadline but retains the full allowance until parsing settles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const succeeds of [true, false]) {
    const controller = new HttpBodyAdmissionController();
    let finish!: (error?: Error) => void;
    let signal!: AbortSignal;
    const parser = createAdmittedJsonBodyParser({
      controller, getLimitBytes: () => 100, receiveTimeoutMs: 10,
      parse: (_req, _res, next, _limit, cancellation, received) => {
        signal = cancellation; received(2); finish = next;
      },
    });
    const res = new EventEmitter() as Response;
    let outcome: unknown;
    parser(requestWithHeaders({ 'content-type': 'application/json' }), res, (error) => { outcome = error; });
    assert.equal(controller.getSnapshot().reservedBytes, 100);
    t.mock.timers.tick(20);
    assert.equal(signal.aborted, false, 'receipt must cancel the receive deadline even while parsing is pending');
    finish(succeeds ? undefined : new Error('invalid input'));
    assert.equal(controller.getSnapshot().reservedBytes, succeeds ? 2 : 0);
    assert.equal(Boolean(outcome), !succeeds);
    res.emit('finish');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
  }
});

test('small gzip and split-upload bursts admit all inputs before long handlers finish', { timeout: 10000 }, async (t) => {
  for (const split of [false, true]) {
    // Exercise byte-accounting and burst recovery, not the speed of a busy CI host.
    const controller = new HttpBodyAdmissionController({ waitMs: 30_000 });
    let allQueued!: () => void;
    const queued = new Promise<void>((resolve) => { allQueued = resolve; });
    const admit = controller.admit.bind(controller);
    t.mock.method(controller, 'admit', (...args: Parameters<typeof admit>) => {
      const result = admit(...args);
      if (controller.getSnapshot().queuedRequests === 28) allQueued();
      return result;
    });
    let entered = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let allEntered!: () => void;
    const ready = new Promise<void>((resolve) => { allEntered = resolve; });
    const app = express();
    app.post('/input', createAdmittedJsonBodyParser({
      controller, getLimitBytes: () => 100 * 1024 * 1024, parse: parseBoundedBody,
    }), asyncHandler(async (_req, res) => {
      if (++entered === 32) allEntered();
      await hold; res.sendStatus(204);
    }));
    app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
      res.status(error.status ?? 500).end();
      allEntered(); // Fail the assertions below instead of waiting for the test timeout.
    });
    const server = await startTestServer(app);
    const body = split ? Buffer.from('{}') : gzipSync(Buffer.from('{}'));
    const requests: ReturnType<typeof createRequest>[] = [];
    const results = Array.from({ length: 32 }, () => new Promise<number>((resolve, reject) => {
      const req = createRequest(`${server.baseUrl}/input`, { method: 'POST', signal: t.signal, headers: {
        'content-type': 'application/json', 'content-length': body.length,
        ...(split ? {} : { 'content-encoding': 'gzip' }),
      } }, (res) => {
        res.once('error', reject);
        res.resume(); res.once('end', () => resolve(res.statusCode!));
      });
      requests.push(req); req.on('error', reject);
      if (split) req.write(body.subarray(0, 1)); else req.end(body);
    }));
    const allResults = Promise.all(results);
    void allResults.catch(() => {});
    try {
      if (split) {
        await Promise.race([queued, allResults]);
        requests.forEach((req) => req.end(body.subarray(1)));
      }
      await Promise.race([ready, allResults]);
      assert.equal(entered, 32);
      assert.equal(controller.getSnapshot().activeParsers, 0);
      assert.equal(controller.getSnapshot().queuedRequests, 0);
      assert.equal(controller.getSnapshot().reservedBytes, 64);
      release();
      assert.ok((await allResults).every((status) => status === 204));
      assert.equal(controller.getSnapshot().reservedBytes, 0);
    } finally {
      release(); requests.forEach((req) => req.destroy());
      await Promise.allSettled(results); await server.close();
    }
  }
});

test('HTTP JSON body admission frees parsing slots while retaining the parsed body reservation', () => {
  const controller = new HttpBodyAdmissionController();
  const retained = reserve(controller, { 'content-length': '32' });
  assert.ok(retained);

  retained.retain();
  retained.releaseParserSlot();
  assert.deepEqual(controller.getSnapshot(), {
    activeParsers: 0,
    maxActiveParsers: MAX_CONCURRENT_HTTP_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 32,
    retainedBodies: 1,
    queuedRequests: 0,
    maxQueuedRequests: 64,
  });

  const parsingReservations = Array.from({ length: MAX_CONCURRENT_HTTP_BODY_PARSERS }, () =>
    reserve(controller, { 'content-length': '32' }),
  );
  retained.release();
  assert.equal(controller.getSnapshot().retainedBodies, 0);
  assert.equal(controller.getSnapshot().reservedBytes, 32 * MAX_CONCURRENT_HTTP_BODY_PARSERS);
  parsingReservations.forEach((reservation) => reservation.release());
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('admitted JSON parsing releases its parser slot before a long-running handler retains the body', () => {
  const controller = new HttpBodyAdmissionController();
  const parser = createAdmittedJsonBodyParser({
    controller,
    getLimitBytes: () => 100,
    parse: (_req, _res, next) => next(),
  });
  const req = requestWithHeaders({
    'content-length': '32',
    'content-type': 'application/json',
  });
  const res = new EventEmitter() as Response;
  let releaseBody: (() => void) | undefined;

  parser(req, res, () => {
    releaseBody = retainParsedRequestBody(req);
  });

  assert.deepEqual(controller.getSnapshot(), {
    activeParsers: 0,
    maxActiveParsers: MAX_CONCURRENT_HTTP_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 32,
    retainedBodies: 1,
    queuedRequests: 0,
    maxQueuedRequests: 64,
  });

  releaseBody?.();
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('HTTP JSON body admission reserves the decoded limit for compressed or unknown-size requests', () => {
  const controller = new HttpBodyAdmissionController();
  const compressed = reserve(
    controller,
    // The parser limit applies after decompression, so a wire payload may be
    // larger than the decoded JSON it represents.
    { 'content-encoding': 'gzip', 'content-length': '101' },
    100,
  );
  assert.ok(compressed);
  assert.equal(controller.getSnapshot().reservedBytes, 100);
  compressed.release();

  const unknownLength = reserve(controller);
  assert.ok(unknownLength);
  assert.equal(controller.getSnapshot().reservedBytes, 100);
  unknownLength.release();
});

test('HTTP JSON body admission rejects declared route-limit violations before reading the body', () => {
  const controller = new HttpBodyAdmissionController();
  assert.throws(
    () => controller.admit(requestWithHeaders({ 'content-length': '101' }), 100),
    (error: Error & { closeConnection?: boolean; status?: number }) =>
      error.status === 413 && error.closeConnection === true,
  );
  assert.deepEqual(controller.getSnapshot(), {
    activeParsers: 0,
    maxActiveParsers: MAX_CONCURRENT_HTTP_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 0,
    retainedBodies: 0,
    queuedRequests: 0,
    maxQueuedRequests: 64,
  });
});

test('admitted parsers enforce declared and decoded limits and count each rejection once', async (t) => {
  const metrics = configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  t.after(resetStudioMetricsForTests);
  const controller = new HttpBodyAdmissionController();
  const app = express();
  app.post(
    '/input',
    createAdmittedJsonBodyParser({
      controller,
      getLimitBytes: () => 32,
      parse: parseBoundedBody,
    }),
    (_req, res) => res.status(204).end(),
  );
  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    res.status((error as { status?: number }).status ?? 500).json({ code: (error as { code?: string }).code });
  });
  const server = await startTestServer(app);
  try {
    const payload = '{"value":"this is longer than thirty two bytes"}';
    const declared = await requestBody(`${server.baseUrl}/input`, {
      body: payload,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    });
    assert.equal(declared.status, 413);
    assert.match(metrics.render(), /rivet_http_body_admission_rejections_total\{outcome="too_large",profile="control"\} 1\n/);

    const chunked = await requestBody(`${server.baseUrl}/input`, {
      body: payload,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).code, 'body_too_large');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
    assert.match(metrics.render(), /rivet_http_body_admission_rejections_total\{outcome="too_large",profile="control"\} 2\n/);

    const compressed = await requestBody(`${server.baseUrl}/input`, {
      body: gzipSync(payload),
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });
    assert.equal(compressed.status, 413);
    assert.equal(JSON.parse(compressed.body).code, 'body_too_large');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
    assert.match(metrics.render(), /rivet_http_body_admission_rejections_total\{outcome="too_large",profile="control"\} 3\n/);
  } finally {
    await server.close();
  }
});

test('a completed pre-body rejection cannot be reused for a later request on the same keep-alive agent', async () => {
  let connections = 0;
  const app = express();
  app.post('/input', createJsonBodyParser(() => 32), (_req, res) => res.status(204).end());
  app.get('/health', (_req, res) => res.status(204).end());
  app.use((error: Error, req: Request, res: Response, _next: unknown) => {
    sendRejectedBodyResponse(req, res, () =>
      res.status((error as { status?: number }).status ?? 500).json({ code: (error as { code?: string }).code }));
  });
  const server = await startTestServer(app);
  server.server.on('connection', () => {
    connections += 1;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const rejected = await requestBody(`${server.baseUrl}/input`, { agent,
      method: 'POST',
      body: 'not json',
      headers: { 'content-length': '8', 'content-type': 'text/plain' },
    });
    assert.equal(rejected.status, 415);
    assert.equal(rejected.headers.connection, 'close');

    const health = await requestBody(`${server.baseUrl}/health`, { agent, method: 'GET' });
    assert.equal(health.status, 204);
    assert.notEqual(health.localPort, rejected.localPort);
    assert.equal(connections, 2);
  } finally {
    agent.destroy();
    await server.close();
  }
});

test('pre-body cleanup is shared, bounded and detaches its listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = requestWithHeaders({ 'content-length': '10000' });
  const res = Object.assign(new EventEmitter(), { setHeader() {} }) as unknown as Response;
  const pause = t.mock.method(req, 'pause');
  const resume = t.mock.method(req, 'resume');
  let replies = 0;
  closeResponseConnectionAfterFlush(res, req);
  sendRejectedBodyResponse(req, res, () => { replies += 1; });
  closeResponseConnectionAfterFlush(res, req);
  assert.equal(resume.mock.callCount(), 1, 'route and final formatter share one discard');
  t.mock.timers.tick(249);
  await Promise.resolve();
  assert.equal(replies, 0, 'the response must wait for the unfinished discard');
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(pause.mock.callCount(), 1);
  assert.equal(replies, 1, 'an unfinished upload cannot delay the response beyond the grace period');
  assert.equal(res.shouldKeepAlive, false);
  assert.equal(req.listenerCount('end'), 0);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('rejection cleanup waits for a delayed error response before ending an open upload', async () => {
  const app = express();
  app.post('/reject', (req, res, next) => {
    closeResponseConnectionAfterFlush(res, req);
    next(Object.assign(new Error('Rejected before reading the body.'), { closeConnection: true, status: 413 }));
  });
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    setTimeout(() => res.status(error.status ?? 500).json({ error: error.message }), 300);
  });
  const server = await startTestServer(app);
  try {
    const response = await requestBody(`${server.baseUrl}/reject`, {
      body: '{',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      leaveOpen: true,
    });
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), { error: 'Rejected before reading the body.' });
  } finally {
    await server.close();
  }
});

test('large rejected uploads deliver their error after preflight', async () => {
  const controller = new HttpBodyAdmissionController();
  const app = express();
  app.use((req, _res, next) => {
    // Complete preflight only once the upload has actually reached the unread stream.
    if (req.readableLength > 0) next();
    else req.once('readable', () => next());
  });
  app.post('/input', createAdmittedJsonBodyParser({
    controller, getLimitBytes: () => 1024, parse: parseBoundedBody, rejectUnsupportedMediaType: true,
  }), () => assert.fail('rejected input must not reach its handler'));
  app.use((error: Error & { status?: number; code?: string; closeConnection?: boolean }, req: Request, res: Response, _next: unknown) => {
    if (error.closeConnection) closeResponseConnectionAfterFlush(res, req);
    res.status(error.status ?? 500).json({ code: error.code });
  });
  const server = await startTestServer(app);
  try {
    for (const [headers, status, code] of [
      [{ 'content-type': 'application/json' }, 413, 'body_too_large'],
      [{ 'content-type': 'application/json', 'content-encoding': 'unsupported' }, 415, 'unsupported_body_encoding'],
      [{ 'content-type': 'text/plain' }, 415, 'unsupported_media_type'],
    ] as const) {
      const response = await fetch(`${server.baseUrl}/input`, {
        method: 'POST', headers,
        body: JSON.stringify('x'.repeat(1024 * 1024)), signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('connection'), 'close');
      assert.deepEqual(await response.json(), { code });
      assert.equal(controller.getSnapshot().activeParsers, 0);
      assert.equal(controller.getSnapshot().reservedBytes, 0);
    }
  } finally { await server.close(); }
});

test('deferred rejection replies preserve their context and disappear on disconnect', async () => {
  const context = new AsyncLocalStorage<string>();
  for (const disconnected of [false, true]) {
    const req = requestWithHeaders({ 'content-length': '10000' });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, destroyed: false }) as unknown as Response;
    const observed: Array<string | undefined> = [];
    context.run('rejected request', () => sendRejectedBodyResponse(req, res, () => observed.push(context.getStore())));
    context.run('another request', () => {
      if (disconnected) {
        res.destroyed = true;
        res.emit('close');
      } else req.emit('end');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, disconnected ? [] : ['rejected request']);
    assert.equal(req.listenerCount('end'), 0);
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(res.listenerCount('close'), 0);
  }
});

test('a rejected response writer failure closes its connection without crashing the server', async (t) => {
  const failure = new Error('reply fixture failed');
  const diagnostics = t.mock.method(console, 'error', () => {});
  const app = express();
  app.post('/reject', (req, res) => sendRejectedBodyResponse(req, res, () => { throw failure; }));
  app.get('/health', (_req, res) => res.sendStatus(204));
  const server = await startTestServer(app);
  try {
    await assert.rejects(requestBody(`${server.baseUrl}/reject`, { body: '{}' }), { code: 'ECONNRESET' });
    assert.equal((await fetch(`${server.baseUrl}/health`)).status, 204);
    assert.equal(diagnostics.mock.callCount(), 1);
    assert.equal(diagnostics.mock.calls[0]!.arguments[1], failure);
  } finally { await server.close(); }
});

test('body saturation rejects excess uploads while health remains responsive', async () => {
  const controller = new HttpBodyAdmissionController({ maxQueuedRequests: 0 });
  const app = express();
  let started = 0;
  let allStarted!: () => void;
  const ready = new Promise<void>((resolve) => { allStarted = resolve; });
  app.get('/health', (_req, res) => res.sendStatus(204));
  app.post('/input', createAdmittedJsonBodyParser({
    controller,
    getLimitBytes: () => 128,
    parse: (req, res, next, limit, signal, markBodyReceived) => {
      parseBoundedBody(req, res, next, limit, signal, markBodyReceived);
      if (++started === MAX_CONCURRENT_HTTP_BODY_PARSERS) allStarted();
    },
  }), (_req, res) => res.sendStatus(204));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).end();
  });
  const server = await startTestServer(app);
  const uploads = Array.from({ length: MAX_CONCURRENT_HTTP_BODY_PARSERS }, () => {
    const upload = createRequest(`${server.baseUrl}/input`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    upload.on('error', () => {});
    upload.write('{');
    return upload;
  });
  try {
    await ready;
    assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_HTTP_BODY_PARSERS);
    assert.equal((await fetch(`${server.baseUrl}/health`)).status, 204);
    assert.equal((await requestBody(`${server.baseUrl}/input`, {
      body: '{}', headers: { 'content-type': 'application/json' },
    })).status, 503);
  } finally {
    for (const upload of uploads) upload.destroy();
    await server.close();
  }
});

test('cancelled readers detach before completion and cannot publish a late body', async () => {
  for (const encoding of ['identity', 'gzip']) {
    const req = new PassThrough() as unknown as Request;
    req.headers = { 'content-type': 'application/json', 'content-encoding': encoding };
    const cancellation = new AbortController();
    const reason = new Error('cancelled');
    const completed = new Promise<unknown>((resolve) => {
      parseBoundedBody(req, {} as Response, resolve, 1024, cancellation.signal, () => {});
    });
    const bytes = encoding === 'gzip' ? gzipSync('{"value":"late"}') : Buffer.from('{"value":"late"}');
    (req as unknown as PassThrough).write(bytes.subarray(0, 5));
    cancellation.abort(reason);
    assert.equal(await completed, reason);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('error'), 0);
    (req as unknown as PassThrough).end(bytes.subarray(5));
    assert.equal(req.body, undefined);
    req.destroy();
  }
});

test('admitted parsers reject overflow before an open upload finishes', async () => {
  const controller = new HttpBodyAdmissionController();
  const app = express();
  app.post('/input', createAdmittedJsonBodyParser({
    controller,
    getLimitBytes: () => 32,
    receiveTimeoutMs: 10_000,
    parse: parseBoundedBody,
  }), (_req, res) => res.sendStatus(204));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).end();
  });
  const server = await startTestServer(app);
  try {
    for (const encoding of ['identity', 'gzip']) {
      const data = Buffer.from(JSON.stringify('x'.repeat(200)));
      const response = await requestBody(`${server.baseUrl}/input`, {
        body: encoding === 'gzip' ? gzipSync(data) : data,
        headers: { 'content-type': 'application/json', 'content-encoding': encoding },
        leaveOpen: true,
      });
      assert.equal(response.status, 413, 'must reject overflow, not wait for the receive timeout');
      assert.equal(controller.getSnapshot().activeParsers, 0);
      assert.equal(controller.getSnapshot().reservedBytes, 0);
    }
  } finally {
    await server.close();
  }
});

test('admitted parsers time out a stalled HTTP body and release its reservation', async () => {
  const controller = new HttpBodyAdmissionController();
  const app = express();
  app.post(
    '/input',
    createAdmittedBodyParser({
      controller,
      getLimitBytes: () => 100,
      receiveTimeoutMs: 25,
      shouldParse: (req) => req.get('content-type') === 'application/json',
      parse: parseBoundedBody,
    }),
    (_req, res) => res.status(204).end(),
  );
  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    res.status((error as { status?: number }).status ?? 500).json({ code: (error as { code?: string }).code });
  });
  const server = await startTestServer(app);
  try {
    const response = await requestBody(`${server.baseUrl}/input`, {
      body: '{',
      headers: { 'content-length': '100', 'content-type': 'application/json' },
      leaveOpen: true,
    });
    assert.equal(response.status, 408);
    assert.equal(JSON.parse(response.body).code, 'body_receive_timeout');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
  } finally {
    await server.close();
  }
});

test('async handlers retain a parsed request body after response close until their durable work settles', async () => {
  const controller = new HttpBodyAdmissionController();
  const parser = createAdmittedJsonBodyParser({
    controller,
    getLimitBytes: () => 100,
    parse: (_req, _res, next) => next(),
  });
  const req = requestWithHeaders({ 'content-length': '32', 'content-type': 'application/json' });
  const res = new EventEmitter() as Response;
  let finishWork: (() => void) | undefined;
  const handler = asyncHandler(async () => {
    await new Promise<void>((resolve) => {
      finishWork = resolve;
    });
  });

  parser(req, res, () => handler(req, res, () => undefined));
  res.emit('close');
  assert.equal(controller.getSnapshot().retainedBodies, 1);
  assert.equal(controller.getSnapshot().reservedBytes, 32);

  finishWork?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().retainedBodies, 0);
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});
