import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, createServer, request as createRequest } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';

import express from 'express';
import type { Request, Response } from 'express';

import {
  closeResponseConnectionAfterFlush,
  createAdmittedJsonBodyParser,
  createAdmittedBodyParser,
  HttpBodyAdmissionController,
  MAX_CONCURRENT_JSON_BODY_PARSERS,
  retainParsedRequestBody,
} from '../middleware/body-admission.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseBoundedBody } from '../middleware/body-reader.js';
import { createJsonBodyParser } from '../middleware/body-parsers.js';

test('JSON media admission matches the parser rather than accepting arbitrary +json types', async () => {
  const app = express();
  app.post('/input', createJsonBodyParser(() => 128), (req, res) => res.json(req.body));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).end();
  });
  const server = await startTestServer(app);
  try {
    for (const type of ['text/custom+json', 'image/custom+json', 'application/bad/type+json']) {
      assert.equal((await requestBody(`${server.baseUrl}/input`, {
        headers: { 'content-type': type }, body: '{"value":1}',
      })).status, 415);
    }
    const response = await requestBody(`${server.baseUrl}/input`, {
      headers: { 'content-type': 'application/custom+json' }, body: '{"value":1}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { value: 1 });
  } finally { await server.close(); }
});

test('a reader rejects an already destroyed request without waiting for its receive deadline', async () => {
  const req = new PassThrough() as unknown as Request;
  req.headers = { 'content-type': 'application/json' };
  req.destroy();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancellation = new AbortController();
  let result: unknown;
  parseBoundedBody(req, {} as Response, (error) => { result = error; }, 128, cancellation.signal, () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal((result as { status?: number } | undefined)?.status, 400);
    assert.equal(req.listenerCount('data'), 0);
  } finally { cancellation.abort(new Error('test cleanup')); }
});

function requestWithHeaders(headers: Record<string, string | undefined>): Request {
  return Object.assign(new EventEmitter(), {
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  }) as Request;
}

async function startTestServer(app: express.Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  server: ReturnType<typeof createServer>;
}> {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

async function requestWithAgent(
  url: string,
  agent: Agent,
  options: { body?: Buffer | string; headers?: Record<string, string>; method?: string } = {},
): Promise<{ body: string; localPort: number | undefined; status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let localPort: number | undefined;
    const request = createRequest({
      agent,
      hostname: target.hostname,
      method: options.method ?? 'GET',
      path: target.pathname,
      port: target.port,
      headers: options.headers,
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
      response.once('end', () =>
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          localPort,
          status: response.statusCode ?? 0,
        }),
      );
    });
    request.end(options.body);
  });
}

async function requestBody(
  url: string,
  options: { body?: Buffer | string; headers?: Record<string, string>; leaveOpen?: boolean } = {},
): Promise<{ body: string; headers: Record<string, string | string[] | undefined>; status: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = createRequest({
      hostname: target.hostname,
      method: 'POST',
      path: target.pathname,
      port: target.port,
      headers: options.headers,
    });
    request.once('error', reject);
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () =>
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers,
          status: response.statusCode ?? 0,
        }),
      );
    });
    if (options.body != null) request.write(options.body);
    if (!options.leaveOpen) request.end();
  });
}

test('HTTP JSON body admission bounds concurrent reservations and releases them exactly once', () => {
  const controller = new HttpBodyAdmissionController();
  const reservations = Array.from({ length: MAX_CONCURRENT_JSON_BODY_PARSERS }, () =>
    controller.admit(requestWithHeaders({ 'content-length': '32' }), 100),
  );

  assert.ok(reservations.every((reservation) => reservation != null));
  assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_JSON_BODY_PARSERS);
  assert.equal(controller.admit(requestWithHeaders({ 'content-length': '32' }), 100), null);

  const first = reservations[0];
  assert.ok(first);
  first.release();
  first.release();
  assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_JSON_BODY_PARSERS - 1);
  assert.ok(controller.admit(requestWithHeaders({ 'content-length': '32' }), 100));
});

test('HTTP JSON body admission frees parsing slots while retaining the parsed body reservation', () => {
  const controller = new HttpBodyAdmissionController();
  const retained = controller.admit(requestWithHeaders({ 'content-length': '32' }), 100);
  assert.ok(retained);

  retained.retain();
  retained.releaseParserSlot();
  assert.deepEqual(controller.getSnapshot(), {
    activeParsers: 0,
    maxActiveParsers: MAX_CONCURRENT_JSON_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 32,
    retainedBodies: 1,
  });

  const parsingReservations = Array.from({ length: MAX_CONCURRENT_JSON_BODY_PARSERS }, () =>
    controller.admit(requestWithHeaders({ 'content-length': '32' }), 100),
  );
  assert.ok(parsingReservations.every((reservation) => reservation != null));

  retained.release();
  assert.equal(controller.getSnapshot().retainedBodies, 0);
  assert.equal(controller.getSnapshot().reservedBytes, 32 * MAX_CONCURRENT_JSON_BODY_PARSERS);
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
    maxActiveParsers: MAX_CONCURRENT_JSON_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 32,
    retainedBodies: 1,
  });

  releaseBody?.();
  assert.equal(controller.getSnapshot().reservedBytes, 0);
});

test('HTTP JSON body admission reserves the decoded limit for compressed or unknown-size requests', () => {
  const controller = new HttpBodyAdmissionController();
  const compressed = controller.admit(
    // The parser limit applies after decompression, so a wire payload may be
    // larger than the decoded JSON it represents.
    requestWithHeaders({ 'content-encoding': 'gzip', 'content-length': '101' }),
    100,
  );
  assert.ok(compressed);
  assert.equal(controller.getSnapshot().reservedBytes, 100);
  compressed.release();

  const unknownLength = controller.admit(requestWithHeaders({}), 100);
  assert.ok(unknownLength);
  assert.equal(controller.getSnapshot().reservedBytes, 100);
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
    maxActiveParsers: MAX_CONCURRENT_JSON_BODY_PARSERS,
    maxReservedBytes: 1024 * 1024 * 1024,
    reservedBytes: 0,
    retainedBodies: 0,
  });
});

test('admitted parsers enforce decoded limits for chunked and compressed HTTP bodies', async () => {
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
    const chunked = await requestBody(`${server.baseUrl}/input`, {
      body: '{"value":"this is longer than thirty two bytes"}',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).code, 'body_too_large');
    assert.equal(controller.getSnapshot().reservedBytes, 0);

    const compressed = await requestBody(`${server.baseUrl}/input`, {
      body: gzipSync('{"value":"this is longer than thirty two bytes"}'),
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });
    assert.equal(compressed.status, 413);
    assert.equal(JSON.parse(compressed.body).code, 'body_too_large');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
  } finally {
    await server.close();
  }
});

test('route-owned JSON parsers reject unsupported body media types before handlers run', async () => {
  const controller = new HttpBodyAdmissionController();
  let handlerRan = false;
  const app = express();
  app.post(
    '/input',
    createAdmittedBodyParser({
      controller,
      getLimitBytes: () => 32,
      shouldParse: (req) => req.get('content-type') === 'application/json',
      rejectUnsupportedMediaType: true,
      parse: parseBoundedBody,
    }),
    (_req, res) => {
      handlerRan = true;
      res.status(204).end();
    },
  );
  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    if ((error as { closeConnection?: unknown }).closeConnection === true) {
      res.shouldKeepAlive = false;
      res.setHeader('Connection', 'close');
    }
    res.status((error as { status?: number }).status ?? 500).json({ code: (error as { code?: string }).code });
  });
  const server = await startTestServer(app);
  try {
    const response = await requestBody(`${server.baseUrl}/input`, {
      body: 'not json',
      headers: { 'content-length': '8', 'content-type': 'text/plain' },
    });
    assert.equal(response.status, 415);
    assert.equal(JSON.parse(response.body).code, 'unsupported_media_type');
    assert.equal(response.headers.connection, 'close');
    assert.equal(handlerRan, false);
    assert.equal(controller.getSnapshot().reservedBytes, 0);
  } finally {
    await server.close();
  }
});

test('a completed pre-body rejection cannot be reused for a later request on the same keep-alive agent', async () => {
  let connections = 0;
  const app = express();
  app.post(
    '/input',
    createAdmittedBodyParser({
      getLimitBytes: () => 32,
      shouldParse: (req) => req.get('content-type') === 'application/json',
      rejectUnsupportedMediaType: true,
      parse: parseBoundedBody,
    }),
    (_req, res) => res.status(204).end(),
  );
  app.get('/health', (_req, res) => res.status(204).end());
  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    if ((error as { closeConnection?: unknown }).closeConnection === true) {
      res.shouldKeepAlive = false;
      res.setHeader('Connection', 'close');
    }
    res.status((error as { status?: number }).status ?? 500).json({ code: (error as { code?: string }).code });
  });
  const server = await startTestServer(app);
  server.server.on('connection', () => {
    connections += 1;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const rejected = await requestWithAgent(`${server.baseUrl}/input`, agent, {
      method: 'POST',
      body: 'not json',
      headers: { 'content-length': '8', 'content-type': 'text/plain' },
    });
    assert.equal(rejected.status, 415);

    const health = await requestWithAgent(`${server.baseUrl}/health`, agent);
    assert.equal(health.status, 204);
    assert.notEqual(health.localPort, rejected.localPort);
    assert.equal(connections, 2);
  } finally {
    agent.destroy();
    await server.close();
  }
});

test('pre-body connection closure is idempotent across route and error middleware', async () => {
  let connections = 0;
  const app = express();
  app.post('/reject', (req, res, next) => {
    closeResponseConnectionAfterFlush(res, req);
    const error = new Error('Rejected before reading the body.') as Error & {
      closeConnection?: boolean;
      status?: number;
    };
    error.closeConnection = true;
    error.status = 413;
    next(error);
  });
  app.get('/health', (_req, res) => res.status(204).end());
  app.use((error: Error, req: Request, res: Response, _next: unknown) => {
    if ((error as { closeConnection?: unknown }).closeConnection === true) {
      // Production's final formatter can observe the same rejection after the
      // route has already scheduled the close.
      closeResponseConnectionAfterFlush(res, req);
    }
    res.status((error as { status?: number }).status ?? 500).json({ error: error.message });
  });
  const server = await startTestServer(app);
  server.server.on('connection', () => {
    connections += 1;
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const rejected = await requestWithAgent(`${server.baseUrl}/reject`, agent, {
      method: 'POST',
      body: Buffer.alloc(16 * 1024, 'x'),
      headers: { 'content-length': String(16 * 1024), 'content-type': 'application/json' },
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body, '{"error":"Rejected before reading the body."}');

    // A large rejected upload gets a bounded drain window so the client can
    // receive its 413. The connection must still be terminal afterwards.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const health = await requestWithAgent(`${server.baseUrl}/health`, agent);
    assert.equal(health.status, 204);
    assert.notEqual(health.localPort, rejected.localPort);
    assert.equal(connections, 2);
  } finally {
    agent.destroy();
    await server.close();
  }
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

test('the receive deadline ends once a parser has received its finite body', async () => {
  const app = express();
  app.post('/input', createAdmittedBodyParser({
    getLimitBytes: () => 128,
    receiveTimeoutMs: 10,
    shouldParse: () => true,
    parse: (_req, _res, next, _limit, _signal, markBodyReceived) => {
      markBodyReceived();
      setTimeout(next, 30);
    },
  }), (_req, res) => res.sendStatus(204));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).end();
  });
  const server = await startTestServer(app);
  try {
    assert.equal((await requestBody(`${server.baseUrl}/input`, {
      body: '{}', headers: { 'content-type': 'application/json' },
    })).status, 204);
  } finally {
    await server.close();
  }
});

test('admitted JSON parsers return an explicit representation error for unsupported content encodings', async () => {
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
    const response = await requestBody(`${server.baseUrl}/input`, {
      body: '{}',
      headers: { 'content-encoding': 'made-up', 'content-type': 'application/json' },
    });
    assert.equal(response.status, 415);
    assert.equal(JSON.parse(response.body).code, 'unsupported_body_encoding');
    assert.equal(controller.getSnapshot().reservedBytes, 0);
  } finally {
    await server.close();
  }
});

test('body saturation rejects excess uploads while health remains responsive', async () => {
  const controller = new HttpBodyAdmissionController();
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
      if (++started === MAX_CONCURRENT_JSON_BODY_PARSERS) allStarted();
    },
  }), (_req, res) => res.sendStatus(204));
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: unknown) => {
    res.status(error.status ?? 500).end();
  });
  const server = await startTestServer(app);
  const uploads = Array.from({ length: MAX_CONCURRENT_JSON_BODY_PARSERS }, () => {
    const upload = createRequest(`${server.baseUrl}/input`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    upload.on('error', () => {});
    upload.write('{');
    return upload;
  });
  try {
    await ready;
    assert.equal(controller.getSnapshot().activeParsers, MAX_CONCURRENT_JSON_BODY_PARSERS);
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
    const startedAt = performance.now();
    const response = await requestBody(`${server.baseUrl}/input`, {
      body: '{',
      headers: { 'content-length': '100', 'content-type': 'application/json' },
      leaveOpen: true,
    });
    assert.equal(response.status, 408);
    assert.equal(JSON.parse(response.body).code, 'body_receive_timeout');
    assert.ok(performance.now() - startedAt < 1_000, 'the timeout response must not wait for HTTP keep-alive expiry');
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
