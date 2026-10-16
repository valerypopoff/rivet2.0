import test from 'node:test';
import assert from 'node:assert/strict';
import { editorSource } from '../dashboard/editorSource.js';

test('iframe pins the dashboard production build without changing direct or development openings', () => {
  const document = (content?: string) => ({ querySelector: () => content ? { content } : null }) as unknown as Document;
  const id = 'a'.repeat(64);
  assert.equal(editorSource(document(id), null), `/?editor&webBuild=${id}`);
  assert.equal(editorSource(document(id), 'dev-generation'), '/?editor&devBuild=dev-generation');
  assert.equal(editorSource(document(), null), '/?editor');
  assert.equal(editorSource(document('https://other.test'), null), '/?editor');
});
