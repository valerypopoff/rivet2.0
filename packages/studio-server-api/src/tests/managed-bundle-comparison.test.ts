import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type Project } from '@valerypopoff/rivet2-node';
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
  let contents = serializeProject({ metadata: { id: 'old', title: 'Old' }, graphs: {} } as Project) as string;
  const read: unknown[] = [],
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
        return contents;
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
    contents: (value: string) => {
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
