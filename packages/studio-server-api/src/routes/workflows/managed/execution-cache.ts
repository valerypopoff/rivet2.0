import { LRUCache } from 'lru-cache';

export type ManagedWorkflowRunKind = 'published' | 'latest' | 'web-app' | 'latest-web-app';

export type ManagedEndpointPointerCacheEntry = {
  workflowId: string;
  relativePath: string;
  revisionId: string;
  webAppUiGraphId?: string;
  webAppAllowedEmails?: string[];
};

export type ManagedRevisionMaterializationCacheEntry = {
  revisionId: string;
  contents: string;
  datasetsContents: string | null;
};

type ManagedRevisionMaterializationRecord = {
  entry: ManagedRevisionMaterializationCacheEntry;
  sizeBytes: number;
};

type ManagedWorkflowExecutionCacheOptions = {
  endpointPointerLimit?: number;
  revisionMaterializationBytesLimit?: number;
  maxSingleRevisionBytes?: number;
};

const DEFAULT_ENDPOINT_POINTER_LIMIT = 4096;
const DEFAULT_REVISION_MATERIALIZATION_BYTES_LIMIT = 64 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_REVISION_BYTES = 8 * 1024 * 1024;

function measureRevisionMaterializationBytes(entry: ManagedRevisionMaterializationCacheEntry): number {
  return Buffer.byteLength(entry.contents, 'utf8') + Buffer.byteLength(entry.datasetsContents ?? '', 'utf8');
}

export class ManagedWorkflowExecutionCache {
  readonly #endpointPointerLimit: number;
  readonly #revisionMaterializationBytesLimit: number;
  readonly #maxSingleRevisionBytes: number;
  readonly #endpointPointers: LRUCache<string, ManagedEndpointPointerCacheEntry>;
  readonly #workflowEndpointPointerKeys = new Map<string, Set<string>>();
  readonly #revisionMaterializations: LRUCache<string, ManagedRevisionMaterializationRecord>;

  constructor(options: ManagedWorkflowExecutionCacheOptions = {}) {
    this.#endpointPointerLimit = options.endpointPointerLimit ?? DEFAULT_ENDPOINT_POINTER_LIMIT;
    this.#revisionMaterializationBytesLimit = options.revisionMaterializationBytesLimit ?? DEFAULT_REVISION_MATERIALIZATION_BYTES_LIMIT;
    this.#maxSingleRevisionBytes = options.maxSingleRevisionBytes ?? DEFAULT_MAX_SINGLE_REVISION_BYTES;
    this.#endpointPointers = new LRUCache({
      max: Math.max(1, this.#endpointPointerLimit),
      dispose: (entry, key) => {
        this.#unlinkEndpointPointerKey(entry.workflowId, key);
      },
    });
    this.#revisionMaterializations = new LRUCache({
      maxSize: Math.max(1, this.#revisionMaterializationBytesLimit),
      maxEntrySize: Math.max(1, this.#maxSingleRevisionBytes),
      sizeCalculation: (record) => record.sizeBytes,
    });
  }

  getEndpointPointer(key: string): ManagedEndpointPointerCacheEntry | null {
    if (this.#endpointPointerLimit <= 0) {
      return null;
    }

    return this.#endpointPointers.get(key) ?? null;
  }

  setEndpointPointer(key: string, entry: ManagedEndpointPointerCacheEntry): void {
    if (this.#endpointPointerLimit <= 0) {
      this.#endpointPointers.delete(key);
      return;
    }

    this.#endpointPointers.set(key, entry);
    this.#linkEndpointPointerKey(entry.workflowId, key);
  }

  invalidateWorkflowEndpointPointers(workflowId: string): void {
    const keys = this.#workflowEndpointPointerKeys.get(workflowId);
    if (!keys) {
      return;
    }

    for (const key of [...keys]) {
      this.#endpointPointers.delete(key);
    }
  }

  clearEndpointPointers(): void {
    this.#endpointPointers.clear();
    this.#workflowEndpointPointerKeys.clear();
  }

  getRevisionMaterialization(revisionId: string): ManagedRevisionMaterializationCacheEntry | null {
    if (this.#revisionMaterializationBytesLimit <= 0) {
      return null;
    }

    return this.#revisionMaterializations.get(revisionId)?.entry ?? null;
  }

  setRevisionMaterialization(entry: ManagedRevisionMaterializationCacheEntry): boolean {
    const sizeBytes = measureRevisionMaterializationBytes(entry);
    if (
      this.#revisionMaterializationBytesLimit <= 0
      || sizeBytes > this.#maxSingleRevisionBytes
      || sizeBytes > this.#revisionMaterializationBytesLimit
    ) {
      this.#revisionMaterializations.delete(entry.revisionId);
      return false;
    }

    this.#revisionMaterializations.set(entry.revisionId, {
      entry,
      sizeBytes,
    });
    return true;
  }

  clearRevisionMaterializations(): void {
    this.#revisionMaterializations.clear();
  }

  #linkEndpointPointerKey(workflowId: string, key: string): void {
    const keys = this.#workflowEndpointPointerKeys.get(workflowId);
    if (keys) {
      keys.add(key);
      return;
    }

    this.#workflowEndpointPointerKeys.set(workflowId, new Set([key]));
  }

  #unlinkEndpointPointerKey(workflowId: string, key: string): void {
    const keys = this.#workflowEndpointPointerKeys.get(workflowId);
    if (!keys) {
      return;
    }

    keys.delete(key);
    if (keys.size === 0) {
      this.#workflowEndpointPointerKeys.delete(workflowId);
    }
  }
}
