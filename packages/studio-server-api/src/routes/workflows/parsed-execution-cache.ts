import { serialize } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { LRUCache } from 'lru-cache';
import { deserializeDatasets, deserializeProject } from '@valerypopoff/rivet2-core/serialization';
import { getFilesystemProjectRevisionId } from './project-index.js';
import { recordStudioMetrics } from '../../metrics.js';

type Source = { revisionId: string; contents: string; datasetsContents: string | null };
type Definition = {
  project: ReturnType<typeof deserializeProject>[0];
  attachedData: ReturnType<typeof deserializeProject>[1];
  datasets: ReturnType<typeof deserializeDatasets>;
};
type Entry = { source: Source; definition: Definition; bytes: number; retained: boolean; contentRevision?: string };
type ProjectParser = (contents: string) => ReturnType<typeof deserializeProject>;

/** Only parsed data is reusable. Every consumer receives detached mutable state;
 * graph plans, external-project pointers and processors remain run-scoped. */
export class ParsedExecutionCache {
  readonly #cache: LRUCache<string, Entry>;
  readonly #enabled: boolean;
  readonly #parse: ProjectParser;
  readonly #maxBytes: number;
  readonly #maxEntryBytes: number;

  constructor(options: { maxBytes?: number; maxEntryBytes?: number; parse?: ProjectParser } = {}) {
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.#enabled = maxBytes > 0;
    this.#maxBytes = maxBytes;
    this.#maxEntryBytes = options.maxEntryBytes ?? 8 * 1024 * 1024;
    this.#parse = options.parse ?? deserializeProject;
    this.#cache = new LRUCache({
      maxSize: Math.max(1, maxBytes),
      maxEntrySize: Math.max(1, this.#maxEntryBytes),
      sizeCalculation: (entry) => entry.bytes,
      dispose: (entry, _key, reason) => {
        recordStudioMetrics((metrics) => metrics.adjustParsedExecutionCache(-entry.bytes));
        if (reason === 'evict') recordStudioMetrics((metrics) => metrics.recordParsedExecutionCache('evicted'));
      },
    });
  }

  #entry(source: Source): Entry {
    const cached = this.#enabled ? this.#cache.get(source.revisionId) : undefined;
    if (
      cached &&
      cached.source.contents === source.contents &&
      cached.source.datasetsContents === source.datasetsContents
    ) {
      recordStudioMetrics((metrics) => metrics.recordParsedExecutionCache('hit'));
      return cached;
    }
    recordStudioMetrics((metrics) => metrics.recordParsedExecutionCache('miss'));
    const parseStartedAt = performance.now();
    const [project, attachedData] = this.#parse(source.contents);
    const definition = {
      project,
      attachedData,
      datasets: source.datasetsContents ? deserializeDatasets(source.datasetsContents) : [],
    };
    recordStudioMetrics((metrics) => metrics.observeParsedExecution('parse', performance.now() - parseStartedAt));
    // Conservative accounting includes both source text and expanded data. This
    // is a cache admission budget, not a claim about exact V8 heap consumption.
    const accountingStartedAt = performance.now();
    const sourceBytes = 2 * (source.contents.length + (source.datasetsContents?.length ?? 0));
    // Source text alone is a lower bound: reject before making an additional
    // serialized copy of a definition that cannot possibly fit.
    const bytes =
      this.#enabled && sourceBytes <= Math.min(this.#maxBytes, this.#maxEntryBytes)
        ? 4 * serialize(definition).byteLength + sourceBytes
        : sourceBytes;
    const retained = this.#enabled && bytes <= this.#maxBytes && bytes <= this.#maxEntryBytes;
    const entry: Entry = { source: { ...source }, definition, bytes, retained };
    if (retained) {
      this.#cache.set(source.revisionId, entry);
      recordStudioMetrics((metrics) => metrics.adjustParsedExecutionCache(entry.bytes));
    } else {
      this.#cache.delete(source.revisionId);
      recordStudioMetrics((metrics) =>
        metrics.recordParsedExecutionCache(
          !this.#enabled ? 'disabled' : bytes > this.#maxEntryBytes ? 'entry_too_large' : 'total_budget',
        ),
      );
    }
    recordStudioMetrics((metrics) =>
      metrics.observeParsedExecution('accounting', performance.now() - accountingStartedAt),
    );
    return entry;
  }

  materialize(source: Source, contentRevision = false): Definition & { contentRevision?: string } {
    const entry = this.#entry(source);
    if (contentRevision)
      entry.contentRevision ??= getFilesystemProjectRevisionId(source.contents, source.datasetsContents);
    const cloneStartedAt = performance.now();
    // The default deserializer owns fresh data. When it is not retained, there
    // is no shared state to detach. Injected parsers may reuse objects.
    const definition =
      !entry.retained && this.#parse === deserializeProject ? entry.definition : structuredClone(entry.definition);
    recordStudioMetrics((metrics) => metrics.observeParsedExecution('clone', performance.now() - cloneStartedAt));
    return {
      ...definition,
      ...(contentRevision ? { contentRevision: entry.contentRevision } : {}),
    };
  }

  clear(): void {
    this.#cache.clear();
  }

  getStats(): { entries: number; retainedBytes: number } {
    return { entries: this.#cache.size, retainedBytes: this.#cache.calculatedSize };
  }
}
