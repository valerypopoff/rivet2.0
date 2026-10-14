import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { decodeManagedArtifact, prepareManagedTextArtifact } from '../routes/workflows/managed/artifact-descriptor.js';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { createDeferred } from './helpers/managed-backend-harness.js';

// Verify the wire signature after emulating Google's modification of this header.
// Checking only a mocked SDK command would miss both signing and transcoding.
function verifyWireSignature(req: IncomingMessage): void {
  const authorization = String(req.headers.authorization);
  const [, credential, signedHeaders, signature] = authorization.match(
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=(.+)$/,
  )!;
  const [accessKey, date, region, service, terminator] = credential!.split('/');
  assert.equal(accessKey, 'test-access-key');
  const headers = signedHeaders!.split(';');
  assert.ok(!headers.includes('accept-encoding'));
  const forwarded = { ...req.headers, 'accept-encoding': `${req.headers['accept-encoding']},gzip(gfe)` };
  const url = new URL(req.url!, 'http://localhost');
  const query = [...url.searchParams]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const canonical = [
    req.method,
    url.pathname,
    query,
    headers
      .map(
        (name) =>
          `${name}:${String(forwarded[name as keyof typeof forwarded])
            .trim()
            .replace(/\s+/g, ' ')}\n`,
      )
      .join(''),
    signedHeaders,
    req.headers['x-amz-content-sha256'],
  ].join('\n');
  const scope = [date, region, service, terminator].join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    req.headers['x-amz-date'],
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  let key: Buffer = Buffer.from('AWS4test-secret-key');
  for (const part of [date, region, service, terminator]) key = createHmac('sha256', key).update(part!).digest();
  assert.equal(createHmac('sha256', key).update(stringToSign).digest('hex'), signature);
}

async function fixture(t: test.TestContext) {
  const objects = new Map<string, { bytes: Buffer; gzip: boolean }>();
  const requests: Array<{ method: string; encoding: string | undefined }> = [];
  const failures: unknown[] = [];
  let mode: 'normal' | 'retry' | 'overflow' | 'truncated' | 'corrupt' | 'stalled' = 'normal';
  let retries = 0;
  const closed = createDeferred<void>();
  const stalled = createDeferred<void>();
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    requests.push({ method: req.method!, encoding: req.headers['accept-encoding'] });
    const key = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname.replace('/bucket/', ''));
    if (req.method === 'PUT') {
      assert.equal(req.headers['accept-encoding'], undefined);
      if (key.includes('.artifact-v1.')) assert.equal(req.headers['if-none-match'], '*');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) {
        res.writeHead(412, { 'content-type': 'application/xml' });
        res.end('<Error><Code>PreconditionFailed</Code></Error>');
      } else {
        objects.set(key, { bytes: Buffer.concat(chunks), gzip: req.headers['content-encoding'] === 'gzip' });
        res.end();
      }
      return;
    }
    if (req.method === 'HEAD') {
      assert.equal(req.headers['accept-encoding'], undefined);
      res.writeHead(objects.has(key) ? 200 : 404).end();
      return;
    }
    try {
      verifyWireSignature(req);
    } catch (error) {
      failures.push(error);
      res.writeHead(403).end();
      return;
    }
    if (new URL(req.url!, 'http://localhost').searchParams.has('list-type')) {
      const xml =
        '<ListBucketResult><Name>bucket</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>';
      res.setHeader('content-type', 'application/xml');
      // Negotiation must not opt XML APIs into compressed transport responses.
      if (req.headers['accept-encoding'] === 'gzip') {
        res.setHeader('content-encoding', 'gzip');
        res.end(gzipSync(xml));
      } else res.end(xml);
      return;
    }
    if (mode === 'retry' && retries++ === 0) {
      res.writeHead(503, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SlowDown</Code></Error>');
      return;
    }
    const object = objects.get(key)!;
    // GCS expands gzip objects unless the caller explicitly accepts gzip.
    let bytes = object.gzip && req.headers['accept-encoding'] !== 'gzip' ? gunzipSync(object.bytes) : object.bytes;
    if (mode === 'overflow') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
    if (mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    if (mode === 'corrupt') {
      bytes = Buffer.from(bytes);
      bytes[0] = bytes[0]! ^ 1;
    }
    if (mode === 'stalled') {
      res.on('close', () => {
        closed.resolve();
      });
      res.writeHead(200);
      res.write(bytes.subarray(0, 1));
      stalled.resolve();
      return;
    }
    if (object.gzip && req.headers['accept-encoding'] === 'gzip') res.setHeader('content-encoding', 'gzip');
    // Exercise chunked bodies, including overflow without Content-Length.
    res.write(bytes.subarray(0, 10));
    res.end(bytes.subarray(10));
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      failures.push(error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    objectStorageBucket: 'bucket',
    objectStorageRegion: 'us-east-1',
    objectStorageEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objectStorageAccessKeyId: 'test-access-key',
    objectStorageSecretAccessKey: 'test-secret-key',
    objectStoragePrefix: '',
    objectStorageForcePathStyle: true,
  };
  const store = new S3ManagedWorkflowBlobStore(config);
  t.after(async () => {
    store.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    assert.deepEqual(failures, []);
  });
  return {
    store,
    config,
    objects,
    requests,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    closed: closed.promise,
    stalled: stalled.promise,
  };
}

test('real S3 transport preserves compressed bytes and signatures without changing upload metadata', async (t) => {
  const f = await fixture(t);
  const text = 'recording payload 🦊\n'.repeat(1000);
  const artifact = await prepareManagedTextArtifact('workflow/recordings/run/recording.rivet-recording', text, true);
  await f.store.putArtifact(artifact.descriptor, artifact.bytes);
  const stored = f.objects.get(artifact.descriptor.key)!;
  assert.equal(stored.gzip, true);
  assert.equal(stored.bytes.length, artifact.descriptor.storedBytes);
  assert.ok(stored.bytes.length < Buffer.byteLength(text));

  // Demonstrate the failure with the unmodified SDK before checking the fix.
  const originalClient = new S3Client({
    endpoint: f.config.objectStorageEndpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
  });
  try {
    const response = await originalClient.send(
      new GetObjectCommand({ Bucket: 'bucket', Key: artifact.descriptor.key }),
    );
    const expanded = await response.Body!.transformToByteArray();
    assert.equal(expanded.byteLength, artifact.descriptor.decodedBytes);
    await assert.rejects(decodeManagedArtifact(expanded, artifact.descriptor), /size/);
  } finally {
    originalClient.destroy();
  }

  for (const filename of ['recording.rivet-recording', 'replay-project.rivet-project', 'replay-dataset.rivet-data']) {
    const payload = await prepareManagedTextArtifact(`workflow/recordings/run/${filename}`, text, true);
    await f.store.putArtifact(payload.descriptor, payload.bytes);
    await f.store.putArtifact(payload.descriptor, payload.bytes); // 412 read/verify path
    assert.deepEqual(Buffer.from(await f.store.getBytes(payload.descriptor.key)), payload.bytes);
    assert.equal(await f.store.getText(payload.descriptor.key), text);
    assert.equal(await f.store.exists(payload.descriptor.key), true);
  }
  const identity = await prepareManagedTextArtifact('workflow/revision', text, false);
  await f.store.putArtifact(identity.descriptor, identity.bytes);
  assert.equal(await f.store.getText(identity.descriptor.key), text);
  await f.store.putText('legacy', 'legacy text');
  assert.equal(await f.store.getText('legacy'), 'legacy text');
  f.setMode('retry');
  const start = f.requests.length;
  assert.equal(await f.store.getText(artifact.descriptor.key), text);
  assert.equal(f.requests.length - start, 2);
  assert.ok(f.requests.slice(start).every((request) => request.encoding === 'gzip'));
});

test('bucket listing GETs do not opt into response compression', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.listPage({ pageSize: 100 }), { objects: [] });
  assert.deepEqual(f.requests, [{ method: 'GET', encoding: undefined }]);
});

test('cancellation during local decoding cannot turn an object read into success', async (t) => {
  const f = await fixture(t);
  const artifact = await prepareManagedTextArtifact(
    'workflow/recordings/run/recording.rivet-recording',
    'payload',
    true,
  );
  await f.store.putArtifact(artifact.descriptor, artifact.bytes);
  const controller = new AbortController();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = decoder.decode.bind(decoder);
  let cancelledDuringDecode = false;
  t.mock.method(TextDecoder.prototype, 'decode', (...args: Parameters<TextDecoder['decode']>) => {
    // Deterministic cancellation at decode completion, without relying on zlib timing.
    if (args[0] instanceof Uint8Array && Buffer.from(args[0]).equals(Buffer.from('payload'))) {
      cancelledDuringDecode = true;
      controller.abort(new Error('cancelled while decoding'));
    }
    return decode(...args);
  });
  await assert.rejects(
    f.store.getText(artifact.descriptor.key, { signal: controller.signal }),
    /cancelled while decoding/,
  );
  assert.equal(cancelledDuringDecode, true);
});

test(
  'real object downloads still reject corrupt, truncated and oversized bodies and cancel stalled reads',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const artifact = await prepareManagedTextArtifact(
      'workflow/recordings/run/recording.rivet-recording',
      'payload'.repeat(1000),
      true,
    );
    await f.store.putArtifact(artifact.descriptor, artifact.bytes);
    for (const mode of ['overflow', 'truncated', 'corrupt'] as const) {
      f.setMode(mode);
      await assert.rejects(f.store.getText(artifact.descriptor.key), /size|checksum/);
    }
    f.setMode('stalled');
    const controller = new AbortController();
    const reading = assert.rejects(
      f.store.getBytes(artifact.descriptor.key, { signal: controller.signal }),
      /abort|cancellation/i,
    );
    // Wait for headers/body arrival rather than racing cancellation before dispatch.
    try {
      await f.stalled;
      controller.abort(new Error('test cancellation'));
      await reading;
      await f.closed;
    } finally {
      controller.abort();
    }
  },
);
