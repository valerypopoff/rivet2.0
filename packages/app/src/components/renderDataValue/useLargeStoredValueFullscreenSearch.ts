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

    const activeHighlightElement = applyHighlightsToTextSegments({
      textSegments: collectHighlightTextSegments(contentElement, { includeLineBreakElements: true }),
      matchRanges: [activeVisibleMatchRange],
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
  }, [activeChunkText, activeVisibleMatchRange, contentRef, highlightMode]);

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
