export const PROVIDER_ATTRIBUTE = 'data-fullscreen-output-search-provider';
export const MATCH_ATTRIBUTE = 'data-fullscreen-output-search-match';
export const MATCH_INDEX_ATTRIBUTE = 'data-match-index';
export const MATCH_CLASS = 'fullscreen-output-search-match';
export const MATCH_ACTIVE_CLASS = 'fullscreen-output-search-match-active';

export type SearchProvider = {
  id: string;
  rootElement: HTMLElement;
  getMatchRanges(query: string): SearchMatchRange[];
  activateMatch(localMatchIndex: number): void;
  clearActiveMatch(): void;
  clearMatches?(): void;
};

export type SearchMatchRange = {
  startOffset: number;
  endOffset: number;
};

export type SearchBlock =
  | {
      kind: 'text';
      textNodes: Text[];
      matches: SearchMatchRange[];
    }
  | {
      kind: 'provider';
      providerId: string;
      matches: SearchMatchRange[];
    };

export type SearchMatch =
  | {
      kind: 'text';
      blockIndex: number;
      localMatchIndex: number;
    }
  | {
      kind: 'provider';
      blockIndex: number;
      providerId: string;
      localMatchIndex: number;
    };

type TextNodeRange = {
  startOffset: number;
  endOffset: number;
  matchIndex: number;
};

type HighlightTextNodeRangeGroup = {
  textNode: Text;
  ranges: TextNodeRange[];
};

export type HighlightTextSegment =
  | {
      kind: 'text';
      textNode: Text;
      text: string;
    }
  | {
      kind: 'virtual';
      text: string;
    };

export function findMatchRanges(text: string, query: string): SearchMatchRange[] {
  const normalizedQuery = query.toLocaleLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const normalizedText = buildNormalizedTextIndex(text);
  const ranges: SearchMatchRange[] = [];

  let searchFromIndex = 0;
  while (searchFromIndex < normalizedText.text.length) {
    const nextMatchIndex = normalizedText.text.indexOf(normalizedQuery, searchFromIndex);
    if (nextMatchIndex === -1) {
      break;
    }

    const nextMatchEndIndex = nextMatchIndex + normalizedQuery.length;
    const startOffset = normalizedText.originalStartOffsets[nextMatchIndex];
    const endOffset = normalizedText.originalEndOffsets[nextMatchEndIndex - 1];

    if (startOffset != null && endOffset != null && endOffset > startOffset) {
      ranges.push({
        startOffset,
        endOffset,
      });
    }

    searchFromIndex = nextMatchEndIndex;
  }

  return ranges;
}

export function wrapMatchIndex(totalMatchCount: number, currentMatchIndex: number, delta: 1 | -1): number {
  if (totalMatchCount <= 0) {
    return 0;
  }

  return (currentMatchIndex + delta + totalMatchCount) % totalMatchCount;
}

export function projectMatches(blocks: readonly SearchBlock[]): SearchMatch[] {
  const matches: SearchMatch[] = [];

  blocks.forEach((block, blockIndex) => {
    block.matches.forEach((_, localMatchIndex) => {
      if (block.kind === 'provider') {
        matches.push({
          kind: 'provider',
          blockIndex,
          providerId: block.providerId,
          localMatchIndex,
        });
        return;
      }

      matches.push({
        kind: 'text',
        blockIndex,
        localMatchIndex,
      });
    });
  });

  return matches;
}

export function buildSearchBlocks(
  rootElement: HTMLElement,
  providersById: ReadonlyMap<string, SearchProvider>,
  query: string,
): SearchBlock[] {
  const blocks: SearchBlock[] = [];
  let pendingTextNodes: Text[] = [];
  let pendingText = '';

  const flushTextBlock = () => {
    if (pendingTextNodes.length === 0) {
      return;
    }

    blocks.push({
      kind: 'text',
      textNodes: pendingTextNodes,
      matches: findMatchRanges(pendingText, query),
    });

    pendingTextNodes = [];
    pendingText = '';
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.length > 0) {
        pendingTextNodes.push(node as Text);
        pendingText += text;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    const providerId = element.getAttribute(PROVIDER_ATTRIBUTE);
    if (providerId) {
      flushTextBlock();

      const provider = providersById.get(providerId);
      if (provider) {
        blocks.push({
          kind: 'provider',
          providerId,
          matches: provider.getMatchRanges(query),
        });
      }

      return;
    }

    const isBoundaryElement = isBoundaryTag(element.tagName);
    if (isBoundaryElement) {
      flushTextBlock();

      if (element.tagName === 'BR') {
        return;
      }
    }

    for (const childNode of Array.from(element.childNodes)) {
      visit(childNode);
    }

    if (isBoundaryElement) {
      flushTextBlock();
    }
  };

  for (const childNode of Array.from(rootElement.childNodes)) {
    visit(childNode);
  }

  flushTextBlock();

  return blocks;
}

export function clearHighlights(rootElement: HTMLElement): void {
  const highlightElements = Array.from(rootElement.querySelectorAll<HTMLElement>(`[${MATCH_ATTRIBUTE}="true"]`));

  for (const highlightElement of highlightElements) {
    const parentNode = highlightElement.parentNode;
    if (!parentNode) {
      continue;
    }

    while (highlightElement.firstChild) {
      parentNode.insertBefore(highlightElement.firstChild, highlightElement);
    }

    parentNode.removeChild(highlightElement);
    parentNode.normalize?.();
  }
}

export function collectTextNodes(rootElement: HTMLElement): Text[] {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);

  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      textNodes.push(currentNode as Text);
    }

    currentNode = walker.nextNode();
  }

  return textNodes;
}

export function collectHighlightTextSegments(
  rootElement: HTMLElement,
  options: { includeLineBreakElements?: boolean } = {},
): HighlightTextSegment[] {
  const textSegments: HighlightTextSegment[] = [];
  const { includeLineBreakElements = false } = options;

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      textSegments.push({
        kind: 'text',
        textNode,
        text: textNode.textContent ?? '',
      });
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node as HTMLElement;
    if (includeLineBreakElements && element.tagName === 'BR') {
      // Rich renderers such as Monaco colorization can represent raw "\n" as
      // <br>, so provider-owned raw-text offsets need this virtual segment.
      textSegments.push({
        kind: 'virtual',
        text: '\n',
      });
      return;
    }

    for (const childNode of Array.from(element.childNodes)) {
      visit(childNode);
    }
  };

  visit(rootElement);

  return textSegments;
}

export function applyHighlights(args: {
  textNodes: readonly Text[];
  matchRanges: readonly SearchMatchRange[];
  matchIndices: readonly number[];
  activeMatchIndex?: number;
  includeMatchIndexAttribute?: boolean;
}): HTMLElement | null {
  const {
    textNodes,
    matchRanges,
    matchIndices,
    activeMatchIndex,
    includeMatchIndexAttribute = true,
  } = args;

  return applyHighlightsToTextSegments({
    textSegments: textNodes.map((textNode) => ({
      kind: 'text' as const,
      textNode,
      text: textNode.textContent ?? '',
    })),
    matchRanges,
    matchIndices,
    activeMatchIndex,
    includeMatchIndexAttribute,
  });
}

export function applyHighlightsToTextSegments(args: {
  textSegments: readonly HighlightTextSegment[];
  matchRanges: readonly SearchMatchRange[];
  matchIndices: readonly number[];
  activeMatchIndex?: number;
  includeMatchIndexAttribute?: boolean;
}): HTMLElement | null {
  const {
    textSegments,
    matchRanges,
    matchIndices,
    activeMatchIndex,
    includeMatchIndexAttribute = true,
  } = args;

  if (matchRanges.length === 0) {
    return null;
  }

  const textNodeRangeGroups = getHighlightTextNodeRangeGroups({
    textSegments,
    matchRanges,
    matchIndices,
  });

  let firstHighlightElement: HTMLElement | null = null;

  for (const { textNode, ranges } of textNodeRangeGroups) {
    const sortedRanges = ranges.sort((left, right) => left.startOffset - right.startOffset);
    const originalText = textNode.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const range of sortedRanges) {
      const highlightStartOffset = Math.max(range.startOffset, cursor);
      if (range.endOffset <= highlightStartOffset) {
        continue;
      }

      if (highlightStartOffset > cursor) {
        fragment.appendChild(document.createTextNode(originalText.slice(cursor, highlightStartOffset)));
      }

      const highlightElement = document.createElement('span');
      highlightElement.setAttribute(MATCH_ATTRIBUTE, 'true');
      if (includeMatchIndexAttribute) {
        highlightElement.setAttribute(MATCH_INDEX_ATTRIBUTE, String(range.matchIndex));
      }
      highlightElement.className =
        activeMatchIndex === range.matchIndex ? `${MATCH_CLASS} ${MATCH_ACTIVE_CLASS}` : MATCH_CLASS;
      highlightElement.textContent = originalText.slice(highlightStartOffset, range.endOffset);
      fragment.appendChild(highlightElement);

      if (!firstHighlightElement) {
        firstHighlightElement = highlightElement;
      }

      cursor = range.endOffset;
    }

    if (cursor < originalText.length) {
      fragment.appendChild(document.createTextNode(originalText.slice(cursor)));
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  }

  return firstHighlightElement;
}

export function getHighlightTextNodeRangeGroups(args: {
  textSegments: readonly HighlightTextSegment[];
  matchRanges: readonly SearchMatchRange[];
  matchIndices: readonly number[];
}): HighlightTextNodeRangeGroup[] {
  const { textSegments, matchRanges, matchIndices } = args;
  const textSegmentPositions = textSegments.map((segment) => ({
    segment,
    startOffset: 0,
    endOffset: 0,
    text: segment.text,
  }));

  let runningOffset = 0;
  textSegmentPositions.forEach((position) => {
    position.startOffset = runningOffset;
    runningOffset += position.text.length;
    position.endOffset = runningOffset;
  });

  const rangesByTextNode = new Map<Text, TextNodeRange[]>();

  matchRanges.forEach((matchRange, localMatchIndex) => {
    const matchIndex = matchIndices[localMatchIndex];
    if (matchIndex == null || matchRange.endOffset <= matchRange.startOffset) {
      return;
    }

    for (const position of textSegmentPositions) {
      if (position.segment.kind === 'virtual') {
        continue;
      }

      const overlapStart = Math.max(matchRange.startOffset, position.startOffset);
      const overlapEnd = Math.min(matchRange.endOffset, position.endOffset);

      if (overlapStart >= overlapEnd) {
        continue;
      }

      const ranges = rangesByTextNode.get(position.segment.textNode) ?? [];
      ranges.push({
        startOffset: overlapStart - position.startOffset,
        endOffset: overlapEnd - position.startOffset,
        matchIndex,
      });
      rangesByTextNode.set(position.segment.textNode, ranges);
    }
  });

  return Array.from(rangesByTextNode, ([textNode, ranges]) => ({
    textNode,
    ranges,
  }));
}

function isBoundaryTag(tagName: string): boolean {
  return tagName === 'BR' || BOUNDARY_TAGS.has(tagName);
}

// DL is included for completeness. If definition-list markdown support is added,
// include DT and DD here as boundaries too.
const BOUNDARY_TAGS = new Set([
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

function buildNormalizedTextIndex(text: string): {
  text: string;
  originalStartOffsets: number[];
  originalEndOffsets: number[];
} {
  const wholeStringNormalizedText = text.toLocaleLowerCase();
  const normalizedParts: string[] = [];
  const originalStartOffsets: number[] = [];
  const originalEndOffsets: number[] = [];

  for (let originalOffset = 0; originalOffset < text.length; ) {
    const codePoint = text.codePointAt(originalOffset);
    const originalCharacter = String.fromCodePoint(codePoint!);
    const originalEndOffset = originalOffset + originalCharacter.length;
    const normalizedCharacter = originalCharacter.toLocaleLowerCase();
    normalizedParts.push(normalizedCharacter);

    for (let normalizedOffset = 0; normalizedOffset < normalizedCharacter.length; normalizedOffset++) {
      originalStartOffsets.push(originalOffset);
      originalEndOffsets.push(originalEndOffset);
    }

    originalOffset = originalEndOffset;
  }

  // Whole-string lowercasing preserves context-sensitive matching, such as Greek
  // final sigma. If a browser ever produces a different length than the
  // per-codepoint offset map, prefer exact offset mapping over context-sensitive
  // matching rather than drifting highlights.
  const normalizedText =
    wholeStringNormalizedText.length === originalStartOffsets.length
      ? wholeStringNormalizedText
      : normalizedParts.join('');

  return {
    text: normalizedText,
    originalStartOffsets,
    originalEndOffsets,
  };
}
