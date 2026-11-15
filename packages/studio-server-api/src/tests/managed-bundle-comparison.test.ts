import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type Project, type ProjectId, type GraphId, type NodeId } from '@valerypopoff/rivet2-node';
import { createManagedBundleComparisonService } from '../routes/workflows/bundle-comparison.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import type { RevisionRow } from '../routes/workflows/managed/types.js';

const oldRoot = { bundle_id: 'older', name: 'Older', relative_path: 'Library/Older' };
const newRoot = { bundle_id: 'newer', name: 'Newer', relative_path: 'Library/Newer' };
const member = (id: string, root = oldRoot) => ({
  workflow_id: id,
  name: id,
  relative_path: `${root.relative_path}/Nested/${id}.rivet-project`,
  current_draft_revision_id: `draft-${id}`,
  published_revision_id: `published-${id}`,
});
function fixture() {
  const abort = new AbortController();
  const old = member('old');
  const newer = member('new', newRoot);
  let rows: unknown[] = [
    { side: 'older', project: old, revision: { workflow_id: 'old', revision_id: 'pinned-old' }, bundle_id: 'older' },
    { side: 'newer', project: newer, revision: null, bundle_id: 'newer' },
  ];
  let contents: string | ((revision: RevisionRow) => string | Promise<string>) = serializeProject({
    metadata: { id: 'old', title: 'Old' },
    graphs: {},
  } as Project) as string;
  const read: RevisionRow[] = [],
    queries: string[] = [];
  let released = false;
  const service = createManagedBundleComparisonService({
    initialize: async () => {},
    pool: {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith('BEGIN') || sql.startsWith('SELECT set_config') || sql === 'ROLLBACK') return { rows: [] };
          return { rows };
        },
        release: () => {
          released = true;
        },
      }),
    },
    revisions: {
      readRevisionProjectContents: async (revision: RevisionRow, options: { signal?: AbortSignal }) => {
        assert.equal(released, true, 'SQL lease is released before blob IO');
        assert.equal(options.signal, abort.signal);
        read.push(revision);
        return typeof contents === 'function' ? contents(revision) : contents;
      },
      readRevisionContents: () => {
        throw new Error('Comparison must not load datasets');
      },
    },
  } as unknown as ManagedWorkflowContext);
  const input = {
    older: { bundleId: 'older', projectId: 'old', revisionId: 'pinned-old' },
    newer: { bundleId: 'newer', projectId: 'new' },
  };
  return {
    service,
    input,
    abort,
    queries,
    read,
    rows: (value: unknown[]) => {
      rows = value;
    },
    contents: (value: string | ((revision: RevisionRow) => string | Promise<string>)) => {
      contents = value;
    },
  };
}
void test('selected comparison pins the Older revision and returns a validated Newer binding without loading its contents', async () => {
  const f = fixture();
  const result = await f.service.pair(f.input, f.abort.signal);
  assert.equal(result.older?.revisionId, 'pinned-old');
  assert.equal(result.newer?.path, '/managed/workflows/Library/Newer/Nested/new.rivet-project');
  assert.deepEqual(f.read, [{ workflow_id: 'old', revision_id: 'pinned-old' }]);
  assert.equal(
    f.queries.filter((q) => !q.startsWith('BEGIN') && !q.startsWith('SELECT set_config') && q !== 'ROLLBACK').length,
    1,
  );
  assert.ok(f.queries.every((q) => !/INSERT|UPDATE|DELETE|COMMIT/.test(q)));
});
void test('catalog discovery includes empty folders, saved/latest and published pointers without any blob reads', async () => {
  const f = fixture();
  f.rows([
    {
      root: oldRoot,
      members: [member('old')],
      folders: [{ relative_path: oldRoot.relative_path }, { relative_path: `${oldRoot.relative_path}/Empty` }],
    },
    { root: newRoot, members: [], folders: [] },
  ]);
  const result = await f.service.manifest('older', 'newer', f.abort.signal);
  assert.deepEqual(result.older.folders, ['Empty']);
  assert.equal(result.older.projects[0]?.relativePath, 'Nested/old.rivet-project');
  assert.equal(result.older.projects[0]?.publishedRevisionId, 'published-old');
  assert.deepEqual(result.newer.projects, []);
  assert.deepEqual(f.read, []);
  f.rows([
    { root: oldRoot, members: Array.from({ length: 257 }, () => member('old')), folders: [] },
    { root: newRoot, members: [], folders: [] },
  ]);
  await assert.rejects(f.service.manifest('older', 'newer', f.abort.signal), /at most 256/);
});
void test('missing membership/revision, foreign artifact identity and malformed contents are explicit located failures', async () => {
  for (const mode of ['member', 'revision', 'foreign', 'malformed'] as const) {
    const f = fixture();
    f.input.newer = null as never;
    if (mode === 'member') f.rows([{ side: 'older', project: null, revision: null, bundle_id: 'older' }]);
    if (mode === 'revision') f.rows([{ side: 'older', project: member('old'), revision: null, bundle_id: 'older' }]);
    if (mode === 'foreign')
      f.contents(serializeProject({ metadata: { id: 'foreign', title: 'Other' }, graphs: {} } as Project) as string);
    if (mode === 'malformed') f.contents('private malformed YAML: [not for error messages');
    await assert.rejects(f.service.pair(f.input, f.abort.signal), (error: Error) => {
      assert.match(
        error.message,
        mode === 'member'
          ? /no longer/
          : mode === 'revision'
            ? /unavailable/
            : mode === 'foreign'
              ? /does not belong/
              : /Could not parse.*old/,
      );
      assert.doesNotMatch(error.message, /private malformed|blob/);
      return true;
    });
  }
});
void test('newer-only reads never fetch an Older artifact and cancellation does not acquire a SQL lease', async () => {
  const f = fixture();
  const result = await f.service.pair({ older: null, newer: f.input.newer }, f.abort.signal);
  assert.equal(result.older, null);
  assert.equal(result.newer?.projectId, 'new');
  assert.deepEqual(f.read, []);
  f.abort.abort();
  const previous = f.queries.length;
  await assert.rejects(f.service.pair(f.input, f.abort.signal), /abort/i);
  assert.equal(f.queries.length, previous);
});

void test('change indicators compare pinned content with current drafts using the reviewed ID mapping', async () => {
  const f = fixture();
  const older = { ...member('old'), name: 'Project' };
  const newer = { ...member('new', newRoot), name: 'Renamed project' };
  f.rows([
    { project: older, revision: { workflow_id: 'old', revision_id: 'pinned-old' } },
    { project: newer, revision: { workflow_id: 'new', revision_id: 'draft-new' } },
  ]);
  let changed: 'description' | 'title' | 'version' | 'cosmetic' | null = null;
  f.contents(
    (revision) =>
      serializeProject({
        metadata: {
          id: revision.workflow_id as ProjectId,
          title: changed === 'title' && revision.workflow_id === 'new' ? 'New title' : 'Project',
          description: changed === 'description' && revision.workflow_id === 'new' ? 'Edited' : '',
          path: '/different/' + revision.workflow_id,
        },
        graphs: {
          ['main' as GraphId]: {
            metadata: { id: 'main' as GraphId, name: 'Main' },
            nodes: [
              {
                id: 'call' as NodeId,
                type: 'subGraph',
                title: 'Call',
                data: {
                  targetProjectId: revision.workflow_id,
                  graphId: 'main',
                  targetVersion: changed === 'version' && revision.workflow_id === 'new' ? 'latest' : 'published',
                },
                visualData: { x: changed === 'cosmetic' && revision.workflow_id === 'new' ? 900 : 0, y: 0, width: 200 },
              },
              ...(changed === 'cosmetic' && revision.workflow_id === 'new'
                ? [
                    {
                      id: 'comment' as NodeId,
                      type: 'comment',
                      title: 'Comment',
                      data: { text: 'Not a workflow change' },
                      visualData: { x: 0, y: 0, width: 200 },
                    },
                  ]
                : []),
            ],
            connections: [],
          },
        },
        references: [{ id: revision.workflow_id as ProjectId, hintPaths: ['/different/' + revision.workflow_id] }],
      }) as string,
  );
  const input = {
    olderId: 'older',
    newerId: 'newer',
    pairs: [{ olderId: 'old', newerId: 'new', olderRevisionId: 'pinned-old' }],
  };
  assert.deepEqual(await f.service.changes(input, f.abort.signal), { changedNewerIds: [] });
  changed = 'description';
  assert.deepEqual(await f.service.changes(input, f.abort.signal), { changedNewerIds: ['new'] });
  assert.ok(f.queries.every((q) => !/INSERT|UPDATE|DELETE|COMMIT/.test(q)));
  assert.deepEqual(
    f.read.map((r) => r.revision_id),
    ['pinned-old', 'draft-new', 'pinned-old', 'draft-new'],
  );
  for (const field of ['title', 'cosmetic', 'version'] as const) {
    changed = field;
    assert.deepEqual(
      await f.service.changes(input, f.abort.signal),
      { changedNewerIds: field === 'version' ? ['new'] : [] },
      field,
    );
  }
  await assert.rejects(
    f.service.changes({ ...input, pairs: [...input.pairs, ...input.pairs] }, f.abort.signal),
    /one-to-one/,
  );
  f.rows([{ project: older, revision: null }]);
  await assert.rejects(f.service.changes(input, f.abort.signal), /unavailable/);
});

void test('corresponding references are unchanged, but unrelated and opposite-side targets remain changes', async () => {
  const f = fixture();
  const pairs = [
    { olderId: 'old', newerId: 'new', olderRevisionId: 'pinned-old' },
    { olderId: 'old-b', newerId: 'new-b', olderRevisionId: 'pinned-b' },
  ];
  f.rows(
    pairs.flatMap((p) => [
      { project: { ...member(p.olderId), name: 'Project' }, revision: { workflow_id: p.olderId } },
      { project: { ...member(p.newerId, newRoot), name: 'Project' }, revision: { workflow_id: p.newerId } },
    ]),
  );
  let target = 'new-b';
  let reselected = false;
  f.contents((revision) => {
    const id = revision.workflow_id;
    const project = { metadata: { id, title: 'Project' }, graphs: {} } as Project;
    if (id === 'old' || id === 'new') {
      const targetId = id === 'old' ? 'old-b' : target;
      project.graphs['main' as GraphId] = {
        metadata: { id: 'main', name: 'Main' },
        nodes: [
          {
            id: 'call',
            type: 'subGraph',
            title: 'Call',
            data: {
              targetProjectId: targetId,
              graphId: 'main',
              ...(reselected
                ? id === 'new'
                  ? { targetVersion: 'latest', targetScope: 'same-bundle' }
                  : {}
                : { targetVersion: 'published' }),
            },
            visualData: { x: 0, y: 0 },
          },
        ],
        connections: [],
      } as never;
      project.references = [{ id: targetId as ProjectId, title: targetId, hintPaths: [`/${targetId}`] }];
    }
    return serializeProject(project) as string;
  });
  const input = { olderId: 'older', newerId: 'newer', pairs };
  assert.deepEqual(await f.service.changes(input, f.abort.signal), { changedNewerIds: [] });
  reselected = true;
  assert.deepEqual(await f.service.changes(input, f.abort.signal), { changedNewerIds: [] });
  for (const other of ['unrelated', 'old-b']) {
    target = other;
    assert.deepEqual(await f.service.changes(input, f.abort.signal), { changedNewerIds: ['new'] }, other);
  }
});

void test('saved comparison batches keep at most four reads in flight and do not depend on SQL row order', async () => {
  const f = fixture();
  const pairs = Array.from({ length: 3 }, (_, i) => ({
    olderId: `old-${i}`,
    newerId: `new-${i}`,
    olderRevisionId: `pinned-${i}`,
  }));
  f.rows(
    pairs
      .flatMap((p) =>
        [p.olderId, p.newerId].map((id) => ({
          project: member(id),
          revision: { workflow_id: id },
        })),
      )
      .reverse(),
  );
  let active = 0,
    peak = 0;
  f.contents(async (revision) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return serializeProject({
      metadata: { id: revision.workflow_id, title: revision.workflow_id },
      graphs: {},
    } as Project) as string;
  });
  assert.deepEqual(await f.service.changes({ olderId: 'older', newerId: 'newer', pairs }, f.abort.signal), {
    changedNewerIds: [],
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(f.read.length, 6);
});
