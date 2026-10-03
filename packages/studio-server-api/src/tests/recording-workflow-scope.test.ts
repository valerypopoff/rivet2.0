import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { recordingWorkflowScopeClause } from '../routes/workflows/recording-workflow-scope.js';
import {
  createWorkflowRecordingInputAfter,
  parseWorkflowRecordingInputAfter,
} from '../routes/workflows/recording-input-filter.js';

for (const storage of ['filesystem', 'sqlite', 'managed'] as const) {
  test(`${storage} recording scope includes related descendants without sibling or unlinked runs`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      const table =
        storage === 'filesystem' ? 'recording_runs' : storage === 'sqlite' ? 'recordings' : 'workflow_recordings';
      db.exec(
        `CREATE TABLE ${table} (id TEXT, workflow_id TEXT, execution_surface TEXT, correlation_id TEXT, metadata_json TEXT)`,
      );
      const rows = [
        ['root-a', 'a', 'workflow_endpoint', 'run-a'],
        ['child-b', 'b', 'subgraph_project', 'run-a'],
        ['grandchild-c', 'c', 'subgraph_project', 'run-a'],
        ['root-b', 'b', 'editor_local', 'run-b'],
        ['child-c-of-b', 'c', 'subgraph_project', 'run-b'],
        ['unlinked', 'c', 'subgraph_project', null],
        ['empty-key', 'c', 'subgraph_project', ''],
        ['different-root', 'c', 'workflow_endpoint', 'run-a'],
      ];
      for (const [id, owner, surface, correlationId] of rows) {
        db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`).run(
          id,
          owner,
          surface,
          correlationId,
          JSON.stringify({ executionIdentity: { surface, correlationId } }),
        );
      }
      const ids = (owner: string, include: boolean) =>
        db
          .prepare(
            // Execute the PostgreSQL predicate with SQLite's equivalent binding.
            `SELECT id FROM ${table} WHERE ${recordingWorkflowScopeClause(owner, include, storage).replaceAll('$1', '?1')} ORDER BY id`,
          )
          .all(...(owner ? [owner] : storage === 'managed' ? [''] : []))
          .map((row) => row.id);
      assert.deepEqual(ids('a', true), ['child-b', 'grandchild-c', 'root-a']);
      assert.deepEqual(ids('b', true), ['child-b', 'child-c-of-b', 'root-b']);
      assert.deepEqual(ids('a', false), ['root-a']);
      // PostgreSQL's Any guard uses a cast that SQLite doesn't support.
      if (storage !== 'managed') assert.equal(ids('', true).length, rows.length);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run('root-a');
      assert.deepEqual(ids('a', true), []);
      assert.deepEqual(ids('b', true), ['child-b', 'child-c-of-b', 'root-b']);
      if (storage !== 'managed') assert.equal(ids('', true).length, rows.length - 1);
    } finally {
      db.close();
    }
  });
}

test('recording input continuation cannot cross the direct and related-child scopes', () => {
  const scope = {
    workflowId: 'a',
    statusFilter: 'all',
    filter: { path: '$.value', operator: '==' as const, value: '1' },
  };
  const cursor = { createdAt: '2026-10-03T00:00:00.000Z', recordingId: 'child', legacyCursor: 1 };
  const related = createWorkflowRecordingInputAfter(cursor, { ...scope, includeSubgraphRuns: true });
  assert.deepEqual(parseWorkflowRecordingInputAfter(related, { ...scope, includeSubgraphRuns: true }), cursor);
  assert.throws(() => parseWorkflowRecordingInputAfter(related, scope), /does not match/);
  const direct = createWorkflowRecordingInputAfter(cursor, scope);
  assert.throws(
    () => parseWorkflowRecordingInputAfter(direct, { ...scope, includeSubgraphRuns: true }),
    /does not match/,
  );
  // Any already includes every recording and does not acquire a second scope.
  const any = createWorkflowRecordingInputAfter(cursor, { ...scope, workflowId: '', includeSubgraphRuns: true });
  assert.deepEqual(parseWorkflowRecordingInputAfter(any, { ...scope, workflowId: '' }), cursor);
  const payload = JSON.parse(Buffer.from(related, 'base64url').toString('utf8'));
  for (const malformed of ['true', 'false', 1, 0, null, {}]) {
    const token = Buffer.from(JSON.stringify({ ...payload, includeSubgraphRuns: malformed })).toString('base64url');
    assert.throws(
      () => parseWorkflowRecordingInputAfter(token, { ...scope, includeSubgraphRuns: true }),
      /does not match/,
    );
  }
});

test('managed recording scope respects parameter positions in direct, related and Any queries', () => {
  assert.equal(recordingWorkflowScopeClause('', true, 'managed', 3), '$3::text IS NOT NULL');
  assert.equal(recordingWorkflowScopeClause('a', false, 'managed', 3), 'workflow_id = $3');
  const related = recordingWorkflowScopeClause('a', true, 'managed', 3);
  assert.match(related, /workflow_id = \$3/);
  assert.doesNotMatch(related, /\$1/);
});
