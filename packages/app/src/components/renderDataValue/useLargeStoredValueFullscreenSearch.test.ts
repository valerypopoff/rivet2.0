import assert from 'node:assert/strict';
import test from 'node:test';
import { findMatchRanges } from '../nodeOutput/fullscreenOutputSearch.js';
import { mapSourceMatchRangeToRenderedText } from './useLargeStoredValueFullscreenSearch.js';

test('maps an active source match to Markdown-rendered text after syntax changes its offsets', () => {
  const sourceText = '# Heading\n\nFind **needle** in this loaded value.';
  const sourceMatchRange = findMatchRanges(sourceText, 'needle')[0];

  assert.deepEqual(
    mapSourceMatchRangeToRenderedText({
      sourceText,
      sourceMatchRange: sourceMatchRange!,
      renderedText: 'HeadingFind needle in this loaded value.',
    }),
    {
      startOffset: 'HeadingFind '.length,
      endOffset: 'HeadingFind needle'.length,
    },
  );
});

test('preserves the active occurrence when Markdown source contains repeated text', () => {
  const sourceText = '**needle** then needle';
  const sourceMatchRange = findMatchRanges(sourceText, 'needle')[1];

  assert.deepEqual(
    mapSourceMatchRangeToRenderedText({
      sourceText,
      sourceMatchRange: sourceMatchRange!,
      renderedText: 'needle then needle',
    }),
    {
      startOffset: 'needle then '.length,
      endOffset: 'needle then needle'.length,
    },
  );
});
