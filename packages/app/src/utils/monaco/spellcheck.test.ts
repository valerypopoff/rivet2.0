import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getSpellcheckIssues,
  getSpellcheckMarkers,
  getSpellcheckWordRanges,
  SPELLCHECK_MARKER_LIMIT,
  SPELLCHECK_MARKER_OWNER,
} from './spellcheck.js';

const utilsDir = dirname(fileURLToPath(import.meta.url));

const fakeSpellchecker = {
  correct: (word: string) => !['mispelled', 'wrds', 'helllo'].includes(word.toLowerCase()),
};

const compoundSpellchecker = {
  correct: (word: string) =>
    ['another', 'chat', 'end', 'facing', 'front', 'good', 'open', 'schema', 'system', 'to', 'word'].includes(
      word.toLowerCase(),
    ),
};

function createFakeModel(text: string) {
  return {
    getPositionAt(offset: number) {
      const before = text.slice(0, offset);
      const lines = before.split('\n');

      return {
        lineNumber: lines.length,
        column: lines.at(-1)!.length + 1,
      };
    },
  } as any;
}

test('runCodeEditorSpellcheck is available for every Monaco editor language', () => {
  const spellcheckSource = readFileSync(join(utilsDir, 'spellcheck.ts'), 'utf8');

  assert.doesNotMatch(spellcheckSource, /SPELLCHECK_LANGUAGES/);
  assert.doesNotMatch(spellcheckSource, /getLanguageId\(\)/);
});

test('getSpellcheckWordRanges ignores URLs, emails, numbers, interpolation, and dotted identifiers', () => {
  const text = [
    'This has mispelled wrds.',
    'Ignore https://example.com/helllo and user@example.com.',
    'Ignore {{mispelledPlaceholder}} and 12345.',
    'Ignore API, var1, and object.property.',
  ].join('\n');

  assert.deepEqual(
    getSpellcheckWordRanges(text).map(({ word }) => word),
    ['This', 'has', 'mispelled', 'wrds', 'Ignore', 'and', 'Ignore', 'and', 'Ignore', 'and'],
  );
});

test('getSpellcheckIssues accepts valid delimiter and camel-case compounds', () => {
  const text = [
    'system-facing',
    'word/word',
    'word_word',
    'wordAnotherWord',
    'OpenAI',
    'LLMChat',
    'JSONSchema',
    'front-end',
    'end-to-end',
  ].join(' ');

  assert.deepEqual(getSpellcheckIssues(text, compoundSpellchecker), []);
});

test('getSpellcheckIssues accepts supplemental Rivet and technical vocabulary', () => {
  const rejectEverythingSpellchecker = { correct: () => false };
  const text = 'Reachability subgraphs frontend webapps tooltips metadata';

  assert.deepEqual(getSpellcheckIssues(text, rejectEverythingSpellchecker), []);
});

test('getSpellcheckIssues accepts caller-provided dictionary words', () => {
  const rejectEverythingSpellchecker = { correct: () => false };
  const text = 'CSpellDictionaryWord unknownword';

  assert.deepEqual(
    getSpellcheckIssues(text, rejectEverythingSpellchecker, new Set(['cspelldictionaryword'])).map(({ word }) => word),
    ['unknownword'],
  );
});

test('getSpellcheckIssues reports only invalid compound parts with exact ranges', () => {
  const text = 'systm-facing word/wrod word_anotherWrod goodTehWord';

  assert.deepEqual(
    getSpellcheckIssues(text, compoundSpellchecker).map(({ word, start, end }) => ({
      word,
      start,
      end,
      slice: text.slice(start, end),
    })),
    [
      { word: 'systm', start: 0, end: 5, slice: 'systm' },
      { word: 'wrod', start: 18, end: 22, slice: 'wrod' },
      { word: 'Wrod', start: 35, end: 39, slice: 'Wrod' },
      { word: 'Teh', start: 44, end: 47, slice: 'Teh' },
    ],
  );
});

test('getSpellcheckIssues returns only words rejected by the checker', () => {
  assert.deepEqual(
    getSpellcheckIssues('This has mispelled wrds and fine words.', fakeSpellchecker).map(({ word }) => word),
    ['mispelled', 'wrds'],
  );
});

test('getSpellcheckMarkers converts offsets to Monaco marker ranges and caps marker count', () => {
  const text = 'mispelled\nhelllo';
  const issues = Array.from({ length: SPELLCHECK_MARKER_LIMIT + 1 }, (_, index) => ({
    word: index === 0 ? 'mispelled' : 'helllo',
    start: index === 0 ? 0 : 10,
    end: index === 0 ? 9 : 16,
  }));
  const markers = getSpellcheckMarkers(createFakeModel(text), issues);
  const firstMarker = markers[0]!;
  const secondMarker = markers[1]!;

  assert.equal(markers.length, SPELLCHECK_MARKER_LIMIT);
  assert.equal(firstMarker.source, 'Rivet spellcheck');
  assert.equal(firstMarker.message, 'Possible spelling issue: "mispelled"');
  assert.equal(firstMarker.startLineNumber, 1);
  assert.equal(firstMarker.startColumn, 1);
  assert.equal(secondMarker.startLineNumber, 2);
  assert.equal(secondMarker.startColumn, 1);
});

test('spellcheck marker owner is dedicated to Rivet spellcheck markers', () => {
  assert.equal(SPELLCHECK_MARKER_OWNER, 'rivet-spellcheck');
});

test('spellcheck lazy dictionary load is retryable after failure', () => {
  const spellcheckSource = readFileSync(join(utilsDir, 'spellcheck.ts'), 'utf8');

  assert.match(spellcheckSource, /catch\(\(error\) => \{[\s\S]*spellcheckResourcesPromise = undefined;/);
});
