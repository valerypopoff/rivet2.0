import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  prepareManagedTextArtifact,
  parseManagedArtifactDescriptor,
  decodeManagedArtifact,
} from '../routes/workflows/managed/artifact-descriptor.js';
import {
  S3ManagedWorkflowBlobStore,
  isManagedWorkflowArtifactObjectKey,
} from '../routes/workflows/managed/blob-store.js';

test('managed artifact descriptors verify compressed and legacy text without trusting object metadata', async () => {
  for (const compress of [false, true]) {
    const text = 'Image and recording data 🦊\n'.repeat(1000);
    const artifact = await prepareManagedTextArtifact(
      'workflow/recordings/run/recording.rivet-recording',
      text,
      compress,
    );
    assert.equal(await decodeManagedArtifact(artifact.bytes, artifact.descriptor), text);
    assert.ok(isManagedWorkflowArtifactObjectKey(artifact.descriptor.key));
    if (compress) assert.ok(artifact.descriptor.storedBytes < artifact.descriptor.decodedBytes);
    const corrupt = Buffer.from(artifact.bytes);
    corrupt[0] = corrupt[0]! ^ 1;
    await assert.rejects(decodeManagedArtifact(corrupt, artifact.descriptor), /checksum/);
    await assert.rejects(
      decodeManagedArtifact(artifact.bytes, { ...artifact.descriptor, decodedBytes: text.length + 1 }),
    );
    await assert.rejects(
      decodeManagedArtifact(artifact.bytes, { ...artifact.descriptor, encoding: compress ? 'identity' : 'gzip' }),
      /descriptor differs/,
    );
  }
  assert.equal(await decodeManagedArtifact(Buffer.from('legacy text'), null), 'legacy text');
  assert.throws(() => parseManagedArtifactDescriptor('bad.artifact-v1.123'), /Malformed/);
});

test('S3 artifacts are conditionally immutable and bounded while streaming', async (t) => {
  const objects = new Map<string, Buffer>();
  t.mock.method(S3Client.prototype, 'send', async (command: GetObjectCommand | PutObjectCommand) => {
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, '*');
      if (objects.has(command.input.Key!)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    const bytes = objects.get(command.input.Key!)!;
    return { Body: Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]), ContentLength: bytes.length };
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
    const artifact = await prepareManagedTextArtifact(
      'workflow/recordings/run/recording.rivet-recording',
      'sample'.repeat(1000),
      true,
    );
    await store.putArtifact(artifact.descriptor, artifact.bytes);
    await store.putArtifact(artifact.descriptor, artifact.bytes);
    assert.equal(await store.getText(artifact.descriptor.key), 'sample'.repeat(1000));
    objects.set(artifact.descriptor.key, Buffer.concat([artifact.bytes, Buffer.from('unexpected')]));
    await assert.rejects(store.getBytes(artifact.descriptor.key), /expected size/);
    objects.set(artifact.descriptor.key, Buffer.alloc(artifact.bytes.length));
    await assert.rejects(store.putArtifact(artifact.descriptor, artifact.bytes), /checksum/);
  } finally {
    store.dispose();
  }
});

test('gzip output cannot exceed the immutable decoded size and streaming cannot bypass size limits', async (t) => {
  const artifact = await prepareManagedTextArtifact(
    'workflow/recordings/run/recording.rivet-recording',
    'payload'.repeat(1000),
    true,
  );
  const key = `workflow/recordings/run/recording.rivet-recording.artifact-v1.${createHash('sha256').update(artifact.bytes).digest('hex')}.${artifact.bytes.length}.1.gzip`;
  await assert.rejects(decodeManagedArtifact(artifact.bytes, parseManagedArtifactDescriptor(key)));
  let stream: Readable | undefined;
  t.mock.method(S3Client.prototype, 'send', async () => ({
    Body: (stream = Readable.from([artifact.bytes, Buffer.from('extra')])),
  }));
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
    await assert.rejects(store.getBytes(artifact.descriptor.key), /expected size/);
    assert.equal(stream?.destroyed, true);
  } finally {
    store.dispose();
  }
});
