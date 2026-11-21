import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { type GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  prepareManagedTextArtifact,
  parseManagedArtifactDescriptor,
  decodeManagedArtifact,
  ManagedArtifactSizeError,
  MAX_MANAGED_ARTIFACT_BYTES,
} from '../routes/workflows/managed/artifact-descriptor.js';
import {
  S3ManagedWorkflowBlobStore,
  isManagedWorkflowArtifactObjectKey,
} from '../routes/workflows/managed/blob-store.js';

test('managed artifact descriptors verify compressed and legacy text without trusting object metadata', async () => {
  for (const compress of ['identity', 'gzip', 'br'] as const) {
    const text = 'Image and recording data 🦊\n'.repeat(1000);
    const artifact = await prepareManagedTextArtifact(
      'workflow/recordings/run/recording.rivet-recording',
      text,
      compress,
    );
    assert.equal(await decodeManagedArtifact(artifact.bytes, artifact.descriptor), text);
    assert.ok(isManagedWorkflowArtifactObjectKey(artifact.descriptor.key));
    if (compress !== 'identity') assert.ok(artifact.descriptor.storedBytes < artifact.descriptor.decodedBytes);
    const corrupt = Buffer.from(artifact.bytes);
    corrupt[0] = corrupt[0]! ^ 1;
    await assert.rejects(decodeManagedArtifact(corrupt, artifact.descriptor), /checksum/);
    await assert.rejects(
      decodeManagedArtifact(artifact.bytes, { ...artifact.descriptor, decodedBytes: text.length + 1 }),
    );
    await assert.rejects(
      decodeManagedArtifact(artifact.bytes, {
        ...artifact.descriptor,
        encoding: compress !== 'identity' ? 'identity' : 'gzip',
      }),
      /descriptor differs/,
    );
  }
  assert.equal(await decodeManagedArtifact(Buffer.from('legacy text'), null), 'legacy text');
  assert.throws(() => parseManagedArtifactDescriptor('bad.artifact-v1.123'), /Malformed/);
  assert.throws(
    () =>
      parseManagedArtifactDescriptor(`recording.artifact-v1.${'a'.repeat(64)}.${MAX_MANAGED_ARTIFACT_BYTES + 1}.1.br`),
    ManagedArtifactSizeError,
  );
});

test('S3 artifacts are conditionally immutable and bounded while streaming', async (t) => {
  const objects = new Map<string, Buffer>();
  let contentLength = true;
  let stream: Readable;
  t.mock.method(S3Client.prototype, 'send', async (command: GetObjectCommand | PutObjectCommand) => {
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, '*');
      assert.equal(command.input.ContentEncoding, command.input.Key!.endsWith('.gzip') ? 'gzip' : undefined);
      if (objects.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    const bytes = objects.get(command.input.Key!)!;
    return {
      Body: (stream = Readable.from([bytes.subarray(0, 10), bytes.subarray(10)])),
      ...(contentLength ? { ContentLength: bytes.length } : {}),
    };
  });
  const store = new S3ManagedWorkflowBlobStore({
    objectStorageBucket: 'bucket',
    objectStorageRegion: 'us-east-1',
    objectStorageEndpoint: null,
    objectStorageAccessKeyId: 'test',
    objectStorageSecretAccessKey: 'test',
    objectStoragePrefix: '',
    objectStorageForcePathStyle: true,
  });
  try {
    for (const encoding of ['gzip', 'br'] as const) {
      const artifact = await prepareManagedTextArtifact(
        'workflow/recordings/run/recording.rivet-recording',
        'sample'.repeat(1000),
        encoding,
      );
      await store.putArtifact(artifact.descriptor, artifact.bytes);
      await store.putArtifact(artifact.descriptor, artifact.bytes);
      assert.equal(await store.getText(artifact.descriptor.key), 'sample'.repeat(1000));
      objects.set(artifact.descriptor.key, Buffer.concat([artifact.bytes, Buffer.from('unexpected')]));
      for (contentLength of [true, false]) {
        await assert.rejects(store.getBytes(artifact.descriptor.key), /expected size/);
        assert.equal(stream!.destroyed, true);
      }
      contentLength = true;
      objects.set(artifact.descriptor.key, Buffer.alloc(artifact.bytes.length));
      await assert.rejects(store.putArtifact(artifact.descriptor, artifact.bytes), /checksum/);
    }
  } finally {
    store.dispose();
  }
});

test('Brotli preserves empty and Unicode bytes at the existing artifact boundary', async () => {
  for (const text of ['', '🙂\r\n\u0000']) {
    const artifact = await prepareManagedTextArtifact(
      'workflow/recordings/empty/recording.rivet-recording',
      text,
      'br',
    );
    assert.equal(await decodeManagedArtifact(artifact.bytes, artifact.descriptor), text);
  }
});

test('compressed output respects decoded sizes and rejects truncation', async () => {
  for (const encoding of ['gzip', 'br'] as const) {
    const compressed = await prepareManagedTextArtifact(
      'workflow/recordings/run/recording.rivet-recording',
      'payload'.repeat(1000),
      encoding,
    );
    const bounded = compressed.descriptor.key.replace(
      `.${compressed.descriptor.decodedBytes}.${encoding}`,
      `.1.${encoding}`,
    );
    await assert.rejects(decodeManagedArtifact(compressed.bytes, parseManagedArtifactDescriptor(bounded)));
    const truncated = compressed.bytes.subarray(0, compressed.bytes.length - 1);
    const broken = `workflow/recordings/run/recording.rivet-recording.artifact-v1.${createHash('sha256').update(truncated).digest('hex')}.${truncated.length}.${compressed.descriptor.decodedBytes}.${encoding}`;
    await assert.rejects(decodeManagedArtifact(truncated, parseManagedArtifactDescriptor(broken)));
  }
});
