import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createManagedObjectStorageHttpHandlerOptions } from '../../../managed-health.js';
import { observeObjectStorageOperation } from '../../../metrics.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';

export interface ManagedWorkflowBlobStore {
  initialize?(): Promise<void>;
  checkHealth?(context?: RuntimeHealthCheckContext): Promise<void>;
  dispose?(): void;
  putText(key: string, contents: string, contentType?: string): Promise<void>;
  getText(key: string): Promise<string>;
  delete(key: string | null | undefined): Promise<void>;
}

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

export function createManagedWorkflowBlobKey(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .map((segment) => normalizeBlobKey(segment))
    .join('/');
}

export function createManagedWorkflowS3ClientConfig(config: ManagedWorkflowStorageConfig): S3ClientConfig {
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

export class S3ManagedWorkflowBlobStore implements ManagedWorkflowBlobStore {
  readonly #client;
  readonly #bucket;
  readonly #prefix;

  constructor(config: ManagedWorkflowStorageConfig) {
    this.#client = new S3Client(createManagedWorkflowS3ClientConfig(config));
    this.#bucket = config.objectStorageBucket;
    this.#prefix = normalizeKeyPrefix(config.objectStoragePrefix);
  }

  #key(key: string): string {
    return `${this.#prefix}${normalizeBlobKey(key)}`;
  }

  async initialize(): Promise<void> {
    await observeObjectStorageOperation('workflows', 'health', async () => {
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
    await observeObjectStorageOperation('workflows', 'health', () =>
      this.#client.send(
        new HeadBucketCommand({ Bucket: this.#bucket }),
        context ? { abortSignal: context.signal } : undefined,
      ),
    );
  }

  dispose(): void {
    this.#client.destroy();
  }

  async putText(key: string, contents: string, contentType = 'text/plain; charset=utf-8'): Promise<void> {
    await observeObjectStorageOperation('workflows', 'put', () =>
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

  async getText(key: string): Promise<string> {
    return observeObjectStorageOperation('workflows', 'get', async () => {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(key),
        }),
      );

      if (!response.Body) {
        throw new Error(`Object body missing for key ${key}`);
      }

      return response.Body.transformToString();
    });
  }

  async delete(key: string | null | undefined): Promise<void> {
    if (!key) {
      return;
    }

    await observeObjectStorageOperation('workflows', 'delete', () =>
      this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(key),
        }),
      ),
    );
  }
}

export class InMemoryManagedWorkflowBlobStore implements ManagedWorkflowBlobStore {
  readonly #objects = new Map<string, string>();

  async putText(key: string, contents: string): Promise<void> {
    this.#objects.set(normalizeBlobKey(key), contents);
  }

  async getText(key: string): Promise<string> {
    const normalizedKey = normalizeBlobKey(key);
    const contents = this.#objects.get(normalizedKey);
    if (contents == null) {
      throw new Error(`Blob not found: ${key}`);
    }

    return contents;
  }

  async delete(key: string | null | undefined): Promise<void> {
    if (!key) {
      return;
    }

    this.#objects.delete(normalizeBlobKey(key));
  }
}

export function createRevisionBlobKey(workflowId: string, revisionId: string, kind: 'project' | 'dataset'): string {
  return createManagedWorkflowBlobKey(
    workflowId,
    'revisions',
    revisionId,
    kind === 'project' ? 'project.rivet-project' : 'dataset.rivet-data',
  );
}

export function createRecordingBlobKey(
  workflowId: string,
  recordingId: string,
  kind: 'recording' | 'replay-project' | 'replay-dataset',
): string {
  const fileName =
    kind === 'recording'
      ? 'recording.rivet-recording'
      : kind === 'replay-project'
        ? 'replay.rivet-project'
        : 'replay.rivet-data';

  return createManagedWorkflowBlobKey(workflowId, 'recordings', recordingId, fileName);
}

export function createManagedRevisionId(): string {
  return randomUUID();
}
