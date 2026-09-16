import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertCaughtTextRequestFailure,
  createContext,
  createNode,
  getStringOutputValue,
  installHttpCallNodeTestHooks,
  requestErrorOutputId,
} from './HttpCallNode.testUtils.js';
import type { Outputs } from '../../../src/index.js';

installHttpCallNodeTestHooks();

void test('still throws invalid URL when catchRequestFailed is disabled', async () => {
  const node = createNode({ url: 'not a url' });

  await assert.rejects(() => node.process({}, createContext()), /Invalid URL: not a url/);
});
void test('returns excluded outputs and requestFailed=true for invalid URL when enabled', async () => {
  const node = createNode({ url: 'not a url', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assertCaughtTextRequestFailure(result, [/Invalid URL: not a url/]);
});
void test('catches browser-style Failed to fetch errors when enabled', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext({ executor: 'browser' }));

  assert.deepStrictEqual(result.requestFailed, { type: 'boolean', value: true });
  assert.deepStrictEqual(result.res_body, { type: 'control-flow-excluded', value: undefined });
  const errorText = getStringOutputValue(result, requestErrorOutputId);
  assert.match(errorText, /CORS problems/);
  assert.match(errorText, /Failed to fetch/);
});
void test('catches browser-style Load failed errors when enabled', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Load failed');
  };

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext({ executor: 'browser' }));

  assert.deepStrictEqual(result.requestFailed, { type: 'boolean', value: true });
  assert.deepStrictEqual(result.statusCode, { type: 'control-flow-excluded', value: undefined });
  const errorText = getStringOutputValue(result, requestErrorOutputId);
  assert.match(errorText, /CORS problems/);
  assert.match(errorText, /Load failed/);
});
void test('catches node-style fetch failed errors when enabled', async () => {
  const fetchError = new TypeError('fetch failed') as TypeError & { cause?: { code: string; message: string } };
  fetchError.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND example.invalid' };
  globalThis.fetch = async () => {
    throw fetchError;
  };

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result.requestFailed, { type: 'boolean', value: true });
  assert.deepStrictEqual(result.res_headers, { type: 'control-flow-excluded', value: undefined });
  const errorText = getStringOutputValue(result, requestErrorOutputId);
  assert.match(errorText, /fetch failed/);
  assert.match(errorText, /ENOTFOUND/);
});
void test('treats non-2XX responses as requestFailed=true when both toggles are enabled', async () => {
  globalThis.fetch = async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: true,
  });
  const result = await node.process({}, createContext());

  assertCaughtTextRequestFailure(result, [/HTTP call returned non-2XX status code: 404/]);
});
void test('retains a non-2XX response status and headers for the terminal error display', async () => {
  globalThis.fetch = async () =>
    new Response('rate limited', {
      status: 429,
      headers: {
        'content-type': 'text/plain',
        'retry-after': '30',
        'x-request-id': 'request-429',
      },
    });

  let failureOutputs: Outputs | undefined;
  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: false,
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

  assert.deepStrictEqual(failureOutputs, {
    statusCode: { type: 'number', value: 429 },
    res_headers: {
      type: 'object',
      value: {
        'content-type': 'text/plain',
        'retry-after': '30',
        'x-request-id': 'request-429',
      },
    },
  });
});
void test('publishes non-2XX metadata to direct consumers when no failure-output channel is available', async () => {
  globalThis.fetch = async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: false,
  });
  const context = {
    ...createContext(),
    partialOutputs: undefined as Outputs | undefined,
    onPartialOutputs(outputs: Outputs) {
      this.partialOutputs = outputs;
    },
  };

  await assert.rejects(
    () => node.process({}, context),
    /HTTP call returned non-2XX status code: 429/,
  );

  assert.deepStrictEqual(context.partialOutputs, {
    statusCode: { type: 'number', value: 429 },
    res_headers: {
      type: 'object',
      value: { 'content-type': 'text/plain;charset=UTF-8', 'retry-after': '30' },
    },
  });
});
void test('still throws runtime request failures when catchRequestFailed is disabled', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };

  const node = createNode({ method: 'GET', url: 'https://example.com' });

  await assert.rejects(() => node.process({}, createContext()), /fetch failed/);
});
void test('catches malformed JSON responses when enabled', async () => {
  globalThis.fetch = async () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assertCaughtTextRequestFailure(result, [/SyntaxError/]);
});
void test('does not catch abort errors', async () => {
  const abortError = new Error('Aborted');
  abortError.name = 'AbortError';
  globalThis.fetch = async () => {
    throw abortError;
  };

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });

  await assert.rejects(() => node.process({}, createContext()), /Aborted/);
});
void test('catches response body read failures when enabled', async () => {
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => {
        throw new Error('Body read failed');
      },
    }) as Response;

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assertCaughtTextRequestFailure(result, [/Body read failed/]);
});
void test('catches invalid configured headers JSON when enabled', async () => {
  const node = createNode({ method: 'GET', url: 'https://example.com', headers: '{', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assertCaughtTextRequestFailure(result, [/SyntaxError/]);
});
