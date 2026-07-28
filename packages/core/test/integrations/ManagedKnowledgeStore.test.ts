import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ManagedKnowledgeStore,
  type KnowledgeDriverSearchRequest,
  type KnowledgeOperationContext,
  type KnowledgeSourceManifest,
  type ManagedKnowledgeChunk,
  type ManagedKnowledgeStoreDriver,
  type RivetKnowledgeEvidence,
} from '../../src/index.js';

const context = (signal = new AbortController().signal): KnowledgeOperationContext => ({ signal });

class MemoryDriver implements ManagedKnowledgeStoreDriver {
  readonly capabilities = {
    supportedFilterOperators: ['eq', 'in'] as const,
    supportsProviderReranking: false,
    supportedExecutors: ['nodejs'] as const,
  };
  operationScope?: string;

  readonly manifests = new Map<string, KnowledgeSourceManifest>();
  readonly chunks = new Map<string, ManagedKnowledgeChunk[]>();
  readonly events: string[] = [];
  searchResults = new Map<string, RivetKnowledgeEvidence[]>();
  failUpload = false;
  failCleanup = false;

  async getManifest(sourceId: string): Promise<KnowledgeSourceManifest | undefined> {
    this.events.push(`manifest:get:${sourceId}`);
    return this.manifests.get(sourceId);
  }

  async upsertChunks(sourceId: string, version: string, chunks: ManagedKnowledgeChunk[]): Promise<void> {
    this.events.push(`chunks:upsert:${version}`);
    if (this.failUpload) throw new Error('upload failed');
    this.chunks.set(`${sourceId}:${version}`, chunks);
  }

  async commitManifest(manifest: KnowledgeSourceManifest): Promise<void> {
    this.events.push(`manifest:commit:${manifest.activeVersion}`);
    this.manifests.set(manifest.sourceId, manifest);
  }

  async search(request: KnowledgeDriverSearchRequest): Promise<RivetKnowledgeEvidence[]> {
    this.events.push(`search:${request.query}:${request.version}`);
    return this.searchResults.get(request.query) ?? [];
  }

  async deleteVersion(sourceId: string, version: string): Promise<void> {
    this.events.push(`version:delete:${version}`);
    if (this.failCleanup) throw new Error('cleanup failed');
    this.chunks.delete(`${sourceId}:${version}`);
  }
}

function source(version?: string) {
  return { connectionId: 'test-store', sourceId: 'handbook', ...(version ? { version } : {}) };
}

function evidence(id: string, query: string): RivetKnowledgeEvidence {
  return {
    id,
    text: `${query} text`,
    source: source('driver-version'),
    documentId: `document-${id}`,
  };
}

describe('ManagedKnowledgeStore', () => {
  it('never calls a legacy progress callback-shaped property supplied at runtime', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    let progressCalls = 0;
    const legacyContext = {
      signal: new AbortController().signal,
      reportProgress: () => {
        progressCalls += 1;
      },
    } as KnowledgeOperationContext;

    await store.syncSource(
      {
        source: source(),
        documents: [{ text: 'A sufficiently long source document. '.repeat(20) }],
        chunking: { unit: 'characters', targetSize: 160, overlap: 20, minimumBoundarySize: 80 },
      },
      legacyContext,
    );

    assert.equal(progressCalls, 0);
  });

  it('commits an immutable version after uploading chunks and skips unchanged content', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    const request = {
      source: source(),
      documents: [{ id: 'intro', title: 'Introduction', text: 'A sufficiently long source document. '.repeat(20) }],
      chunking: { unit: 'characters' as const, targetSize: 160, overlap: 20, minimumBoundarySize: 80 },
    };

    const created = await store.syncSource(request, context());
    const unchanged = await store.syncSource(request, context());

    assert.equal(created.result, 'created');
    assert.equal(created.source.version.startsWith('ks1-'), true);
    assert.equal(created.chunkCount > 1, true);
    assert.equal(unchanged.result, 'unchanged');
    assert.equal(unchanged.source.version, created.source.version);
    assert.equal(driver.events.filter((event) => event.startsWith('chunks:upsert')).length, 1);
    const uploadIndex = driver.events.findIndex((event) => event.startsWith('chunks:upsert'));
    const commitIndex = driver.events.findIndex((event) => event.startsWith('manifest:commit'));
    assert.equal(uploadIndex < commitIndex, true);
    assert.match(driver.manifests.get('handbook')?.commitId ?? '', /^[a-f0-9]{32}$/);
  });

  it('assigns a distinct activation ID when force-refreshing the same content version', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    const request = { source: source(), documents: [{ text: 'same content' }] };

    const created = await store.syncSource(request, context());
    const firstCommitId = driver.manifests.get('handbook')?.commitId;
    const refreshed = await store.syncSource({ ...request, forceRefresh: true }, context());

    assert.equal(refreshed.source.version, created.source.version);
    assert.notEqual(driver.manifests.get('handbook')?.commitId, firstCommitId);
  });

  it('does not activate a partial version when chunk upload fails', async () => {
    const driver = new MemoryDriver();
    driver.failUpload = true;
    const store = new ManagedKnowledgeStore(driver);

    await assert.rejects(
      () => store.syncSource({ source: source(), documents: [{ text: 'document text' }] }, context()),
      /upload failed/,
    );
    assert.equal(driver.manifests.has('handbook'), false);
    assert.equal(
      driver.events.some((event) => event.startsWith('manifest:commit')),
      false,
    );
  });

  it('activates an update before cleaning the old version and reports non-cancellation cleanup failures', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    const first = await store.syncSource({ source: source(), documents: [{ text: 'first version' }] }, context());
    driver.failCleanup = true;

    const updated = await store.syncSource({ source: source(), documents: [{ text: 'second version' }] }, context());

    assert.equal(updated.result, 'updated');
    assert.equal(updated.previousVersion, first.source.version);
    assert.match(updated.warnings[0] ?? '', /cleanup failed/);
    const commitIndex = driver.events.findLastIndex((event) => event.startsWith('manifest:commit'));
    const deleteIndex = driver.events.findLastIndex((event) => event.startsWith('version:delete'));
    assert.equal(commitIndex < deleteIndex, true);
    assert.equal(driver.manifests.get('handbook')?.activeVersion, updated.source.version);
  });

  it('treats a missing source and an inactive requested version as normal search results', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);

    const missing = await store.search({ source: source(), queries: ['question'] }, context());
    assert.deepEqual(missing.evidence, []);
    assert.equal(missing.sourceFound, false);

    await store.syncSource({ source: source(), documents: [{ text: 'ready source' }] }, context());
    const stale = await store.search({ source: source('old-version'), queries: ['question'] }, context());
    assert.equal(stale.sourceFound, false);
    assert.match(stale.message, /not requested version/);
    assert.equal(
      driver.events.some((event) => event.startsWith('search:question')),
      false,
    );
  });

  it('uses an exact source-reference version as the status expectation', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    const synchronized = await store.syncSource({ source: source(), documents: [{ text: 'ready source' }] }, context());

    const matching = await store.getSourceStatus({ source: source(synchronized.source.version) }, context());
    const stale = await store.getSourceStatus({ source: source('old-version') }, context());

    assert.equal(matching.matchesExpectedVersion, true);
    assert.equal(stale.matchesExpectedVersion, false);
    assert.equal(stale.source.version, synchronized.source.version);
  });

  it('runs independent queries concurrently, fuses duplicates, and preserves query ordering', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const driver = new MemoryDriver();
    driver.searchResults.set('first', [evidence('a', 'first'), evidence('b', 'first')]);
    driver.searchResults.set('second', [evidence('b', 'second'), evidence('c', 'second')]);
    const originalSearch = driver.search.bind(driver);
    driver.search = async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (maximumActive === 2) release();
      await gate;
      try {
        return await originalSearch(request);
      } finally {
        active -= 1;
      }
    };
    const store = new ManagedKnowledgeStore(driver);
    await store.syncSource({ source: source(), documents: [{ text: 'ready source' }] }, context());

    const result = await store.search(
      { source: source(), queries: ['first', 'second'], topK: 3, maxConcurrency: 2, finalResultCount: 3 },
      context(),
    );

    assert.equal(maximumActive, 2);
    assert.deepEqual(
      result.queryResults.map((item) => item.query),
      ['first', 'second'],
    );
    assert.deepEqual(
      result.evidence.map((item) => item.id),
      ['b', 'a', 'c'],
    );
    assert.equal(result.evidence[0]?.source.version, result.source.version);
  });

  it('aborts unfinished sibling queries when one provider request fails', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    await store.syncSource({ source: source(), documents: [{ text: 'ready source' }] }, context());
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let siblingAborted = false;
    driver.search = async (request, operationContext = context()) => {
      if (request.query === 'fail') {
        await slowStarted;
        throw new Error('query failed');
      }
      markSlowStarted();
      return new Promise<RivetKnowledgeEvidence[]>((resolve, reject) => {
        const abort = () => {
          siblingAborted = true;
          reject(operationContext.signal.reason);
        };
        if (operationContext.signal.aborted) abort();
        else operationContext.signal.addEventListener('abort', abort, { once: true });
      });
    };

    await assert.rejects(
      () => store.search({ source: source(), queries: ['slow', 'fail'], maxConcurrency: 2 }, context()),
      /query failed/,
    );
    assert.equal(siblingAborted, true);
  });

  it('rejects unsupported filters and reranking before calling the driver', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    await store.syncSource({ source: source(), documents: [{ text: 'ready source' }] }, context());

    await assert.rejects(
      () =>
        store.search(
          { source: source(), queries: ['q'], filter: { field: 'year', operator: 'gt', value: 2020 } },
          context(),
        ),
      /does not support the "gt" filter operator/,
    );
    await assert.rejects(
      () => store.search({ source: source(), queries: ['q'], rerank: { mode: 'required' } }, context()),
      /does not support provider-side reranking/,
    );
    await assert.rejects(
      () =>
        store.search({ source: source(), queries: ['q'], rerank: { mode: 'connection-default', topN: 0 } }, context()),
      /Rerank result count must be an integer between 1 and 100/,
    );
    await assert.rejects(
      () =>
        store.syncSource(
          {
            source: source(),
            documents: [{ text: 'content' }],
            chunking: { unit: 'words' as never },
          },
          context(),
        ),
      /Chunk size unit must be characters or tokens/,
    );
  });

  it('cancels a queued same-source sync without blocking later operations', async () => {
    let releaseUpload!: () => void;
    let markStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const driver = new MemoryDriver();
    const originalUpsert = driver.upsertChunks.bind(driver);
    let blockFirst = true;
    driver.upsertChunks = async (...args) => {
      if (blockFirst) {
        blockFirst = false;
        markStarted();
        await uploadGate;
      }
      await originalUpsert(...args);
    };
    const store = new ManagedKnowledgeStore(driver);
    const first = store.syncSource({ source: source(), documents: [{ text: 'first' }] }, context());
    await started;
    const abortController = new AbortController();
    const queued = store.syncSource(
      { source: source(), documents: [{ text: 'cancelled' }] },
      context(abortController.signal),
    );
    abortController.abort(new Error('cancel queued sync'));

    await assert.rejects(() => queued, /cancel queued sync/);
    const later = store.syncSource({ source: source(), documents: [{ text: 'later' }] }, context());
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(driver.events.filter((event) => event === 'manifest:get:handbook').length, 1);
    releaseUpload();
    await first;
    assert.equal((await later).result, 'updated');
  });

  it('rejects duplicate document IDs before writing colliding chunk records', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);

    await assert.rejects(
      () =>
        store.syncSource(
          {
            source: source(),
            documents: [
              { id: 'chapter', text: 'first chapter' },
              { id: 'chapter', text: 'second chapter' },
            ],
          },
          context(),
        ),
      /duplicate document ID "chapter"/,
    );
    assert.equal(driver.events.length, 0);
  });

  it('serializes same-source syncs across store instances that share an operation scope', async () => {
    let releaseUpload!: () => void;
    let markUploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const driver = new MemoryDriver();
    driver.operationScope = `shared-memory-${Date.now()}`;
    const originalUpsert = driver.upsertChunks.bind(driver);
    let blockFirst = true;
    driver.upsertChunks = async (...args) => {
      if (blockFirst) {
        blockFirst = false;
        markUploadStarted();
        await uploadGate;
      }
      await originalUpsert(...args);
    };

    const first = new ManagedKnowledgeStore(driver).syncSource(
      { source: source(), documents: [{ text: 'first' }] },
      context(),
    );
    await uploadStarted;
    const second = new ManagedKnowledgeStore(driver).syncSource(
      { source: source(), documents: [{ text: 'second' }] },
      context(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(driver.events.filter((event) => event === 'manifest:get:handbook').length, 1);

    releaseUpload();
    await Promise.all([first, second]);
    assert.equal(driver.events.filter((event) => event.startsWith('chunks:upsert:')).length, 2);
  });

  it('fails instead of reporting a version that lost activation to another writer', async () => {
    const driver = new MemoryDriver();
    driver.commitManifest = async (manifest) => {
      driver.manifests.set(manifest.sourceId, { ...manifest, activeVersion: 'concurrent-version' });
    };
    const store = new ManagedKnowledgeStore(driver);

    await assert.rejects(
      () => store.syncSource({ source: source(), documents: [{ text: 'content' }] }, context()),
      /did not retain its activation.*Another writer may have updated/,
    );
  });

  it('detects a same-version activation race by commit ID', async () => {
    const driver = new MemoryDriver();
    driver.commitManifest = async (manifest) => {
      driver.manifests.set(manifest.sourceId, { ...manifest, commitId: 'another-writer' });
    };
    const store = new ManagedKnowledgeStore(driver);

    await assert.rejects(
      () => store.syncSource({ source: source(), documents: [{ text: 'content' }] }, context()),
      /did not retain its activation.*Another writer may have updated/,
    );
  });

  it('does not downgrade an observed activation race to a cleanup warning', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    await store.syncSource({ source: source(), documents: [{ text: 'first' }] }, context());
    const originalGetManifest = driver.getManifest.bind(driver);
    let reads = 0;
    driver.getManifest = async (sourceId) => {
      reads += 1;
      const manifest = await originalGetManifest(sourceId);
      return reads === 3 && manifest ? { ...manifest, activeVersion: 'concurrent-version' } : manifest;
    };

    await assert.rejects(
      () => store.syncSource({ source: source(), documents: [{ text: 'second' }] }, context()),
      /no longer has its activation.*Another writer updated/,
    );
    assert.equal(
      driver.events.some((event) => event.startsWith('version:delete:')),
      false,
    );
  });

  it('rejects unsupported manifests and malformed driver evidence', async () => {
    const driver = new MemoryDriver();
    driver.manifests.set('handbook', {
      schemaVersion: 'future',
      sourceId: 'handbook',
      activeVersion: 'v1',
      documentCount: 1,
      chunkCount: 1,
      updatedAt: new Date().toISOString(),
    });
    const store = new ManagedKnowledgeStore(driver);
    await assert.rejects(() => store.getSourceStatus({ source: source() }, context()), /unsupported schema version/);

    driver.manifests.clear();
    await store.syncSource({ source: source(), documents: [{ text: 'content' }] }, context());
    driver.searchResults.set('question', [
      { id: 'broken', text: '', documentId: 'document', source: source('ignored') },
    ]);
    await assert.rejects(
      () => store.search({ source: source(), queries: ['question'] }, context()),
      /requires non-empty/,
    );
  });

  it('preserves the configured token overlap instead of dropping small overlaps', async () => {
    const driver = new MemoryDriver();
    const store = new ManagedKnowledgeStore(driver);
    const text = Array.from({ length: 250 }, (_, index) => String.fromCharCode(33 + (index % 90))).join('');

    const result = await store.syncSource(
      {
        source: source(),
        documents: [{ id: 'document', text }],
        chunking: {
          unit: 'tokens',
          targetSize: 100,
          overlap: 10,
          minimumBoundarySize: 100,
          includeTitle: false,
        },
      },
      {
        ...context(),
        getTokenCount: async (value) => value.length,
      },
    );

    const chunks = driver.chunks.get(`handbook:${result.source.version}`)!;
    assert.equal(chunks[0]?.text, text.slice(0, 100));
    assert.equal(chunks[1]?.text, text.slice(90, 190));
    assert.equal(chunks[2]?.text, text.slice(180, 250));
  });
});
