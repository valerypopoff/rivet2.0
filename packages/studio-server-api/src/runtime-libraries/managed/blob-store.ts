import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createManagedObjectStorageHttpHandlerOptions } from '../../managed-health.js';
import { observeObjectStorageOperation } from '../../metrics.js';
import type { RuntimeHealthCheckContext } from '../../runtime-health.js';
import type { ManagedRuntimeLibrariesConfig } from '../config.js';

export interface RuntimeLibrariesBlobStore {
  initialize?(): Promise<void>;
  checkHealth?(context?: RuntimeHealthCheckContext): Promise<void>;
  dispose?(): void;
  putBuffer(key: string, contents: Buffer, contentType?: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  delete(key: string | null | undefined): Promise<void>;
}

export type RuntimeLibrariesBlobObject = {
  key: string;
  size: number;
  lastModified: string | null;
};

function normalizeKeyPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }

  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function normalizeBlobKey(key: string): string {
  return key.replace(/^\/+/, '').replace(/\\/g, '/');
}

export function getRuntimeLibrariesBlobPrefix(prefix: string): string {
  return normalizeKeyPrefix(prefix);
}

export function getRuntimeLibrariesBlobKeyWithPrefix(prefix: string, key: string): string {
  return `${normalizeKeyPrefix(prefix)}${normalizeBlobKey(key)}`;
}

export function stripRuntimeLibrariesBlobPrefix(prefix: string, key: string): string {
  const normalizedPrefix = normalizeKeyPrefix(prefix);
  return normalizedPrefix && key.startsWith(normalizedPrefix) ? key.slice(normalizedPrefix.length) : key;
}

export function createRuntimeLibrariesBlobKey(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .map((segment) => normalizeBlobKey(segment))
    .join('/');
}

export function createRuntimeLibraryReleaseArtifactKey(releaseId: string): string {
  return createRuntimeLibrariesBlobKey('releases', releaseId, 'release.tar');
}

export function createRuntimeLibrariesS3ClientConfig(config: ManagedRuntimeLibrariesConfig): S3ClientConfig {
  const clientConfig: S3ClientConfig = {
    region: config.objectStorageRegion,
    forcePathStyle: config.objectStorageForcePathStyle,
    requestHandler: new NodeHttpHandler(createManagedObjectStorageHttpHandlerOptions()),
    credentials: {
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
    },
  };

  if (config.objectStorageEndpoint) {
    clientConfig.endpoint = config.objectStorageEndpoint;
  }

  return clientConfig;
}

export async function listRuntimeLibrariesBlobObjects(
  config: ManagedRuntimeLibrariesConfig,
): Promise<RuntimeLibrariesBlobObject[]> {
  return observeObjectStorageOperation('runtime_libraries', 'list', async () => {
    const client = new S3Client(createRuntimeLibrariesS3ClientConfig(config));
    const prefix = getRuntimeLibrariesBlobPrefix(config.objectStoragePrefix);
    const objects: RuntimeLibrariesBlobObject[] = [];
    let continuationToken: string | undefined;

    try {
      while (true) {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: config.objectStorageBucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const entry of response.Contents ?? []) {
          if (!entry.Key) {
            continue;
          }

          objects.push({
            key: stripRuntimeLibrariesBlobPrefix(prefix, entry.Key),
            size: typeof entry.Size === 'number' ? entry.Size : 0,
            lastModified: entry.LastModified ? entry.LastModified.toISOString() : null,
          });
        }

        if (!response.IsTruncated || !response.NextContinuationToken) {
          break;
        }

        continuationToken = response.NextContinuationToken;
      }
    } finally {
      client.destroy();
    }

    return objects;
  });
}
export async function deleteRuntimeLibrariesBlobObjects(
  config: ManagedRuntimeLibrariesConfig,
  keys: string[],
): Promise<number> {
  const uniqueKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));

  if (uniqueKeys.length === 0) {
    return 0;
  }

  return observeObjectStorageOperation('runtime_libraries', 'delete_many', async () => {
    const client = new S3Client(createRuntimeLibrariesS3ClientConfig(config));
    let deletedCount = 0;

    try {
      for (let index = 0; index < uniqueKeys.length; index += 1_000) {
        const batch = uniqueKeys.slice(index, index + 1_000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: config.objectStorageBucket,
            Delete: {
              Objects: batch.map((key) => ({
                Key: getRuntimeLibrariesBlobKeyWithPrefix(config.objectStoragePrefix, key),
              })),
              Quiet: true,
            },
          }),
        );
        deletedCount += batch.length;
      }
    } finally {
      client.destroy();
    }

    return deletedCount;
  });
}
export class S3RuntimeLibrariesBlobStore implements RuntimeLibrariesBlobStore {
  readonly #client;
  readonly #bucket;
  readonly #prefix;

  constructor(config: ManagedRuntimeLibrariesConfig) {
    this.#client = new S3Client(createRuntimeLibrariesS3ClientConfig(config));
    this.#bucket = config.objectStorageBucket;
    this.#prefix = normalizeKeyPrefix(config.objectStoragePrefix);
  }

  #key(key: string): string {
    return `${this.#prefix}${normalizeBlobKey(key)}`;
  }

  async initialize(): Promise<void> {
    await observeObjectStorageOperation('runtime_libraries', 'health', async () => {
      try {
        await this.#client.send(
          new HeadBucketCommand({
            Bucket: this.#bucket,
          }),
        );
      } catch (error) {
        const statusCode =
          typeof error === 'object' &&
          error != null &&
          '$metadata' in error &&
          typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 'number'
            ? (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode
            : undefined;

        if (statusCode && statusCode !== 404) {
          throw error;
        }

        await this.#client.send(
          new CreateBucketCommand({
            Bucket: this.#bucket,
          }),
        );
      }
    });
  }

  async checkHealth(context?: RuntimeHealthCheckContext): Promise<void> {
    await observeObjectStorageOperation('runtime_libraries', 'health', () =>
      this.#client.send(
        new HeadBucketCommand({ Bucket: this.#bucket }),
        context ? { abortSignal: context.signal } : undefined,
      ),
    );
  }

  dispose(): void {
    this.#client.destroy();
  }

  async putBuffer(key: string, contents: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    await observeObjectStorageOperation('runtime_libraries', 'put', () =>
      this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(key),
          Body: contents,
          ContentType: contentType,
        }),
      ),
    );
  }

  async getBuffer(key: string): Promise<Buffer> {
    return observeObjectStorageOperation('runtime_libraries', 'get', async () => {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(key),
        }),
      );

      if (!response.Body) {
        throw new Error(`Object body missing for key ${key}`);
      }

      return Buffer.from(await response.Body.transformToByteArray());
    });
  }

  async delete(key: string | null | undefined): Promise<void> {
    if (!key) {
      return;
    }

    await observeObjectStorageOperation('runtime_libraries', 'delete', () =>
      this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(key),
        }),
      ),
    );
  }
}
