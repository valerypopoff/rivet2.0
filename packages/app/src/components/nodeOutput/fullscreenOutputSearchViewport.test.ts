import assert from 'node:assert/strict';
import test from 'node:test';
import { getFullscreenOutputSearchScrollDelta } from './fullscreenOutputSearchViewport.js';

test('returns no adjustment when the search target is fully visible', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 220,
      targetBottom: 240,
      viewportTop: 100,
      viewportBottom: 500,
    }),
    0,
  );
});

test('scrolls up far enough to clear the sticky header', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 80,
      targetBottom: 100,
      viewportTop: 120,
      viewportBottom: 500,
    }),
    -220,
  );
});

test('scrolls down far enough to show a target below the modal viewport', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 520,
      targetBottom: 540,
      viewportTop: 100,
      viewportBottom: 500,
    }),
    230,
  );
});

test('scrolls up when a target is above the visible area', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 70,
      targetBottom: 90,
      viewportTop: 100,
      viewportBottom: 500,
    }),
    -220,
  );
});

test('keeps oversized targets anchored to the top instead of oscillating', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 80,
      targetBottom: 920,
      viewportTop: 120,
      viewportBottom: 500,
    }),
    -40,
  );
});

test('does not scroll while the viewport is not measurable', () => {
  assert.equal(
    getFullscreenOutputSearchScrollDelta({
      targetTop: 0,
      targetBottom: 20,
      viewportTop: 0,
      viewportBottom: 0,
    }),
    0,
  );
});
