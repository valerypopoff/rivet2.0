import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { createManagedWorkflowS3ClientConfig } from './routes/workflows/managed/blob-store.js';
import { getManagedWorkflowStorageConfig } from './routes/workflows/storage-config.js';
import { getLegacyRestoreWorkspaceEpoch } from './legacy-restore/service.js';
import type { ProjectBundleJobStatus } from '../../studio-server-shared/project-bundle-types.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Manifest = { workspaceEpoch: string; status: ProjectBundleJobStatus; archive: { objectId: string; etag: string; versionId?: string; generation?: string }; manifestEtag?: string; manifestVersionId?: string; manifestGeneration?: string };
export class BundlePublicationUncertainError extends Error {}
export function createSharedBundleArchiveClient(
  config: Parameters<typeof createManagedWorkflowS3ClientConfig>[0] = getManagedWorkflowStorageConfig(),
): S3Client {
  // SDK retries can replay an unacknowledged multipart allocation/publication
  // before this owner gets a chance to reconcile it. Reads reconcile explicitly;
  // this disposable-export client must never retry a write behind the owner.
  return new S3Client({ ...createManagedWorkflowS3ClientConfig(config), maxAttempts: 1 });
}
/** Disposable exports only: keys are derived from installation/epoch/UUID, never supplied by a journal or URL. */
export class SharedBundleArchives {
  #client?: S3Client;
  readonly #generations = new WeakMap<object, string>();
  constructor(private readonly dependencies?: {
    client: S3Client; location(id: string): { Bucket: string; Key: string }; epoch(): string; googleStorage?: boolean;
  }) {}
  #googleStorage(): boolean {
    if (this.dependencies) return this.dependencies.googleStorage === true;
    const endpoint = getManagedWorkflowStorageConfig().objectStorageEndpoint;
    return !!endpoint && /(^|\.)storage\.googleapis\.com$/.test(new URL(endpoint).hostname);
  }
  #guard<T extends GetObjectCommand | HeadObjectCommand | DeleteObjectCommand | PutObjectCommand>(command: T, generation?: string): T {
    if (!this.#googleStorage()) return command;
    if (generation !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(generation)) throw new Error('Export generation identity invalid');
    // These four SDK stacks share the same build/response seam. The middleware
    // never reads or rewrites their operation-specific input/output payloads.
    const stack = command.middlewareStack as GetObjectCommand['middlewareStack'];
    stack.add(next => async args => {
      if (generation !== undefined) {
        const request = args.request as { headers: Record<string, string>; query: Record<string, string> };
        if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand)
          request.query = { ...request.query, generation };
        else request.headers['x-goog-if-generation-match'] = generation;
      }
      return next(args);
    }, { step: 'build', name: 'rivetExportGenerationGuard' });
    stack.add(next => async args => {
      const result = await next(args);
      const value = (result.response as { headers?: Record<string, string> })?.headers?.['x-goog-generation'];
      if (result.output && value && /^[1-9][0-9]{0,19}$/.test(value)) this.#generations.set(result.output, value);
      return result;
    }, { step: 'deserialize', priority: 'high', name: 'rivetExportGenerationIdentity' });
    return command;
  }
  #delete(key: { Bucket: string; Key: string }, identity: { generation?: string; versionId?: string; etag?: string }) {
    if (this.#googleStorage() && !identity.generation) throw new Error('Export generation deletion identity unavailable');
    return this.#guard(new DeleteObjectCommand({ ...key,
      ...(identity.versionId ? { VersionId: identity.versionId } : { IfMatch: identity.etag }) }), identity.generation);
  }
  async #removeObject(command: DeleteObjectCommand): Promise<void> {
    try { await this.#clientForStore().send(command); }
    catch (error) {
      // A retry after a lost delete response must still settle the owning job.
      // Only absence is success; a changed generation/precondition is not.
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
    }
  }
  #clientForStore() { return this.dependencies?.client ?? (this.#client ??= createSharedBundleArchiveClient()); }
  #epoch() { return this.dependencies?.epoch() ?? getLegacyRestoreWorkspaceEpoch(); }
  #location(id: string) {
    if (!UUID.test(id)) throw new Error('Invalid export identity');
    if (this.dependencies) return this.dependencies.location(id);
    const config = getManagedWorkflowStorageConfig();
    const installation = process.env.RIVET_LEGACY_RESTORE_INSTALLATION;
    if (!installation) throw new Error('Export installation identity unavailable');
    // Stable across restore so the owning journal can clean up old exports.
    // Epoch validation below prevents stale tabs from reading a prior workspace.
    const namespace = createHash('sha256').update(installation).digest('hex');
    return { Bucket: config.objectStorageBucket, Key: `${config.objectStoragePrefix}ha-exports/${namespace}/${id}/` };
  }
  async publish(status: ProjectBundleJobStatus, path: string): Promise<void> {
    const location = this.#location(status.id), client = this.#clientForStore();
    const objectId = randomUUID();
    const workspaceEpoch = this.#epoch();
    const archiveKey = { ...location, Key: location.Key + `archive-${objectId}.zip` };
    let upload;
    try {
      upload = await client.send(new CreateMultipartUploadCommand({ ...archiveKey, ContentType: 'application/zip', Metadata: { sha256: status.archiveHash! } }));
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (statusCode && statusCode >= 400 && statusCode < 500) throw error;
      // The server may have allocated an upload even if its acknowledgement was
      // lost. Without UploadId it cannot be aborted safely or replayed.
      throw new BundlePublicationUncertainError('Export upload initialization acknowledgement is unconfirmed.');
    }
    if (!upload.UploadId) throw new BundlePublicationUncertainError('Export artifact upload identity unavailable');
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      const actualHash = createHash('sha256'); let actualBytes = 0;
      let chunks: Buffer[] = [], bytes = 0;
      const flush = async () => {
        const response = await client.send(new UploadPartCommand({ ...archiveKey, UploadId: upload.UploadId, PartNumber: parts.length + 1,
          Body: Buffer.concat(chunks, bytes), ContentLength: bytes }));
        if (!response.ETag) throw new Error('Export upload acknowledgement unavailable');
        parts.push({ PartNumber: parts.length + 1, ETag: response.ETag }); chunks = []; bytes = 0;
      };
      for await (const chunk of createReadStream(path)) {
        actualHash.update(chunk as Buffer); actualBytes += (chunk as Buffer).length;
        chunks.push(chunk as Buffer); bytes += (chunk as Buffer).length;
        if (bytes >= 8 * 1024 * 1024) await flush();
      }
      if (bytes) await flush();
      if (actualBytes !== status.archiveBytes || actualHash.digest('hex') !== status.archiveHash)
        throw new Error('Export bytes changed during publication.');
      // GCS's S3-compatible multipart completion does not support preconditions.
      // A fresh object nonce is never reused; the conditional manifest publishes its identity.
      const completed = await client.send(new CompleteMultipartUploadCommand({ ...archiveKey, UploadId: upload.UploadId, MultipartUpload: { Parts: parts } }));
      const head = await client.send(this.#guard(new HeadObjectCommand({ ...archiveKey, ...(completed.VersionId ? { VersionId: completed.VersionId } : {}) })));
      if (!head.ETag || head.ContentLength !== status.archiveBytes || head.Metadata?.sha256 !== status.archiveHash)
        throw new Error('Export artifact verification failed');
      const generation = this.#generations.get(head);
      if (this.#googleStorage() && !generation) throw new Error('Export generation verification unavailable');
      await client.send(this.#guard(new PutObjectCommand({ ...location, Key: location.Key + 'status.json', ContentType: 'application/json',
        Body: JSON.stringify({ workspaceEpoch, status, archive: { objectId, etag: head.ETag, versionId: completed.VersionId, generation } } satisfies Manifest), IfNoneMatch: '*' }), '0'));
    } catch (error) {
      let abortConfirmed = false;
      await client.send(new AbortMultipartUploadCommand({ ...archiveKey, UploadId: upload.UploadId }))
        .then(() => { abortConfirmed = true; }, error => { abortConfirmed = error.$metadata?.httpStatusCode === 404; });
      let readConfirmed = false;
      const durable = await this.read(status.id, true).then((value) => { readConfirmed = true; return value; }).catch(() => undefined);
      if (durable?.archive.objectId === objectId && durable.status.archiveHash === status.archiveHash && durable.status.archiveBytes === status.archiveBytes) return;
      if (!readConfirmed) throw new BundlePublicationUncertainError('Export publication acknowledgement is unconfirmed.');
      try {
        const head = await client.send(this.#guard(new HeadObjectCommand(archiveKey)));
        if (!head.ETag || head.Metadata?.sha256 !== status.archiveHash || head.ContentLength !== status.archiveBytes)
          throw new Error('Export orphan identity is unconfirmed.');
        await client.send(this.#delete(archiveKey, { versionId: head.VersionId, etag: head.ETag, generation: this.#generations.get(head) }));
      } catch (cleanupError) {
        if ((cleanupError as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404 || !abortConfirmed)
          throw new BundlePublicationUncertainError('Export artifact cleanup acknowledgement is unconfirmed.');
      }
      throw error; // Reconcile by reading; unknown writes are never replayed.
    }
  }
  async read(id: string, includeExpired = false): Promise<Manifest | undefined> {
    const location = this.#location(id);
    try {
      const result = await this.#clientForStore().send(this.#guard(new GetObjectCommand({ ...location, Key: location.Key + 'status.json' })));
      if (!(result.Body instanceof Readable)) throw new Error('Export manifest body unavailable');
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        for await (const chunk of result.Body) {
          bytes += chunk.length;
          if (bytes > 64 * 1024) throw new Error('Export manifest is oversized');
          chunks.push(Buffer.from(chunk));
        }
      } finally { result.Body.destroy(); }
      const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as Manifest;
      if (value.status?.id !== id || value.status.phase !== 'ready' || !/^[a-f0-9]{64}$/.test(value.status.archiveHash ?? '') ||
          !Number.isSafeInteger(value.status.archiveBytes) || value.status.archiveBytes! < 1 || !value.archive?.etag || !UUID.test(value.archive.objectId ?? '') || !Number.isFinite(Date.parse(value.status.expiresAt)) ||
          (!includeExpired && value.workspaceEpoch !== this.#epoch()) ||
          (!includeExpired && Date.parse(value.status.expiresAt) <= Date.now())) return undefined;
      return { ...value, manifestEtag: result.ETag, manifestVersionId: result.VersionId, manifestGeneration: this.#generations.get(result) };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }
  async open(id: string, manifest: Manifest): Promise<Readable> {
    const location = this.#location(id);
    if (this.#googleStorage() && !manifest.archive.generation) throw new Error('Export generation read identity unavailable');
    const result = await this.#clientForStore().send(this.#guard(new GetObjectCommand({ ...location, Key: location.Key + `archive-${manifest.archive.objectId}.zip`,
      ...(manifest.archive.versionId ? { VersionId: manifest.archive.versionId } : { IfMatch: manifest.archive.etag }) }), manifest.archive.generation));
    if (result.ContentLength !== manifest.status.archiveBytes || result.Metadata?.sha256 !== manifest.status.archiveHash || !(result.Body instanceof Readable)) {
      if (result.Body instanceof Readable) result.Body.destroy();
      throw new Error('Export artifact identity changed');
    }
    return result.Body;
  }
  async remove(id: string): Promise<void> {
    const manifest = await this.read(id, true); if (!manifest) return;
    const location = this.#location(id);
    await this.#removeObject(this.#delete({ ...location, Key: location.Key + `archive-${manifest.archive.objectId}.zip` }, manifest.archive));
    if (!manifest.manifestEtag && !manifest.manifestVersionId) throw new Error('Export manifest deletion identity unavailable');
    await this.#removeObject(this.#delete({ ...location, Key: location.Key + 'status.json' },
      { versionId: manifest.manifestVersionId, etag: manifest.manifestEtag, generation: manifest.manifestGeneration }));
  }
  dispose(): void { this.#client?.destroy(); this.#client = undefined; }
}
export const sharedBundleArchives = process.env.RIVET_HA_DEPLOYMENT === '1' ? new SharedBundleArchives() : undefined;
