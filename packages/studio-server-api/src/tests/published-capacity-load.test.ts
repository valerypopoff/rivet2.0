import assert from 'node:assert/strict';
import test from 'node:test';

import { runPublishedCapacityLoad, validateCapacityLoadConfig } from '../scripts/published-capacity-load.js';

test('published capacity load is bounded, records exact request outcomes, and never retries rejected work', async () => {
  let active = 0;
  let maxActive = 0;
  let publishedRequests = 0;
  let controlRequests = 0;
  let authorization = '';
  const report = await runPublishedCapacityLoad(
    {
      version: 1,
      proxyBaseUrl: 'http://proxy.test',
      controlBaseUrl: 'http://control.test',
      requestTimeoutMs: 1_000,
      controlCanaryEveryRequests: 2,
      controlCanaryTimeoutMs: 1_000,
      scenarios: [{ name: 'fast', endpoint: 'fixture-fast', body: { input: 'safe' } }],
      stages: [{ name: 'overload', scenario: 'fast', concurrency: 3, requests: 7, expect: 'overload' }],
    },
    {
      bearerToken: 'scoped-capability',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/readyz') {
          controlRequests += 1;
          return new Response('', { status: 200 });
        }
        assert.equal(url.pathname, '/workflows/fixture-fast');
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        publishedRequests += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(JSON.stringify({ code: 'execution_capacity_exceeded' }), { status: 429 });
      },
    },
  );

  const stage = report.stages[0]!;
  assert.equal(publishedRequests, 7, 'the worker must not retry rejected work');
  assert.equal(controlRequests, 3);
  assert.equal(stage.completed, 7);
  assert.equal(stage.outcomes.capacityRejected, 7);
  assert.equal(stage.outcomes.unexpected, 0);
  assert.equal(stage.maxConcurrentObserved, 3);
  assert.equal(maxActive, 3);
  assert.equal(authorization, 'Bearer scoped-capability');
});

test('published capacity load rejects latest routes and unsafe load shapes before any request starts', () => {
  assert.throws(
    () =>
      validateCapacityLoadConfig({
        version: 1,
        proxyBaseUrl: 'https://proxy.test',
        controlBaseUrl: 'https://control.test',
        requestTimeoutMs: 1_000,
        controlCanaryEveryRequests: 1,
        controlCanaryTimeoutMs: 1_000,
        scenarios: [{ name: 'unsafe', endpoint: 'workflows-latest/example', body: {} }],
        stages: [{ name: 'steady', scenario: 'unsafe', concurrency: 1, requests: 1, expect: 'success' }],
      }),
    /safe published endpoint slug; latest routes are forbidden/,
  );
  assert.throws(
    () =>
      validateCapacityLoadConfig({
        version: 1,
        proxyBaseUrl: 'https://proxy.test',
        controlBaseUrl: 'https://control.test',
        requestTimeoutMs: 1_000,
        controlCanaryEveryRequests: 1,
        controlCanaryTimeoutMs: 1_000,
        scenarios: [{ name: 'fast', endpoint: 'fixture-fast', body: {} }],
        stages: [{ name: 'steady', scenario: 'fast', concurrency: 513, requests: 1, expect: 'success' }],
      }),
    /concurrency must be an integer from 1 to 512/,
  );
  assert.throws(
    () =>
      validateCapacityLoadConfig({
        version: 1,
        proxyBaseUrl: 'https://proxy.test',
        controlBaseUrl: 'https://control.test',
        requestHeaders: { authorization: 'Bearer forbidden' },
        requestTimeoutMs: 1_000,
        controlCanaryEveryRequests: 1,
        controlCanaryTimeoutMs: 1_000,
        scenarios: [{ name: 'fast', endpoint: 'fixture-fast', body: {} }],
        stages: [{ name: 'steady', scenario: 'fast', concurrency: 1, requests: 1, expect: 'success' }],
      }),
    /does not accept requestHeaders/,
  );
});
