export type KnowledgeStoreConnectionId = string;

export type KnowledgeMetadataScalar = null | boolean | number | string;
export type KnowledgeMetadataValue = KnowledgeMetadataScalar | boolean[] | number[] | string[];
export type KnowledgeMetadata = Record<string, KnowledgeMetadataValue>;

export type RivetKnowledgeSourceReference = {
  connectionId: KnowledgeStoreConnectionId;
  sourceId: string;
  /** When omitted, operations resolve the source's active committed version. */
  version?: string;
};

export type RivetKnowledgeDocument = {
  id?: string;
  text: string;
  title?: string;
  metadata?: KnowledgeMetadata;
};

export type RivetKnowledgeEvidence = {
  id: string;
  text: string;
  relevanceScore?: number;
  source: RivetKnowledgeSourceReference;
  documentId: string;
  title?: string;
  chunkIndex?: number;
  metadata?: KnowledgeMetadata;
};

export type KnowledgeFilterComparisonOperator = 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export type KnowledgeFilter =
  | {
      field: string;
      operator: KnowledgeFilterComparisonOperator;
      value?: KnowledgeMetadataValue;
    }
  | { and: KnowledgeFilter[] }
  | { or: KnowledgeFilter[] }
  | { not: KnowledgeFilter };

export type RivetKnowledgeStoreCapabilities = {
  supportedFilterOperators?: ReadonlyArray<KnowledgeFilterComparisonOperator>;
  supportsProviderReranking?: boolean;
  supportedExecutors?: ReadonlyArray<'browser' | 'nodejs'>;
};

export type KnowledgeOperationContext = {
  signal: AbortSignal;
  getTokenCount?: (text: string) => Promise<number>;
};

export type KnowledgeChunkingOptions = {
  unit?: 'characters' | 'tokens';
  targetSize?: number;
  overlap?: number;
  minimumBoundarySize?: number;
  includeTitle?: boolean;
};

type KnowledgeSourceStatusFields = {
  source: RivetKnowledgeSourceReference;
  documentCount?: number;
  chunkCount?: number;
  updatedAt?: string;
  metadata?: KnowledgeMetadata;
  message: string;
};

export type KnowledgeSourceStatus =
  | (KnowledgeSourceStatusFields & {
      exists: true;
      activeVersion: string;
    })
  | (KnowledgeSourceStatusFields & {
      exists: false;
      activeVersion?: never;
    });

export type GetKnowledgeSourceStatusRequest = {
  source: RivetKnowledgeSourceReference;
  expectedVersion?: string;
};

export type GetKnowledgeSourceStatusResult = KnowledgeSourceStatus & {
  matchesExpectedVersion?: boolean;
};

export type SyncKnowledgeSourceRequest = {
  source: RivetKnowledgeSourceReference;
  documents: RivetKnowledgeDocument[];
  metadata?: KnowledgeMetadata;
  chunking?: KnowledgeChunkingOptions;
  forceRefresh?: boolean;
};

export type SyncKnowledgeSourceResult = {
  source: RivetKnowledgeSourceReference & { version: string };
  result: 'created' | 'updated' | 'unchanged';
  previousVersion?: string;
  documentCount: number;
  chunkCount: number;
  warnings: string[];
};

export type KnowledgeRerankOptions = {
  mode: 'connection-default' | 'required';
  topN?: number;
};

export type SearchKnowledgeSourceRequest = {
  source: RivetKnowledgeSourceReference;
  queries: string[];
  topK?: number;
  filter?: KnowledgeFilter;
  rerank?: KnowledgeRerankOptions;
  maxConcurrency?: number;
  finalResultCount?: number;
};

export type KnowledgeQueryResult = {
  query: string;
  evidence: RivetKnowledgeEvidence[];
};

export type SearchKnowledgeSourceResult = {
  sourceFound: boolean;
  source: RivetKnowledgeSourceReference;
  evidence: RivetKnowledgeEvidence[];
  queryResults: KnowledgeQueryResult[];
  message: string;
};

/**
 * High-level, provider-neutral store used by Rivet nodes and programmatic hosts.
 * Implementations own their durable source/version representation.
 */
export interface RivetKnowledgeStore {
  readonly capabilities: RivetKnowledgeStoreCapabilities;

  getSourceStatus(
    request: GetKnowledgeSourceStatusRequest,
    context: KnowledgeOperationContext,
  ): Promise<GetKnowledgeSourceStatusResult>;

  syncSource(
    request: SyncKnowledgeSourceRequest,
    context: KnowledgeOperationContext,
  ): Promise<SyncKnowledgeSourceResult>;

  search(
    request: SearchKnowledgeSourceRequest,
    context: KnowledgeOperationContext,
  ): Promise<SearchKnowledgeSourceResult>;
}

export type RivetKnowledgeStoreRegistry = Record<KnowledgeStoreConnectionId, RivetKnowledgeStore>;
