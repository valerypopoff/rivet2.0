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
        nodes: calls.map((call) => {
          const node = SubGraphNodeImpl.create();
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
