import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WIDTH_RATIO,
  MAX_WIDTH_RATIO,
  MIN_WIDTH,
  clampNodeEditorWidth,
  dragNodeEditorWidth,
  isValidWidth,
  resolveNodeEditorWidth,
} from './useNodeEditorWidth.js';

function halfViewport(viewportWidth: number): number {
  return Math.round(viewportWidth * MAX_WIDTH_RATIO);
}

test('resolveNodeEditorWidth prefers persisted width and falls back to the shared default ratio', () => {
  assert.equal(resolveNodeEditorWidth({ persistedWidth: 720, viewportWidth: 1600 }), 720);
  assert.equal(
    resolveNodeEditorWidth({ persistedWidth: undefined, viewportWidth: 1200 }),
    Math.max(MIN_WIDTH, Math.round(1200 * DEFAULT_WIDTH_RATIO)),
  );
});

test('resolveNodeEditorWidth clamps persisted and fallback widths to the supported range', () => {
  assert.equal(resolveNodeEditorWidth({ persistedWidth: 1600, viewportWidth: 2200 }), halfViewport(2200));
  assert.equal(resolveNodeEditorWidth({ persistedWidth: 1000, viewportWidth: 1600 }), halfViewport(1600));
  assert.equal(resolveNodeEditorWidth({ persistedWidth: 100, viewportWidth: 900 }), halfViewport(900));
  assert.equal(resolveNodeEditorWidth({ persistedWidth: undefined, viewportWidth: 4000 }), 4000 * DEFAULT_WIDTH_RATIO);
});

test('node editor width never exceeds half the app viewport', () => {
  assert.equal(clampNodeEditorWidth(900, 1600), halfViewport(1600));
  assert.equal(clampNodeEditorWidth(700, 900), halfViewport(900));
});

test('isValidWidth rejects invalid stored values', () => {
  assert.equal(isValidWidth(Number.NaN), false);
  assert.equal(isValidWidth(0), false);
  assert.equal(isValidWidth(undefined), false);
});

test('dragNodeEditorWidth expands leftward, shrinks rightward, and clamps to limits', () => {
  assert.equal(
    dragNodeEditorWidth({
      startWidth: 600,
      startClientX: 1000,
      currentClientX: 900,
      viewportWidth: 1600,
    }),
    700,
  );
  assert.equal(
    dragNodeEditorWidth({
      startWidth: 600,
      startClientX: 1000,
      currentClientX: 1200,
      viewportWidth: 1600,
    }),
    MIN_WIDTH,
  );
  assert.equal(clampNodeEditorWidth(5000, 2400), halfViewport(2400));
});
