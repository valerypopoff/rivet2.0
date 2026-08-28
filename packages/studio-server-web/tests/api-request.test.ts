import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createResponseError,
  parseJsonResponse,
  parseTextResponse,
} from '../dashboard/apiRequest.js';

test('parseJsonResponse returns parsed JSON for successful JSON responses', async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  const parsed = await parseJsonResponse<{ ok: boolean }>(response);
  assert.deepEqual(parsed, { ok: true });
});

test('parseJsonResponse throws the proxy guidance error when HTML is returned', async () => {
  const response = new Response('<!doctype html><html><body>oops</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

  await assert.rejects(
    parseJsonResponse(response),
    /HTML instead of JSON/,
  );
});

test('parseJsonResponse preserves JSON error status and message', async () => {
  const response = new Response(JSON.stringify({ error: 'Bad request' }), {
    status: 400,
    statusText: 'Bad Request',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  await assert.rejects(
    parseJsonResponse(response),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 400);
      assert.equal((error as Error).message, 'Bad request');
      return true;
    },
  );
});

test('parseTextResponse returns plain text bodies unchanged', async () => {
  const response = new Response('hello world', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

  assert.equal(await parseTextResponse(response), 'hello world');
});

test('parseTextResponse extracts JSON errors and falls back to status text for non-JSON failures', async () => {
  const jsonError = new Response(JSON.stringify({ error: 'No recording' }), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

  await assert.rejects(
    parseTextResponse(jsonError),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 404);
      assert.equal((error as Error).message, 'No recording');
      return true;
    },
  );

  const plainError = new Response('nope', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

  await assert.rejects(
    parseTextResponse(plainError),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 503);
      assert.equal((error as Error).message, 'Service Unavailable');
      return true;
    },
  );
});

test('createResponseError attaches the HTTP status to the thrown error', () => {
  const error = createResponseError(418, 'teapot');
  assert.equal(error.status, 418);
  assert.equal(error.message, 'teapot');
});
