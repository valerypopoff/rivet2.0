import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const editorsDir = dirname(fileURLToPath(import.meta.url));
const segmentedEditorSource = readFileSync(join(editorsDir, 'SegmentedEditor.tsx'), 'utf8');

test('active segmented choices use calculated primary foreground contrast', () => {
  assert.match(
    segmentedEditorSource,
    /\.segmented-choice-option\.is-active \{[\s\S]*background: var\(--primary\);[\s\S]*color: var\(--foreground-on-primary\);/,
  );
  assert.doesNotMatch(
    segmentedEditorSource,
    /\.segmented-choice-option\.is-active \{[\s\S]*color: var\(--grey-darkest\);/,
  );
});

test('segmented choice track is theme-tokenized for Bright contrast', () => {
  const colorsSource = readFileSync(join(editorsDir, '..', '..', 'colors.css'), 'utf8');

  assert.match(segmentedEditorSource, /\.segmented-choice \{[\s\S]*background: var\(--segmented-choice-bg\);/);
  assert.match(colorsSource, /--segmented-choice-bg: rgba\(0, 0, 0, 0\.22\);/);
  assert.match(
    colorsSource,
    /:root\.theme-bright,[\s\S]*--segmented-choice-bg: color-mix\(in srgb, var\(--secondary\) 5%, #c7d0dc 95%\);/,
  );
});

test('callers can keep compact segmented options on one line', () => {
  assert.match(segmentedEditorSource, /allowOptionWrap\?: boolean/);
  assert.match(segmentedEditorSource, /const wraps = allowOptionWrap && choice\.scrollWidth > availableWidth \+ 1;/);
  assert.match(
    segmentedEditorSource,
    /\.segmented-choice\[data-wrap='false'\] \{[\s\S]*max-width: none;[\s\S]*flex-shrink: 0;/,
  );
});
