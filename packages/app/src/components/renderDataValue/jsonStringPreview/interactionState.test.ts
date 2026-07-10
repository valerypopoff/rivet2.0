import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonStringPreviewRange } from '../jsonStringPreviewRanges.js';
import { EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE, reduceJsonStringPreviewInteraction } from './interactionState.js';

const range = {
  decodedValue: 'line one\nline two',
  endOffset: 22,
  endLine: 2,
  id: '4:22',
  startOffset: 4,
  startLine: 1,
} as JsonStringPreviewRange;

test('decoded string interaction has one mutually exclusive edit surface', () => {
  const withButton = reduceJsonStringPreviewInteraction(EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE, {
    button: { left: 10, range, top: 20 },
    type: 'setButton',
  });
  const withPopover = reduceJsonStringPreviewInteraction(withButton, {
    left: 10,
    range,
    top: 48,
    type: 'openPopover',
  });
  const withEdit = reduceJsonStringPreviewInteraction(withPopover, { range, type: 'openEdit' });

  assert.equal(withEdit.button, null);
  assert.equal(withEdit.popover, null);
  assert.equal(withEdit.editModal?.draft, range.decodedValue);
});

test('all close reasons reset every transient surface', () => {
  const opened = reduceJsonStringPreviewInteraction(EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE, {
    range,
    type: 'openEdit',
  });

  assert.equal(
    reduceJsonStringPreviewInteraction(opened, { reason: 'text-change', type: 'clear' }),
    EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE,
  );
});
