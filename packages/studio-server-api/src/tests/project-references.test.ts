import assert from 'node:assert/strict';
import test from 'node:test';
import {
  serializeProject,
  SubGraphNodeImpl,
  type Project,
  type ProjectId,
  type GraphId,
} from '@valerypopoff/rivet2-node';
import { scanIncomingProjectReferences } from '../routes/workflows/project-references.js';
import type {
  WorkflowProjectReferenceSnapshot,
  WorkflowProjectReferenceCatalogEntry,
} from '../routes/workflows/project-reference-snapshots.js';

function project(
  id: string,
  calls: Array<{ id: string; version?: 'latest' | 'published'; disabled?: boolean }> = [],
): Project {
  return {
    metadata: { id: id as ProjectId, title: id, description: '' },
    graphs: {
      ['main' as GraphId]: {
        metadata: { id: 'main' as GraphId, name: 'Non-main graph', description: '' },
        connections: [],
        nodes: calls.map((call, index) => {
          const node = SubGraphNodeImpl.create();
          node.id = `call-${index}` as typeof node.id;
          node.data.targetProjectId = call.id as ProjectId;
          node.data.targetVersion = call.version;
          node.data.graphId = 'main' as GraphId;
          node.disabled = call.disabled;
          return node;
        }),
      },
    },
  };
}
const serialized = (value: Project) => serializeProject(value) as string;
const saved = (value: Project): WorkflowProjectReferenceSnapshot => ({
  source: { kind: 'saved-latest' },
  contents: serialized(value),
});
function fixture(callers: Record<string, WorkflowProjectReferenceSnapshot[]>) {
  const catalog: WorkflowProjectReferenceCatalogEntry[] = [
    { name: 'Target', relativePath: 'target.rivet-project', projectMetadataId: 'target', identity: '1' },
    ...Object.keys(callers).map((id) => ({
      name: id,
      relativePath: `folder/${id}.rivet-project`,
      projectMetadataId: id,
      identity: '1',
    })),
  ];
  const options = {
    relativePath: 'target.rivet-project',
    signal: new AbortController().signal,
    getCatalog: async () => catalog,
    readSaved: async () => serialized(project('target')),
    readSnapshots: async (value: string) => callers[value.split('/')[1]!.replace('.rivet-project', '')]!,
  };
  return { catalog, options };
}

test('incoming references include all graphs, version choices, declared references and active publications', async () => {
  const a = project('a', [
    { id: 'target' },
    { id: 'target', version: 'published' },
    { id: 'target' },
    { id: 'unrelated' },
  ]);
  a.references = [{ id: 'target' as ProjectId, title: 'Target', hintPaths: [] }];
  const published = project('b', [{ id: 'target', version: 'published' }]);
  const { options } = fixture({
    a: [saved(a)],
    b: [
      saved(project('b')),
      { source: { kind: 'published-endpoint', label: 'b-endpoint' }, contents: serialized(published) },
      { source: { kind: 'published-web-app', label: 'b-ui' }, contents: serialized(published) },
    ],
    c: [saved(project('c', [{ id: 'target', disabled: true }]))],
  });
  const result = await scanIncomingProjectReferences(options);
  assert.equal(result.complete, true);
  assert.equal(result.checkedProjects, 3);
  assert.deepEqual(
    result.references.map((item) => [item.projectId, item.sources]),
    [
      ['a', [{ kind: 'saved-latest', targetVersions: ['latest', 'project-reference', 'published'] }]],
      [
        'b',
        [
          { kind: 'published-endpoint', label: 'b-endpoint', targetVersions: ['published'] },
          { kind: 'published-web-app', label: 'b-ui', targetVersions: ['published'] },
        ],
      ],
    ],
  );
});

test('prefab Subgraphs are resolved and malformed or identity-mismatched callers make the result incomplete', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const a = project('a', [{ id: 'target' }]);
  const sourceNode = a.graphs['main' as GraphId]!.nodes[0]!;
  a.nodePrefabs = { prefab: { id: 'prefab', sourceNode } } as unknown as Project['nodePrefabs'];
  a.graphs['main' as GraphId]!.nodes = [
    { ...sourceNode, type: 'nodePrefabInstance', data: { prefabId: 'prefab' } } as never,
  ];
  const { options } = fixture({
    a: [saved(a)],
    broken: [{ source: { kind: 'saved-latest' }, contents: 'not a project' }],
    mismatch: [saved(project('wrong-id'))],
  });
  const result = await scanIncomingProjectReferences(options);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.references.map((item) => item.projectId),
    ['a'],
  );
  assert.deepEqual(
    result.unreadableProjects.map((item) => item.name),
    ['broken', 'mismatch'],
  );
  assert.equal(JSON.stringify(result).includes('not a project'), false);
  assert.equal(warnings.mock.callCount(), 0);
});

test('a corrupt later publication preserves already verified incoming connections', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const { options } = fixture({
    a: [
      saved(project('a', [{ id: 'target' }])),
      { source: { kind: 'published-endpoint', label: 'broken-publication' }, contents: 'not a project' },
    ],
  });
  const result = await scanIncomingProjectReferences(options);
  assert.equal(result.complete, false);
  assert.deepEqual(result.references, [
    {
      projectId: 'a',
      name: 'a',
      relativePath: 'folder/a.rivet-project',
      sources: [{ kind: 'saved-latest', targetVersions: ['latest'] }],
    },
  ]);
  assert.deepEqual(result.unreadableProjects, [{ name: 'a', relativePath: 'folder/a.rivet-project' }]);
  assert.equal(JSON.stringify(result).includes('not a project'), false);
  assert.equal(warnings.mock.callCount(), 0);
});

test('changed catalogs, scan limits and cancellation never claim an exhaustive result', async () => {
  const { options, catalog } = fixture({ a: [saved(project('a'))], b: [saved(project('b'))] });
  const limited = await scanIncomingProjectReferences({ ...options, maxProjects: 1 });
  assert.equal(limited.complete, false);
  assert.equal(limited.checkedProjects, 1);
  let reads = 0;
  const changed = await scanIncomingProjectReferences({
    ...options,
    getCatalog: async () => {
      reads++;
      return reads === 1 ? catalog : catalog.map((item) => ({ ...item, identity: '2' }));
    },
  });
  assert.equal(changed.changedDuringScan, true);
  assert.equal(changed.complete, false);
  const controller = new AbortController();
  await assert.rejects(
    scanIncomingProjectReferences({
      ...options,
      signal: controller.signal,
      readSnapshots: async () => {
        controller.abort();
        return [];
      },
    }),
    { name: 'AbortError' },
  );
  await assert.rejects(scanIncomingProjectReferences({ ...options, expectedProjectId: 'stale-id' }), { status: 409 });
});

test('graph deletion review filters exact targets and preserves saved/published caller locations', async () => {
  const caller = project('a', [{ id: 'target' }, { id: 'target', version: 'published' }, { id: 'other' }]);
  caller.graphs['main' as GraphId]!.nodes[0]!.title = 'Calls deleted graph';
  const mismatch = project('b', [{ id: 'target' }]);
  (mismatch.graphs['main' as GraphId]!.nodes[0]!.data as { graphId: GraphId }).graphId = 'different-graph' as GraphId;
  const { options } = fixture({
    a: [saved(caller), { source: { kind: 'published-endpoint', label: 'live' }, contents: serialized(caller) }],
    b: [saved(mismatch)],
  });
  const result = await scanIncomingProjectReferences({
    ...options,
    relativePath: undefined,
    expectedProjectId: 'target',
    graphIds: ['main'],
  });
  assert.equal(result.complete, true);
  assert.equal(result.graphReferences!.length, 4);
  assert.deepEqual(
    result.graphReferences!.map((item) => [item.projectId, item.sourceGraphId, item.targetVersion, item.source.kind]),
    [
      ['a', 'main', 'latest', 'saved-latest'],
      ['a', 'main', 'published', 'saved-latest'],
      ['a', 'main', 'latest', 'published-endpoint'],
      ['a', 'main', 'published', 'published-endpoint'],
    ],
  );
  assert.equal(result.graphReferences![0]!.nodeTitle, 'Calls deleted graph');
  assert.equal(result.graphReferences![0]!.relativePath, 'folder/a.rivet-project');
  const none = await scanIncomingProjectReferences({ ...options, graphIds: ['unrelated'] });
  assert.equal(none.complete, true);
  assert.deepEqual(none.graphReferences, []);
});

test('graph review ignores missing library nodes while retaining direct and resolved-library callers', async () => {
  const caller = project('a', [{ id: 'target' }]);
  const direct = caller.graphs['main' as GraphId]!.nodes[0]!;
  direct.title = 'Current caller name';
  caller.nodePrefabs = { prefab: { id: 'prefab', sourceNode: direct } } as unknown as Project['nodePrefabs'];
  const missing = { ...direct, id: 'missing', type: 'nodePrefabInstance', data: { prefabId: 'absent' } };
  caller.graphs['main' as GraphId]!.nodes = [
    missing as never,
    direct,
    {
      ...direct,
      id: 'valid-instance',
      title: 'Outdated caller name',
      type: 'nodePrefabInstance',
      data: { prefabId: 'prefab' },
    } as never,
  ];
  const unrelated = project('b');
  unrelated.graphs['main' as GraphId]!.nodes = [missing as never];
  const { options } = fixture({
    a: [saved(caller), { source: { kind: 'published-endpoint' }, contents: serialized(caller) }],
    b: [saved(unrelated)],
  });
  const result = await scanIncomingProjectReferences({ ...options, graphIds: ['main'] });
  assert.equal(result.complete, true);
  assert.deepEqual(result.unreadableProjects, []);
  assert.ok(result.graphReferences!.every((call) => call.nodeTitle === 'Current caller name'));
  assert.deepEqual(
    result.graphReferences!.map((call) => call.nodeId),
    [direct.id, 'valid-instance', direct.id, 'valid-instance'],
  );
  const none = await scanIncomingProjectReferences({ ...options, graphIds: ['not-referenced'] });
  assert.equal(none.complete, true);
  assert.deepEqual(none.graphReferences, []);
});

test('graph scans keep verified callers on later errors and expose truncation and ambiguous IDs', async () => {
  const { options, catalog } = fixture({
    a: [
      saved(project('a', [{ id: 'target' }])),
      { source: { kind: 'published-web-app', label: 'bad' }, contents: 'invalid' },
    ],
  });
  const partial = await scanIncomingProjectReferences({ ...options, graphIds: ['main'] });
  assert.equal(partial.complete, false);
  assert.equal(partial.graphReferences!.length, 1);
  const many = fixture({
    a: [
      saved(
        project(
          'a',
          Array.from({ length: 1001 }, () => ({ id: 'target' })),
        ),
      ),
    ],
  });
  const limited = await scanIncomingProjectReferences({ ...many.options, graphIds: ['main'] });
  assert.equal(limited.complete, false);
  assert.equal(limited.graphReferencesTruncated, true);
  assert.equal(limited.graphReferences!.length, 1000);
  await assert.rejects(
    scanIncomingProjectReferences({
      ...options,
      relativePath: undefined,
      expectedProjectId: 'target',
      graphIds: ['main'],
      getCatalog: async () => [...catalog, { ...catalog[0]!, relativePath: 'duplicate.rivet-project' }],
    }),
    { status: 409 },
  );
});
