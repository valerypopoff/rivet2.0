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
  readonly #endpointPointers = new Map<string, ManagedEndpointPointerCacheEntry>();
  readonly #workflowEndpointPointerKeys = new Map<string, Set<string>>();
  readonly #revisionMaterializations = new Map<string, ManagedRevisionMaterializationRecord>();
  #revisionMaterializationBytes = 0;

  constructor(options: ManagedWorkflowExecutionCacheOptions = {}) {
    this.#endpointPointerLimit = options.endpointPointerLimit ?? DEFAULT_ENDPOINT_POINTER_LIMIT;
    this.#revisionMaterializationBytesLimit = options.revisionMaterializationBytesLimit ?? DEFAULT_REVISION_MATERIALIZATION_BYTES_LIMIT;
    this.#maxSingleRevisionBytes = options.maxSingleRevisionBytes ?? DEFAULT_MAX_SINGLE_REVISION_BYTES;
  }

  getEndpointPointer(key: string): ManagedEndpointPointerCacheEntry | null {
    const entry = this.#endpointPointers.get(key);
    if (!entry) {
      return null;
    }

    this.#endpointPointers.delete(key);
    this.#endpointPointers.set(key, entry);
    return entry;
  }

  setEndpointPointer(key: string, entry: ManagedEndpointPointerCacheEntry): void {
    const existing = this.#endpointPointers.get(key);
    if (existing) {
      this.#unlinkEndpointPointerKey(existing.workflowId, key);
      this.#endpointPointers.delete(key);
    }

    this.#endpointPointers.set(key, entry);
    this.#linkEndpointPointerKey(entry.workflowId, key);

    while (this.#endpointPointers.size > this.#endpointPointerLimit) {
      const oldestKey = this.#endpointPointers.keys().next().value;
      if (!oldestKey) {
        break;
      }

      const oldestEntry = this.#endpointPointers.get(oldestKey);
      this.#endpointPointers.delete(oldestKey);
      if (oldestEntry) {
        this.#unlinkEndpointPointerKey(oldestEntry.workflowId, oldestKey);
      }
    }
  }

  invalidateWorkflowEndpointPointers(workflowId: string): void {
    const keys = this.#workflowEndpointPointerKeys.get(workflowId);
    if (!keys) {
      return;
    }

    for (const key of keys) {
      this.#endpointPointers.delete(key);
    }

    this.#workflowEndpointPointerKeys.delete(workflowId);
  }

  clearEndpointPointers(): void {
    this.#endpointPointers.clear();
    this.#workflowEndpointPointerKeys.clear();
  }

  getRevisionMaterialization(revisionId: string): ManagedRevisionMaterializationCacheEntry | null {
    const record = this.#revisionMaterializations.get(revisionId);
    if (!record) {
      return null;
    }

    this.#revisionMaterializations.delete(revisionId);
    this.#revisionMaterializations.set(revisionId, record);
    return record.entry;
  }

  setRevisionMaterialization(entry: ManagedRevisionMaterializationCacheEntry): boolean {
    const sizeBytes = measureRevisionMaterializationBytes(entry);
    if (sizeBytes > this.#maxSingleRevisionBytes) {
      this.#deleteRevisionMaterialization(entry.revisionId);
      return false;
    }

    this.#deleteRevisionMaterialization(entry.revisionId);
    this.#revisionMaterializations.set(entry.revisionId, {
      entry,
      sizeBytes,
    });
    this.#revisionMaterializationBytes += sizeBytes;

    while (this.#revisionMaterializationBytes > this.#revisionMaterializationBytesLimit) {
      const oldestRevisionId = this.#revisionMaterializations.keys().next().value;
      if (!oldestRevisionId) {
        break;
      }

      this.#deleteRevisionMaterialization(oldestRevisionId);
    }

    return true;
  }

  clearRevisionMaterializations(): void {
    this.#revisionMaterializations.clear();
    this.#revisionMaterializationBytes = 0;
  }

  #deleteRevisionMaterialization(revisionId: string): void {
    const existing = this.#revisionMaterializations.get(revisionId);
    if (!existing) {
      return;
    }

    this.#revisionMaterializations.delete(revisionId);
    this.#revisionMaterializationBytes = Math.max(0, this.#revisionMaterializationBytes - existing.sizeBytes);
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
