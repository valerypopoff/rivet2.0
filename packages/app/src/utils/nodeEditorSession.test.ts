import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeEditorSession, mergeNodeEditorChange } from './nodeEditorSession.js';
import type { ChartNode } from '@valerypopoff/rivet2-core';

test('A -> B -> A never revives an old editor callback', () => {
  let owner = 'A';
  const old = createNodeEditorSession(() => owner === 'A');
  assert.equal(old.isCurrent(), true);
  owner = 'B';
  assert.equal(old.isCurrent(), false);
  owner = 'A';
  assert.equal(old.isCurrent(), false);
  assert.equal(createNodeEditorSession(() => owner === 'A').isCurrent(), true);
});

test('retirement cancels registered work once and rejects newly registered work', () => {
  let cancellations = 0;
  const session = createNodeEditorSession(() => true);
  const unsubscribe = session.onRetire(() => {
    throw new Error('unsubscribed');
  });
  unsubscribe();
  session.onRetire(() => {
    cancellations++;
  });
  session.retire();
  session.retire();
  assert.equal(cancellations, 1);
  session.onRetire(() => {
    cancellations++;
  });
  assert.equal(cancellations, 2);
  assert.equal(session.isCurrent(), false);
});

test('same IDs with a replaced content generation invalidate callbacks', () => {
  let revision = 1;
  const session = createNodeEditorSession(() => revision === 1);
  revision++;
  assert.equal(session.isCurrent(), false);
});

test('a field callback based on an old render cannot overwrite a newer sibling', () => {
  const rendered = { id: 'n', type: 'code', title: 'Node', data: { code: 'old', useCodeInput: false } } as ChartNode<
    'code',
    {
      code: string;
      useCodeInput: boolean;
    }
  >;
  const current = { ...rendered, title: 'Renamed', data: { ...rendered.data, useCodeInput: true } };
  const changed = { ...rendered, data: { ...rendered.data, code: 'new' } };
  const result = mergeNodeEditorChange(current, rendered, changed);
  assert.equal(result.title, 'Renamed');
  assert.deepEqual(result.data, { code: 'new', useCodeInput: true });
});

test('cancelling optional metadata explicitly clears the value without reverting newer fields', () => {
  const current = {
    id: 'n',
    type: 'code',
    title: 'Renamed',
    description: 'Temporary description',
    data: { code: 'latest' },
  } as ChartNode;
  const changed = { ...current, description: undefined };
  const result = mergeNodeEditorChange(current, current, changed);
  assert.equal(Object.hasOwn(result, 'description'), true, 'partial edit commands need an explicit clearing field');
  assert.equal(result.description, undefined);
  assert.equal(result.title, 'Renamed');
  assert.deepEqual(result.data, { code: 'latest' });
});
