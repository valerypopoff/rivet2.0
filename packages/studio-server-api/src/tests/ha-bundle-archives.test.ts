import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { S3Client } from '@aws-sdk/client-s3';
import { SharedBundleArchives, BundlePublicationUncertainError, createSharedBundleArchiveClient } from '../ha-bundle-archives.js';
import { createManagedWorkflowS3ClientConfig } from '../routes/workflows/managed/blob-store.js';

test('the production export client never lets SDK retry an uncertain multipart allocation', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; req.resume();
    res.statusCode = 503; res.setHeader('Content-Type', 'application/xml');
    res.end('<Error><Code>SlowDown</Code><Message>Unconfirmed allocation</Message></Error>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = createSharedBundleArchiveClient({ objectStorageBucket: 'owned', objectStoragePrefix: 'owned/', objectStorageEndpoint: `http://127.0.0.1:${address.port}`,
    objectStorageRegion: 'fixture', objectStorageForcePathStyle: true,
    objectStorageAccessKeyId: 'fixture', objectStorageSecretAccessKey: 'fixture' });
  try {
    const exports = new SharedBundleArchives({ client, epoch: () => 'a', location: key => ({ Bucket: 'owned', Key: `${key}/` }) });
    await assert.rejects(exports.publish({ id: randomUUID() } as any, 'never-opened.zip'), BundlePublicationUncertainError);
    assert.equal(requests, 1);
  } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('lost multipart initialization never retries or pretends cleanup is confirmed', async () => {
  for (const response of [new Error('connection lost'), {}]) {
    const commands: string[] = [];
    const exports = new SharedBundleArchives({ epoch: () => 'a', location: key => ({ Bucket: 'owned', Key: `${key}/` }),
      client: { send: async (command: object) => {
        commands.push(command.constructor.name);
        if (response instanceof Error) throw response;
        return response;
      } } as unknown as S3Client });
    await assert.rejects(exports.publish({ id: randomUUID() } as any, 'never-opened.zip'), BundlePublicationUncertainError);
    assert.deepEqual(commands, ['CreateMultipartUploadCommand']);
  }
});

test('lost manifest acknowledgement reconciles the exact immutable export without re-upload or deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-export-'));
  try {
    const bytes = Buffer.from('compressed archive fixture');
    const file = path.join(root, 'archive.zip'); await fs.writeFile(file, bytes);
    const status = { id: randomUUID(), phase: 'ready', archiveBytes: bytes.length,
      archiveHash: createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(Date.now() + 60_000).toISOString() } as any;
    let durable: string | undefined; const commands: string[] = [];
    const exports = new SharedBundleArchives({ epoch: () => 'a', location: key => ({ Bucket: 'owned', Key: `${key}/` }),
      client: { send: async (command: any) => {
        commands.push(command.constructor.name);
        switch (command.constructor.name) {
          case 'CreateMultipartUploadCommand': return { UploadId: 'one-upload' };
          case 'UploadPartCommand': assert.deepEqual(command.input.Body, bytes); return { ETag: 'part' };
          case 'CompleteMultipartUploadCommand': return { VersionId: 'immutable-version' };
          case 'HeadObjectCommand': return { ETag: 'archive', ContentLength: bytes.length, Metadata: { sha256: status.archiveHash } };
          case 'PutObjectCommand': durable = command.input.Body; throw new Error('committed but response lost');
          case 'AbortMultipartUploadCommand': return {};
          case 'GetObjectCommand': return { Body: Readable.from([durable!]), ETag: 'manifest' };
          default: throw new Error('Unexpected export operation');
        }
      } } as unknown as S3Client });
    await exports.publish(status, file);
    assert.equal(commands.filter(c => c === 'CreateMultipartUploadCommand').length, 1);
    assert.equal(commands.filter(c => c === 'PutObjectCommand').length, 1);
    assert.equal(commands.includes('DeleteObjectCommand'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared exports enforce epoch, immutable body identity and scoped version deletion', async () => {
  const id = randomUUID(), objectId = randomUUID(), hash = 'a'.repeat(64);
  let epoch = 'old'; const commands: { name: string; input: any }[] = [];
  const body = Buffer.from('zip');
  const manifest = { workspaceEpoch: 'old', status: { id, phase: 'ready', archiveBytes: body.length, archiveHash: hash, expiresAt: new Date(Date.now() + 100_000).toISOString() }, archive: { objectId, etag: 'archive-etag', versionId: 'archive-version' } };
  const client = { send: async (command: any) => {
    commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'GetObjectCommand') {
      if (command.input.Key.endsWith('status.json')) return { Body: Readable.from([JSON.stringify(manifest)]), ETag: 'manifest-etag', VersionId: 'manifest-version' };
      return { Body: Readable.from([body]), ContentLength: body.length, Metadata: { sha256: hash } };
    }
    return {};
  } } as unknown as S3Client;
  const exports = new SharedBundleArchives({ client, epoch: () => epoch, location: key => ({ Bucket: 'owned', Key: `installation/${key}/` }) });
  const ready = await exports.read(id); assert.ok(ready);
  const stream = await exports.open(id, ready);
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), body);
  const get = commands.find(x => x.input.Key.endsWith('.zip'))!;
  assert.equal(get.input.VersionId, 'archive-version');
  epoch = 'new'; assert.equal(await exports.read(id), undefined);
  await exports.remove(id);
  assert.deepEqual(commands.filter(x => x.name === 'DeleteObjectCommand').map(x => [x.input.Bucket, x.input.VersionId]), [['owned', 'archive-version'], ['owned', 'manifest-version']]);
  assert.ok(commands.every(x => x.input.Key.startsWith(`installation/${id}/`)));
  await assert.rejects(exports.read('../foreign'), /Invalid export identity/);
});

test('oversized manifests and changed archive metadata fail closed and close response streams', async () => {
  const id = randomUUID(); let stream = Readable.from(['x'.repeat(65537)]);
  const exports = new SharedBundleArchives({ epoch: () => 'a', location: key => ({ Bucket: 'owned', Key: `${key}/` }),
    client: { send: async () => ({ Body: stream, ContentLength: 1, Metadata: { sha256: 'changed' } }) } as unknown as S3Client });
  await assert.rejects(exports.read(id), /oversized/); assert.equal(stream.destroyed, true);
  stream = Readable.from(['bytes']);
  const manifest = { workspaceEpoch: 'a', status: { id, phase: 'ready', archiveBytes: 5, archiveHash: 'a'.repeat(64) }, archive: { objectId: randomUUID(), etag: 'old' } } as any;
  await assert.rejects(exports.open(id, manifest), /identity changed/); assert.equal(stream.destroyed, true);
});

test('Google XML export publication, exact-generation reads and deletes use signed generation guards', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-google-export-'));
  const bytes = Buffer.from('zip bytes'), hash = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID(); let manifest: string | undefined;
  const observed: Array<{ method: string; generation: string | null; guard?: string }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    observed.push({ method: req.method!, generation: url.searchParams.get('generation'), guard: req.headers['x-goog-if-generation-match'] as string | undefined });
    const isManifest = url.pathname.endsWith('status.json');
    res.setHeader('ETag', isManifest ? '"manifest"' : '"archive"');
    res.setHeader('x-goog-generation', isManifest ? '44' : '33');
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      res.setHeader('Content-Type', 'application/xml');
      res.end('<InitiateMultipartUploadResult><Bucket>owned</Bucket><Key>archive</Key><UploadId>owned-upload</UploadId></InitiateMultipartUploadResult>');
    } else if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      assert.deepEqual(body, bytes); res.end();
    } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      res.setHeader('Content-Type', 'application/xml');
      res.end('<CompleteMultipartUploadResult><Bucket>owned</Bucket><Key>archive</Key><ETag>"archive"</ETag></CompleteMultipartUploadResult>');
    } else if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(bytes.length)); res.setHeader('x-amz-meta-sha256', hash); res.end();
    } else if (req.method === 'PUT' && isManifest) {
      assert.equal(req.headers['x-goog-if-generation-match'], '0');
      assert.match(String(req.headers.authorization), /^GOOG4-HMAC-SHA256 .*x-goog-if-generation-match/);
      assert.equal(Object.keys(req.headers).some(name => name.startsWith('x-amz-')), false);
      manifest = body.toString(); assert.equal(JSON.parse(manifest).archive.generation, '33'); res.end();
    } else if (req.method === 'GET') {
      const payload = isManifest ? Buffer.from(manifest!) : bytes;
      res.setHeader('Content-Length', String(payload.length));
      if (!isManifest) res.setHeader('x-amz-meta-sha256', hash);
      res.end(payload);
    } else if (req.method === 'DELETE') {
      assert.equal(req.headers['x-goog-if-generation-match'], isManifest ? '44' : '33');
      assert.match(String(req.headers.authorization), /^GOOG4-HMAC-SHA256 .*x-goog-if-generation-match/);
      assert.equal(Object.keys(req.headers).some(name => name.startsWith('x-amz-')), false);
      res.statusCode = 204; res.end();
    } else { res.statusCode = 400; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new S3Client({ ...createManagedWorkflowS3ClientConfig({ objectStorageBucket: 'owned', objectStoragePrefix: '',
    objectStorageEndpoint: 'https://storage.googleapis.com', objectStorageRegion: 'fixture',
    objectStorageForcePathStyle: true, objectStorageAccessKeyId: 'fixture', objectStorageSecretAccessKey: 'fixture' }),
    endpoint: `http://127.0.0.1:${address.port}`, region: 'fixture',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, forcePathStyle: true, maxAttempts: 1 });
  const exports = new SharedBundleArchives({ client, googleStorage: true, epoch: () => 'a',
    location: key => ({ Bucket: 'owned', Key: `${key}/` }) });
  try {
    const file = path.join(root, 'archive.zip'); await fs.writeFile(file, bytes);
    await exports.publish({ id, phase: 'ready', archiveBytes: bytes.length, archiveHash: hash,
      expiresAt: new Date(Date.now() + 60_000).toISOString() } as any, file);
    const ready = await exports.read(id); assert.ok(ready);
    const stream = await exports.open(id, ready);
    const received: Buffer[] = []; for await (const chunk of stream) received.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(received), bytes);
    await exports.remove(id);
    assert.ok(observed.some(r => r.method === 'GET' && r.generation === '33'));
    assert.deepEqual(observed.filter(r => r.method === 'DELETE').map(r => r.guard), ['33', '44']);
  } finally {
    client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanup can settle after a lost archive-delete acknowledgement but never ignores changed identity', async () => {
  const id = randomUUID();
  const manifest = { workspaceEpoch: 'a', status: { id, phase: 'ready', archiveBytes: 3, archiveHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString() }, archive: { objectId: randomUUID(), etag: 'archive' } };
  for (const statusCode of [404, 412]) {
    const removed: string[] = [];
    const exports = new SharedBundleArchives({ epoch: () => 'a', location: key => ({ Bucket: 'owned', Key: `${key}/` }),
      client: { send: async (command: any) => {
        if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([JSON.stringify(manifest)]), ETag: 'manifest' };
        removed.push(command.input.Key);
        if (command.input.Key.endsWith('.zip')) throw Object.assign(new Error('delete response'), { $metadata: { httpStatusCode: statusCode } });
        return {};
      } } as unknown as S3Client });
    if (statusCode === 404) { await exports.remove(id); assert.equal(removed.length, 2); }
    else { await assert.rejects(exports.remove(id), /delete response/); assert.equal(removed.length, 1); }
  }
});
