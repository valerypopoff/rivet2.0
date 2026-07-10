import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findJsonStringPreviewRangeAtOffset,
  findJsonStringPreviewRangeAtPosition,
  getJsonStringPreviewRanges,
  isCurrentJsonStringPreviewLiteral,
} from './jsonStringPreviewRanges.js';

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
  const text = JSON.stringify({ value: 'x'.repeat(50) }, null, 2);

  const ranges = getJsonStringPreviewRanges(text);

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.decodedValue, 'x'.repeat(50));
});

test('supports custom length thresholds', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"123456"}', { minDecodedLength: 6 });

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.decodedValue, '123456');
});

test('can opt into previewing short string values', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"short"}', { minDecodedLength: 0 });

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.decodedValue, 'short');
});

test('detects string values even when the surrounding JSON document is malformed', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"line\\nnext",}');

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['line\nnext'],
  );
});

test('detects string values in JSON-template-like editor text', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"line\\nnext","other":{{input}}}');

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['line\nnext'],
  );
});

test('detects short JSON-template string values when the caller opts into all strings', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"{{input}}","other":{{input}}}', { minDecodedLength: 0 });

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['{{input}}'],
  );
});

test('ignores malformed individual string literals', () => {
  const ranges = getJsonStringPreviewRanges('{"bad":"line\\q","good":"line\\nnext"}');

  assert.deepEqual(
    ranges.map((range) => range.decodedValue),
    ['line\nnext'],
  );
});

test('returns no ranges for incomplete string literals', () => {
  const ranges = getJsonStringPreviewRanges('{"value":"line\\nnext');

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

test('finds preview ranges from any position on the same field line', () => {
  const text = '{\n  "value": "line\\nnext"\n}';
  const ranges = getJsonStringPreviewRanges(text);
  const range = ranges[0]!;
  const keyOffset = text.indexOf('"value"');

  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, keyOffset, 2), range);
  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, text.indexOf('  '), 2), range);
  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, 0, 1), undefined);
});

test('exact string hits win before same-line fallback', () => {
  const text = '{"first":"line\\nnext","second":"tab\\tvalue"}';
  const ranges = getJsonStringPreviewRanges(text);
  const firstRange = ranges[0]!;
  const secondRange = ranges[1]!;

  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, firstRange.startOffset + 1, 1), firstRange);
  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, secondRange.startOffset + 1, 1), secondRange);
});

test('same-line fallback chooses the nearest string value', () => {
  const text = '{"first":"line\\nnext","second":"tab\\tvalue"}';
  const ranges = getJsonStringPreviewRanges(text);
  const firstRange = ranges[0]!;
  const secondRange = ranges[1]!;

  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, firstRange.endOffset + 1, 1), firstRange);
  assert.equal(findJsonStringPreviewRangeAtPosition(ranges, secondRange.startOffset - 1, 1), secondRange);
});

test('editable previews reject stale or malformed source literals', () => {
  const [range] = getJsonStringPreviewRanges('{"value":"line\\nvalue"}', { minDecodedLength: 0 });

  assert.ok(range);
  assert.equal(isCurrentJsonStringPreviewLiteral('"line\\nvalue"', range), true);
  assert.equal(isCurrentJsonStringPreviewLiteral('"changed"', range), false);
  assert.equal(isCurrentJsonStringPreviewLiteral('"incomplete', range), false);
});
