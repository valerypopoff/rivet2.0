import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonEscapeText, jsonUnescapeText } from './editorTextTransforms.js';

test('jsonEscapeText delegates to native JSON string escaping', () => {
  const text = 'Quote: " Backslash: \\ Newline:\nTab:\tUnicode: \u2713';
  const escaped = jsonEscapeText(text);

  assert.equal(escaped, JSON.stringify(text).slice(1, -1));
  assert.match(escaped, /\\"/);
  assert.match(escaped, /\\\\/);
  assert.match(escaped, /\\n/);
  assert.match(escaped, /\\t/);
});

test('jsonEscapeText normalizes selected editor line endings to LF before escaping', () => {
  assert.equal(jsonEscapeText('first\r\nsecond\rthird\nfourth'), 'first\\nsecond\\nthird\\nfourth');
});

test('jsonUnescapeText delegates to native JSON string parsing', () => {
  const escaped = 'Quote: \\" Backslash: \\\\ Newline:\\nTab:\\tUnicode: \\u2713';

  assert.equal(jsonUnescapeText(escaped), 'Quote: " Backslash: \\ Newline:\nTab:\tUnicode: \u2713');
});

test('jsonUnescapeText returns undefined for invalid escaped JSON string content', () => {
  assert.equal(jsonUnescapeText('bad \\q escape'), undefined);
});

test('jsonEscapeText and jsonUnescapeText handle empty strings', () => {
  assert.equal(jsonEscapeText(''), '');
  assert.equal(jsonUnescapeText(''), '');
});
