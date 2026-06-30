import assert from 'node:assert/strict';
import test from 'node:test';
import { getMarkdownFoldingRanges, shouldEnableMarkdownFolding } from './markdownFoldingRanges.js';

test('Markdown folding ranges cover heading sections', () => {
  assert.deepEqual(
    getMarkdownFoldingRanges(['# Title', 'intro', '## Details', '- one', '- two', '# Next', 'end'].join('\n')),
    [
      { start: 1, end: 5 },
      { start: 3, end: 5 },
      { start: 6, end: 7 },
    ],
  );
});

test('Markdown folding ranges cover fenced code blocks and ignore headings inside them', () => {
  assert.deepEqual(
    getMarkdownFoldingRanges(['# Title', '```md', '## Not a heading', '```', '## Real', 'body'].join('\n')),
    [
      { start: 1, end: 6 },
      { start: 2, end: 4 },
      { start: 5, end: 6 },
    ],
  );
});

test('Markdown folding ranges only close fenced blocks on bare fence markers', () => {
  assert.deepEqual(getMarkdownFoldingRanges(['```', '```js', 'const value = 1;', '```'].join('\n')), [
    { start: 1, end: 4 },
  ]);
});

test('Markdown folding ranges handle CRLF input and skip single-line headings', () => {
  assert.deepEqual(getMarkdownFoldingRanges('# One\r\n## Empty\r\n# Two'), [{ start: 1, end: 2 }]);
});

test('Markdown folding is enabled only for node-settings Markdown languages', () => {
  assert.equal(shouldEnableMarkdownFolding('markdown'), true);
  assert.equal(shouldEnableMarkdownFolding('prompt-interpolation-markdown'), true);
  assert.equal(shouldEnableMarkdownFolding('json'), false);
  assert.equal(shouldEnableMarkdownFolding(undefined), false);
});
