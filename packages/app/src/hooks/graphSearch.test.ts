import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';
import {
  buildGraphSearchItems,
  buildProjectGraphSearchItems,
  clampGraphSearchSelectedIndex,
  getGraphSearchContentSnippets,
  getGraphSearchStats,
  getSynchronousSearchableEditorDataKeys,
  groupGraphSearchMatches,
  isNodeGraphSearchMatch,
  searchGraphNodes,
  searchGraphNodesWithMode,
  serializeSearchableContentFields,
  serializeGraphSearchValue,
  formatGraphSearchStats,
} from './graphSearch.js';

const asNodeId = (value: string) => value as NodeId;
const asGraphId = (value: string) => value as GraphId;

function createNode(overrides: Partial<ChartNode>): ChartNode {
  return {
    id: asNodeId('node-a'),
    type: 'testNode',
    title: '',
    description: '',
    data: {},
    visualData: {
      x: 0,
      y: 0,
      width: 300,
    },
    ...overrides,
  } as ChartNode;
}

function createGraph(overrides: Partial<NodeGraph>): NodeGraph {
  return {
    metadata: {
      id: asGraphId('graph-a'),
      name: 'Main Graph',
    },
    nodes: [],
    connections: [],
    ...overrides,
  };
}

function matchNodeIds(items: ReturnType<typeof searchGraphNodes>): NodeId[] {
  return items.filter(isNodeGraphSearchMatch).map((match) => match.nodeId);
}

test('buildGraphSearchItems indexes title, description, id, and node type', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('alpha-node'),
          title: 'Fetch profile',
          description: 'Loads user account details',
          type: 'httpCall',
        }),
      ],
    }),
    () => 'HTTP Call',
  );

  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'fetch profile')), [asNodeId('alpha-node')]);
  assert.deepEqual(searchGraphNodes(items, 'fetch profile')[0]?.locations, ['node name']);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'account')), [asNodeId('alpha-node')]);
  assert.deepEqual(searchGraphNodes(items, 'account')[0]?.locations, ['node description']);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'alpha-node')), [asNodeId('alpha-node')]);
  assert.deepEqual(searchGraphNodes(items, 'alpha-node')[0]?.locations, ['node id']);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'alp')), [asNodeId('alpha-node')]);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'http call')), [asNodeId('alpha-node')]);
  assert.deepEqual(searchGraphNodes(items, 'http call')[0]?.locations, ['node type']);
});

test('buildGraphSearchItems indexes configured content fields and skips scalar settings', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('node-a'),
          data: {
            url: 'https://example.com/users',
            enabled: true,
            retries: 3,
            headers: 'Authorization: Bearer search-token',
            body: '{ "name": "Ada" }',
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'HTTP Call', searchableContentKeys: ['headers', 'body'] }),
  );

  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'search-token ada')), [asNodeId('node-a')]);
  assert.equal(searchGraphNodes(items, 'search-token')[0]?.contentSnippets.length, 1);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'example users true 3')), []);
});

test('buildGraphSearchItems indexes explicitly searchable Set/Get Global ID settings', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('set-global-node'),
          type: 'setGlobal',
          data: {
            id: 'customerProfile',
            dataType: 'string',
          },
        }),
        createNode({
          id: asNodeId('get-global-node'),
          type: 'getGlobal',
          data: {
            id: 'customerProfile',
            dataType: 'string',
          },
        }),
      ],
    }),
    (node) => ({
      nodeTypeLabel: node.type === 'setGlobal' ? 'Set Global' : 'Get Global',
      searchableContentKeys: ['id'],
    }),
  );

  const matches = searchGraphNodes(items, 'customerProfile');

  assert.deepEqual(matchNodeIds(matches), [asNodeId('set-global-node'), asNodeId('get-global-node')]);
  assert.deepEqual(matches[0]?.locations, ['node content']);
  assert.equal(matches[0]?.contentSnippets[0], 'customerProfile');
  assert.deepEqual(matches[1]?.locations, ['node content']);
  assert.equal(matches[1]?.contentSnippets[0], 'customerProfile');
});

test('searchGraphNodes matches short ID fragments without indexing default settings', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('http-f-random-id'),
          title: 'Http Call',
          type: 'httpCall',
          data: {
            method: 'GET',
            url: '',
            headers: '',
            body: '',
            errorOnNon200: true,
            catchRequestFailed: false,
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'Http Call', searchableContentKeys: ['headers', 'body'] }),
  );

  const matches = searchGraphNodes(items, 'f');
  assert.deepEqual(matchNodeIds(matches), [asNodeId('http-f-random-id')]);
  assert.deepEqual(matches[0]?.locations, ['node id']);
  assert.equal(matches[0]?.occurrenceCount, 1);
  assert.deepEqual(searchGraphNodes(items, 'GET'), []);
});

test('project graph search finds short complete node IDs across graphs', () => {
  const items = buildProjectGraphSearchItems(
    {
      [asGraphId('graph-a')]: createGraph({ nodes: [] }),
      [asGraphId('graph-b')]: createGraph({
        metadata: { id: asGraphId('graph-b'), name: 'Other graph' },
        nodes: [createNode({ id: asNodeId('Xy_2') })],
      }),
    },
    () => 'Text',
  );
  const matches = searchGraphNodes(items, 'xy_2');
  assert.deepEqual(matchNodeIds(matches), [asNodeId('Xy_2')]);
  assert.equal(matches[0]?.graphId, asGraphId('graph-b'));
  assert.deepEqual(matches[0]?.locations, ['node id']);
  assert.equal(matches[0]?.occurrenceCount, 1);
});

test('buildGraphSearchItems indexes nested values only when they belong to configured content fields', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('node-a'),
          data: {
            payload: {
              customer: {
                email: 'ada@example.com',
              },
            },
            ignoredPayload: {
              customer: {
                email: 'grace@example.com',
              },
            },
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'Object', searchableContentKeys: ['payload'] }),
  );

  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'customer email ada')), [asNodeId('node-a')]);
  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'grace')), []);
});

test('buildGraphSearchItems indexes nested array values', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('node-a'),
          data: {
            items: ['alpha', { label: 'beta' }],
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'Object', searchableContentKeys: ['items'] }),
  );

  assert.deepEqual(matchNodeIds(searchGraphNodes(items, 'alpha beta')), [asNodeId('node-a')]);
});

test('searchGraphNodes prefers whole-query matches before separate-word fallback', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('exact-node'),
          data: {
            text: 'alpha beta',
          },
        }),
        createNode({
          id: asNodeId('word-node'),
          data: {
            text: 'alpha between beta',
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'Text', searchableContentKeys: ['text'] }),
  );

  const result = searchGraphNodesWithMode(items, 'alpha beta');

  assert.equal(result.fallbackToTerms, false);
  assert.deepEqual(matchNodeIds(result.matches), [asNodeId('exact-node')]);
});

test('searchGraphNodes falls back to separate words when no whole-query match exists', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('word-node'),
          data: {
            text: 'alpha between beta',
          },
        }),
      ],
    }),
    () => ({ nodeTypeLabel: 'Text', searchableContentKeys: ['text'] }),
  );

  const result = searchGraphNodesWithMode(items, 'alpha beta');

  assert.equal(result.fallbackToTerms, true);
  assert.deepEqual(matchNodeIds(result.matches), [asNodeId('word-node')]);
});

test('searchGraphNodes only shows fallback content snippets when content matches all fallback words', () => {
  const items = buildGraphSearchItems(
    createGraph({
      nodes: [
        createNode({
          id: asNodeId('mixed-node'),
          title: 'Alpha object',
          data: {
            value: 'needle appears here, but the other term does not',
          },
        }),
        createNode({
          id: asNodeId('content-node'),
          title: 'Plain text',
          data: {
            text: 'alpha and needle both appear in this node content',
          },
        }),
      ],
    }),
    (node) => ({
      nodeTypeLabel: node.id === asNodeId('mixed-node') ? 'Object' : 'Text',
      searchableContentKeys: node.id === asNodeId('mixed-node') ? ['value'] : ['text'],
    }),
  );

  const result = searchGraphNodesWithMode(items, 'alpha needle');
  const snippetsByNodeId = new Map(
    result.matches.filter(isNodeGraphSearchMatch).map((match) => [match.nodeId, match.contentSnippets]),
  );

  assert.equal(result.fallbackToTerms, true);
  assert.deepEqual(snippetsByNodeId.get(asNodeId('mixed-node')), []);
  assert.equal(snippetsByNodeId.get(asNodeId('content-node'))?.[0]?.includes('alpha and needle'), true);
});

test('buildProjectGraphSearchItems indexes all project graphs and preserves grouping metadata', () => {
  const graphA = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Main' },
    nodes: [createNode({ id: asNodeId('node-a'), title: 'Needle one', type: 'text' })],
  });
  const graphB = createGraph({
    metadata: { id: asGraphId('graph-b'), name: 'Tools' },
    nodes: [createNode({ id: asNodeId('node-b'), title: 'Needle two', type: 'code' })],
  });

  const items = buildProjectGraphSearchItems(
    {
      [asGraphId('graph-a')]: graphA,
      [asGraphId('graph-b')]: graphB,
    },
    (node) => ({ nodeTypeLabel: node.type === 'text' ? 'Text' : 'Code', searchableContentKeys: ['text', 'code'] }),
  );
  const matches = searchGraphNodes(items, 'needle');
  const nodeMatches = matches.filter(isNodeGraphSearchMatch);

  assert.deepEqual(
    nodeMatches.map((match) => ({
      nodeId: match.nodeId,
      graphName: match.graphName,
      nodeType: match.nodeType,
    })),
    [
      { nodeId: asNodeId('node-a'), graphName: 'Main', nodeType: 'Text' },
      { nodeId: asNodeId('node-b'), graphName: 'Tools', nodeType: 'Code' },
    ],
  );
});

test('buildProjectGraphSearchItems indexes graph names', () => {
  const graphA = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Billing Tools' },
    nodes: [createNode({ id: asNodeId('node-a'), title: 'Fetch invoice', type: 'httpCall' })],
  });

  const items = buildProjectGraphSearchItems({ [asGraphId('graph-a')]: graphA }, () => 'HTTP Call');
  const matches = searchGraphNodes(items, 'billing');

  assert.equal(matches[0]?.kind, 'graph');
  assert.equal(matches[0]?.graphId, asGraphId('graph-a'));
  assert.deepEqual(matches[0]?.locations, ['graph name']);
  assert.deepEqual(matches[0]?.contentSnippets, []);
});

test('buildProjectGraphSearchItems keeps only the latest graph when graph metadata ids collide', () => {
  const staleGraph = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Main' },
    nodes: [
      createNode({
        id: asNodeId('node-a'),
        type: 'object',
        data: { value: 'stale text from another node' },
      }),
    ],
  });
  const liveGraph = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Main' },
    nodes: [
      createNode({
        id: asNodeId('node-b'),
        type: 'text',
        data: { text: 'fresh text from the current graph' },
      }),
    ],
  });

  const items = buildProjectGraphSearchItems(
    {
      [asGraphId('stale-record-key')]: staleGraph,
      [asGraphId('graph-a')]: liveGraph,
    },
    (node) => ({
      nodeTypeLabel: node.type === 'text' ? 'Text' : 'Object',
      searchableContentKeys: node.type === 'text' ? ['text'] : ['value'],
    }),
  );
  const matches = searchGraphNodes(items, 'text');

  assert.deepEqual(matchNodeIds(matches), [asNodeId('node-b')]);
  assert.equal(matches[0]?.contentSnippets[0]?.includes('fresh text'), true);
});

test('buildProjectGraphSearchItems returns graph-name matches even when the graph has no nodes', () => {
  const graphA = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Empty Billing Graph' },
    nodes: [],
  });

  const matches = searchGraphNodes(
    buildProjectGraphSearchItems({ [asGraphId('graph-a')]: graphA }, () => 'Text'),
    'billing',
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, 'graph');
  assert.equal(matches[0]?.graphName, 'Empty Billing Graph');
});

test('buildProjectGraphSearchItems uses the record key when graph metadata id is missing', () => {
  const graphA = createGraph({
    metadata: { name: 'Imported Billing Graph' } as NodeGraph['metadata'],
    nodes: [createNode({ id: asNodeId('node-a'), title: 'Imported fetch' })],
  });

  const matches = searchGraphNodes(
    buildProjectGraphSearchItems({ [asGraphId('record-graph-a')]: graphA }, () => 'Text'),
    'billing',
  );

  assert.equal(matches[0]?.kind, 'graph');
  assert.equal(matches[0]?.graphId, asGraphId('record-graph-a'));
});

test('searchGraphNodesWithMode counts matched occurrences across graphs', () => {
  const graphA = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Needle Graph' },
    nodes: [
      createNode({
        id: asNodeId('node-a'),
        title: 'Needle title needle',
        description: 'Another needle',
        data: { body: 'needle in body\nneedle again' },
      }),
    ],
  });
  const graphB = createGraph({
    metadata: { id: asGraphId('graph-b'), name: 'Tools' },
    nodes: [createNode({ id: asNodeId('node-b'), title: 'Needle tool' })],
  });

  const result = searchGraphNodesWithMode(
    buildProjectGraphSearchItems({ [asGraphId('graph-a')]: graphA, [asGraphId('graph-b')]: graphB }, () => ({
      nodeTypeLabel: 'Text',
      searchableContentKeys: ['body'],
    })),
    'needle',
  );

  assert.deepEqual(
    result.matches.map((match) => ({ graphId: match.graphId, occurrenceCount: match.occurrenceCount })),
    [
      { graphId: asGraphId('graph-a'), occurrenceCount: 1 },
      { graphId: asGraphId('graph-a'), occurrenceCount: 5 },
      { graphId: asGraphId('graph-b'), occurrenceCount: 1 },
    ],
  );
  assert.deepEqual(getGraphSearchStats(result.matches), { occurrenceCount: 7, graphCount: 2 });
});

test('searchGraphNodesWithMode counts separate fallback term occurrences', () => {
  const graphA = createGraph({
    metadata: { id: asGraphId('graph-a'), name: 'Fallback Graph' },
    nodes: [
      createNode({
        id: asNodeId('node-a'),
        title: 'alpha alpha',
        description: 'beta',
      }),
    ],
  });

  const result = searchGraphNodesWithMode(
    buildProjectGraphSearchItems({ [asGraphId('graph-a')]: graphA }, () => 'Text'),
    'alpha beta',
  );

  assert.equal(result.fallbackToTerms, true);
  assert.equal(result.matches[0]?.occurrenceCount, 3);
  assert.deepEqual(getGraphSearchStats(result.matches), { occurrenceCount: 3, graphCount: 1 });
});

test('formatGraphSearchStats pluralizes and localizes the search summary', () => {
  assert.equal(formatGraphSearchStats({ occurrenceCount: 1, graphCount: 1 }), '1 occurrence in 1 graph');
  assert.equal(
    formatGraphSearchStats({ occurrenceCount: 1_234, graphCount: 5 }),
    `${(1_234).toLocaleString()} occurrences in 5 graphs`,
  );
});

test('groupGraphSearchMatches groups results by graph while keeping global indexes', () => {
  const matches = [
    {
      kind: 'node' as const,
      nodeId: asNodeId('node-a'),
      graphId: asGraphId('graph-a'),
      graphName: 'Main',
      nodeTitle: 'First',
      nodeType: 'Text',
      locations: ['node name' as const],
      contentSnippets: [],
      occurrenceCount: 1,
    },
    {
      kind: 'node' as const,
      nodeId: asNodeId('node-b'),
      graphId: asGraphId('graph-a'),
      graphName: 'Main',
      nodeTitle: 'Second',
      nodeType: 'Text',
      locations: ['node content' as const],
      contentSnippets: ['second match context'],
      occurrenceCount: 1,
    },
    {
      kind: 'node' as const,
      nodeId: asNodeId('node-c'),
      graphId: asGraphId('graph-b'),
      graphName: 'Tools',
      nodeTitle: 'Third',
      nodeType: 'Code',
      locations: ['node description' as const],
      contentSnippets: [],
      occurrenceCount: 1,
    },
  ];

  const groups = groupGraphSearchMatches(matches);

  assert.deepEqual(
    groups.map((group) => ({
      title: group.graphName,
      indexes: group.matches.map((entry) => entry.index),
    })),
    [
      { title: 'Main', indexes: [0, 1] },
      { title: 'Tools', indexes: [2] },
    ],
  );
});

test('groupGraphSearchMatches groups graph-name hits without duplicating the graph header', () => {
  const groups = groupGraphSearchMatches([
    {
      kind: 'graph',
      graphId: asGraphId('graph-a'),
      graphName: 'Billing',
      locations: ['graph name'],
      contentSnippets: [],
      occurrenceCount: 1,
    },
    {
      kind: 'node',
      nodeId: asNodeId('node-a'),
      graphId: asGraphId('graph-a'),
      graphName: 'Billing',
      nodeTitle: 'Fetch invoice',
      nodeType: 'HTTP Call',
      locations: ['node name'],
      contentSnippets: [],
      occurrenceCount: 1,
    },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0]?.matches.map((entry) => entry.match.nodeId),
    [asNodeId('node-a')],
  );
});

test('serializeGraphSearchValue does not emit object placeholder text', () => {
  const serialized = serializeGraphSearchValue({ nested: { value: 'needle' } });

  assert.equal(serialized.includes('[object Object]'), false);
  assert.equal(serialized.includes('needle'), true);
});

test('serializeGraphSearchValue handles circular objects safely', () => {
  const value: { name: string; self?: unknown } = { name: 'circle' };
  value.self = value;

  assert.equal(serializeGraphSearchValue(value).includes('[Circular]'), true);
});

test('serializeGraphSearchValue handles throwing getters safely', () => {
  const value = {};

  Object.defineProperty(value, 'broken', {
    enumerable: true,
    get() {
      throw new Error('getter failed');
    },
  });

  assert.equal(serializeGraphSearchValue(value), '[Unserializable Object]');
});

test('serializeGraphSearchValue bounds very large values', () => {
  const serialized = serializeGraphSearchValue({ text: 'x'.repeat(20_000) });

  assert.equal(serialized.length <= 12_004, true);
});

test('serializeSearchableContentFields serializes only selected top-level fields', () => {
  const serialized = serializeSearchableContentFields(
    {
      code: 'const value = "needle";',
      retryOnNon200: false,
      nested: { value: 'ignored' },
    },
    ['code'],
  );

  assert.equal(serialized.includes('needle'), true);
  assert.equal(serialized.includes('false'), false);
  assert.equal(serialized.includes('ignored'), false);
});

test('getSynchronousSearchableEditorDataKeys reads nested code and explicitly searchable editor keys', () => {
  const dataKeys = getSynchronousSearchableEditorDataKeys(() => [
    {
      type: 'group',
      editors: [
        { type: 'string', dataKey: 'title' },
        { type: 'string', dataKey: 'globalId', includeInGraphSearch: true },
        { type: 'code', dataKey: 'prompt' },
        {
          type: 'group',
          editors: [{ type: 'code', dataKey: 'body' }, { type: 'code' }],
        },
      ],
    },
  ]);

  assert.deepEqual(dataKeys, ['globalId', 'prompt', 'body']);
});

test('getSynchronousSearchableEditorDataKeys ignores async editor loaders without leaking rejections', async () => {
  const dataKeys = getSynchronousSearchableEditorDataKeys(() =>
    Promise.reject(new Error("Cannot read properties of undefined (reading 'getChatModelOptions')")),
  );

  assert.deepEqual(dataKeys, []);
  await Promise.resolve();
});

test('getGraphSearchContentSnippets returns separate context snippets for separated content matches', () => {
  const content = `start ${'a'.repeat(140)} first needle ${'b'.repeat(200)} second needle ${'c'.repeat(140)} end`;
  const snippets = getGraphSearchContentSnippets(content, ['needle']);

  assert.equal(snippets.length, 2);
  assert.equal(
    snippets.every((snippet) => snippet.includes('needle')),
    true,
  );
  assert.equal(
    snippets.every((snippet) => snippet.length < content.length),
    true,
  );
});

test('getGraphSearchContentSnippets merges overlapping context snippets', () => {
  const content = 'alpha needle one and nearby needle two omega';

  assert.deepEqual(getGraphSearchContentSnippets(content, ['needle']), [content]);
});

test('searchGraphNodes returns no matches for an empty query', () => {
  const items = buildGraphSearchItems(createGraph({ nodes: [createNode({ title: 'Anything' })] }), () => 'Test');

  assert.deepEqual(searchGraphNodes(items, ''), []);
  assert.deepEqual(searchGraphNodes(items, '   '), []);
});

test('graph search clamps active indexes', () => {
  assert.equal(clampGraphSearchSelectedIndex(5, 2), 1);
  assert.equal(clampGraphSearchSelectedIndex(-1, 2), 0);
  assert.equal(clampGraphSearchSelectedIndex(3, 0), 0);
});
