import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNodePrefabInstance, type Project, type ProjectId } from '@valerypopoff/rivet2-node';
import type { BundleMergeChoices } from '../../../studio-server-shared/workflow-bundle-types.js';
import { resolveBundleMerge } from '../routes/workflows/bundle-merge-plan.js';
import { bundleMergeDigest, bundleMergePath } from '../routes/workflows/managed/bundle-merge.js';
import { createManagedBundleMergeService } from '../routes/workflows/managed/bundle-merge.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import {
  bundleGraphKey,
  inspectBundleProjectBindings,
  remapBundleProject,
} from '../routes/workflows/remap-bundle-project.js';

const members = ['a1', 'b1', 'x1', 'y1', 'unused'].map((projectId) => ({
  projectId,
  title: projectId,
  relativePath: `${projectId}.rivet-project`,
}));
const targets = ['a', 'b', 'x'].map((projectId) => ({
  projectId,
  title: projectId,
  relativePath: `${projectId}.rivet-project`,
}));
const project = (id: string, references: string[]): Project => ({
  metadata: { id: id as ProjectId, title: id, description: '' },
  graphs: {},
  references: references.map((id) => ({ id: id as ProjectId, hintPaths: ['old'] })),
});
const choices = (): BundleMergeChoices => ({
  destinationBundleId: 'destination',
  actions: [
    { kind: 'replace', sourceProjectId: 'a1', targetProjectId: 'a' },
    { kind: 'replace', sourceProjectId: 'b1', targetProjectId: 'b' },
  ],
  dependencies: [],
  graphs: [],
});

test('merge fingerprints survive JSON schema parsing that changes object key order', () => {
  assert.equal(
    bundleMergeDigest({
      choices: { actions: [{ sourceProjectId: 'a', kind: 'add', relativePath: 'A.rivet-project' }] },
    }),
    bundleMergeDigest({
      choices: { actions: [{ kind: 'add', relativePath: 'A.rivet-project', sourceProjectId: 'a' }] },
    }),
  );
});

test('cancelled previews and expired unknown commits cannot start project reads or preparation', async () => {
  let initialized = 0;
  const context = {
    initialize: async () => {
      initialized++;
    },
    pool: { query: async () => ({ rows: [] }) },
  } as unknown as ManagedWorkflowContext;
  const service = createManagedBundleMergeService(context);
  await assert.rejects(service.preview('source', choices(), AbortSignal.abort()), { status: 504 });
  assert.equal(initialized, 0);
  await assert.rejects(
    service.commit(
      'source',
      { choices: choices(), fingerprint: '0'.repeat(64), acknowledgedWarnings: [] },
      { operationId: 'expired-test', expiresAt: new Date(Date.now() - 1000).toISOString() },
    ),
    { status: 410 },
  );
  assert.equal(initialized, 1);
});

test('case variants of the same bundle identity reject before reading storage', async () => {
  const service = createManagedBundleMergeService({} as ManagedWorkflowContext);
  await assert.rejects(service.preview('Source', { ...choices(), destinationBundleId: 'source' }), { status: 400 });
});

test('merge asks once for shared required counterparts and never expands a use-existing dependency', async () => {
  const input = choices();
  input.dependencies = [{ sourceProjectId: 'x1', kind: 'existing', targetProjectId: 'x' }];
  const read: string[] = [];
  const plan = await resolveBundleMerge(members, targets, input, async (id) => {
    read.push(id);
    assert.ok(id === 'a1' || id === 'b1');
    return project(id, ['x1']);
  });
  assert.deepEqual(read, ['a1', 'b1']);
  assert.deepEqual(
    plan.requiredProjects.map((value) => value.project.projectId),
    ['x1'],
  );
  assert.equal(plan.requiredProjects[0]!.sites.length, 2);
  assert.equal(plan.mapping.get('x1'), 'x');
  assert.deepEqual(plan.actions, input.actions);
});

test('added dependency closure terminates cycles and prunes choices no longer reachable from an explicit action', async () => {
  const input = choices();
  input.actions = input.actions.slice(0, 1);
  input.dependencies = ['x1', 'y1', 'unused'].map((sourceProjectId) => ({
    sourceProjectId,
    kind: 'add',
    relativePath: `${sourceProjectId}.rivet-project`,
  }));
  const read: string[] = [];
  const plan = await resolveBundleMerge(members, targets, input, async (id) => {
    read.push(id);
    return project(id, id === 'a1' ? ['x1'] : id === 'x1' ? ['y1'] : ['x1']);
  });
  assert.deepEqual(read, ['a1', 'x1', 'y1']);
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.mapping.has('unused'), false);
  const empty = await resolveBundleMerge(members, targets, { ...input, actions: [] }, async () => {
    throw new Error('No content should load');
  });
  assert.deepEqual(empty.actions, []);
  assert.deepEqual(empty.requiredProjects, []);
});

test('selected additions remain explicit while mappings and immutable input are preserved', async () => {
  const input = choices();
  input.actions.push({ sourceProjectId: 'y1', kind: 'add', relativePath: 'Nested/Y.rivet-project' });
  const snapshot = structuredClone(input);
  const plan = await resolveBundleMerge(members, targets, input, async (id) =>
    project(id, id === 'a1' ? ['b1', 'y1'] : []),
  );
  assert.deepEqual(plan.requiredProjects, []);
  assert.equal(plan.mapping.get('b1'), 'b');
  assert.equal(plan.actions.length, 3);
  assert.deepEqual(input, snapshot);
});

test('ambiguous writes and foreign project choices reject before reading content', async () => {
  const input = choices();
  input.actions[1] = { kind: 'replace', sourceProjectId: 'b1', targetProjectId: 'a' };
  const fail = async () => {
    throw new Error('Unexpected project read');
  };
  await assert.rejects(resolveBundleMerge(members, targets, input, fail), /same destination/);
  await assert.rejects(
    resolveBundleMerge(
      members,
      targets,
      { ...choices(), actions: [{ sourceProjectId: 'outside', kind: 'add', relativePath: 'Outside.rivet-project' }] },
      fail,
    ),
    /source bundle/,
  );
});

test('obsolete dependency choices are ignored until a selected project actually needs them', async () => {
  const input = choices();
  input.dependencies = [
    { sourceProjectId: 'removed-source', kind: 'existing', targetProjectId: 'removed-target' },
    { sourceProjectId: 'x1', kind: 'existing', targetProjectId: 'removed-target' },
  ];
  const result = await resolveBundleMerge(members, targets, input, async (id) => project(id, []));
  assert.deepEqual(result.requiredProjects, []);
  await assert.rejects(
    resolveBundleMerge(members, targets, input, async (id) => project(id, ['x1'])),
    /required counterpart/,
  );
});

test('graph remapping covers typed authored data, keeps inactive locations, and never replaces ID-looking text', () => {
  const input = project('a1', ['x1']);
  input.graphs = {
    main: {
      metadata: { id: 'main', name: 'Main' },
      connections: [],
      nodes: [
        {
          id: 'call',
          type: 'subGraph',
          title: 'Call',
          data: { targetProjectId: 'x1', graphId: 'old', targetVersion: 'published', inputPortOrder: ['in'] },
          variants: [{ data: { targetProjectId: 'x1', graphId: 'old' } }],
        },
      ],
    },
  } as unknown as Project['graphs'];
  input.metadata.description = 'x1 / old';
  const before = structuredClone(input);
  const bindings = inspectBundleProjectBindings(input);
  assert.equal(bindings[1]!.site.active, true);
  assert.equal(bindings[2]!.site.active, false);
  assert.deepEqual(input, before);
  remapBundleProject(
    input,
    new Map([
      ['a1', 'a' as ProjectId],
      ['x1', 'x' as ProjectId],
    ]),
    {
      graphs: new Map([[bundleGraphKey('x1', 'old'), 'new']]),
      titles: new Map([['x', 'Original X']]),
    },
  );
  const data = input.graphs['main' as keyof Project['graphs']]!.nodes[0]!.data as Record<string, unknown>;
  assert.equal(input.metadata.id, 'a');
  assert.equal(input.metadata.description, 'x1 / old');
  assert.equal(data.targetProjectId, 'x');
  assert.equal(data.graphId, 'new');
  assert.equal(data.targetVersion, 'latest');
  assert.deepEqual(data.inputPortOrder, ['in']);
  assert.deepEqual(input.references, [{ id: 'x', title: 'Original X' }]);
});

test('addition paths reject escapes, noncanonical names and project-file folder ancestors', () => {
  assert.deepEqual(bundleMergePath('Nested/C.rivet-project'), { name: 'C', relativePath: 'Nested/C.rivet-project' });
  for (const path of [
    '../C.rivet-project',
    '/C.rivet-project',
    'Nested//C.rivet-project',
    'C.txt',
    'Folder.rivet-project/C.rivet-project',
    ' C.rivet-project',
  ])
    assert.throws(() => bundleMergePath(path), Error, path);
});

test('Library binding activity follows the effective source node used by execution', () => {
  const input = project('a1', []);
  input.graphs = {
    main: {
      metadata: { id: 'main', name: 'Main' },
      connections: [],
      nodes: [
        {
          id: 'link',
          type: 'nodePrefabInstance',
          disabled: true,
          data: { prefabId: 'library' },
          visualData: { x: 0, y: 0 },
        },
      ],
    },
  } as unknown as Project['graphs'];
  input.nodePrefabs = {
    library: {
      id: 'library',
      sourceNode: {
        id: 'library-call',
        type: 'subGraph',
        data: { targetProjectId: 'x1', graphId: 'child' },
        visualData: { x: 0, y: 0 },
      },
    },
  } as unknown as Project['nodePrefabs'];
  const effective = resolveNodePrefabInstance(input, Object.values(input.graphs)[0]!.nodes[0]!);
  assert.equal(effective.type, 'subGraph');
  assert.equal(effective.disabled, undefined);
  const [binding] = inspectBundleProjectBindings(input);
  assert.ok(binding && 'prefabId' in binding.site);
  assert.equal(binding.site.prefabId, 'library');
  assert.equal(binding.site.active, !effective.disabled, 'A live Library call cannot become an inactive warning');
  Object.values(input.nodePrefabs!)[0]!.sourceNode.disabled = true;
  assert.equal(inspectBundleProjectBindings(input)[0]!.site.active, false);
  Object.values(input.nodePrefabs!)[0]!.sourceNode.disabled = false;
  Object.values(input.graphs)[0]!.nodes = [];
  assert.equal(inspectBundleProjectBindings(input)[0]!.site.active, false, 'An unused Library source remains advisory');
});

test('legacy aliases ignore Subgraph-only version and boundary metadata', () => {
  const input = project('a1', []);
  input.graphs = {
    main: {
      metadata: { id: 'main', name: 'Main' },
      connections: [],
      nodes: [
        {
          id: 'alias',
          type: 'referencedGraphAlias',
          data: { projectId: 'x1', graphId: 'child', targetVersion: 'published', targetBoundary: 'unused metadata' },
        },
      ],
    },
  } as unknown as Project['graphs'];
  const [binding] = inspectBundleProjectBindings(input);
  assert.equal(binding!.kind, 'alias');
  assert.equal(binding!.version, 'latest');
  assert.equal(binding!.boundary, undefined);
  assert.equal(binding!.invalidVersion, false);
});
