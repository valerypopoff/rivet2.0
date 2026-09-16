import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertRetryAttemptOutputs,
  assertStringArrayOutputMatches,
  createContext,
  createNode,
  installHttpCallNodeTestHooks,
  requestErrorOutputId,
} from './HttpCallNode.testUtils.js';
import type { Outputs } from '../../../src/index.js';

installHttpCallNodeTestHooks();

void test('throws on non-2XX responses when errorOnNon200 is enabled and catchRequestFailed is disabled', async () => {
  globalThis.fetch = async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: false,
  });

  await assert.rejects(() => node.process({}, createContext()), /HTTP call returned non-2XX status code: 404/);
});
void test('retains response headers for every retry attempt when retries end in a non-2XX error', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response('rate limited', {
      status: 429,
      headers: {
        'retry-after': requestCount === 1 ? '1' : '30',
        'x-request-id': `request-${requestCount}`,
      },
    });
  };

  let failureOutputs: Outputs | undefined;
  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });

  await assert.rejects(
    () =>
      node.process({}, {
        ...createContext(),
        setFailureOutputs: (outputs) => {
          failureOutputs = outputs;
        },
      }),
    /HTTP call returned non-2XX status code: 429/,
  );

  assert.equal(requestCount, 2);
  assert.deepStrictEqual(failureOutputs, {
    statusCode: { type: 'number[]', value: [429, 429] },
    res_headers: {
      type: 'object[]',
      value: [
        {
          'content-type': 'text/plain;charset=UTF-8',
          'retry-after': '1',
          'x-request-id': 'request-1',
        },
        {
          'content-type': 'text/plain;charset=UTF-8',
          'retry-after': '30',
          'x-request-id': 'request-2',
        },
      ],
    },
  });
});
void test('retries non-200 responses before applying fail-on-non-2XX behavior', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return requestCount === 1
      ? new Response('server error', { status: 500, headers: { 'content-type': 'text/plain', 'x-attempt': '1' } })
      : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'x-attempt': '2' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: false,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 2);
  assert.deepStrictEqual(result.res_body, { type: 'string', value: 'ok' });
  assert.deepStrictEqual(result.res_headers, {
    type: 'object[]',
    value: [
      { 'content-type': 'text/plain', 'x-attempt': '1' },
      { 'content-type': 'text/plain', 'x-attempt': '2' },
    ],
  });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [500, 200],
    requestFailedValues: [true, false],
    requestErrorParts: [[/HTTP call returned non-2XX status code: 500/]],
  });
});
void test('retries 2XX responses that are not exactly 200', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return requestCount === 1
      ? new Response('created', { status: 201, headers: { 'content-type': 'text/plain' } })
      : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 2);
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [201, 200],
    requestFailedValues: [true, false],
    requestErrorParts: [[/HTTP call returned non-2XX status code: 201/]],
  });
});
void test('treats saved repeat counts below one as one repeat when retry is enabled', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return requestCount === 1
      ? new Response('server error', { status: 500, headers: { 'content-type': 'text/plain' } })
      : new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 0,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 2);
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [500, 200],
    requestFailedValues: [true, false],
    requestErrorParts: [[/HTTP call returned non-2XX status code: 500/]],
  });
});
void test('returns the final non-200 response after retries when fail-on-non-2XX is disabled', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response(`try ${requestCount}`, { status: 503, headers: { 'content-type': 'text/plain' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: false,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 2,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 3);
  assert.deepStrictEqual(result.res_body, { type: 'string', value: 'try 3' });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [503, 503, 503],
    requestFailedValues: [true, true, true],
    requestErrorParts: [
      [/HTTP call returned non-2XX status code: 503/],
      [/HTTP call returned non-2XX status code: 503/],
      [/HTTP call returned non-2XX status code: 503/],
    ],
  });
});
void test('lets catchRequestFailed catch the final non-2XX failure after retries are exhausted', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 2);
  assert.equal(Object.keys(result)[0], requestErrorOutputId);
  assert.deepStrictEqual(result.res_body, { type: 'control-flow-excluded', value: undefined });
  assert.deepStrictEqual(result.json, { type: 'control-flow-excluded', value: undefined });
  assert.deepStrictEqual(result.res_headers, { type: 'control-flow-excluded', value: undefined });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [404, 404],
    requestFailedValues: [true, true],
    requestErrorParts: [
      [/HTTP call returned non-2XX status code: 404/],
      [/HTTP call returned non-2XX status code: 404/],
    ],
  });
});
void test('records thrown request failures in existing retry transport outputs when catch mode is enabled', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    catchRequestFailed: true,
    retryOnNon200: true,
  });
  const result = await node.process({}, createContext());

  assert.equal(Object.keys(result)[0], requestErrorOutputId);
  assert.deepStrictEqual(result.res_body, { type: 'control-flow-excluded', value: undefined });
  assert.deepStrictEqual(result.json, { type: 'control-flow-excluded', value: undefined });
  assert.deepStrictEqual(result.res_headers, { type: 'control-flow-excluded', value: undefined });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: undefined,
    requestFailedValues: [true],
    requestErrorParts: [[/fetch failed/]],
  });
});
void test('uses existing retry transport outputs for invalid URLs before any request starts', async () => {
  const node = createNode({ url: 'not a url', catchRequestFailed: true, retryOnNon200: true });
  const result = await node.process({}, createContext());

  assert.equal(Object.keys(result)[0], requestErrorOutputId);
  assertRetryAttemptOutputs(result, {
    statusCodeValues: undefined,
    requestFailedValues: [true],
    requestErrorParts: [[/Invalid URL: not a url/]],
  });
});
void test('keeps response processing failures visible in existing retry transport outputs', async () => {
  globalThis.fetch = async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    catchRequestFailed: true,
    retryOnNon200: true,
  });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result.res_body, { type: 'control-flow-excluded', value: undefined });
  assertRetryAttemptOutputs(result, {
    statusCodeValues: [200],
    requestFailedValues: [true],
    requestErrorParts: [[/SyntaxError/]],
  });
});
void test('records request errors from each failed retry attempt in existing Request error output', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response(`try ${requestCount}`, { status: requestCount === 1 ? 502 : 503 });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: false,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });
  const result = await node.process({}, createContext());

  assertRetryAttemptOutputs(result, {
    statusCodeValues: [502, 503],
    requestFailedValues: [true, true],
    requestErrorParts: [
      [/HTTP call returned non-2XX status code: 502/],
      [/HTTP call returned non-2XX status code: 503/],
    ],
  });
});
void test('records final caught retry errors as an array on the existing Request error output', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  };

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
  });
  const result = await node.process({}, createContext());

  assert.equal(requestCount, 2);
  assertStringArrayOutputMatches(result, requestErrorOutputId, [
    [/HTTP call returned non-2XX status code: 404/],
    [/HTTP call returned non-2XX status code: 404/],
  ]);
});
void test('does not swallow aborts during retry cooldown', async () => {
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount++;
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  };

  const abortController = new AbortController();
  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    catchRequestFailed: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    retryOnNon200CooldownMs: 50,
  });

  setTimeout(() => abortController.abort(), 5);

  await assert.rejects(() => node.process({}, createContext({ signal: abortController.signal })), /Aborted/);
  assert.equal(requestCount, 1);
});
void test('does not format unused retry-attempt errors when retry mode is disabled', async () => {
  globalThis.fetch = async () => new Response('created', { status: 201, headers: { 'content-type': 'text/plain' } });

  const originalPrepareStackTrace = Error.prepareStackTrace;
  let formattedStackCount = 0;
  Error.prepareStackTrace = () => {
    formattedStackCount++;
    return 'formatted stack';
  };

  try {
    const node = createNode({
      method: 'GET',
      url: 'https://example.com',
      errorOnNon200: true,
      retryOnNon200: false,
    });
    const result = await node.process({}, createContext());

    assert.deepStrictEqual(result.statusCode, { type: 'number', value: 201 });
    assert.equal(formattedStackCount, 0);
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
  }
});
