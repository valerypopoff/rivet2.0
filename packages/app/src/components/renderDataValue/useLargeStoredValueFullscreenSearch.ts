import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useFullscreenOutputSearchContext } from '../nodeOutput/FullscreenOutputSearchContext.js';
import {
  applyHighlightsToTextSegments,
  clearHighlights,
  collectHighlightTextSegments,
  findMatchRanges,
  PROVIDER_ATTRIBUTE,
  type SearchMatchRange,
} from '../nodeOutput/fullscreenOutputSearch.js';
import { scheduleFullscreenOutputSearchTargetReveal } from '../nodeOutput/fullscreenOutputSearchViewport.js';
import { getLargeStoredValueChunkIndexForOffset, type LargeStoredValueChunk } from './largeStoredValueChunks.js';

type ActiveSearchMatch = {
  matchRange: SearchMatchRange;
};

export type LargeStoredValueFullscreenSearchResult = {
  providerRootProps?: Record<string, string>;
  clearSearchAutoExpansion: () => void;
  activeMatchRange: SearchMatchRange | null;
};

export function useLargeStoredValueFullscreenSearch(args: {
  providerId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  fullText: string | undefined;
  chunks: readonly LargeStoredValueChunk[];
  activeChunk: LargeStoredValueChunk | undefined;
  activeChunkText: string | undefined;
  shouldPageFullText: boolean;
  showFull: boolean;
  setShowFull: Dispatch<SetStateAction<boolean>>;
  chunkPage: number;
  setChunkPage: Dispatch<SetStateAction<number>>;
  highlightMode?: 'dom' | 'external';
  /**
   * Markdown changes the rendered text-node offsets by removing syntax and
   * adding element boundaries. Search still indexes the stored source text,
   * then maps the active source match onto those rendered text nodes.
   */
  renderMarkdown?: boolean;
}): LargeStoredValueFullscreenSearchResult {
  const {
    providerId,
    rootRef,
    contentRef,
    fullText,
    chunks,
    activeChunk,
    activeChunkText,
    shouldPageFullText,
    showFull,
    setShowFull,
    chunkPage,
    setChunkPage,
    highlightMode = 'dom',
    renderMarkdown = false,
  } = args;

  const fullscreenOutputSearch = useFullscreenOutputSearchContext();
  const [activeSearchMatch, setActiveSearchMatch] = useState<ActiveSearchMatch | null>(null);
  const autoExpandedSearchStateRef = useRef<{ showFull: boolean; chunkPage: number } | null>(null);
  const currentSearchMatchRangesRef = useRef<SearchMatchRange[]>([]);
  const displayStateRef = useRef({
    showFull,
    chunkPage,
  });

  displayStateRef.current = {
    showFull,
    chunkPage,
  };

  useEffect(() => {
    setActiveSearchMatch(null);
    autoExpandedSearchStateRef.current = null;
    currentSearchMatchRangesRef.current = [];
  }, [providerId]);

  useLayoutEffect(() => {
    if (!fullscreenOutputSearch || !rootRef.current) {
      return;
    }

    const restoreAutoExpandedSearchState = () => {
      const restoreState = autoExpandedSearchStateRef.current;
      if (!restoreState) {
        return;
      }

      autoExpandedSearchStateRef.current = null;
      setShowFull(restoreState.showFull);
      setChunkPage(restoreState.chunkPage);
    };

    return fullscreenOutputSearch.registerProvider({
      id: providerId,
      rootElement: rootRef.current,
      getMatchRanges: (query: string) => {
        const matchRanges = fullText ? findMatchRanges(fullText, query) : [];
        currentSearchMatchRangesRef.current = matchRanges;
        return matchRanges;
      },
      activateMatch: (localMatchIndex: number) => {
        const matchRange = currentSearchMatchRangesRef.current[localMatchIndex];
        if (matchRange == null) {
          setActiveSearchMatch(null);
          return;
        }

        const displayState = displayStateRef.current;
        if (!displayState.showFull && !autoExpandedSearchStateRef.current) {
          autoExpandedSearchStateRef.current = {
            showFull: false,
            chunkPage: displayState.chunkPage,
          };
          setShowFull(true);
        }

        if (shouldPageFullText) {
          setChunkPage(getLargeStoredValueChunkIndexForOffset(chunks, matchRange.startOffset));
        } else {
          setChunkPage(0);
        }

        setActiveSearchMatch({
          matchRange,
        });
      },
      clearActiveMatch: () => {
        setActiveSearchMatch(null);
        restoreAutoExpandedSearchState();
      },
      clearMatches: () => {
        currentSearchMatchRangesRef.current = [];
        setActiveSearchMatch(null);
        restoreAutoExpandedSearchState();
      },
    });
  }, [chunks, fullText, fullscreenOutputSearch, providerId, rootRef, setChunkPage, setShowFull, shouldPageFullText]);

  const activeVisibleMatchRange = useMemo((): SearchMatchRange | null => {
    if (!showFull || !activeChunk || !activeChunkText || !activeSearchMatch) {
      return null;
    }

    const localMatchStartOffset = activeSearchMatch.matchRange.startOffset - activeChunk.startOffset;
    const localMatchEndOffset = activeSearchMatch.matchRange.endOffset - activeChunk.startOffset;
    if (
      localMatchEndOffset <= 0 ||
      localMatchStartOffset >= activeChunkText.length ||
      localMatchEndOffset <= localMatchStartOffset
    ) {
      return null;
    }

    return {
      startOffset: Math.max(0, localMatchStartOffset),
      endOffset: Math.min(activeChunkText.length, localMatchEndOffset),
    };
  }, [activeChunk, activeChunkText, activeSearchMatch, showFull]);

  useEffect(() => {
    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    clearHighlights(contentElement);

    if (highlightMode === 'external') {
      return;
    }

    if (!activeChunkText || !activeVisibleMatchRange) {
      return;
    }

    const textSegments = collectHighlightTextSegments(contentElement, { includeLineBreakElements: true });
    const renderedMatchRange = renderMarkdown
      ? mapSourceMatchRangeToRenderedText({
          sourceText: activeChunkText,
          sourceMatchRange: activeVisibleMatchRange,
          renderedText: textSegments.map((segment) => segment.text).join(''),
        })
      : activeVisibleMatchRange;

    if (!renderedMatchRange) {
      return;
    }

    const activeHighlightElement = applyHighlightsToTextSegments({
      textSegments,
      matchRanges: [renderedMatchRange],
      matchIndices: [0],
      activeMatchIndex: 0,
      includeMatchIndexAttribute: false,
    });

    if (!activeHighlightElement) {
      return;
    }

    const cancelReveal = scheduleFullscreenOutputSearchTargetReveal(() => activeHighlightElement);
    return () => {
      cancelReveal();
      clearHighlights(contentElement);
    };
  }, [activeChunkText, activeVisibleMatchRange, contentRef, highlightMode, renderMarkdown]);

  return {
    providerRootProps: fullscreenOutputSearch
      ? {
          [PROVIDER_ATTRIBUTE]: providerId,
        }
      : undefined,
    clearSearchAutoExpansion: () => {
      autoExpandedSearchStateRef.current = null;
    },
    activeMatchRange: activeVisibleMatchRange,
  };
}

/**
 * Maps an active source-text match onto its Markdown-rendered text. The source
 * range remains the authority for provider navigation and large-value paging;
 * only the final DOM highlight needs translated offsets.
 */
export function mapSourceMatchRangeToRenderedText({
  sourceText,
  sourceMatchRange,
  renderedText,
}: {
  sourceText: string;
  sourceMatchRange: SearchMatchRange;
  renderedText: string;
}): SearchMatchRange | null {
  const matchedSourceText = sourceText.slice(sourceMatchRange.startOffset, sourceMatchRange.endOffset);
  if (!matchedSourceText) {
    return null;
  }

  const sourceMatches = findMatchRanges(sourceText, matchedSourceText);
  const sourceMatchIndex = sourceMatches.findIndex(
    (range) => range.startOffset === sourceMatchRange.startOffset && range.endOffset === sourceMatchRange.endOffset,
  );
  const renderedMatches = findMatchRanges(renderedText, matchedSourceText);

  return renderedMatches[sourceMatchIndex] ?? renderedMatches[0] ?? null;
}
