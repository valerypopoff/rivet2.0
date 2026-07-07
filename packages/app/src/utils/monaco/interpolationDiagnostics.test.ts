import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getActiveInterpolationOffsetRanges,
  JS_VALUE_INTERPOLATION_MARKER_OWNERS,
  JSON_TEMPLATE_INTERPOLATION_MARKER_OWNERS,
  rangesOverlap,
  shouldSuppressMarkerForInterpolation,
} from './interpolationDiagnostics.js';
import { JSON_TEMPLATE_VALIDATION_MARKER_OWNER } from './jsonTemplateValidation.js';

test('getActiveInterpolationOffsetRanges ignores escaped interpolation tokens', () => {
  const text = '{{{literal}}}{{real}} const value = {{input}};';
  const ranges = getActiveInterpolationOffsetRanges(text);

  assert.deepEqual(
    ranges.map((range) => text.slice(range.start, range.end)),
    ['{{real}}', '{{input}}'],
  );
});

test('getActiveInterpolationOffsetRanges skips malformed outer tokens with nested openers', () => {
  const text = 'before {{outer {{inner}} after {{real}}';
  const ranges = getActiveInterpolationOffsetRanges(text);

  assert.deepEqual(
    ranges.map((range) => text.slice(range.start, range.end)),
    ['{{inner}}', '{{real}}'],
  );
});

test('interpolation diagnostics stay independent from the core runtime barrel', async () => {
  const source = await readFile(new URL('./interpolationDiagnostics.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('@valerypopoff/rivet2-core'), false);
});

test('JSON template interpolation uses JSON validation markers only', () => {
  assert.deepEqual([...JSON_TEMPLATE_INTERPOLATION_MARKER_OWNERS], ['json']);
});

test('JSON template interpolation installs Rivet-owned validation markers', async () => {
  const source = await readFile(new URL('./interpolationEditorSupport.ts', import.meta.url), 'utf8');

  assert.equal(JSON_TEMPLATE_VALIDATION_MARKER_OWNER, 'rivet-json-template-validation');
  assert.match(source, /validateJsonTemplate/);
  assert.match(source, /JSON_TEMPLATE_VALIDATION_MARKER_OWNER/);
  assert.match(source, /syntax === 'json-template'\s+\?\s+\[\]/);
  assert.match(source, /monaco\.editor\.setModelMarkers\(model, JSON_TEMPLATE_VALIDATION_MARKER_OWNER, markers\)/);
  assert.match(source, /clearPendingMarkerFilterTimeouts/);
});

test('JavaScript value interpolation uses JavaScript and TypeScript validation markers only', () => {
  assert.deepEqual([...JS_VALUE_INTERPOLATION_MARKER_OWNERS], ['javascript', 'typescript']);
});

test('rangesOverlap treats zero-width marker ranges as a one-character marker', () => {
  assert.equal(rangesOverlap({ start: 10, end: 10 }, { start: 10, end: 19 }), true);
  assert.equal(rangesOverlap({ start: 9, end: 9 }, { start: 10, end: 19 }), false);
});

test('shouldSuppressMarkerForInterpolation suppresses only overlapping marker ranges', () => {
  const text = 'const value = {{input}};\nconst broken = ;';
  const interpolationRanges = getActiveInterpolationOffsetRanges(text);
  const interpolationStart = text.indexOf('{{input}}');
  const brokenStart = text.indexOf('= ;');

  assert.equal(
    shouldSuppressMarkerForInterpolation(
      {
        start: interpolationStart,
        end: interpolationStart + 1,
      },
      interpolationRanges,
    ),
    true,
  );
  assert.equal(
    shouldSuppressMarkerForInterpolation(
      {
        start: brokenStart,
        end: brokenStart + 1,
      },
      interpolationRanges,
    ),
    false,
  );
});
