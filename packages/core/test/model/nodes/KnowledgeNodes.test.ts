import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BuildKnowledgeContextNodeImpl,
  KnowledgeDocumentNodeImpl,
  KnowledgeSourceNodeImpl,
  SearchKnowledgeNodeImpl,
  SyncKnowledgeSourceNodeImpl,
  normalizeKnowledgeDocument,
  normalizeKnowledgeEvidence,
  normalizeKnowledgeConnectionId,
  normalizeKnowledgeFilter,
  normalizeKnowledgeMetadata,
  normalizeSearchKnowledgeSourceResult,
  normalizeKnowledgeSourceStatusResult,
  type Inputs,
  type InternalProcessContext,
  type RivetKnowledgeStore,
} from '../../../src/index.js';

function createContext(store?: RivetKnowledgeStore): InternalProcessContext {
  return {
    getKnowledgeStore: async () => {
      if (!store) throw new Error('unexpected knowledge-store resolution');
      return store;
    },
    signal: new AbortController().signal,
    tokenizer: {
      getTokenCountForString: async (text: string) => text.length,
    },
  } as InternalProcessContext;
}

describe('knowledge nodes', () => {
  it('uses structured JSON editors for object-backed settings', () => {
    const editorTypes = [
      new KnowledgeDocumentNodeImpl(KnowledgeDocumentNodeImpl.create())
        .getEditors()
        .find((editor) => editor.label === 'Metadata')?.type,
      new SyncKnowledgeSourceNodeImpl(SyncKnowledgeSourceNodeImpl.create())
        .getEditors()
        .find((editor) => editor.label === 'Source Metadata')?.type,
      new SearchKnowledgeNodeImpl(SearchKnowledgeNodeImpl.create())
        .getEditors()
        .find((editor) => editor.label === 'Metadata Filter')?.type,
    ];

    assert.deepEqual(editorTypes, ['jsonObject', 'jsonObject', 'jsonObject']);
  });

  it('creates a source reference from dynamic IDs and an optional exact version', async () => {
    const node = KnowledgeSourceNodeImpl.create();
    node.data.useConnectionIdInput = true;
    node.data.useSourceIdInput = true;
    node.data.useVersionInput = true;

    const outputs = await new KnowledgeSourceNodeImpl(node).process(
      {
        'connection-id': { type: 'string', value: ' main ' },
        'source-id': { type: 'string', value: ' handbook ' },
        version: { type: 'string', value: ' v1 ' },
      } as Inputs,
      createContext(),
    );

    assert.deepEqual(outputs.source, {
      type: 'knowledge-source',
      value: { connectionId: 'main', sourceId: 'handbook', version: 'v1' },
    });

    await assert.rejects(
      () =>
        new KnowledgeSourceNodeImpl(node).process(
          {
            'connection-id': { type: 'string', value: 'main' },
            'source-id': { type: 'string', value: 'handbook' },
            version: { type: 'string', value: 'v'.repeat(513) },
          } as Inputs,
          createContext(),
        ),
      /cannot exceed 512 characters/,
    );
  });

  it('normalizes document line endings and portable metadata', async () => {
    const node = KnowledgeDocumentNodeImpl.create();
    node.data.useDocumentIdInput = true;
    node.data.useTitleInput = true;
    node.data.useMetadataInput = true;

    const outputs = await new KnowledgeDocumentNodeImpl(node).process(
      {
        text: { type: 'string', value: ' first\r\nsecond ' },
        'document-id': { type: 'string', value: ' chapter-1 ' },
        title: { type: 'string', value: ' Chapter 1 ' },
        metadata: { type: 'object', value: { chapter_index: 0, tags: ['opening'] } },
      } as Inputs,
      createContext(),
    );

    assert.deepEqual(outputs.document, {
      type: 'knowledge-document',
      value: {
        id: 'chapter-1',
        title: 'Chapter 1',
        text: 'first\nsecond',
        metadata: { chapter_index: 0, tags: ['opening'] },
      },
    });
  });

  it('passes a normalized source and document array to the selected store', async () => {
    let received: unknown;
    const store: RivetKnowledgeStore = {
      capabilities: {},
      async getSourceStatus() {
        throw new Error('not used');
      },
      async search() {
        throw new Error('not used');
      },
      async syncSource(request) {
        received = request;
        return {
          source: { ...request.source, version: 'computed' },
          result: 'created',
          documentCount: request.documents.length,
          chunkCount: 2,
          warnings: [],
        };
      },
    };
    const node = SyncKnowledgeSourceNodeImpl.create();

    const outputs = await new SyncKnowledgeSourceNodeImpl(node).process(
      {
        source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
        documents: { type: 'string[]', value: ['one', 'two'] },
      } as Inputs,
      createContext(store),
    );

    assert.deepEqual((received as { documents: unknown[] }).documents, [{ text: 'one' }, { text: 'two' }]);
    assert.deepEqual(outputs.result, { type: 'string', value: 'created' });
    assert.deepEqual(outputs.source, {
      type: 'knowledge-source',
      value: { connectionId: 'main', sourceId: 'book', version: 'computed' },
    });
  });

  it('returns grouped evidence from multi-query search without flattening away its provenance', async () => {
    const item = {
      id: 'chunk-1',
      text: 'Relevant text',
      documentId: 'chapter-1',
      source: { connectionId: 'main', sourceId: 'book', version: 'v1' },
    };
    const store: RivetKnowledgeStore = {
      capabilities: {},
      async getSourceStatus() {
        throw new Error('not used');
      },
      async syncSource() {
        throw new Error('not used');
      },
      async search(request) {
        return {
          sourceFound: true,
          source: { ...request.source, version: 'v1' },
          evidence: [item],
          queryResults: [{ query: request.queries[0]!, evidence: [item] }],
          message: 'Found one result.',
        };
      },
    };
    const outputs = await new SearchKnowledgeNodeImpl(SearchKnowledgeNodeImpl.create()).process(
      {
        source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
        query: { type: 'string', value: 'Who is the protagonist?' },
      } as Inputs,
      createContext(store),
    );

    assert.deepEqual(outputs['query-results'], {
      type: 'object[]',
      value: [{ query: 'Who is the protagonist?', evidence: [item] }],
    });
  });

  it('preserves string arrays emitted through dynamically typed query ports', async () => {
    let receivedQueries: string[] | undefined;
    const store: RivetKnowledgeStore = {
      capabilities: {},
      async getSourceStatus() {
        throw new Error('not used');
      },
      async syncSource() {
        throw new Error('not used');
      },
      async search(request) {
        receivedQueries = request.queries;
        return {
          sourceFound: true,
          source: { ...request.source, version: 'v1' },
          evidence: [],
          queryResults: request.queries.map((query) => ({ query, evidence: [] })),
          message: 'No results.',
        };
      },
    };
    const implementation = new SearchKnowledgeNodeImpl(SearchKnowledgeNodeImpl.create());

    await implementation.process(
      {
        source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
        query: { type: 'any', value: ['protagonist', 'main character'] },
      } as Inputs,
      createContext(store),
    );

    assert.deepEqual(receivedQueries, ['protagonist', 'main character']);
    await assert.rejects(
      () =>
        implementation.process(
          {
            source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
            query: { type: 'any', value: ['valid', 42] },
          } as Inputs,
          createContext(store),
        ),
      /must contain only strings/,
    );
  });

  it('rejects malformed results from host-provided knowledge stores', async () => {
    const store: RivetKnowledgeStore = {
      capabilities: {},
      async getSourceStatus({ source }) {
        return { exists: false, source, message: 'missing' };
      },
      async syncSource({ source }) {
        return {
          source: { ...source, version: '' },
          result: 'created',
          documentCount: 1,
          chunkCount: 1,
          warnings: [],
        };
      },
      async search({ source }) {
        const wrongSource = { connectionId: source.connectionId, sourceId: 'another-source', version: 'v1' };
        const item = { id: 'chunk', text: 'text', documentId: 'document', source: wrongSource };
        return {
          sourceFound: true,
          source: { ...source, version: 'v1' },
          evidence: [item],
          queryResults: [{ query: 'question', evidence: [item] }],
          message: 'found',
        };
      },
    };

    await assert.rejects(
      () =>
        new SyncKnowledgeSourceNodeImpl(SyncKnowledgeSourceNodeImpl.create()).process(
          {
            source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
            documents: { type: 'string', value: 'content' },
          } as Inputs,
          createContext(store),
        ),
      /requires a committed version/,
    );
    await assert.rejects(
      () =>
        new SearchKnowledgeNodeImpl(SearchKnowledgeNodeImpl.create()).process(
          {
            source: { type: 'knowledge-source', value: { connectionId: 'main', sourceId: 'book' } },
            query: { type: 'string', value: 'question' },
          } as Inputs,
          createContext(store),
        ),
      /does not belong to the returned source/,
    );
  });

  it('enforces the Build Knowledge Context budget including separators', async () => {
    const node = BuildKnowledgeContextNodeImpl.create();
    node.data.budgetUnit = 'characters';
    node.data.budget = 24;
    node.data.maxItems = 2;
    node.data.metadataFields = [];
    const evidence = [
      { id: 'a', text: '1234567890', source: { connectionId: 'main', sourceId: 'book' }, documentId: 'a' },
      { id: 'b', text: 'abcdefghij', source: { connectionId: 'main', sourceId: 'book' }, documentId: 'b' },
    ];

    const outputs = await new BuildKnowledgeContextNodeImpl(node).process(
      { evidence: { type: 'knowledge-evidence[]', value: evidence } } as Inputs,
      createContext(),
    );

    assert.deepEqual(outputs['included-evidence'], { type: 'knowledge-evidence[]', value: [evidence[0]] });
    assert.deepEqual(outputs['excluded-count'], { type: 'number', value: 1 });
  });

  it('includes only own evidence metadata fields in generated context', async () => {
    const node = BuildKnowledgeContextNodeImpl.create();
    node.data.budgetUnit = 'characters';
    node.data.budget = 1000;
    node.data.metadataFields = ['constructor', 'missing', 'chapter_index'];

    const outputs = await new BuildKnowledgeContextNodeImpl(node).process(
      {
        evidence: {
          type: 'knowledge-evidence[]',
          value: [
            {
              id: 'chapter',
              text: 'Chapter text',
              source: { connectionId: 'main', sourceId: 'book' },
              documentId: 'chapter',
              metadata: { chapter_index: 3 },
            },
          ],
        },
      } as Inputs,
      createContext(),
    );

    assert.deepEqual(outputs.context, { type: 'string', value: '[K1] chapter_index: 3\nChapter text' });
  });
});

describe('knowledge filter validation', () => {
  it('rejects ambiguous and empty logical filters and validates array operators', () => {
    assert.throws(() => normalizeKnowledgeFilter({}), /exactly one/);
    assert.throws(() => normalizeKnowledgeFilter({ and: [] }), /cannot be empty/);
    assert.throws(() => normalizeKnowledgeFilter({ field: 'tag', operator: 'in', value: 'one' }), /array value/);
    assert.deepEqual(normalizeKnowledgeFilter({ field: 'tag', operator: 'in', value: ['one'] }), {
      field: 'tag',
      operator: 'in',
      value: ['one'],
    });
  });

  it('rejects object-prototype keys at portable metadata and filter boundaries', () => {
    assert.throws(() => normalizeKnowledgeConnectionId('__proto__'), /reserved/);
    assert.throws(() => normalizeKnowledgeMetadata(JSON.parse('{"__proto__":"unsafe"}')), /reserved/);
    assert.throws(() => normalizeKnowledgeMetadata(new Date()), /plain object/);
    assert.throws(
      () => normalizeKnowledgeFilter({ field: 'constructor', operator: 'eq', value: 'unsafe' }),
      /reserved/,
    );
  });

  it('rejects malformed optional document and evidence fields instead of silently discarding them', () => {
    assert.throws(() => normalizeKnowledgeDocument({ text: 'content', id: 42 }), /document ID must be a string/);
    assert.throws(
      () =>
        normalizeKnowledgeEvidence({
          id: 'chunk',
          text: 'content',
          documentId: 'document',
          source: { connectionId: 'main', sourceId: 'book' },
          relevanceScore: Number.NaN,
        }),
      /relevance score must be a finite number/,
    );
    assert.throws(
      () =>
        normalizeKnowledgeEvidence({
          id: 'chunk',
          text: 'content',
          documentId: 'document',
          source: { connectionId: 'main', sourceId: 'book' },
          chunkIndex: -1,
        }),
      /chunk index must be a non-negative integer/,
    );
  });

  it('preserves a requested exact version without reporting it as active for a missing source', () => {
    const source = { connectionId: 'main', sourceId: 'book', version: 'requested-version' };
    const result = normalizeKnowledgeSourceStatusResult({ exists: false, source, message: 'missing' }, source);

    assert.deepEqual(result.source, source);
    assert.equal(result.activeVersion, undefined);
    assert.equal(result.matchesExpectedVersion, false);
  });

  it('derives and validates expected-version matches from the returned active version', () => {
    const source = { connectionId: 'main', sourceId: 'book' };
    const matching = normalizeKnowledgeSourceStatusResult(
      { exists: true, source, activeVersion: 'v1', message: 'ready' },
      source,
      'v1',
    );
    assert.equal(matching.matchesExpectedVersion, true);
    assert.throws(
      () =>
        normalizeKnowledgeSourceStatusResult(
          { exists: true, source, activeVersion: 'v1', matchesExpectedVersion: true, message: 'ready' },
          source,
          'v2',
        ),
      /incorrect expected-version match/,
    );
  });

  it('rejects duplicate evidence and query groups that do not match the request', () => {
    const source = { connectionId: 'main', sourceId: 'book', version: 'v1' };
    const item = { id: 'chunk', text: 'content', documentId: 'document', source };
    assert.throws(
      () =>
        normalizeSearchKnowledgeSourceResult(
          {
            sourceFound: true,
            source,
            evidence: [item, item],
            queryResults: [{ query: 'question', evidence: [item] }],
            message: 'found',
          },
          source,
          ['question'],
        ),
      /duplicate evidence ID/,
    );
    assert.throws(
      () =>
        normalizeSearchKnowledgeSourceResult(
          {
            sourceFound: true,
            source,
            evidence: [item],
            queryResults: [{ query: 'different question', evidence: [item] }],
            message: 'found',
          },
          source,
          ['question'],
        ),
      /do not match the requested queries/,
    );
    assert.throws(
      () =>
        normalizeSearchKnowledgeSourceResult(
          {
            sourceFound: true,
            source: { ...source, version: 'v2' },
            evidence: [],
            queryResults: [{ query: 'question', evidence: [] }],
            message: 'found',
          },
          source,
          ['question'],
        ),
      /different version than the exact version requested/,
    );
    assert.throws(
      () =>
        normalizeSearchKnowledgeSourceResult(
          {
            sourceFound: true,
            source,
            evidence: [item],
            queryResults: [{ query: 'question', evidence: [] }],
            message: 'found',
          },
          source,
          ['question'],
        ),
      /does not occur in any query result/,
    );
  });
});
