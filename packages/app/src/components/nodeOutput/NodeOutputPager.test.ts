import assert from 'node:assert/strict';
import test from 'node:test';
import { getNodeOutputPagerPageLabel } from './NodeOutputPager.js';

test('labels the selected decisive Watch page as Terminal while preserving numbered history pages', () => {
  assert.equal(getNodeOutputPagerPageLabel(0, 4, 'Terminal'), 1);
  assert.equal(getNodeOutputPagerPageLabel(2, 4, 'Terminal'), 3);
  assert.equal(getNodeOutputPagerPageLabel(3, 4, 'Terminal'), 'Terminal');
  assert.equal(getNodeOutputPagerPageLabel('latest', 4, 'Terminal'), 'Terminal');
  assert.equal(getNodeOutputPagerPageLabel('latest', 4), 4);
});
