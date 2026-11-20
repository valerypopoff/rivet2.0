import test from 'node:test';
import { strict as assert } from 'node:assert';
import { createContext, createNode, installHttpCallNodeTestHooks } from './HttpCallNode.testUtils.js';

installHttpCallNodeTestHooks();

void test('keeps success behavior unchanged when catchRequestFailed is disabled', async () => {
  globalThis.fetch = async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });

  const node = createNode({ method: 'GET', url: 'https://example.com' });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'ok' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number', value: 200 },
    res_headers: { type: 'object', value: { 'content-type': 'text/plain' } },
  });
});
void test('does not throw on non-2XX responses when errorOnNon200 is disabled', async () => {
  globalThis.fetch = async () =>
    new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });

  const node = createNode({ method: 'GET', url: 'https://example.com', errorOnNon200: false });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'unavailable' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number', value: 503 },
    res_headers: { type: 'object', value: { 'content-type': 'text/plain' } },
  });
});
void test('does not throw on 2XX responses when errorOnNon200 is enabled', async () => {
  globalThis.fetch = async () => new Response('created', { status: 201, headers: { 'content-type': 'text/plain' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: false,
  });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'created' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number', value: 201 },
    res_headers: { type: 'object', value: { 'content-type': 'text/plain' } },
  });
});
void test('returns the complete success contract when retry mode succeeds without failed attempts', async () => {
  globalThis.fetch = async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    catchRequestFailed: true,
    retryOnNon200: true,
  });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'ok' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number[]', value: [200] },
    res_headers: { type: 'object[]', value: [{ 'content-type': 'text/plain' }] },
    requestFailed: { type: 'boolean[]', value: [false] },
    requestError: { type: 'control-flow-excluded', value: undefined },
  });
});
void test('returns requestFailed=false on successful text responses when enabled', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: '{"ok":true}' },
    json: { type: 'object', value: { ok: true } },
    statusCode: { type: 'number', value: 200 },
    res_headers: { type: 'object', value: { 'content-type': 'application/json' } },
    requestFailed: { type: 'boolean', value: false },
    requestError: { type: 'control-flow-excluded', value: undefined },
  });
});
void test('returns requestFailed=false on successful non-json responses when enabled', async () => {
  globalThis.fetch = async () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } });

  const node = createNode({ method: 'GET', url: 'https://example.com', catchRequestFailed: true });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'plain' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number', value: 200 },
    res_headers: { type: 'object', value: { 'content-type': 'text/plain' } },
    requestFailed: { type: 'boolean', value: false },
    requestError: { type: 'control-flow-excluded', value: undefined },
  });
});
void test('returns requestFailed=false on successful binary responses when enabled', async () => {
  globalThis.fetch = async () =>
    new Response(Uint8Array.from([0, 127, 128, 255]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    catchRequestFailed: true,
    isBinaryOutput: true,
  });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    binary: { type: 'binary', value: Uint8Array.from([0, 127, 128, 255]) },
    statusCode: { type: 'number', value: 200 },
    res_headers: { type: 'object', value: { 'content-type': 'application/octet-stream' } },
    requestFailed: { type: 'boolean', value: false },
    requestError: { type: 'control-flow-excluded', value: undefined },
  });
});
void test('keeps 2XX responses out of the requestFailed path when both toggles are enabled', async () => {
  globalThis.fetch = async () => new Response('created', { status: 201, headers: { 'content-type': 'text/plain' } });

  const node = createNode({
    method: 'GET',
    url: 'https://example.com',
    errorOnNon200: true,
    catchRequestFailed: true,
  });
  const result = await node.process({}, createContext());

  assert.deepStrictEqual(result, {
    res_body: { type: 'string', value: 'created' },
    json: { type: 'control-flow-excluded', value: undefined },
    statusCode: { type: 'number', value: 201 },
    res_headers: { type: 'object', value: { 'content-type': 'text/plain' } },
    requestFailed: { type: 'boolean', value: false },
    requestError: { type: 'control-flow-excluded', value: undefined },
  });
});
