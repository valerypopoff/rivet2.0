import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findMatchRanges,
  getHighlightTextNodeRangeGroups,
  projectMatches,
  type HighlightTextSegment,
  type SearchBlock,
} from './fullscreenOutputSearch.js';

test('findMatchRanges is case-insensitive and returns non-overlapping ranges', () => {
  assert.deepEqual(findMatchRanges('Hello hello HELLO', 'heLLo'), [
    { startOffset: 0, endOffset: 5 },
    { startOffset: 6, endOffset: 11 },
    { startOffset: 12, endOffset: 17 },
  ]);
  assert.deepEqual(findMatchRanges('banana', 'ana'), [{ startOffset: 1, endOffset: 4 }]);
});

test('findMatchRanges returns original-text ranges when lowercase expansion changes string length', () => {
  assert.deepEqual(findMatchRanges('İ abc foo', 'foo'), [{ startOffset: 6, endOffset: 9 }]);
  assert.deepEqual(findMatchRanges('İ abc foo', 'i'), [{ startOffset: 0, endOffset: 1 }]);
  assert.deepEqual(findMatchRanges('İ abc foo', 'İ'), [{ startOffset: 0, endOffset: 1 }]);
});

test('findMatchRanges preserves whole-string lowercase matching for context-sensitive casing', () => {
  assert.deepEqual(findMatchRanges('ΟΣ alpha', 'ος'), [{ startOffset: 0, endOffset: 2 }]);
});

test('findMatchRanges returns zero matches for an empty query', () => {
  assert.deepEqual(findMatchRanges('hello', ''), []);
});

test('projectMatches keeps document-order sequencing across text and provider blocks', () => {
  const blocks: SearchBlock[] = [
    {
      kind: 'text',
      textNodes: [],
      matches: [{ startOffset: 0, endOffset: 5 }],
    },
    {
      kind: 'provider',
      providerId: 'provider-1',
      matches: [
        { startOffset: 3, endOffset: 8 },
        { startOffset: 9, endOffset: 14 },
      ],
    },
    {
      kind: 'text',
      textNodes: [],
      matches: [
        { startOffset: 5, endOffset: 10 },
        { startOffset: 11, endOffset: 16 },
      ],
    },
  ];

  const matches = projectMatches(blocks);

  assert.deepEqual(
    matches.map((match) =>
      match.kind === 'provider'
        ? `provider:${match.blockIndex}:${match.localMatchIndex}`
        : `text:${match.blockIndex}:${match.localMatchIndex}`,
    ),
    ['text:0:0', 'provider:1:0', 'provider:1:1', 'text:2:0', 'text:2:1'],
  );
});

test('projectMatches returns zero matches when blocks have no match ranges', () => {
  const blocks: SearchBlock[] = [
    {
      kind: 'text',
      textNodes: [],
      matches: [],
    },
  ];

  assert.deepEqual(projectMatches(blocks), []);
});

test('highlight range mapping counts virtual line breaks from rich rendered text', () => {
  const firstLine = createFakeTextNode('  "first": "alpha",');
  const secondLine = createFakeTextNode('  "target": "needle"');
  const segments: HighlightTextSegment[] = [
    { kind: 'text', textNode: firstLine, text: firstLine.textContent ?? '' },
    { kind: 'virtual', text: '\n' },
    { kind: 'text', textNode: secondLine, text: secondLine.textContent ?? '' },
  ];
  const rawText = segments.map((segment) => segment.text).join('');
  const needleStartOffset = rawText.indexOf('needle');
  const secondLineNeedleStartOffset = secondLine.textContent!.indexOf('needle');

  const groups = getHighlightTextNodeRangeGroups({
    textSegments: segments,
    matchRanges: [{ startOffset: needleStartOffset, endOffset: needleStartOffset + 'needle'.length }],
    matchIndices: [0],
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.textNode, secondLine);
  assert.deepEqual(groups[0]?.ranges, [
    {
      startOffset: secondLineNeedleStartOffset,
      endOffset: secondLineNeedleStartOffset + 'needle'.length,
      matchIndex: 0,
    },
  ]);
});

function createFakeTextNode(textContent: string): Text {
  return { textContent } as Text;
}
