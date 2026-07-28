import CryptoJS from 'crypto-js';
import type {
  KnowledgeFilter,
  KnowledgeMetadata,
  KnowledgeOperationContext,
  RivetKnowledgeEvidence,
  RivetKnowledgeStore,
} from '../../integrations/KnowledgeStore.js';
import {
  ManagedKnowledgeStore,
  type KnowledgeDriverSearchRequest,
  type KnowledgeSourceManifest,
  type ManagedKnowledgeChunk,
  type ManagedKnowledgeStoreDriver,
  normalizeKnowledgeSourceManifest,
} from '../../integrations/ManagedKnowledgeStore.js';
import type { KnowledgeStoreConnectionDefinition } from '../../model/Project.js';
import type { KnowledgeStoreProviderTestContext } from '../../integrations/KnowledgeStoreProvider.js';
import type { RuntimeSettings } from '../../model/Settings.js';

const DEFAULT_API_VERSION = '2026-04';
const MANIFEST_RECORD_ID = '__rivet_manifest__';
const RESERVED_PREFIX = 'rivet_';
const DEFAULT_TEXT_FIELD = 'chunk_text';
const MANIFEST_VISIBILITY_ATTEMPTS = 12;

type PineconeKnowledgeConfig = {
  indexHost: string;
  namespaceTemplate: string;
  textField: string;
  apiVersion: string;
  rerankModel?: string;
};

export function createPineconeKnowledgeStore(
  definition: KnowledgeStoreConnectionDefinition,
  settings: RuntimeSettings,
  credentials: Readonly<Record<string, string>>,
): RivetKnowledgeStore {
  const config = readConfig(definition);
  const pluginSettings = settings.pluginSettings?.pinecone;
  const apiKey = firstNonEmptyString(
    credentials.apiKey,
    pluginSettings?.pineconeApiKey,
    settings.pluginEnv?.PINECONE_API_KEY,
  );
  if (!apiKey) {
    throw new Error(
      `Pinecone credentials are missing for knowledge store "${definition.displayName}". Configure its API key or PINECONE_API_KEY.`,
    );
  }
  return new ManagedKnowledgeStore(new PineconeKnowledgeStoreDriver(config, apiKey));
}

export async function testPineconeKnowledgeConnection(
  definition: KnowledgeStoreConnectionDefinition,
  credentials: Record<string, string>,
  signal: AbortSignal,
  context: KnowledgeStoreProviderTestContext,
): Promise<void> {
  const config = readConfig(definition);
  const apiKey = firstNonEmptyString(
    credentials.apiKey,
    context.settings.pluginSettings?.pinecone?.pineconeApiKey,
    context.settings.pluginEnv?.PINECONE_API_KEY,
  );
  if (!apiKey) throw new Error('Enter an API key before testing this Pinecone connection.');
  const response = await fetch(`${config.indexHost}/describe_index_stats`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'X-Pinecone-Api-Version': config.apiVersion,
    },
    body: '{}',
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw createProviderError(response.status, response.statusText, body);
  }
  const payload = await parseJsonResponse(response, 'testing the knowledge-store connection');
  if (!isRecord(payload)) throw new Error('Pinecone connection test returned a malformed successful response.');
}

class PineconeKnowledgeStoreDriver implements ManagedKnowledgeStoreDriver {
  readonly capabilities = {
    supportedFilterOperators: ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists'] as const,
    supportsProviderReranking: true,
    supportedExecutors: ['nodejs'] as const,
  };
  readonly operationScope: string;

  constructor(
    readonly config: PineconeKnowledgeConfig,
    readonly apiKey: string,
  ) {
    this.operationScope = `pinecone:${config.indexHost}`;
  }

  async getManifest(
    sourceId: string,
    context: KnowledgeOperationContext,
  ): Promise<KnowledgeSourceManifest | undefined> {
    return (await this.#readManifest(sourceId, context)).manifest;
  }

  async #readManifest(
    sourceId: string,
    context: KnowledgeOperationContext,
  ): Promise<{ manifest?: KnowledgeSourceManifest; indexedLsn?: bigint }> {
    const namespace = this.#namespace(sourceId);
    const url = `${this.config.indexHost}/vectors/fetch?ids=${encodeURIComponent(MANIFEST_RECORD_ID)}&namespace=${encodeURIComponent(namespace)}`;
    const response = await this.#request(url, { method: 'GET' }, context);
    const indexedLsn = readPineconeLsn(response.headers, 'x-pinecone-max-indexed-lsn');
    const payload = await parseJsonResponse(response, 'fetching the knowledge-source manifest');
    if (!isRecord(payload)) {
      throw new Error('Pinecone returned an invalid manifest fetch response.');
    }
    const vectors = payload.vectors;
    if (!isRecord(vectors)) {
      throw new Error('Pinecone manifest fetch response is missing its vectors map.');
    }
    const manifestRecord = vectors[MANIFEST_RECORD_ID];
    if (manifestRecord != null && !isRecord(manifestRecord)) {
      throw new Error(`Pinecone manifest record for source "${sourceId}" is malformed.`);
    }
    if (!isRecord(manifestRecord)) return { ...(indexedLsn == null ? {} : { indexedLsn }) };
    const fields = isRecord(manifestRecord.fields)
      ? manifestRecord.fields
      : isRecord(manifestRecord.metadata)
        ? manifestRecord.metadata
        : {};
    const encodedManifest = fields.rivet_manifest_json;
    if (typeof encodedManifest !== 'string') {
      throw new Error(`Pinecone manifest for source "${sourceId}" is missing Rivet manifest metadata.`);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(encodedManifest);
    } catch {
      throw new Error(`Pinecone manifest for source "${sourceId}" contains invalid JSON.`);
    }
    return {
      manifest: normalizeKnowledgeSourceManifest(manifest, sourceId),
      ...(indexedLsn == null ? {} : { indexedLsn }),
    };
  }

  async upsertChunks(
    sourceId: string,
    version: string,
    chunks: ManagedKnowledgeChunk[],
    context: KnowledgeOperationContext,
  ): Promise<void> {
    const namespace = this.#namespace(sourceId);
    const records = chunks.map((chunk) => this.#chunkRecord(sourceId, version, chunk));
    const batches = batchNdjson(records, 32, 1_500_000);
    for (let index = 0; index < batches.length; index += 1) {
      const response = await this.#request(
        `${this.config.indexHost}/records/namespaces/${encodeURIComponent(namespace)}/upsert`,
        { method: 'POST', body: batches[index], headers: { 'Content-Type': 'application/x-ndjson' } },
        context,
      );
      await response.text();
    }
  }

  async commitManifest(manifest: KnowledgeSourceManifest, context: KnowledgeOperationContext): Promise<void> {
    const namespace = this.#namespace(manifest.sourceId);
    const record = {
      _id: MANIFEST_RECORD_ID,
      [this.config.textField]:
        `Rivet knowledge-source manifest for ${manifest.sourceId}, version ${manifest.activeVersion}.`,
      rivet_record_type: 'manifest',
      rivet_source_id: manifest.sourceId,
      rivet_source_version: manifest.activeVersion,
      rivet_manifest_json: JSON.stringify(manifest),
    };
    validatePineconeRecordMetadataSize(record, this.config.textField, `manifest for source "${manifest.sourceId}"`);
    const response = await this.#request(
      `${this.config.indexHost}/records/namespaces/${encodeURIComponent(namespace)}/upsert`,
      { method: 'POST', body: JSON.stringify(record), headers: { 'Content-Type': 'application/x-ndjson' } },
      context,
    );
    const writeLsn =
      readPineconeLsn(response.headers, 'x-pinecone-request-lsn') ??
      readPineconeLsn(response.headers, 'x-pinecone-max-indexed-lsn');
    await response.text();

    // Pinecone is eventually consistent. Once the later manifest write is
    // readable, all earlier chunk upserts in this namespace are readable too.
    for (let attempt = 0; attempt < MANIFEST_VISIBILITY_ATTEMPTS; attempt += 1) {
      const visible = await this.#readManifest(manifest.sourceId, context);
      const indexedWrite = writeLsn == null || visible.indexedLsn == null || visible.indexedLsn >= writeLsn;
      if (visible.manifest && sameManifestCommit(visible.manifest, manifest) && indexedWrite) return;
      if (attempt + 1 < MANIFEST_VISIBILITY_ATTEMPTS) {
        await cancellableDelay(Math.min(2_000, 100 * 2 ** attempt), context.signal);
      }
    }
    throw new Error(
      `Pinecone accepted knowledge source "${manifest.sourceId}", but its committed manifest did not become readable in time.`,
    );
  }

  async search(
    request: KnowledgeDriverSearchRequest,
    context: KnowledgeOperationContext,
  ): Promise<RivetKnowledgeEvidence[]> {
    const namespace = this.#namespace(request.sourceId);
    const filter = combinePineconeFilters(
      {
        $and: [{ rivet_record_type: { $eq: 'chunk' } }, { rivet_source_version: { $eq: request.version } }],
      },
      request.filter ? toPineconeFilter(request.filter) : undefined,
    );
    const body: Record<string, unknown> = {
      query: { inputs: { text: request.query }, top_k: request.topK, filter },
    };
    if (request.rerank) {
      const model = this.config.rerankModel;
      if (!model && request.rerank.mode === 'required') {
        throw new Error('Pinecone reranking is required, but this connection has no rerank model configured.');
      }
      if (model) {
        body.rerank = {
          query: request.query,
          model,
          top_n: Math.min(request.topK, request.rerank.topN ?? 7),
          rank_fields: [this.config.textField],
        };
      }
    }

    const response = await this.#request(
      `${this.config.indexHost}/records/namespaces/${encodeURIComponent(namespace)}/search`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
      context,
    );
    const payload = await parseJsonResponse(response, 'searching knowledge');
    if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.hits)) {
      throw new Error('Pinecone returned an invalid knowledge search response.');
    }
    return payload.result.hits.map((hit, index): RivetKnowledgeEvidence => {
      if (!isRecord(hit) || !isRecord(hit.fields)) {
        throw new Error(`Pinecone knowledge search hit ${index + 1} is malformed.`);
      }
      const fields = hit.fields;
      const id = recordId(hit);
      const text = fields[this.config.textField];
      const documentId = fields.rivet_document_id;
      if (!id || typeof text !== 'string' || !text.trim() || typeof documentId !== 'string' || !documentId.trim()) {
        throw new Error(`Pinecone knowledge search hit ${index + 1} is missing required Rivet fields.`);
      }
      if (fields.rivet_title != null && typeof fields.rivet_title !== 'string') {
        throw new Error(`Pinecone knowledge search hit ${index + 1} has an invalid title.`);
      }
      if (
        fields.rivet_chunk_index != null &&
        (!Number.isInteger(fields.rivet_chunk_index) || (fields.rivet_chunk_index as number) < 0)
      ) {
        throw new Error(`Pinecone knowledge search hit ${index + 1} has an invalid chunk index.`);
      }
      if (hit._score != null && (typeof hit._score !== 'number' || !Number.isFinite(hit._score))) {
        throw new Error(`Pinecone knowledge search hit ${index + 1} has an invalid relevance score.`);
      }
      const title =
        typeof fields.rivet_title === 'string' && fields.rivet_title.trim() ? fields.rivet_title : undefined;
      const chunkIndex = fields.rivet_chunk_index as number | undefined;
      const score = hit._score as number | undefined;
      const metadata = extractUserMetadata(fields, this.config.textField);
      return {
        id,
        text,
        documentId,
        source: { connectionId: '', sourceId: request.sourceId, version: request.version },
        ...(title ? { title } : {}),
        ...(chunkIndex == null ? {} : { chunkIndex }),
        ...(score == null ? {} : { relevanceScore: score }),
        ...(metadata ? { metadata } : {}),
      };
    });
  }

  async deleteVersion(sourceId: string, version: string, context: KnowledgeOperationContext): Promise<void> {
    const namespace = this.#namespace(sourceId);
    const response = await this.#request(
      `${this.config.indexHost}/vectors/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace,
          filter: {
            $and: [{ rivet_record_type: { $eq: 'chunk' } }, { rivet_source_version: { $eq: version } }],
          },
        }),
      },
      context,
    );
    await response.text();
  }

  #chunkRecord(sourceId: string, version: string, chunk: ManagedKnowledgeChunk): Record<string, unknown> {
    const metadata = chunk.metadata ?? {};
    for (const [key, value] of Object.entries(metadata)) {
      validatePineconeFieldName(key, 'Knowledge metadata field');
      if (key.startsWith(RESERVED_PREFIX)) {
        throw new Error(`Knowledge metadata field "${key}" uses the reserved ${RESERVED_PREFIX} prefix.`);
      }
      if (key === this.config.textField) {
        throw new Error(
          `Knowledge metadata field "${key}" conflicts with the Pinecone integrated embedding text field.`,
        );
      }
      if (value === null || (Array.isArray(value) && !value.every((item) => typeof item === 'string'))) {
        throw new Error(
          `Pinecone metadata field "${key}" must be a string, finite number, boolean, or array of strings.`,
        );
      }
    }
    const record = {
      _id: chunk.id,
      [this.config.textField]: chunk.text,
      rivet_record_type: 'chunk',
      rivet_source_id: sourceId,
      rivet_source_version: version,
      rivet_document_id: chunk.documentId,
      rivet_title: chunk.title ?? '',
      rivet_chunk_index: chunk.chunkIndex,
      rivet_chunks_in_document: chunk.chunksInDocument,
      ...metadata,
    };
    validatePineconeRecordMetadataSize(record, this.config.textField, `knowledge chunk "${chunk.id}"`);
    return record;
  }

  #namespace(sourceId: string): string {
    const readableSourceId =
      sourceId
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 120) || 'source';
    const sourceHash = CryptoJS.SHA256(sourceId).toString(CryptoJS.enc.Hex).slice(0, 24);
    const safeSourceId = `${readableSourceId}--${sourceHash}`;
    const namespace = this.config.namespaceTemplate.replaceAll('{sourceId}', safeSourceId).trim();
    if (!namespace) throw new Error('Pinecone Namespace Template produced an empty namespace.');
    if (namespace.length > 512)
      throw new Error('Pinecone Namespace Template produced a namespace longer than 512 characters.');
    return namespace;
  }

  async #request(url: string, init: RequestInit, context: KnowledgeOperationContext): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Api-Key', this.apiKey);
    headers.set('X-Pinecone-Api-Version', this.config.apiVersion);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('Pinecone request was cancelled.');
      try {
        const response = await fetch(url, { ...init, headers, signal: context.signal });
        if (response.ok) return response;
        const body = await response.text();
        const error = createProviderError(response.status, response.statusText, body);
        if (!isRetryableStatus(response.status) || attempt === 2) throw error;
        lastError = error;
        const retryAfter = response.headers.get('retry-after');
        await cancellableDelay(retryDelayMs(retryAfter, attempt), context.signal);
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error;
        if (error instanceof PineconeKnowledgeError || attempt === 2) throw error;
        lastError = error;
        await cancellableDelay(500 * 2 ** attempt + Math.floor(Math.random() * 150), context.signal);
      }
    }
    throw lastError ?? new Error('Pinecone request failed.');
  }
}

export class PineconeKnowledgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerBody: string,
  ) {
    super(message);
    this.name = 'PineconeKnowledgeError';
  }
}

function readConfig(definition: KnowledgeStoreConnectionDefinition): PineconeKnowledgeConfig {
  const indexHostRaw = stringConfig(definition.config.indexHost);
  if (!indexHostRaw) throw new Error(`Pinecone knowledge store "${definition.displayName}" requires an Index Host.`);
  const indexHost = /^https?:\/\//i.test(indexHostRaw) ? indexHostRaw : `https://${indexHostRaw}`;
  let parsed: URL;
  try {
    parsed = new URL(indexHost);
  } catch {
    throw new Error(`Pinecone knowledge store "${definition.displayName}" has an invalid Index Host.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Pinecone knowledge store "${definition.displayName}" requires an HTTPS Index Host.`);
  }
  const namespaceTemplate = stringConfig(definition.config.namespaceTemplate) || '{sourceId}';
  if (!namespaceTemplate.includes('{sourceId}')) {
    throw new Error('Pinecone Namespace Template must contain {sourceId} so sources remain isolated.');
  }
  const textField = stringConfig(definition.config.textField) || DEFAULT_TEXT_FIELD;
  validatePineconeFieldName(textField, 'Pinecone Text Field');
  if (textField.startsWith(RESERVED_PREFIX))
    throw new Error(`Pinecone Text Field cannot use the reserved ${RESERVED_PREFIX} prefix.`);
  return {
    indexHost: `${parsed.protocol}//${parsed.host}`,
    namespaceTemplate,
    textField,
    apiVersion: stringConfig(definition.config.apiVersion) || DEFAULT_API_VERSION,
    ...(stringConfig(definition.config.rerankModel)
      ? { rerankModel: stringConfig(definition.config.rerankModel) }
      : {}),
  };
}

function toPineconeFilter(filter: KnowledgeFilter): Record<string, unknown> {
  if ('and' in filter) return { $and: filter.and.map(toPineconeFilter) };
  if ('or' in filter) return { $or: filter.or.map(toPineconeFilter) };
  if ('not' in filter) return toNegatedPineconeFilter(filter.not);
  validatePineconeFilterComparison(filter);
  const operatorMap = {
    eq: '$eq',
    neq: '$ne',
    in: '$in',
    nin: '$nin',
    gt: '$gt',
    gte: '$gte',
    lt: '$lt',
    lte: '$lte',
    exists: '$exists',
  } as const;
  return { [filter.field]: { [operatorMap[filter.operator]]: filter.operator === 'exists' ? true : filter.value } };
}

function toNegatedPineconeFilter(filter: KnowledgeFilter): Record<string, unknown> {
  if ('and' in filter) return { $or: filter.and.map(toNegatedPineconeFilter) };
  if ('or' in filter) return { $and: filter.or.map(toNegatedPineconeFilter) };
  if ('not' in filter) return toPineconeFilter(filter.not);
  validatePineconeFilterComparison(filter);
  const operatorMap = {
    eq: '$ne',
    neq: '$eq',
    in: '$nin',
    nin: '$in',
    gt: '$lte',
    gte: '$lt',
    lt: '$gte',
    lte: '$gt',
    exists: '$exists',
  } as const;
  return { [filter.field]: { [operatorMap[filter.operator]]: filter.operator === 'exists' ? false : filter.value } };
}

function combinePineconeFilters(
  required: Record<string, unknown>,
  optional: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!optional) return required;
  const requiredParts = Array.isArray(required.$and) ? required.$and : [required];
  return { $and: [...requiredParts, optional] };
}

function batchNdjson(records: Record<string, unknown>[], maxRecords: number, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const batches: string[] = [];
  let lines: string[] = [];
  let bytes = 0;
  for (const record of records) {
    const line = JSON.stringify(record);
    const lineBytes = encoder.encode(line).byteLength + (lines.length ? 1 : 0);
    if (lineBytes > maxBytes) throw new Error(`A single Pinecone knowledge record exceeds ${maxBytes} bytes.`);
    if (lines.length && (lines.length >= maxRecords || bytes + lineBytes > maxBytes)) {
      batches.push(lines.join('\n'));
      lines = [];
      bytes = 0;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  if (lines.length) batches.push(lines.join('\n'));
  return batches;
}

function validatePineconeRecordMetadataSize(record: Record<string, unknown>, textField: string, label: string): void {
  const storedMetadata = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== '_id' && key !== textField),
  );
  if (new TextEncoder().encode(JSON.stringify(storedMetadata)).byteLength > 40 * 1024) {
    throw new Error(`Pinecone metadata for ${label} exceeds 40 KB.`);
  }
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  const body = await response.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Pinecone returned invalid JSON while ${operation}: ${body.slice(0, 1000)}`);
  }
}

function createProviderError(status: number, statusText: string, body: string): PineconeKnowledgeError {
  let providerMessage = body.trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : undefined;
      providerMessage =
        stringConfig(error?.message) || stringConfig(parsed.message) || stringConfig(parsed.error) || providerMessage;
    }
  } catch {
    // Preserve non-JSON provider bodies verbatim.
  }
  return new PineconeKnowledgeError(
    `Pinecone request failed (${status} ${statusText}).${providerMessage ? ` ${providerMessage}` : ''}`,
    status,
    body,
  );
}

function extractUserMetadata(fields: Record<string, unknown>, textField: string): KnowledgeMetadata | undefined {
  const metadata: KnowledgeMetadata = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === textField || key.startsWith(RESERVED_PREFIX) || key.startsWith('_')) continue;
    validatePineconeFieldName(key, 'Pinecone response metadata field');
    if (
      value === null ||
      (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number' && !Array.isArray(value)) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (Array.isArray(value) && !value.every((item) => typeof item === 'string'))
    ) {
      throw new Error(
        `Pinecone response metadata field "${key}" must be a string, finite number, boolean, or array of strings.`,
      );
    }
    metadata[key] = value as KnowledgeMetadata[string];
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function recordId(value: unknown): string {
  if (!isRecord(value)) return '';
  return stringConfig(value._id) || stringConfig(value.id);
}

function stringConfig(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = stringConfig(value);
    if (normalized) return normalized;
  }
  return '';
}

function sameManifestCommit(left: KnowledgeSourceManifest, right: KnowledgeSourceManifest): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sourceId === right.sourceId &&
    left.activeVersion === right.activeVersion &&
    (left.commitId ?? '') === (right.commitId ?? '') &&
    left.documentCount === right.documentCount &&
    left.chunkCount === right.chunkCount &&
    left.updatedAt === right.updatedAt
  );
}

function readPineconeLsn(headers: Headers, name: string): bigint | undefined {
  const value = headers.get(name)?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function validatePineconeFieldName(value: string, label: string): void {
  if (!value || value.startsWith('_') || value.startsWith('$')) {
    throw new Error(`${label} "${value}" must be non-empty and cannot start with _ or $.`);
  }
  if (new TextEncoder().encode(value).byteLength > 64) {
    throw new Error(`${label} "${value}" cannot exceed 64 UTF-8 bytes.`);
  }
}

function validatePineconeFilterComparison(filter: Extract<KnowledgeFilter, { field: string }>): void {
  validatePineconeFieldName(filter.field, 'Pinecone filter field');
  if (filter.field.startsWith(RESERVED_PREFIX)) {
    throw new Error(`Pinecone filter field "${filter.field}" uses the reserved ${RESERVED_PREFIX} prefix.`);
  }
  if (filter.operator === 'exists') return;
  if (
    (filter.operator === 'gt' || filter.operator === 'gte' || filter.operator === 'lt' || filter.operator === 'lte') &&
    (typeof filter.value !== 'number' || !Number.isFinite(filter.value))
  ) {
    throw new Error(`Pinecone filter operator "${filter.operator}" requires a finite number.`);
  }
  if (filter.value === null || (Array.isArray(filter.value) && filter.operator !== 'in' && filter.operator !== 'nin')) {
    throw new Error(`Pinecone filter operator "${filter.operator}" requires a supported scalar value.`);
  }
  if (
    (filter.operator === 'in' || filter.operator === 'nin') &&
    (!Array.isArray(filter.value) ||
      !filter.value.every((item) => typeof item === 'string' || typeof item === 'number'))
  ) {
    throw new Error(`Pinecone filter operator "${filter.operator}" requires an array of strings or numbers.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 150);
}

async function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Pinecone request was cancelled.'));
    };
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
