import type * as monaco from 'monaco-editor';
import { getActiveInterpolationOffsetRanges, rangesOverlap, type OffsetRange } from './interpolationDiagnostics.js';

export const SPELLCHECK_MARKER_OWNER = 'rivet-spellcheck';
export const SPELLCHECK_MARKER_LIMIT = 200;

const WORD_PATTERN = /[\p{L}][\p{L}'\u2019/_-]*/gu;
const URL_OR_EMAIL_PATTERN = /https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.\w+/gi;
const TOKEN_BOUNDARY_IGNORE_PATTERN = /[\p{L}\p{N}_$/]/u;
const SPELLCHECK_MARKER_SEVERITY = 4 as monaco.MarkerSeverity;
const WORD_PART_PATTERN = /[^/_-]+/gu;
const IGNORED_INITIALISMS = new Set([
  'ai',
  'api',
  'cli',
  'css',
  'html',
  'http',
  'https',
  'id',
  'js',
  'json',
  'jsx',
  'llm',
  'npm',
  'os',
  'sdk',
  'sql',
  'src',
  'ts',
  'tsx',
  'ui',
  'url',
  'ux',
  'vm',
  'yaml',
]);
const SUPPLEMENTAL_SPELLCHECK_WORDS = new Set([
  'autocomplete',
  'backend',
  'codebase',
  'frontend',
  'metadata',
  'preloader',
  'prefab',
  'prefabs',
  'reachability',
  'subgraph',
  'subgraphs',
  'tooltip',
  'tooltips',
  'webapp',
  'webapps',
  'workflow',
  'workflows',
]);

type Spellchecker = {
  correct(word: string): boolean;
};

type SpellcheckResources = {
  spellchecker: Spellchecker;
  supplementalWords: ReadonlySet<string>;
};

export type SpellcheckMarkerSupport = {
  clear(): void;
  setMarkers(markers: readonly monaco.editor.IMarkerData[]): void;
};

export type SpellcheckCapableCodeEditor = Pick<monaco.editor.IStandaloneCodeEditor, 'getModel'> & {
  __rivetSpellcheckMarkers?: SpellcheckMarkerSupport;
};

export type SpellcheckWordRange = {
  word: string;
  start: number;
  end: number;
};

export type SpellcheckResult = {
  issueCount: number;
  markerCount: number;
  reachedLimit: boolean;
};

let spellcheckResourcesPromise: Promise<SpellcheckResources> | undefined;

function findPatternRanges(text: string, pattern: RegExp): OffsetRange[] {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function isIgnoredByContext(text: string, range: OffsetRange): boolean {
  const previousChar = range.start > 0 ? text[range.start - 1] ?? '' : '';
  const nextChar = range.end < text.length ? text[range.end] ?? '' : '';
  const beforePreviousChar = range.start > 1 ? text[range.start - 2] ?? '' : '';
  const afterNextChar = range.end + 1 < text.length ? text[range.end + 1] ?? '' : '';

  return (
    TOKEN_BOUNDARY_IGNORE_PATTERN.test(previousChar) ||
    TOKEN_BOUNDARY_IGNORE_PATTERN.test(nextChar) ||
    (previousChar === '.' && TOKEN_BOUNDARY_IGNORE_PATTERN.test(beforePreviousChar)) ||
    (nextChar === '.' && TOKEN_BOUNDARY_IGNORE_PATTERN.test(afterNextChar))
  );
}

function isCodeLikeWord(word: string): boolean {
  return /[$\d]/.test(word) || /^[A-Z]{2,}$/.test(word) || IGNORED_INITIALISMS.has(word.toLowerCase());
}

function isSpellcheckCandidate(
  text: string,
  range: SpellcheckWordRange,
  ignoredRanges: readonly OffsetRange[],
): boolean {
  const letterCount = [...range.word.matchAll(/\p{L}/gu)].length;

  return (
    letterCount > 1 &&
    !isCodeLikeWord(range.word) &&
    !isIgnoredByContext(text, range) &&
    !ignoredRanges.some((ignoredRange) => rangesOverlap(range, ignoredRange))
  );
}

async function loadSpellcheckResources(): Promise<SpellcheckResources> {
  spellcheckResourcesPromise ??= Promise.all([import('nspell'), import('dictionary-en'), import('rivet-cspell-words')])
    .then(([nspellModule, dictionaryModule, cspellWordsModule]) => ({
      spellchecker: nspellModule.default(dictionaryModule.default),
      supplementalWords: new Set([
        ...SUPPLEMENTAL_SPELLCHECK_WORDS,
        ...cspellWordsModule.default.map((word) => word.toLowerCase()),
      ]),
    }))
    .catch((error) => {
      spellcheckResourcesPromise = undefined;
      throw error;
    });

  return spellcheckResourcesPromise;
}

function isCorrectWord(spellchecker: Spellchecker, word: string, supplementalWords: ReadonlySet<string>): boolean {
  return supplementalWords.has(word.toLowerCase()) || spellchecker.correct(word);
}

export function getSpellcheckWordRanges(text: string): SpellcheckWordRange[] {
  const ignoredRanges = [...getActiveInterpolationOffsetRanges(text), ...findPatternRanges(text, URL_OR_EMAIL_PATTERN)];

  return [...text.matchAll(WORD_PATTERN)]
    .map((match) => ({
      word: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((range) => isSpellcheckCandidate(text, range, ignoredRanges));
}

function isLowercaseLetter(value: string): boolean {
  return /\p{Ll}/u.test(value);
}

function isUppercaseLetter(value: string): boolean {
  return /\p{Lu}/u.test(value);
}

function shouldSplitCamelCase(word: string, index: number): boolean {
  const previousChar = word[index - 1] ?? '';
  const currentChar = word[index] ?? '';
  const nextChar = word[index + 1] ?? '';

  return (
    (isLowercaseLetter(previousChar) && isUppercaseLetter(currentChar)) ||
    (isUppercaseLetter(previousChar) && isUppercaseLetter(currentChar) && isLowercaseLetter(nextChar))
  );
}

function splitCamelCaseRange(range: SpellcheckWordRange): SpellcheckWordRange[] {
  const parts: SpellcheckWordRange[] = [];
  let partStart = 0;

  for (let index = 1; index < range.word.length; index += 1) {
    if (!shouldSplitCamelCase(range.word, index)) {
      continue;
    }

    parts.push({
      word: range.word.slice(partStart, index),
      start: range.start + partStart,
      end: range.start + index,
    });
    partStart = index;
  }

  parts.push({
    word: range.word.slice(partStart),
    start: range.start + partStart,
    end: range.end,
  });

  return parts;
}

function splitCompoundWordRange(range: SpellcheckWordRange): SpellcheckWordRange[] {
  return [...range.word.matchAll(WORD_PART_PATTERN)].flatMap((match) =>
    splitCamelCaseRange({
      word: match[0],
      start: range.start + match.index,
      end: range.start + match.index + match[0].length,
    }),
  );
}

function shouldIgnoreWordPart(word: string): boolean {
  const letterCount = [...word.matchAll(/\p{L}/gu)].length;

  return letterCount <= 1 || /^[A-Z]{2,}$/.test(word) || IGNORED_INITIALISMS.has(word.toLowerCase());
}

export function getSpellcheckIssues(
  text: string,
  spellchecker: Spellchecker,
  supplementalWords: ReadonlySet<string> = SUPPLEMENTAL_SPELLCHECK_WORDS,
): SpellcheckWordRange[] {
  return getSpellcheckWordRanges(text).flatMap((range) => {
    if (isCorrectWord(spellchecker, range.word, supplementalWords)) {
      return [];
    }

    return splitCompoundWordRange(range).filter(
      ({ word }) => !shouldIgnoreWordPart(word) && !isCorrectWord(spellchecker, word, supplementalWords),
    );
  });
}

export function getSpellcheckMarkers(
  model: monaco.editor.ITextModel,
  issues: readonly SpellcheckWordRange[],
): monaco.editor.IMarkerData[] {
  return issues.slice(0, SPELLCHECK_MARKER_LIMIT).map(({ word, start, end }) => {
    const startPosition = model.getPositionAt(start);
    const endPosition = model.getPositionAt(end);

    return {
      severity: SPELLCHECK_MARKER_SEVERITY,
      source: 'Rivet spellcheck',
      message: `Possible spelling issue: "${word}"`,
      startLineNumber: startPosition.lineNumber,
      startColumn: startPosition.column,
      endLineNumber: endPosition.lineNumber,
      endColumn: endPosition.column,
    };
  });
}

export function clearCodeEditorSpellcheckMarkers(editor: SpellcheckCapableCodeEditor | undefined): void {
  editor?.__rivetSpellcheckMarkers?.clear();
}

export async function runCodeEditorSpellcheck(editor: SpellcheckCapableCodeEditor): Promise<SpellcheckResult> {
  const model = editor.getModel();

  if (!model) {
    return { issueCount: 0, markerCount: 0, reachedLimit: false };
  }

  clearCodeEditorSpellcheckMarkers(editor);

  const { spellchecker, supplementalWords } = await loadSpellcheckResources();
  const issues: SpellcheckWordRange[] = [];
  let reachedLimit = false;

  for (const range of getSpellcheckIssues(model.getValue(), spellchecker, supplementalWords)) {
    if (issues.length >= SPELLCHECK_MARKER_LIMIT) {
      reachedLimit = true;
      break;
    }

    issues.push(range);
  }

  const markers = getSpellcheckMarkers(model, issues);

  editor.__rivetSpellcheckMarkers?.setMarkers(markers);

  return {
    issueCount: issues.length,
    markerCount: markers.length,
    reachedLimit,
  };
}
