import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { S3Assets } from './s3.mjs';
import { BuildAssets, hash, parseManifest, validName, pageForBuild } from './assets.mjs';
import { productionServer } from './server.mjs';

// test-style: fixture-write: builds and object bytes exist only in a test-owned temporary directory/map.
export function memoryStore() {
  const objects = new Map(), calls = [];
  const client = {
    async send(command) {
      const { Key: key, Body: body, Metadata: metadata } = command.input;
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === 'PutObjectCommand') {
        assert.equal(command.input.IfNoneMatch, '*');
        assert.equal(command.input.ContentEncoding, undefined);
        if (!objects.has(key)) objects.set(key, { body: Buffer.from(body), metadata });
        return {};
      }
      const object = objects.get(key);
      if (!object) throw Object.assign(Error('Missing'), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: object.body.length, Metadata: object.metadata,
        ...(name === 'GetObjectCommand' ? { Body: Readable.from([object.body]) } : {}) };
    },
    destroy() {},
  };
  return { store: new S3Assets(client, { bucket: 'fixture', prefix: 'installation/web/' }), objects, calls, client };
}

export async function fixture(t, version) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rivet-web-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), '<html><head><script type="module" src="./assets/entry.js"></script></head><body>Rivet</body></html>');
  await writeFile(path.join(root, 'assets', 'entry.js'), `window.version=${JSON.stringify(version)};window.lazy=()=>import('./lazy.js');window.worker=()=>new Worker(new URL('./worker.js',import.meta.url));`);
  await writeFile(path.join(root, 'assets', 'lazy.js'), `export default ${JSON.stringify(version)};`);
  await writeFile(path.join(root, 'assets', 'worker.js'), `postMessage(${JSON.stringify(version)});`);
  return root;
}

export async function listen(t, root, store) {
  const value = await productionServer({ root, store, logger: { error() {} } });
  value.server.listen(0, '127.0.0.1'); await once(value.server, 'listening');
  t.after(() => new Promise(resolve => { value.server.closeAllConnections(); value.server.close(resolve); }));
  return { ...value, url: `http://127.0.0.1:${value.server.address().port}` };
}

test('mixed replicas serve the same pinned import graph after the original owner is gone', async t => {
  const { store, calls } = memoryStore();
  const first = await listen(t, await fixture(t, 'old'), store);
  const second = await listen(t, await fixture(t, 'new'), store);
  assert.notEqual(first.assets.current.id, second.assets.current.id);
  const id = first.assets.current.id;
  first.server.closeAllConnections(); await new Promise(resolve => first.server.close(resolve));
  const page = await fetch(`${second.url}/?editor&webBuild=${id}`);
  assert.match(await page.text(), new RegExp(`<base href="/__rivet_web/${id}/">`));
  for (const name of ['entry.js', 'lazy.js', 'worker.js']) {
    const response = await fetch(`${second.url}/__rivet_web/${id}/assets/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /old/);
  }
  assert.equal((await fetch(`${second.url}/__rivet_web/${id}/assets/absent.js`)).status, 404);
  assert.equal((await fetch(`${second.url}/?webBuild=${'0'.repeat(64)}`)).status, 404);
  assert.equal(calls.some(c => /Delete|List/.test(c.name)), false);
});

test('publication is deterministic, deduplicated, compressed and fail-closed before readiness', async t => {
  const { store, calls, client } = memoryStore();
  const root = await fixture(t, 'one');
  const first = new BuildAssets(root, store); await first.initialize();
  const writes = calls.filter(c => c.name === 'PutObjectCommand').length;
  const second = new BuildAssets(root, store); await second.initialize();
  assert.equal(first.current.id, second.current.id);
  assert.equal(calls.filter(c => c.name === 'PutObjectCommand').length, writes);
  assert.equal(calls.filter(c => c.name === 'PutObjectCommand').at(-1).input.Key, `installation/web/${first.current.id}.gz`);
  client.send = async () => { throw Error('Storage offline'); };
  await assert.rejects(productionServer({ root, store }), /Storage offline/);
});

test('uncertain create acknowledgement is reconciled without replay or overwrite', async () => {
  const { store, client, calls } = memoryStore();
  const send = client.send.bind(client);
  client.send = async command => {
    const result = await send(command);
    if (command.constructor.name === 'PutObjectCommand') throw Error('Acknowledgement lost');
    return result;
  };
  await store.put(hash('raw'), Buffer.from('compressed-fixture'), 3);
  assert.equal(calls.filter(c => c.name === 'PutObjectCommand').length, 1);
});

test('corrupt immutable objects are rejected rather than overwritten or treated as a missing build', async () => {
  const { store, objects, calls } = memoryStore();
  const id = hash('raw');
  objects.set(`installation/web/${id}.gz`, { body: Buffer.from('invalid'), metadata: { sha256: hash('other'), bytes: '3' } });
  await assert.rejects(store.put(id, Buffer.from('replacement'), 3), /identity is unconfirmed/);
  await assert.rejects(store.get(id, 3), /identity is unconfirmed/);
  assert.equal(calls.some(c => c.name === 'PutObjectCommand'), false);
});

test('HTTP methods, uncompressed/HEAD/conditional reads and traversal cannot escape the build', async t => {
  const { store } = memoryStore();
  const first = await listen(t, await fixture(t, 'old'), store);
  const second = await listen(t, await fixture(t, 'new'), store);
  const url = `${second.url}/__rivet_web/${first.assets.current.id}/assets/lazy.js`;
  const response = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(response.headers.get('content-encoding'), null);
  assert.match(await response.text(), /old/);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(url, { headers: { 'if-none-match': response.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  for (const name of ['../secret', '/etc/passwd', 'assets/../../key', 'assets/%2fkey', 'assets\\key', 'assets//key'])
    assert.equal(validName(name), false);
  const body = Buffer.from('{"version":1,"files":[]}');
  assert.throws(() => parseManifest(hash(body), body), /Invalid/);
  assert.throws(() => pageForBuild('<head><base href="/other">', first.assets.current.id), /Invalid/);
});
