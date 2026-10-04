import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenerationStore, bundlePrefix } from './generations.mjs';
import { createTunnelServer } from './server.mjs';

// test-style: fixture-read: inspect only this test's generated bundle artifacts, never production implementation text.

async function fixture(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rivet-tunnel-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'build');
  await mkdir(output);
  await writeFile(path.join(output, 'index.html'), '<html><head><script src="./entry.js"></script></head></html>');
  await writeFile(path.join(output, 'entry.js'), 'export const value = 1;');
  const store = new GenerationStore(path.join(root, 'cache'), options);
  await store.initialize();
  const state = { session: 'test', phase: 'building', generation: null };
  const api = createTunnelServer(store, state);
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeClients();
    api.server.closeAllConnections();
    await new Promise((resolve) => api.server.close(resolve));
  });
  return { store, output, state, ...api, base: `http://127.0.0.1:${api.server.address().port}` };
}

test('immutable generations pin HTML, lazy chunks and workers across successful rebuilds', async (t) => {
  const { store, output, base } = await fixture(t);
  assert.equal((await fetch(base + '/readyz')).status, 503);
  const first = await store.publish(output);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, new RegExp(`base href="${bundlePrefix}${first}/"`));
  assert.ok(html.indexOf('<base') < html.indexOf('<script'));
  await writeFile(path.join(output, 'entry.js'), 'export const value = 2;');
  const second = await store.publish(output);
  assert.notEqual(first, second);
  assert.match(await (await fetch(base + `/?editor&devBuild=${first}`)).text(), new RegExp(first));
  const old = await fetch(base + `${bundlePrefix}${first}/entry.js`);
  assert.match(old.headers.get('cache-control'), /immutable/);
  assert.match(old.headers.get('cache-control'), /^private,/);
  assert.match(await old.text(), /value = 1/);
  assert.match(await (await fetch(base + `${bundlePrefix}${second}/entry.js`)).text(), /value = 2/);
  assert.equal((await fetch(base + `${bundlePrefix}${second}/missing.js`)).status, 404);
});

test('incomplete builds and disk/generation budgets retain the last successful generation', async (t) => {
  const { store, output, base } = await fixture(t, { maxBytes: 512 });
  const first = await store.publish(output);
  await writeFile(path.join(output, 'index.html'), '<head><script src="./missing.js"></script></head>');
  await assert.rejects(store.publish(output), /ENOENT/);
  await writeFile(path.join(output, 'index.html'), '<head><script src="./entry.js"></script></head>');
  await writeFile(path.join(output, 'entry.js'), 'x'.repeat(1024));
  await assert.rejects(store.publish(output), /disk budget/);
  assert.equal(store.latest, first);
  assert.equal(
    (await readdir(store.root)).some((name) => name.startsWith('pending-')),
    false,
  );
  assert.match(await (await fetch(base + '/')).text(), new RegExp(first));
  store.maxGenerations = 1;
  await assert.rejects(store.publish(output), /cache is full/);
});

test('content addressing deduplicates files and cannot mutate previous HTML', async (t) => {
  const { store, output } = await fixture(t);
  const first = await store.publish(output);
  const bytes = store.bytes;
  await store.publish(output);
  assert.equal(store.bytes, bytes);
  assert.match(await readFile(path.join(store.directory(first), 'page.html'), 'utf8'), new RegExp(first));
  assert.doesNotMatch(await readFile(path.join(store.directory(first), 'index.html'), 'utf8'), /rivet-dev-generation/);
});

test('corrupt pooled objects fail closed and abandoned staging is cleaned without deleting generations', async (t) => {
  const { store, output } = await fixture(t);
  const first = await store.publish(output);
  const [object] = await readdir(path.join(store.root, 'objects'));
  await writeFile(path.join(store.root, 'objects', object), 'corrupt');
  await assert.rejects(store.publish(output), /object is corrupt/);
  assert.equal(store.latest, first);
  const staging = path.join(store.root, 'pending-11111111-1111-4111-8111-111111111111');
  await mkdir(staging);
  await writeFile(path.join(staging, 'partial'), 'partial');
  await store.initialize();
  assert.equal(
    (await readdir(store.root)).some((name) => name.startsWith('pending-')),
    false,
  );
  assert.ok((await readdir(path.join(store.root, 'generations'))).includes(first));
});

test('status SSE sends initial state and updates; traversal and invalid methods fail closed', async (t) => {
  const { store, output, base, state, publish } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(base + '/__rivet_dev/events', { signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /building/);
  state.phase = 'ready';
  state.generation = await store.publish(output);
  publish();
  assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
  controller.abort();
  assert.equal((await fetch(base + '/__rivet_dev/events', { method: 'HEAD' })).status, 405);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/?devBuild=invalid')).status, 404);
  assert.equal((await fetch(base + `${bundlePrefix}${store.latest}/%5csecret`)).status, 404);
  assert.equal((await fetch(base + `${bundlePrefix}%ZZ`)).status, 404);
});

test('asset compression honors explicit refusal and valid gzip quality', async (t) => {
  const { store, output, base } = await fixture(t);
  const generation = await store.publish(output);
  const url = `${base}${bundlePrefix}${generation}/entry.js`;
  for (const encoding of ['gzip;q=0', 'gzip;q=0, br', 'gzip;q=invalid', 'gzip;q=2', 'identity']) {
    const response = await fetch(url, { headers: { 'accept-encoding': encoding } });
    assert.equal(response.headers.get('content-encoding'), null, encoding);
    assert.match(await response.text(), /value = 1/);
  }
  const compressed = await fetch(url, { headers: { 'accept-encoding': 'br, GZIP; q=0.5' } });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.match(await compressed.text(), /value = 1/);
});

test('failed publication objects are reclaimed without removing any retained generation', async (t) => {
  const { store, output } = await fixture(t, { maxBytes: 512 });
  const first = await store.publish(output);
  const before = store.bytes;
  // This new object is pooled before the larger entry fails the disk budget.
  await writeFile(path.join(output, 'aaa.js'), 'export const orphan = true;');
  await writeFile(path.join(output, 'entry.js'), 'x'.repeat(1024));
  await assert.rejects(store.publish(output), /disk budget/);
  assert.ok(store.bytes > before);
  await store.initialize();
  assert.equal(store.bytes, before);
  assert.match(await readFile(path.join(store.directory(first), 'entry.js'), 'utf8'), /value = 1/);
  await writeFile(path.join(output, 'entry.js'), 'export const value = 2;');
  await assert.doesNotReject(store.publish(output));
  assert.match(await readFile(path.join(store.directory(first), 'entry.js'), 'utf8'), /value = 1/);
});
