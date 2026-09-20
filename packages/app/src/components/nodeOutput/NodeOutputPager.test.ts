import assert from 'node:assert/strict';
import test from 'node:test';
import { getPagedPageIndex, isPageBoundaryModifierClick } from '../pageNavigation.js';
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

test('modifier clicks identify pager boundaries and ordinary clicks move one page', () => {
  assert.equal(isPageBoundaryModifierClick({ ctrlKey: true, metaKey: false }), true);
  assert.equal(isPageBoundaryModifierClick({ ctrlKey: false, metaKey: true }), true);
  assert.equal(isPageBoundaryModifierClick({ ctrlKey: false, metaKey: false }), false);

  assert.equal(getPagedPageIndex({ currentPage: 2, pageCount: 4, direction: 'previous', jumpToBoundary: false }), 1);
  assert.equal(getPagedPageIndex({ currentPage: 2, pageCount: 4, direction: 'next', jumpToBoundary: false }), 3);
  assert.equal(getPagedPageIndex({ currentPage: 2, pageCount: 4, direction: 'previous', jumpToBoundary: true }), 0);
  assert.equal(getPagedPageIndex({ currentPage: 1, pageCount: 4, direction: 'next', jumpToBoundary: true }), 3);
  assert.equal(getPagedPageIndex({ currentPage: 0, pageCount: 0, direction: 'next', jumpToBoundary: true }), 0);
  assert.equal(getPagedPageIndex({ currentPage: 3, pageCount: 0, direction: 'previous', jumpToBoundary: false }), 0);
});
