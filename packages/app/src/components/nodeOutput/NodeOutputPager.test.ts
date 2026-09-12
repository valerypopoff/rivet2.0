import assert from 'node:assert/strict';
import test from 'node:test';
import { getNodeOutputPagerPageLabel } from './NodeOutputPager.js';

test('labels only the settled decisive Watch page as Terminal', () => {
  assert.equal(getNodeOutputPagerPageLabel(0, 4, { index: 2, label: 'Terminal' }), 1);
  assert.equal(getNodeOutputPagerPageLabel(1, 4, { index: 2, label: 'Terminal' }), 2);
  assert.equal(getNodeOutputPagerPageLabel(2, 4, { index: 2, label: 'Terminal' }), 'Terminal');
  assert.equal(getNodeOutputPagerPageLabel(3, 4, { index: 2, label: 'Terminal' }), 4);
  // A live branch follows its newest page, but it is still an ordinary run
  // until the terminal Watch summary identifies the winning child run.
  assert.equal(getNodeOutputPagerPageLabel('latest', 4, { index: 2, label: 'Terminal' }), 4);
  assert.equal(getNodeOutputPagerPageLabel('latest', 4), 4);
});
