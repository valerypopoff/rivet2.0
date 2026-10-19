import assert from 'node:assert/strict';
import {
  recordingWorkflowScopeClause,
  type RecordingRunScope,
} from '../../routes/workflows/recording-workflow-scope.js';

export const familyRows = [
  ...Array.from({ length: 25 }, (_, index) => ({
    id: `root-${String(index).padStart(2, '0')}`,
    workflow: 'a',
    surface: index === 0 ? null : 'editor_local',
    correlation: `key-${index}`,
    status: index % 5 === 0 ? 'failed' : 'succeeded',
    created: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  })),
  ...Array.from({ length: 151 }, (_, index) => ({
    id: `child-${String(index).padStart(3, '0')}`,
    workflow: index % 2 ? 'c' : 'b',
    surface: 'subgraph_project',
    correlation: 'key-24',
    status: 'failed',
    created: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
  })),
];

export async function verifyFamilyQueries(
  storage: 'filesystem' | 'sqlite' | 'managed',
  query: (sql: string, values: string[]) => Promise<Array<{ id: string }>>,
) {
  const table =
    storage === 'filesystem' ? 'recording_runs' : storage === 'sqlite' ? 'recordings' : 'workflow_recordings';
  const id = storage === 'filesystem' ? 'id' : 'recording_id';
  const created = storage === 'sqlite' ? "json_extract(metadata_json, '$.createdAt')" : 'created_at';
  const ids = async (
    owner: string,
    scope: RecordingRunScope,
    status: 'all' | 'failed' = 'all',
    limit = 1000,
    offset = 0,
  ) => {
    const clause = recordingWorkflowScopeClause(owner, true, storage, 1, scope, status);
    return (
      await query(
        `SELECT ${id} AS id FROM ${table} WHERE ${clause} ORDER BY ${created} DESC, ${id} DESC LIMIT ${limit} OFFSET ${offset}`,
        owner || storage === 'managed' ? [owner] : [],
      )
    ).map((row) => row.id);
  };
  const roots = familyRows
    .slice(0, 25)
    .map((row) => row.id)
    .reverse();
  assert.deepEqual(await ids('', 'families'), roots);
  assert.deepEqual(await ids('a', 'families'), roots);
  assert.deepEqual(await ids('a', 'families', 'all', 20), roots.slice(0, 20));
  assert.deepEqual(await ids('a', 'families', 'all', 20, 20), roots.slice(20));
  assert.equal((await ids('', 'all')).length, 176, 'The existing flat API contract must stay unchanged');
  const children = await ids('root-24', 'children');
  assert.equal(children.length, 151);
  assert.deepEqual(
    [...(await ids('root-24', 'children', 'all', 100)), ...(await ids('root-24', 'children', 'all', 100, 100))],
    children,
  );
  const context = await ids('b', 'families');
  assert.equal(context.length, 1, 'A project with only child recordings retains a context group');
  assert.equal((await ids(context[0]!, 'project-family-children')).length, 76);
  assert.equal((await ids(context[0]!, 'family-children')).length, 151);
  assert.deepEqual(await ids('root-24', 'family-children'), [], 'A context lookup cannot manufacture a child anchor');
  assert.equal(
    (await ids('', 'families', 'failed')).length,
    6,
    'A filtered-out primary leaves one child context, not 151 slots',
  );
  // A project can both call and be called under the same ambiguous key. Its
  // context must preserve the related children included by the project scope.
  await query(
    storage === 'sqlite'
      ? `INSERT INTO ${table} (recording_id, workflow_id, metadata_json)
        SELECT 'context-caller', 'b', metadata_json FROM ${table} WHERE recording_id = 'root-24'`
      : `INSERT INTO ${table} (${id}, workflow_id, execution_surface, correlation_id, status, created_at)
        SELECT 'context-caller', 'b', execution_surface, correlation_id, status, created_at
        FROM ${table} WHERE ${id} = 'root-24'`,
    [],
  );
  assert.equal((await ids(context[0]!, 'project-family-children')).length, 151);
}
