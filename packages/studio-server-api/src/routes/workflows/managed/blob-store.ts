import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createManagedObjectStorageHttpHandlerOptions } from '../../../managed-health.js';
import { observeObjectStorageOperation, type MetricsObjectStorageDomain } from '../../../metrics.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';

export interface ManagedWorkflowBlobStore {
  initialize?(): Promise<void>;
  checkHealth?(context?: RuntimeHealthCheckContext): Promise<void>;
  dispose?(): void;
  putText(key: string, contents: string, contentType?: string): Promise<void>;
  getText(key: string): Promise<string>;
  /**
   * Reconciliation uses this cheap metadata operation instead of downloading
   * project or recording payloads merely to prove that a referenced object is
   * still present.
   */
  exists?(key: string): Promise<boolean>;
  /**
   * Returns one bounded page scoped to this store's configured prefix. The
   * cursor is the last relative key seen by this store and is persisted only
   * by the reconciliation worker; callers must not derive policy from it.
   */
  listPage?(input: { cursor?: string; pageSize: number }): Promise<ManagedWorkflowBlobPage>;
  delete(key: string | null | undefined): Promise<void>;
}

export type ManagedWorkflowBlobObject = {
  key: string;
  size: number;
  lastModified: string | null;
};

export type ManagedWorkflowBlobPage = {
  objects: ManagedWorkflowBlobObject[];
  nextCursor?: string;
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
  readonly #metricsDomain;

  constructor(config: ManagedWorkflowStorageConfig, metricsDomain: MetricsObjectStorageDomain = 'workflows') {
    this.#client = new S3Client(createManagedWorkflowS3ClientConfig(config));
    this.#bucket = config.objectStorageBucket;
    this.#prefix = normalizeKeyPrefix(config.objectStoragePrefix);
    this.#metricsDomain = metricsDomain;
  }

  #key(key: string): string {
    return `${this.#prefix}${normalizeBlobKey(key)}`;
  }

  async initialize(): Promise<void> {
    await observeObjectStorageOperation(this.#metricsDomain, 'health', async () => {
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
    await observeObjectStorageOperation(this.#metricsDomain, 'health', () =>
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
    await observeObjectStorageOperation(this.#metricsDomain, 'put', () =>
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
    return observeObjectStorageOperation(this.#metricsDomain, 'get', async () => {
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

  async exists(key: string): Promise<boolean> {
    try {
      await observeObjectStorageOperation(this.#metricsDomain, 'head', () =>
        this.#client.send(
          new HeadObjectCommand({
            Bucket: this.#bucket,
            Key: this.#key(key),
          }),
        ),
      );
      return true;
    } catch (error) {
      const statusCode =
        typeof error === 'object' &&
        error != null &&
        '$metadata' in error &&
        typeof (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 'number'
          ? (error as { $metadata: { httpStatusCode: number } }).$metadata.httpStatusCode
          : undefined;
      if (statusCode === 404 || (error as { name?: unknown } | null)?.name === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  async listPage(input: { cursor?: string; pageSize: number }): Promise<ManagedWorkflowBlobPage> {
    const pageSize = Number.isFinite(input.pageSize) ? Math.max(1, Math.min(Math.trunc(input.pageSize), 1_000)) : 1;
    return observeObjectStorageOperation(this.#metricsDomain, 'list', async () => {
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#prefix,
          ...(input.cursor !== undefined ? { StartAfter: this.#key(input.cursor) } : {}),
          MaxKeys: pageSize,
        }),
      );
      const entries = response.Contents ?? [];
      const lastListedKey = entries.at(-1)?.Key;
      let nextCursor: string | undefined;
      if (response.IsTruncated) {
        if (!lastListedKey || !lastListedKey.startsWith(this.#prefix)) {
          throw new Error('Object storage returned a truncated page without an advancing key cursor.');
        }
        nextCursor = lastListedKey.slice(this.#prefix.length);
      }
      return {
        objects: entries.flatMap((entry) => {
          if (!entry.Key || !entry.Key.startsWith(this.#prefix)) return [];
          const key = entry.Key.slice(this.#prefix.length);
          // S3-compatible stores may return a zero-byte object exactly at the
          // prefix to emulate a folder. It is not a Rivet object and cannot
          // form a valid durable finding key.
          if (!key) return [];
          return [
            {
              key,
              size: typeof entry.Size === 'number' ? entry.Size : 0,
              lastModified: entry.LastModified?.toISOString() ?? null,
            },
          ];
        }),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }
  async delete(key: string | null | undefined): Promise<void> {
    if (!key) {
      return;
    }

    await observeObjectStorageOperation(this.#metricsDomain, 'delete', () =>
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

  async exists(key: string): Promise<boolean> {
    return this.#objects.has(normalizeBlobKey(key));
  }

  async listPage(input: { cursor?: string; pageSize: number }): Promise<ManagedWorkflowBlobPage> {
    const keys = [...this.#objects.keys()].sort();
    const start = input.cursor ? keys.findIndex((key) => key > input.cursor!) : 0;
    const pageSize = Number.isFinite(input.pageSize) ? Math.max(1, Math.trunc(input.pageSize)) : 1;
    const safeStart = start < 0 ? keys.length : start;
    const page = keys.slice(safeStart, safeStart + pageSize);
    return {
      objects: page.map((key) => ({ key, size: Buffer.byteLength(this.#objects.get(key) ?? ''), lastModified: null })),
      ...(safeStart + page.length < keys.length && page.at(-1) ? { nextCursor: page.at(-1) } : {}),
    };
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

/**
 * A reconciliation finding is not by itself permission to delete a key. This
 * narrow grammar recognizes only the immutable revision/recording artifacts
 * that this module creates, preventing a future policy from sweeping an
 * arbitrary object under the workflow-storage prefix.
 */
export function isManagedWorkflowArtifactObjectKey(key: string): boolean {
  const segments = key.split('/');
  if (segments.length !== 4 || segments.some((segment) => !segment || segment !== segment.trim())) return false;
  const [workflowId, collection, objectId, fileName] = segments;
  if (!workflowId || !objectId || workflowId === '.' || workflowId === '..' || objectId === '.' || objectId === '..') {
    return false;
  }
  return (
    (collection === 'revisions' && (fileName === 'project.rivet-project' || fileName === 'dataset.rivet-data')) ||
    (collection === 'recordings' &&
      (fileName === 'recording.rivet-recording' ||
        fileName === 'replay.rivet-project' ||
        fileName === 'replay.rivet-data'))
  );
}

export function createManagedRevisionId(): string {
  return randomUUID();
}
