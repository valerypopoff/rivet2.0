import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createAssetStore } from './s3.mjs';
import { hash } from './assets.mjs';
import { signGoogleXmlPrecondition } from '../../studio-server-shared/gcs-xml-signing.ts';

test('Google guarded signing leaves ordinary S3 untouched and rejects unknown signing identity', () => {
  const ordinary = { method: 'PUT', path: '/bucket/key', headers: { authorization: 'original' } };
  signGoogleXmlPrecondition(ordinary, 'secret');
  assert.deepEqual(ordinary.headers, { authorization: 'original' });
  const guarded = { method: 'PUT', path: '/bucket/key', headers: { 'x-goog-if-generation-match': '0' } };
  assert.throws(() => signGoogleXmlPrecondition(guarded, 'secret'), /signing identity/);
  assert.deepEqual(guarded.headers, { 'x-goog-if-generation-match': '0' });
  assert.throws(() => signGoogleXmlPrecondition({ ...guarded, headers: { ...guarded.headers,
    authorization: `AWS4-HMAC-SHA256 Credential=key/20261017/region/s3/aws4_request, SignedHeaders=host, Signature=${'a'.repeat(64)}`,
  } }, 'secret'), /incomplete signed headers/);
});

test('real signed XML transport preserves compressed bytes and Google create preconditions', async t => {
  const data = Buffer.from('console.log("retained build")');
  const id = hash(data), compressed = gzipSync(data), requests = [];
  let present = false;
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, headers: req.headers, url: req.url });
    if (req.method === 'HEAD' && !present) { res.writeHead(404).end(); return; }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), compressed);
      assert.equal(req.headers['content-encoding'], undefined);
      assert.equal(req.headers['x-goog-if-generation-match'], '0');
      assert.match(req.headers.authorization, /^GOOG4-HMAC-SHA256 .*x-goog-if-generation-match/);
      assert.equal(Object.keys(req.headers).some(name => name.startsWith('x-amz-')), false,
        'GCS rejects mixed extension-header dialects even when the guard is signed');
      assert.equal(req.headers['x-goog-meta-sha256'], id);
      present = true; res.end(); return;
    }
    res.writeHead(200, { 'content-length': compressed.length, 'x-amz-meta-sha256': id,
      'x-amz-meta-bytes': data.length, 'content-type': 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : compressed);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const store = createAssetStore({ RIVET_WEB_ASSETS_INSTALLATION: 'fixture-installation',
    RIVET_DEPLOYMENT_STORAGE_BUCKET: 'fixture', RIVET_DEPLOYMENT_STORAGE_REGION: 'us-east-1',
    RIVET_DEPLOYMENT_STORAGE_ENDPOINT: 'https://storage.googleapis.com',
    RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: 'true',
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: 'fixture', RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: 'fixture' });
  const handler = store.client.config.requestHandler;
  // Keep the real production factory/signing path; redirect only its socket to
  // this loopback XML fixture, never the actual provider or an ambient bucket.
  store.client.config.requestHandler = { handle(request, options) {
    request.protocol = 'http:'; request.hostname = '127.0.0.1'; request.port = server.address().port;
    return handler.handle(request, options);
  }, destroy() { handler.destroy(); } };
  t.after(() => store.dispose());
  await store.put(id, compressed, data.length);
  await store.put(id, compressed, data.length);
  assert.deepEqual(await (await store.get(id, data.length)).bytes(), compressed);
  assert.equal(requests.filter(r => r.method === 'PUT').length, 1);
  assert.ok(requests.every(r => r.url.startsWith(`/fixture/${store.config.prefix}${id}.gz`)));
});
