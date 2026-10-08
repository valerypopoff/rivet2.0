import { createHash } from 'node:crypto';

import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  createManagedWorkflowS3ClientConfig,
  S3ManagedWorkflowBlobStore,
  type ManagedWorkflowBlobStore,
} from '../routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';

function stageKey(sourceIdentity: string, contents: string): { key: string; hash: string } {
  const hash = createHash('sha256').update(contents).digest('hex');
  return { key: `rivet-vm-migration-staging/${sourceIdentity}/${hash}`, hash };
}

function isMissingObject(error: unknown): boolean {
  return (
    (error as { name?: string }).name === 'NotFound' ||
    (error as { name?: string }).name === 'NoSuchKey' ||
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

/** Uploads content-addressed candidates while the source remains live. Final copy never trusts a stale candidate. */
export async function precopyMigrationTexts(
  config: ManagedWorkflowStorageConfig,
  sourceIdentity: string,
  contents: Iterable<string> | AsyncIterable<string>,
): Promise<{ objects: number; bytes: number }> {
  const store = new S3ManagedWorkflowBlobStore(config);
  const client = new S3Client(createManagedWorkflowS3ClientConfig(config));
  const seen = new Set<string>();
  let bytes = 0;
  try {
    await store.initialize();
    for await (const text of contents) {
      const { key, hash } = stageKey(sourceIdentity, text);
      if (seen.has(hash)) continue;
      seen.add(hash);
      let exists = false;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.objectStorageBucket, Key: key }));
        if (head.Metadata?.sha256 !== hash) throw new Error('Staged migration object has incorrect checksum metadata.');
        exists = true;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
      if (!exists) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.objectStorageBucket,
            Key: key,
            Body: text,
            Metadata: { sha256: hash },
          }),
        );
      }
      const response = await client.send(new GetObjectCommand({ Bucket: config.objectStorageBucket, Key: key }));
      const staged = await response.Body?.transformToString();
      if (staged === undefined || createHash('sha256').update(staged).digest('hex') !== hash) {
        throw new Error('Staged migration object differs from its content hash.');
      }
      bytes += Buffer.byteLength(text);
    }
  } finally {
    store.dispose();
    client.destroy();
  }
  return { objects: seen.size, bytes };
}

/** Copies a matching staged object server-side; changed drafts fall back to the source's current bytes. */
export function createPrecopyAwareMigrationBlobStore(
  config: ManagedWorkflowStorageConfig,
  sourceIdentity: string,
): ManagedWorkflowBlobStore {
  const base = new S3ManagedWorkflowBlobStore(config);
  const client = new S3Client(createManagedWorkflowS3ClientConfig(config));
  return {
    initialize: () => base.initialize(),
    checkHealth: (context) => base.checkHealth(context),
    dispose: () => {
      base.dispose();
      client.destroy();
    },
    putArtifact: (descriptor, bytes, contentType) => base.putArtifact(descriptor, bytes, contentType),
    putText: async (key, contents, contentType) => {
      const staged = stageKey(sourceIdentity, contents);
      let stagedAvailable = false;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: config.objectStorageBucket, Key: staged.key }));
        if (head.Metadata?.sha256 !== staged.hash)
          throw new Error('Staged migration object has incorrect checksum metadata.');
        stagedAvailable = true;
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
      if (!stagedAvailable) return base.putText(key, contents, contentType);
      const destinationKey = `${config.objectStoragePrefix}${key.replace(/^\/+/, '').replace(/\\/g, '/')}`;
      const copySource = `${encodeURIComponent(config.objectStorageBucket)}/${staged.key
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      await client.send(
        new CopyObjectCommand({
          Bucket: config.objectStorageBucket,
          Key: destinationKey,
          CopySource: copySource,
          MetadataDirective: 'REPLACE',
          ContentType: contentType ?? 'text/plain; charset=utf-8',
        }),
      );
    },
    getText: (key, options) => base.getText(key, options),
    getBytes: (key, options) => base.getBytes(key, options),
    exists: (key) => base.exists(key),
    listPage: (input) => base.listPage(input),
    delete: (key) => base.delete(key),
  };
}
