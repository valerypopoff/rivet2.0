import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiComponentId } from '@valerypopoff/rivet2-core';
import {
  addUiGraphComponentsToSelection,
  getUiGraphComponentIdsInSelectionRectangle,
  selectUiGraphComponent,
} from './componentSelection.js';

const first = 'first' as UiComponentId;
const second = 'second' as UiComponentId;

test('ordinary selection replaces the preview component selection', () => {
  assert.deepEqual(selectUiGraphComponent([first, second], second, 'replace'), [second]);
});

test('modifier selection toggles one preview component without changing the others', () => {
  assert.deepEqual(selectUiGraphComponent([first], second, 'toggle'), [first, second]);
  assert.deepEqual(selectUiGraphComponent([first, second], first, 'toggle'), [second]);
});

test('rectangle selection adds intersecting components without duplicating the existing selection', () => {
  assert.deepEqual(addUiGraphComponentsToSelection([first], [first, second]), [first, second]);
});

test('rectangle selection detects intersecting components regardless of drag direction', () => {
  const componentIds = getUiGraphComponentIdsInSelectionRectangle(
    { currentX: 10, currentY: 10, startX: 120, startY: 120 },
    [
      { id: first, rect: { bottom: 100, left: 20, right: 100, top: 20 } },
      { id: second, rect: { bottom: 220, left: 160, right: 240, top: 160 } },
    ],
  );

  assert.deepEqual(componentIds, [first]);
});

test('rectangle selection matches canvas behavior by requiring at least half of a component', () => {
  const componentIds = getUiGraphComponentIdsInSelectionRectangle(
    { currentX: 50, currentY: 50, startX: 0, startY: 0 },
    [{ id: first, rect: { bottom: 100, left: 20, right: 120, top: 20 } }],
  );

  assert.deepEqual(componentIds, []);
});
