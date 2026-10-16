import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { S3Client } from '@aws-sdk/client-s3';
import { S3Assets } from './s3.mjs';
import { hash } from './assets.mjs';

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
      assert.match(req.headers.authorization, /x-goog-if-generation-match/);
      present = true; res.end(); return;
    }
    res.writeHead(200, { 'content-length': compressed.length, 'x-amz-meta-sha256': id,
      'x-amz-meta-bytes': data.length, 'content-type': 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : compressed);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = new S3Client({ region: 'us-east-1', endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1 });
  t.after(() => client.destroy());
  const store = new S3Assets(client, { bucket: 'fixture', prefix: 'installation/web/', google: true });
  await store.put(id, compressed, data.length);
  await store.put(id, compressed, data.length);
  assert.deepEqual(await (await store.get(id, data.length)).bytes(), compressed);
  assert.equal(requests.filter(r => r.method === 'PUT').length, 1);
  assert.ok(requests.every(r => r.url.startsWith(`/fixture/installation/web/${id}.gz`)));
});
