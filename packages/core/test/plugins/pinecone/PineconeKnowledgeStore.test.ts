import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { KnowledgeStoreConnectionDefinition, RuntimeSettings } from '../../../src/index.js';
import {
  createPineconeKnowledgeStore,
  PineconeKnowledgeError,
  testPineconeKnowledgeConnection,
} from '../../../src/plugins/pinecone/PineconeKnowledgeStore.js';

const definition: KnowledgeStoreConnectionDefinition = {
  displayName: 'Books',
  provider: 'pinecone',
  config: {
    indexHost: 'books.example.svc.pinecone.io',
    namespaceTemplate: 'source-{sourceId}',
    textField: 'chunk_text',
    apiVersion: '2026-04',
    rerankModel: 'bge-reranker-v2-m3',
  },
};

const settings = {} as RuntimeSettings;
const credentials = { apiKey: 'test-key' };

const operationContext = () => ({ signal: new AbortController().signal });

describe('Pinecone knowledge store', () => {
  it('validates successful connection-test responses instead of accepting proxy error pages', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>proxy error</html>');
    try {
      await assert.rejects(
        () =>
          testPineconeKnowledgeConnection(definition, credentials, new AbortController().signal, {
            settings,
          }),
        /invalid JSON while testing the knowledge-store connection/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses integrated-embedding record endpoints and commits a readable manifest', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let manifestRecord: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes('/vectors/fetch')) {
        return Response.json({ vectors: manifestRecord ? { __rivet_manifest__: { metadata: manifestRecord } } : {} });
      }
      if (url.includes('/records/namespaces/') && url.endsWith('/upsert')) {
        const records = String(init.body)
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const manifest = records.find((record) => record._id === '__rivet_manifest__');
        if (manifest) manifestRecord = manifest;
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/search')) {
        return Response.json({
          result: {
            hits: [
              {
                _id: 'chunk-1',
                _score: 0.9,
                fields: {
                  chunk_text: 'Relevant passage',
                  rivet_document_id: 'chapter-1',
                  rivet_title: 'Chapter 1',
                  rivet_chunk_index: 0,
                  chapter_index: 0,
                },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      const result = await store.syncSource(
        {
          source: { connectionId: 'books', sourceId: 'book 573310' },
          documents: [
            { id: 'chapter-1', title: 'Chapter 1', text: 'A passage from the book.', metadata: { chapter_index: 0 } },
          ],
        },
        operationContext(),
      );
      const search = await store.search(
        { source: { connectionId: 'books', sourceId: 'book 573310' }, queries: ['What happened?'] },
        operationContext(),
      );
      await store.search(
        {
          source: { connectionId: 'books', sourceId: 'book 573310' },
          queries: ['Who was there?'],
          topK: 4,
          filter: { field: 'chapter_index', operator: 'gte', value: 0 },
          rerank: { mode: 'required', topN: 99 },
        },
        operationContext(),
      );

      assert.equal(result.result, 'created');
      assert.equal(search.sourceFound, true);
      assert.equal(search.evidence[0]?.text, 'Relevant passage');
      assert.deepEqual(search.evidence[0]?.metadata, { chapter_index: 0 });
      const namespace = new URL(
        requests.find((request) => request.url.includes('/vectors/fetch'))!.url,
      ).searchParams.get('namespace');
      assert.match(namespace ?? '', /^source-book-573310--[a-f0-9]{24}$/);
      assert.equal(
        requests.some((request) => request.url.includes(`/records/namespaces/${namespace}/upsert`)),
        true,
      );
      const upsertBodies = requests
        .filter((request) => request.url.endsWith('/upsert'))
        .flatMap((request) => String(request.init.body).split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(
        upsertBodies.some((record) => record.rivet_record_type === 'chunk'),
        true,
      );
      assert.equal(
        upsertBodies.some((record) => record.rivet_record_type === 'manifest'),
        true,
      );
      assert.equal(
        upsertBodies.every((record) => Object.keys(record).every((key) => key === '_id' || !key.startsWith('_'))),
        true,
      );
      const searchRequest = requests.find((request) => request.url.endsWith('/search'))!;
      const searchBody = JSON.parse(String(searchRequest.init.body)) as { query: { filter: unknown } };
      assert.deepEqual(searchBody.query.filter, {
        $and: [{ rivet_record_type: { $eq: 'chunk' } }, { rivet_source_version: { $eq: result.source.version } }],
      });
      assert.equal(new Headers(searchRequest.init.headers).get('X-Pinecone-Api-Version'), '2026-04');
      const rerankRequest = requests.filter((request) => request.url.endsWith('/search')).at(-1)!;
      const rerankBody = JSON.parse(String(rerankRequest.init.body)) as {
        query: { filter: unknown };
        rerank: { top_n: number };
      };
      assert.equal(rerankBody.rerank.top_n, 4);
      assert.deepEqual(rerankBody.query.filter, {
        $and: [
          { rivet_record_type: { $eq: 'chunk' } },
          { rivet_source_version: { $eq: result.source.version } },
          { chapter_index: { $gte: 0 } },
        ],
      });
      await assert.rejects(
        () =>
          store.search(
            {
              source: { connectionId: 'books', sourceId: 'book 573310' },
              queries: ['Invalid filter'],
              filter: { field: 'chapter_index', operator: 'gt', value: 'not-a-number' },
            },
            operationContext(),
          ),
        /requires a finite number/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps sanitized source IDs in collision-resistant namespaces', async () => {
    const originalFetch = globalThis.fetch;
    const namespaces: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      namespaces.push(url.searchParams.get('namespace') ?? '');
      return Response.json({ vectors: {} });
    };
    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      await store.getSourceStatus({ source: { connectionId: 'books', sourceId: 'a/b' } }, operationContext());
      await store.getSourceStatus({ source: { connectionId: 'books', sourceId: 'a?b' } }, operationContext());

      assert.equal(namespaces.length, 2);
      assert.notEqual(namespaces[0], namespaces[1]);
      assert.match(namespaces[0]!, /^source-a-b--[a-f0-9]{24}$/);
      assert.match(namespaces[1]!, /^source-a-b--[a-f0-9]{24}$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits for the exact force-refresh manifest write instead of accepting the old matching version', async () => {
    const originalFetch = globalThis.fetch;
    let nextLsn = 0n;
    let indexedLsn = 0n;
    let visibleManifest: Record<string, unknown> | undefined;
    let pendingManifest: Record<string, unknown> | undefined;
    let staleReadsRemaining = 0;
    let manifestFetches = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/vectors/fetch')) {
        manifestFetches += 1;
        if (staleReadsRemaining > 0) {
          staleReadsRemaining -= 1;
        } else if (pendingManifest) {
          visibleManifest = pendingManifest;
          pendingManifest = undefined;
          indexedLsn = nextLsn;
        }
        return new Response(
          JSON.stringify({ vectors: visibleManifest ? { __rivet_manifest__: { metadata: visibleManifest } } : {} }),
          { headers: { 'x-pinecone-max-indexed-lsn': indexedLsn.toString() } },
        );
      }
      if (url.endsWith('/upsert')) {
        nextLsn += 1n;
        const records = String(init.body)
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const manifest = records.find((record) => record._id === '__rivet_manifest__');
        if (manifest) {
          if (visibleManifest) {
            pendingManifest = manifest;
            staleReadsRemaining = 1;
          } else {
            visibleManifest = manifest;
            indexedLsn = nextLsn;
          }
        }
        return new Response('{}', {
          headers: { 'x-pinecone-request-lsn': nextLsn.toString() },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      const request = {
        source: { connectionId: 'books', sourceId: 'book' },
        documents: [{ id: 'chapter', text: 'content' }],
      };
      await store.syncSource(request, operationContext());
      const fetchesBeforeRefresh = manifestFetches;

      const refreshed = await store.syncSource({ ...request, forceRefresh: true }, operationContext());

      assert.equal(refreshed.result, 'updated');
      assert.equal(manifestFetches - fetchesBeforeRefresh >= 3, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the activation ID when LSN headers cannot distinguish a same-version force refresh', async () => {
    const originalFetch = globalThis.fetch;
    let visibleManifest: Record<string, unknown> | undefined;
    let pendingManifest: Record<string, unknown> | undefined;
    let staleReadsRemaining = 0;
    let manifestFetches = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/vectors/fetch')) {
        manifestFetches += 1;
        if (staleReadsRemaining > 0) staleReadsRemaining -= 1;
        else if (pendingManifest) {
          visibleManifest = pendingManifest;
          pendingManifest = undefined;
        }
        return Response.json({
          vectors: visibleManifest ? { __rivet_manifest__: { metadata: visibleManifest } } : {},
        });
      }
      if (url.endsWith('/upsert')) {
        const records = String(init.body)
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const manifest = records.find((record) => record._id === '__rivet_manifest__');
        if (manifest) {
          if (visibleManifest) {
            const previous = JSON.parse(String(visibleManifest.rivet_manifest_json)) as Record<string, unknown>;
            const next = JSON.parse(String(manifest.rivet_manifest_json)) as Record<string, unknown>;
            visibleManifest = {
              ...visibleManifest,
              rivet_manifest_json: JSON.stringify({ ...previous, updatedAt: next.updatedAt }),
            };
            pendingManifest = manifest;
            staleReadsRemaining = 1;
          } else {
            visibleManifest = manifest;
          }
        }
        return new Response('{}');
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      const request = {
        source: { connectionId: 'books', sourceId: 'book' },
        documents: [{ id: 'chapter', text: 'content' }],
      };
      await store.syncSource(request, operationContext());
      const fetchesBeforeRefresh = manifestFetches;

      await store.syncSource({ ...request, forceRefresh: true }, operationContext());

      assert.equal(manifestFetches - fetchesBeforeRefresh >= 3, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves the original Pinecone provider body in failed operations', async () => {
    const originalFetch = globalThis.fetch;
    const providerBody = JSON.stringify({ error: { message: 'index host is invalid', code: 400 } });
    globalThis.fetch = async () => new Response(providerBody, { status: 400, statusText: 'Bad Request' });
    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      await assert.rejects(
        () => store.getSourceStatus({ source: { connectionId: 'books', sourceId: 'book' } }, operationContext()),
        (error: unknown) => {
          assert.equal(error instanceof PineconeKnowledgeError, true);
          assert.equal((error as PineconeKnowledgeError).providerBody, providerBody);
          assert.match((error as Error).message, /index host is invalid/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects malformed successful Pinecone fetch and search payloads', async () => {
    const originalFetch = globalThis.fetch;
    let mode: 'fetch' | 'fetch-array' | 'search' = 'fetch';
    const manifest = {
      schemaVersion: '1',
      sourceId: 'book',
      activeVersion: 'v1',
      commitId: 'commit',
      documentCount: 1,
      chunkCount: 1,
      updatedAt: new Date().toISOString(),
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/vectors/fetch')) {
        if (mode === 'fetch') return Response.json({ unexpected: true });
        if (mode === 'fetch-array') return Response.json({ vectors: [] });
        return Response.json({
          vectors: {
            __rivet_manifest__: { metadata: { rivet_manifest_json: JSON.stringify(manifest) } },
          },
        });
      }
      if (url.endsWith('/search')) return Response.json({ result: { hits: [{ _id: 'broken' }] } });
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      await assert.rejects(
        () => store.getSourceStatus({ source: { connectionId: 'books', sourceId: 'book' } }, operationContext()),
        /missing its vectors map/,
      );
      mode = 'fetch-array';
      await assert.rejects(
        () => store.getSourceStatus({ source: { connectionId: 'books', sourceId: 'book' } }, operationContext()),
        /missing its vectors map/,
      );
      mode = 'search';
      await assert.rejects(
        () =>
          store.search(
            { source: { connectionId: 'books', sourceId: 'book' }, queries: ['question'] },
            operationContext(),
          ),
        /search hit 1 is malformed/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects malformed user metadata in otherwise valid Pinecone search hits', async () => {
    const originalFetch = globalThis.fetch;
    const manifest = {
      schemaVersion: '1',
      sourceId: 'book',
      activeVersion: 'v1',
      commitId: 'commit',
      documentCount: 1,
      chunkCount: 1,
      updatedAt: new Date().toISOString(),
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/vectors/fetch')) {
        return Response.json({
          vectors: {
            __rivet_manifest__: { metadata: { rivet_manifest_json: JSON.stringify(manifest) } },
          },
        });
      }
      if (url.endsWith('/search')) {
        return Response.json({
          result: {
            hits: [
              {
                _id: 'chunk',
                _score: 0.9,
                fields: {
                  chunk_text: 'Relevant text',
                  rivet_document_id: 'chapter',
                  rivet_chunk_index: 0,
                  malformed: { nested: true },
                },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      await assert.rejects(
        () =>
          store.search(
            { source: { connectionId: 'books', sourceId: 'book' }, queries: ['question'] },
            operationContext(),
          ),
        /response metadata field "malformed"/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects metadata shapes and field names Pinecone cannot store', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ vectors: {} });
    try {
      const store = createPineconeKnowledgeStore(definition, settings, credentials);
      await assert.rejects(
        () =>
          store.syncSource(
            {
              source: { connectionId: 'books', sourceId: 'book' },
              documents: [{ text: 'text', metadata: { scores: [1, 2] } }],
            },
            operationContext(),
          ),
        /array of strings/,
      );
      await assert.rejects(
        () =>
          store.syncSource(
            {
              source: { connectionId: 'books', sourceId: 'book' },
              documents: [{ text: 'text', metadata: { rivet_internal: 'collision' } }],
            },
            operationContext(),
          ),
        /reserved rivet_/,
      );
      await assert.rejects(
        () =>
          store.syncSource(
            {
              source: { connectionId: 'books', sourceId: 'book' },
              documents: [{ text: 'text' }],
              metadata: { description: 'x'.repeat(41 * 1024) },
            },
            operationContext(),
          ),
        /manifest.*exceeds 40 KB/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to send Pinecone credentials to a non-HTTPS index host', () => {
    assert.throws(
      () =>
        createPineconeKnowledgeStore(
          { ...definition, config: { ...definition.config, indexHost: 'http://books.example.test' } },
          settings,
          credentials,
        ),
      /requires an HTTPS Index Host/,
    );
  });
});
