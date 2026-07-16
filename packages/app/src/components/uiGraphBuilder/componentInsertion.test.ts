import assert from 'node:assert/strict';
import test from 'node:test';
import { getUiGraphComponentInsertionIndex } from './componentInsertion.js';

test('component insertion index chooses before or after the current drop target', () => {
  const targetBoundary = { bottom: 200, top: 160 };

  assert.equal(getUiGraphComponentInsertionIndex(1, 170, targetBoundary), 1);
  assert.equal(getUiGraphComponentInsertionIndex(1, 190, targetBoundary), 2);
});
