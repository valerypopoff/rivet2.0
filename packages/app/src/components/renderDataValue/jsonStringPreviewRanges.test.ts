import assert from 'node:assert/strict';
import test from 'node:test';
import { findJsonStringPreviewRangeAtOffset, getJsonStringPreviewRanges } from './jsonStringPreviewRanges.js';

test('detects escaped object string values and ignores object keys', () => {
  const text = '{\n  "plain": "short",\n  "escaped": "line\\nnext"\n}';

  const ranges = getJsonStringPreviewRanges(text);

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['line\nnext'],
  );
});

test('detects nested object and array string values', () => {
  const text = '{\n  "outer": {\n    "items": [\n      "short",\n      "tab\\tvalue"\n    ]\n  }\n}';

  const ranges = getJsonStringPreviewRanges(text);

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['tab\tvalue'],
  );
});

test('decodes quotes, backslashes, newlines, tabs, and unicode escapes', () => {
  const text =
    '{"quote":"He said \\"hi\\"","path":"C:\\\\tmp","newline":"a\\nb","tab":"a\\tb","unicode":"letter: \\u0041"}';

  const ranges = getJsonStringPreviewRanges(text);

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['He said "hi"', 'C:\\tmp', 'a\nb', 'a\tb', 'letter: A'],
  );
});

test('does not mark plain short strings', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"plain short text"}');

  assert.equal(ranges.length, 0);
});

test('marks long decoded strings by threshold', () => {
  const text = JSON.stringify({ value: 'x'.repeat(121) }, null, 2);

  const ranges = getJsonStringPreviewRanges(text);

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.decodedValue, 'x'.repeat(121));
});

test('supports custom length thresholds', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"123456"}', { minDecodedLength: 6 });

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.decodedValue, '123456');
});

test('returns no ranges for malformed JSON', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"line\\nnext"');

  assert.deepEqual(ranges, []);
});

test('finds preview ranges by displayed text offset', () => {
  const text = '{"value":"line\\nnext"}';
  const ranges = getJsonStringPreviewRanges(text);
  const range = ranges[0]!;

  assert.equal(findJsonStringPreviewRangeAtOffset(ranges, range.startOffset), range);
  assert.equal(findJsonStringPreviewRangeAtOffset(ranges, range.endOffset), range);
  assert.equal(findJsonStringPreviewRangeAtOffset(ranges, range.endOffset + 1), undefined);
});
