import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetryableModuleLoader, getRetryableModuleUrl } from './retryableModuleLoader.js';

test('synchronous loader and retry failures reject promises without poisoning the shared attempt', async () => {
  const base = 'https://rivet.example/assets/release-1/host.js';
  const target = 'https://rivet.example/assets/release-1/CodeEditor-hash.js';
  const failure = new Error(`Failed to fetch dynamically imported module: ${target}`);
  const module = { default: 'recovered' };
  let initialCalls = 0,
    retryCalls = 0;
  const loader = createRetryableModuleLoader(
    () => {
      initialCalls++;
      throw failure;
    },
    base,
    () => {
      if (++retryCalls === 1) throw failure;
      return Promise.resolve(module);
    },
  );
  let first!: Promise<typeof module>;
  assert.doesNotThrow(() => {
    first = loader.load();
  });
  assert.strictEqual(loader.load(), first);
  await assert.rejects(first, failure);
  assert.strictEqual(loader.load(), first, 'A failed attempt stays cached until explicit retry');
  assert.equal(initialCalls, 1);
  let retry!: Promise<typeof module>;
  assert.doesNotThrow(() => {
    retry = loader.retry();
  });
  assert.strictEqual(loader.retry(), retry);
  await assert.rejects(retry, failure);
  assert.strictEqual(await loader.retry(), module);
  assert.strictEqual(await loader.load(), module);
  assert.equal(retryCalls, 2);
});

test('explicit module recovery preserves the pinned namespace, caches success and never cache-busts evaluation errors', async () => {
  const base = 'https://rivet.example/assets/release-1/host.js';
  const target = 'https://rivet.example/assets/release-1/CodeEditor-hash.js';
  const failure = new Error(`Failed to fetch dynamically imported module: ${target}`);
  const calls: string[] = [];
  const module = { default: 'fixture' };
  let loads = 0;
  const loader = createRetryableModuleLoader(
    async () => {
      loads++;
      throw failure;
    },
    base,
    async (url) => {
      calls.push(url);
      if (calls.length === 1) throw failure;
      return module;
    },
  );
  await assert.rejects(loader.load(), failure);
  await assert.rejects(loader.load(), failure);
  assert.equal(loads, 1, 'No background retry after a rejected preload');
  const firstRetry = loader.retry();
  assert.strictEqual(loader.retry(), firstRetry, 'Concurrent explicit retries share one pending module');
  await assert.rejects(firstRetry, failure);
  assert.strictEqual(await loader.retry(), module);
  assert.deepEqual(calls, [`${target}?__rivet_import_retry=1`, `${target}?__rivet_import_retry=2`]);
  assert.strictEqual(await loader.load(), module);
  assert.strictEqual(await loader.retry(), module);
  assert.equal(calls.length, 2);
  for (const url of [
    'https://evil.example/assets/release-1/a.js',
    'https://rivet.example/assets/release-2/a.js',
    'https://rivet.example/assets/release-1/../other/a.js',
    'https://rivet.example/assets/release-1/%2e%2e%2fother/a.js',
    'https://user:secret@rivet.example/assets/release-1/a.js',
    'https://rivet.example/assets/release-1/a.json',
    'data:text/javascript,throw 1',
  ])
    assert.equal(
      getRetryableModuleUrl(new Error(`Failed to fetch dynamically imported module: ${url}`), base),
      undefined,
    );
  assert.equal(getRetryableModuleUrl(new Error('Module initialization failed'), base), undefined);
  assert.equal(getRetryableModuleUrl({ message: failure.message }, base), undefined);
  let attempts = 0;
  const evaluation = createRetryableModuleLoader(
    async () => {
      if (++attempts === 1) throw new Error('Module initialization failed');
      return module;
    },
    base,
    async () => {
      throw new Error('Must not import a second URL for an evaluation failure');
    },
  );
  await assert.rejects(evaluation.load());
  assert.strictEqual(await evaluation.retry(), module);
});
