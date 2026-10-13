import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  hasWorkflowFailure,
  normalizeWorkflowStorageFailure,
  workflowFailure,
} from '../routes/workflows/workflow-failure.js';
import { normalizeWorkflowRelativePath } from '../routes/workflows/workflow-inputs.js';
import { readServerActivity } from '../server-activity.js';

test('failure identity survives the worker error envelope without depending on prose', () => {
  const original = workflowFailure('workflow_publication_missing', 'A different message');
  const transported = Object.assign(new Error(original.message), structuredClone({ ...original }));
  assert.equal(hasWorkflowFailure(transported, 'workflow_publication_missing'), true);
  assert.equal(hasWorkflowFailure(new Error('published version'), 'workflow_publication_missing'), false);
  assert.equal(transported.status, 409);
});

test('unclassified SQLite uniqueness failures remain failures, not domain conflicts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE example (id TEXT PRIMARY KEY, route TEXT UNIQUE); INSERT INTO example VALUES ('one', 'route')",
    );
    for (const sql of [
      "INSERT INTO example VALUES ('one', 'different')",
      "INSERT INTO example VALUES ('two', 'route')",
    ]) {
      let error: unknown;
      try {
        db.exec(sql);
      } catch (caught) {
        error = caught;
      }
      assert.equal(normalizeWorkflowStorageFailure(error), error);
      assert.equal(hasWorkflowFailure(error, 'workflow_destination_conflict'), false);
    }
    const unrelated = new Error('UNIQUE constraint failed');
    assert.equal(normalizeWorkflowStorageFailure(unrelated), unrelated);
    assert.equal(hasWorkflowFailure(normalizeWorkflowStorageFailure({ errcode: 5 }), 'workflow_storage_busy'), true);
    assert.equal(
      hasWorkflowFailure(
        normalizeWorkflowStorageFailure({ reason: 'publication-route-conflict' }),
        'workflow_destination_conflict',
      ),
      true,
    );
    for (const code of ['workflow_state_changed', 'workflow_destination_conflict'] as const) {
      const normalized = normalizeWorkflowStorageFailure(workflowFailure(code, 'Adapter-specific detail'));
      assert.equal(hasWorkflowFailure(normalized, code), true);
      assert.equal(
        (normalized as Error).message,
        'Workflow storage changed or the destination already exists. Refresh before trying again.',
      );
    }
  } finally {
    db.close();
  }
});

test('path normalization is shared while physical containment remains adapter-owned', () => {
  assert.equal(
    normalizeWorkflowRelativePath(' /folder\\project.rivet-project/ ', { allowProjectFile: true }),
    'folder/project.rivet-project',
  );
  assert.equal(normalizeWorkflowRelativePath(undefined, { allowProjectFile: false, allowEmpty: true }), '');
  for (const path of ['a/../b', '.private/a', 'a//b', 15])
    assert.throws(() => normalizeWorkflowRelativePath(path, { allowProjectFile: true }));
  assert.throws(() => normalizeWorkflowRelativePath('project.rivet-project', { allowProjectFile: false }));
});

test('maintenance accounts for pending operations and fails closed on unreadable counters', async () => {
  assert.deepEqual(
    await readServerActivity([
      { name: 'active writes', count: () => 0 },
      { name: 'queued writes', count: async () => 1 },
    ]),
    { ready: false, blockers: ['queued writes'] },
  );
  await assert.rejects(readServerActivity([{ name: 'unavailable', count: () => Number.NaN }]), /Invalid activity/);
  await assert.rejects(
    readServerActivity([
      {
        name: 'unavailable',
        count: () => {
          throw new Error('cannot verify');
        },
      },
    ]),
    /cannot verify/,
  );
});
