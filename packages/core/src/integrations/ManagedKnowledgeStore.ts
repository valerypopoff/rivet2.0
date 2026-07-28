import CryptoJS from 'crypto-js';
import stableStringify from 'safe-stable-stringify';
import type {
  GetKnowledgeSourceStatusRequest,
  GetKnowledgeSourceStatusResult,
  KnowledgeChunkingOptions,
  KnowledgeFilter,
  KnowledgeMetadata,
  KnowledgeOperationContext,
  KnowledgeQueryResult,
  RivetKnowledgeDocument,
  RivetKnowledgeEvidence,
  RivetKnowledgeSourceReference,
  RivetKnowledgeStore,
  RivetKnowledgeStoreCapabilities,
  SearchKnowledgeSourceRequest,
  SearchKnowledgeSourceResult,
  SyncKnowledgeSourceRequest,
  SyncKnowledgeSourceResult,
} from './KnowledgeStore.js';
import {
  normalizeKnowledgeDocument,
  normalizeKnowledgeEvidence,
  normalizeKnowledgeFilter,
  normalizeKnowledgeMetadata,
  normalizeKnowledgeQueries,
  normalizeKnowledgeSourceReference,
} from './KnowledgeStoreValidation.js';

const MANAGED_SCHEMA_VERSION = '1';
const CHUNKER_VERSION = '1';

export type ManagedKnowledgeChunk = {
  id: string;
  text: string;
  documentId: string;
  title?: string;
  chunkIndex: number;
  chunksInDocument: number;
  metadata?: KnowledgeMetadata;
};

export type KnowledgeSourceManifest = {
  schemaVersion: string;
  sourceId: string;
  activeVersion: string;
  /** Uniquely identifies one activation, including a force refresh of the same content version. */
  commitId?: string;
  documentCount: number;
  chunkCount: number;
  updatedAt: string;
  metadata?: KnowledgeMetadata;
};

export type KnowledgeDriverSearchRequest = {
  sourceId: string;
  version: string;
  query: string;
  topK: number;
  filter?: KnowledgeFilter;
  rerank?: SearchKnowledgeSourceRequest['rerank'];
};

export interface ManagedKnowledgeStoreDriver {
  readonly capabilities: RivetKnowledgeStoreCapabilities;

  /**
   * Stable backend scope used to serialize writes to one source across store
   * instances in this JavaScript runtime. Omit it for instance-local locking.
   */
  readonly operationScope?: string;

  getManifest(sourceId: string, context: KnowledgeOperationContext): Promise<KnowledgeSourceManifest | undefined>;

  upsertChunks(
    sourceId: string,
    version: string,
    chunks: ManagedKnowledgeChunk[],
    context: KnowledgeOperationContext,
  ): Promise<void>;

  commitManifest(manifest: KnowledgeSourceManifest, context: KnowledgeOperationContext): Promise<void>;

  search(request: KnowledgeDriverSearchRequest, context: KnowledgeOperationContext): Promise<RivetKnowledgeEvidence[]>;

  deleteVersion(sourceId: string, version: string, context: KnowledgeOperationContext): Promise<void>;
}

/**
 * Provides deterministic chunking, immutable version activation, idempotency,
 * same-process source serialization, and multi-query result fusion for drivers.
 */
export class ManagedKnowledgeStore implements RivetKnowledgeStore {
  readonly capabilities: RivetKnowledgeStoreCapabilities;
  readonly #sourceOperations = new Map<string, Promise<void>>();

  constructor(readonly driver: ManagedKnowledgeStoreDriver) {
    this.capabilities = driver.capabilities;
  }

  async getSourceStatus(
    request: GetKnowledgeSourceStatusRequest,
    context: KnowledgeOperationContext,
  ): Promise<GetKnowledgeSourceStatusResult> {
    const source = normalizeKnowledgeSourceReference(request.source);
    const expectedVersion = request.expectedVersion?.trim()
      ? normalizeKnowledgeSourceReference({ ...source, version: request.expectedVersion }).version
      : source.version;
    const manifest = await this.#getManifest(source.sourceId, context);
    if (!manifest) {
      return {
        exists: false,
        source,
        message: `Knowledge source "${source.sourceId}" has not been synchronized.`,
        ...(expectedVersion ? { matchesExpectedVersion: false } : {}),
      };
    }

    const resolvedSource = { ...source, version: manifest.activeVersion };
    return {
      exists: true,
      source: resolvedSource,
      activeVersion: manifest.activeVersion,
      documentCount: manifest.documentCount,
      chunkCount: manifest.chunkCount,
      updatedAt: manifest.updatedAt,
      metadata: manifest.metadata,
      message: `Knowledge source "${source.sourceId}" is ready.`,
      ...(expectedVersion ? { matchesExpectedVersion: expectedVersion === manifest.activeVersion } : {}),
    };
  }

  async syncSource(
    request: SyncKnowledgeSourceRequest,
    context: KnowledgeOperationContext,
  ): Promise<SyncKnowledgeSourceResult> {
    const source = normalizeKnowledgeSourceReference(request.source);
    return this.#serializeSourceOperation(source.sourceId, context.signal, () =>
      this.#syncSource(source, request, context),
    );
  }

  async search(
    request: SearchKnowledgeSourceRequest,
    context: KnowledgeOperationContext,
  ): Promise<SearchKnowledgeSourceResult> {
    const source = normalizeKnowledgeSourceReference(request.source);
    const queries = normalizeKnowledgeQueries(request.queries);
    validatePositiveInteger(request.topK, 'Results per query', 1, 100);
    validatePositiveInteger(request.maxConcurrency, 'Search concurrency', 1, 32);
    validatePositiveInteger(request.finalResultCount, 'Final result count', 1, 500);
    validatePositiveInteger(request.rerank?.topN, 'Rerank result count', 1, 100);
    if (request.rerank && request.rerank.mode !== 'connection-default' && request.rerank.mode !== 'required') {
      throw new Error('Provider reranking mode must be connection-default or required.');
    }

    const filter = request.filter == null ? undefined : normalizeKnowledgeFilter(request.filter);
    validateCapabilities(this.capabilities, filter, request.rerank);
    const rerank = this.capabilities.supportsProviderReranking ? request.rerank : undefined;

    const manifest = await this.#getManifest(source.sourceId, context);
    if (!manifest) {
      return {
        sourceFound: false,
        source,
        evidence: [],
        queryResults: [],
        message: `Knowledge source "${source.sourceId}" has not been synchronized.`,
      };
    }

    const requestedVersion = source.version?.trim();
    if (requestedVersion && requestedVersion !== manifest.activeVersion) {
      return {
        sourceFound: false,
        source,
        evidence: [],
        queryResults: [],
        message: `Knowledge source "${source.sourceId}" is active at version "${manifest.activeVersion}", not requested version "${requestedVersion}".`,
      };
    }

    const version = manifest.activeVersion;
    const resolvedSource: RivetKnowledgeSourceReference = { ...source, version };
    const topK = request.topK ?? 10;
    const searchAbortController = new AbortController();
    const abortSearch = () => searchAbortController.abort(context.signal.reason);
    if (context.signal.aborted) abortSearch();
    else context.signal.addEventListener('abort', abortSearch, { once: true });
    let queryResults: KnowledgeQueryResult[];
    try {
      const searchContext = { ...context, signal: searchAbortController.signal };
      queryResults = await mapConcurrent(
        queries,
        request.maxConcurrency ?? Math.min(queries.length, 3),
        async (query): Promise<KnowledgeQueryResult> => {
          throwIfAborted(searchContext.signal);
          const evidence = await this.driver.search(
            { sourceId: source.sourceId, version, query, topK, filter, rerank },
            searchContext,
          );
          return {
            query,
            evidence: evidence.map((item) => normalizeKnowledgeEvidence({ ...item, source: resolvedSource })),
          };
        },
      );
    } catch (error) {
      searchAbortController.abort(error);
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abortSearch);
    }

    const evidence = fuseEvidence(queryResults, request.finalResultCount ?? topK);
    return {
      sourceFound: true,
      source: resolvedSource,
      evidence,
      queryResults,
      message: evidence.length
        ? `Found ${evidence.length} relevant knowledge result${evidence.length === 1 ? '' : 's'}.`
        : 'The source is ready, but no relevant knowledge was found.',
    };
  }

  async #syncSource(
    source: RivetKnowledgeSourceReference,
    request: SyncKnowledgeSourceRequest,
    context: KnowledgeOperationContext,
  ): Promise<SyncKnowledgeSourceResult> {
    if (request.documents.length === 0) throw new Error('Sync Knowledge Source requires at least one document.');
    const documents = request.documents.map((document, index) => normalizeKnowledgeDocument(document, index));
    const documentIds = resolveDocumentIds(documents);
    validateUniqueDocumentIds(documentIds);
    const metadata =
      request.metadata == null ? undefined : normalizeKnowledgeMetadata(request.metadata, 'Source metadata');
    const chunking = normalizeChunkingOptions(request.chunking);
    const version = createSourceVersion(documents, metadata, chunking);
    const existing = await this.#getManifest(source.sourceId, context);
    if (!request.forceRefresh && existing?.activeVersion === version) {
      return {
        source: { ...source, version },
        result: 'unchanged',
        previousVersion: existing.activeVersion,
        documentCount: existing.documentCount,
        chunkCount: existing.chunkCount,
        warnings: [],
      };
    }

    const chunks = await chunkDocuments(documents, documentIds, version, chunking, context);
    if (chunks.length === 0) throw new Error('Sync Knowledge Source produced no non-empty chunks.');

    await this.driver.upsertChunks(source.sourceId, version, chunks, context);
    throwIfAborted(context.signal);

    const manifest: KnowledgeSourceManifest = {
      schemaVersion: MANAGED_SCHEMA_VERSION,
      sourceId: source.sourceId,
      activeVersion: version,
      commitId: createManifestCommitId(),
      documentCount: documents.length,
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    };
    await this.driver.commitManifest(manifest, context);

    const committed = await this.#getManifest(source.sourceId, context);
    if (!sameManifestActivation(committed, manifest)) {
      throw new Error(
        `Knowledge source "${source.sourceId}" did not retain its activation for version "${version}". Another writer may have updated the source concurrently.`,
      );
    }

    const warnings: string[] = [];
    if (existing?.activeVersion && existing.activeVersion !== version) {
      let stillActive: KnowledgeSourceManifest | undefined;
      let cleanupVerificationFailed = false;
      try {
        stillActive = await this.#getManifest(source.sourceId, context);
      } catch (error) {
        throwIfAborted(context.signal);
        cleanupVerificationFailed = true;
        warnings.push(`The new version is active, but cleanup verification failed: ${errorMessage(error)}`);
      }
      if (!cleanupVerificationFailed && !sameManifestActivation(stillActive, manifest)) {
        throw new Error(
          `Knowledge source "${source.sourceId}" no longer has its activation for version "${version}" active. Another writer updated the source concurrently.`,
        );
      }
      if (stillActive) {
        try {
          await this.driver.deleteVersion(source.sourceId, existing.activeVersion, context);
        } catch (error) {
          throwIfAborted(context.signal);
          warnings.push(`The new version is active, but stale-version cleanup failed: ${errorMessage(error)}`);
        }
      }
    }

    return {
      source: { ...source, version },
      result: existing ? 'updated' : 'created',
      previousVersion: existing?.activeVersion,
      documentCount: documents.length,
      chunkCount: chunks.length,
      warnings,
    };
  }

  async #serializeSourceOperation<T>(sourceId: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const operations = this.driver.operationScope
      ? getSharedSourceOperations(this.driver.operationScope)
      : this.#sourceOperations;
    const previous = operations.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    operations.set(sourceId, tail);
    void tail.then(() => {
      if (operations.get(sourceId) === tail) {
        operations.delete(sourceId);
        if (this.driver.operationScope) removeEmptySharedSourceOperations(this.driver.operationScope, operations);
      }
    });
    try {
      await waitForPromiseOrAbort(
        previous.catch(() => undefined),
        signal,
      );
      return await operation();
    } finally {
      release();
    }
  }

  async #getManifest(
    sourceId: string,
    context: KnowledgeOperationContext,
  ): Promise<KnowledgeSourceManifest | undefined> {
    const manifest = await this.driver.getManifest(sourceId, context);
    return manifest == null ? undefined : normalizeKnowledgeSourceManifest(manifest, sourceId);
  }
}

const sharedSourceOperations = new Map<string, Map<string, Promise<void>>>();

function getSharedSourceOperations(scope: string): Map<string, Promise<void>> {
  const normalizedScope = scope.trim();
  if (!normalizedScope) throw new Error('Managed knowledge-store operation scope cannot be empty.');
  let operations = sharedSourceOperations.get(normalizedScope);
  if (!operations) {
    operations = new Map();
    sharedSourceOperations.set(normalizedScope, operations);
  }
  return operations;
}

function removeEmptySharedSourceOperations(scope: string, operations: Map<string, Promise<void>>): void {
  if (operations.size === 0 && sharedSourceOperations.get(scope.trim()) === operations) {
    sharedSourceOperations.delete(scope.trim());
  }
}

export function normalizeKnowledgeSourceManifest(value: unknown, expectedSourceId: string): KnowledgeSourceManifest {
  if (!isRecord(value)) throw new Error(`Knowledge manifest for source "${expectedSourceId}" must be an object.`);
  if (value.schemaVersion !== MANAGED_SCHEMA_VERSION) {
    throw new Error(
      `Knowledge manifest for source "${expectedSourceId}" uses unsupported schema version "${String(value.schemaVersion)}".`,
    );
  }
  if (value.sourceId !== expectedSourceId) {
    throw new Error(`Knowledge manifest for source "${expectedSourceId}" belongs to another source.`);
  }
  const activeVersion = typeof value.activeVersion === 'string' ? value.activeVersion.trim() : '';
  if (!activeVersion) throw new Error(`Knowledge manifest for source "${expectedSourceId}" has no active version.`);
  if (activeVersion.length > 512) {
    throw new Error(`Knowledge manifest for source "${expectedSourceId}" has an invalid active version.`);
  }
  const commitId = value.commitId == null ? undefined : typeof value.commitId === 'string' ? value.commitId.trim() : '';
  if (value.commitId != null && (!commitId || commitId.length > 128)) {
    throw new Error(`Knowledge manifest for source "${expectedSourceId}" has an invalid commit ID.`);
  }
  const documentCount = normalizePositiveManifestCount(value.documentCount, 'document', expectedSourceId);
  const chunkCount = normalizePositiveManifestCount(value.chunkCount, 'chunk', expectedSourceId);
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt.trim() : '';
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`Knowledge manifest for source "${expectedSourceId}" has an invalid update time.`);
  }
  const metadata = value.metadata == null ? undefined : normalizeKnowledgeMetadata(value.metadata, 'Manifest metadata');
  return {
    schemaVersion: MANAGED_SCHEMA_VERSION,
    sourceId: expectedSourceId,
    activeVersion,
    ...(commitId ? { commitId } : {}),
    documentCount,
    chunkCount,
    updatedAt,
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

function normalizePositiveManifestCount(value: unknown, label: string, sourceId: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`Knowledge manifest for source "${sourceId}" has an invalid ${label} count.`);
  }
  return value as number;
}

async function waitForPromiseOrAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Knowledge operation was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function createSourceVersion(
  documents: RivetKnowledgeDocument[],
  metadata: KnowledgeMetadata | undefined,
  chunking: Required<KnowledgeChunkingOptions>,
): string {
  const canonical = stableStringify({
    schemaVersion: MANAGED_SCHEMA_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    documents,
    metadata: metadata ?? {},
    chunking,
  });
  const digest = CryptoJS.SHA256(canonical ?? '').toString(CryptoJS.enc.Hex);
  return `ks${MANAGED_SCHEMA_VERSION}-${digest}`;
}

function normalizeChunkingOptions(options: KnowledgeChunkingOptions | undefined): Required<KnowledgeChunkingOptions> {
  if (options?.unit != null && options.unit !== 'characters' && options.unit !== 'tokens') {
    throw new Error('Chunk size unit must be characters or tokens.');
  }
  if (options?.includeTitle != null && typeof options.includeTitle !== 'boolean') {
    throw new Error('Include Title In Indexed Text must be a boolean.');
  }
  const unit = options?.unit ?? 'characters';
  const targetSize = options?.targetSize ?? (unit === 'tokens' ? 700 : 2600);
  const overlap = options?.overlap ?? (unit === 'tokens' ? 80 : 260);
  const minimumBoundarySize = options?.minimumBoundarySize ?? Math.floor(targetSize * 0.55);
  validatePositiveInteger(targetSize, 'Chunk target size', 100, 100_000);
  validatePositiveInteger(overlap, 'Chunk overlap', 0, targetSize - 1);
  validatePositiveInteger(minimumBoundarySize, 'Minimum boundary size', 1, targetSize);
  return { unit, targetSize, overlap, minimumBoundarySize, includeTitle: options?.includeTitle !== false };
}

function createManifestCommitId(): string {
  return CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex);
}

async function chunkDocuments(
  documents: RivetKnowledgeDocument[],
  documentIds: string[],
  version: string,
  options: Required<KnowledgeChunkingOptions>,
  context: KnowledgeOperationContext,
): Promise<ManagedKnowledgeChunk[]> {
  const chunks: ManagedKnowledgeChunk[] = [];
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    throwIfAborted(context.signal);
    const document = documents[documentIndex]!;
    const documentId = documentIds[documentIndex]!;
    const pieces =
      options.unit === 'tokens'
        ? await splitByTokens(document.text, options, context)
        : splitByCharacters(document.text, options);
    const safeDocumentId = createShortHash(documentId);
    pieces.forEach((piece, chunkIndex) => {
      const prefix = options.includeTitle && document.title ? `${document.title}\n\n` : '';
      chunks.push({
        id: `${version}-${safeDocumentId}-${String(chunkIndex).padStart(5, '0')}`,
        text: `${prefix}${piece}`,
        documentId,
        ...(document.title ? { title: document.title } : {}),
        chunkIndex,
        chunksInDocument: pieces.length,
        ...(document.metadata ? { metadata: document.metadata } : {}),
      });
    });
  }
  return chunks;
}

function resolveDocumentIds(documents: RivetKnowledgeDocument[]): string[] {
  return documents.map(
    (document, documentIndex) =>
      document.id?.trim() || createShortHash(`${documentIndex}:${document.title ?? ''}:${document.text}`),
  );
}

function validateUniqueDocumentIds(documentIds: string[]): void {
  const seen = new Set<string>();
  for (const documentId of documentIds) {
    if (seen.has(documentId)) {
      throw new Error(`Sync Knowledge Source contains duplicate document ID "${documentId}".`);
    }
    seen.add(documentId);
  }
}

function splitByCharacters(text: string, options: Required<KnowledgeChunkingOptions>): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + options.targetSize);
    if (end < text.length) end = findBoundary(text, start, end, options.minimumBoundarySize);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - options.overlap);
  }
  return chunks;
}

async function splitByTokens(
  text: string,
  options: Required<KnowledgeChunkingOptions>,
  context: KnowledgeOperationContext,
): Promise<string[]> {
  const getTokenCount = context.getTokenCount;
  if (!getTokenCount) throw new Error('Token-based knowledge chunking requires a runtime tokenizer.');
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let low = Math.min(text.length, start + 1);
    let high = text.length;
    let best = low;
    while (low <= high) {
      throwIfAborted(context.signal);
      const middle = Math.floor((low + high) / 2);
      const count = await getTokenCount(text.slice(start, middle));
      if (count <= options.targetSize) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    let end = best;
    if (end < text.length) {
      const minCharacters = Math.max(1, Math.floor((end - start) * (options.minimumBoundarySize / options.targetSize)));
      end = findBoundary(text, start, end, minCharacters);
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;

    const overlapStart =
      options.overlap > 0
        ? await findTokenOverlapStart(text, start, end, options.overlap, getTokenCount, context.signal)
        : end;
    start = Math.max(start + 1, overlapStart);
  }
  return chunks;
}

async function findTokenOverlapStart(
  text: string,
  chunkStart: number,
  chunkEnd: number,
  overlapTokens: number,
  getTokenCount: NonNullable<KnowledgeOperationContext['getTokenCount']>,
  signal: AbortSignal,
): Promise<number> {
  let low = chunkStart;
  let high = chunkEnd;
  let best = chunkEnd;
  while (low <= high) {
    throwIfAborted(signal);
    const middle = Math.floor((low + high) / 2);
    const count = await getTokenCount(text.slice(middle, chunkEnd));
    if (count <= overlapTokens) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best;
}

function findBoundary(text: string, start: number, proposedEnd: number, minimumSize: number): number {
  const minimumEnd = start + minimumSize;
  const candidates = [
    text.lastIndexOf('\n\n', proposedEnd),
    text.lastIndexOf('\n', proposedEnd),
    text.lastIndexOf('. ', proposedEnd),
    text.lastIndexOf('! ', proposedEnd),
    text.lastIndexOf('? ', proposedEnd),
  ];
  const boundary = Math.max(...candidates);
  return boundary >= minimumEnd ? boundary + 1 : proposedEnd;
}

function fuseEvidence(queryResults: KnowledgeQueryResult[], limit: number): RivetKnowledgeEvidence[] {
  const byId = new Map<string, { evidence: RivetKnowledgeEvidence; score: number; firstSeen: number }>();
  let firstSeen = 0;
  for (const result of queryResults) {
    result.evidence.forEach((evidence, rank) => {
      const contribution = 1 / (60 + rank + 1);
      const current = byId.get(evidence.id);
      if (current) current.score += contribution;
      else byId.set(evidence.id, { evidence, score: contribution, firstSeen: firstSeen++ });
    });
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, limit)
    .map(({ evidence }) => evidence);
}

function validateCapabilities(
  capabilities: RivetKnowledgeStoreCapabilities,
  filter: KnowledgeFilter | undefined,
  rerank: SearchKnowledgeSourceRequest['rerank'],
): void {
  if (rerank?.mode === 'required' && !capabilities.supportsProviderReranking) {
    throw new Error('The selected knowledge store does not support provider-side reranking.');
  }
  if (!filter) return;
  const supported = new Set(capabilities.supportedFilterOperators ?? []);
  for (const operator of collectFilterOperators(filter)) {
    if (!supported.has(operator))
      throw new Error(`The selected knowledge store does not support the "${operator}" filter operator.`);
  }
}

function collectFilterOperators(
  filter: KnowledgeFilter,
): Array<Extract<KnowledgeFilter, { operator: unknown }>['operator']> {
  if ('operator' in filter) return [filter.operator];
  if ('and' in filter) return filter.and.flatMap(collectFilterOperators);
  if ('or' in filter) return filter.or.flatMap(collectFilterOperators);
  return collectFilterOperators(filter.not);
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function validatePositiveInteger(value: number | undefined, label: string, minimum: number, maximum: number): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function createShortHash(value: string): string {
  return CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex).slice(0, 24);
}

function sameManifestActivation(
  actual: KnowledgeSourceManifest | undefined,
  expected: KnowledgeSourceManifest,
): boolean {
  return actual?.activeVersion === expected.activeVersion && actual.commitId === expected.commitId;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('Knowledge operation was cancelled.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
