import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import {
  applyHighlights,
  buildSearchBlocks,
  clearHighlights,
  MATCH_ACTIVE_CLASS,
  MATCH_INDEX_ATTRIBUTE,
  projectMatches,
  type SearchMatch,
  type SearchProvider,
  wrapMatchIndex,
} from './fullscreenOutputSearch.js';
import type { NodeRunDataWithRefs } from '../../state/dataFlow.js';
import type { ProcessId } from '@valerypopoff/rivet2-core';

export type FullscreenOutputSearchContentKey = {
  data: NodeRunDataWithRefs | undefined;
  processId: ProcessId | undefined;
  renderMarkdown: boolean;
  selectedPage: number | 'latest';
};

export function useFullscreenOutputSearch(args: { contentKey: FullscreenOutputSearchContentKey }) {
  const { contentKey } = args;

  const [query, setQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [totalMatchCount, setTotalMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fullscreenOutputBodyRef = useRef<HTMLDivElement>(null);
  const providersRef = useRef(new Map<string, SearchProvider>());
  const [providersVersion, setProvidersVersion] = useState(0);
  const totalMatchCountRef = useRef(0);
  const matchesRef = useRef<SearchMatch[]>([]);
  const previousBuildInputsRef = useRef<{
    contentKey: FullscreenOutputSearchContentKey;
    query: string;
    providersVersion: number;
  } | null>(null);

  const focusSearchInput = useStableCallback(() => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  });

  const registerProvider = useStableCallback((provider: SearchProvider) => {
    providersRef.current.set(provider.id, provider);
    setProvidersVersion((currentVersion) => currentVersion + 1);

    return () => {
      providersRef.current.delete(provider.id);
      setProvidersVersion((currentVersion) => currentVersion + 1);
    };
  });

  const goToNextMatch = useStableCallback(() => {
    const totalMatchCount = totalMatchCountRef.current;
    if (totalMatchCount <= 0) {
      return;
    }

    setCurrentMatchIndex((index) => wrapMatchIndex(totalMatchCount, index, 1));
  });

  const goToPreviousMatch = useStableCallback(() => {
    const totalMatchCount = totalMatchCountRef.current;
    if (totalMatchCount <= 0) {
      return;
    }

    setCurrentMatchIndex((index) => wrapMatchIndex(totalMatchCount, index, -1));
  });

  const handleSearchInputKeyDown = useStableCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey) {
        goToPreviousMatch();
      } else {
        goToNextMatch();
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
      searchInputRef.current?.blur();
    }
  });

  const contextValue = useMemo(
    () => ({
      registerProvider,
    }),
    [registerProvider],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !(event.metaKey || event.ctrlKey) || event.shiftKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();

      focusSearchInput();
    };

    // Capture phase plus stopImmediatePropagation is required so fullscreen search
    // wins over both the canvas hotkey layer and the webview/browser find behavior
    // while the modal is open.
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [focusSearchInput]);

  useLayoutEffect(() => {
    const bodyElement = fullscreenOutputBodyRef.current;
    if (!bodyElement) {
      return;
    }

    const previousBuildInputs = previousBuildInputsRef.current;
    const contentChanged = previousBuildInputs?.contentKey !== contentKey;
    const queryChanged = previousBuildInputs?.query !== query;
    const providersChanged = previousBuildInputs?.providersVersion !== providersVersion;
    const shouldRebuild = !previousBuildInputs || contentChanged || queryChanged || providersChanged;

    if (shouldRebuild) {
      previousBuildInputsRef.current = {
        contentKey,
        query,
        providersVersion,
      };

      clearHighlights(bodyElement);

      if (query.length === 0) {
        matchesRef.current = [];
        providersRef.current.forEach(clearProviderMatches);
      } else {
        const blocks = buildSearchBlocks(bodyElement, providersRef.current, query);
        matchesRef.current = projectMatches(blocks);

        let nextGlobalMatchIndex = 0;
        for (const block of blocks) {
          if (block.kind === 'text' && block.matches.length > 0) {
            applyHighlights({
              textNodes: block.textNodes,
              matchRanges: block.matches,
              matchIndices: block.matches.map((_, localMatchIndex) => nextGlobalMatchIndex + localMatchIndex),
            });
          }

          nextGlobalMatchIndex += block.matches.length;
        }
      }

      const rebuiltTotalMatchCount = matchesRef.current.length;
      if (totalMatchCountRef.current !== rebuiltTotalMatchCount) {
        totalMatchCountRef.current = rebuiltTotalMatchCount;
        setTotalMatchCount(rebuiltTotalMatchCount);
      }
    }

    bodyElement.querySelectorAll<HTMLElement>(`.${MATCH_ACTIVE_CLASS}`).forEach((element) => {
      element.classList.remove(MATCH_ACTIVE_CLASS);
    });

    const matches = matchesRef.current;
    if (matches.length === 0) {
      providersRef.current.forEach(clearProviderMatches);
      if (currentMatchIndex !== 0) {
        setCurrentMatchIndex(0);
      }
      return;
    }

    const effectiveCurrentMatchIndex =
      queryChanged || contentChanged || currentMatchIndex >= matches.length || currentMatchIndex < 0
        ? 0
        : currentMatchIndex;

    if (effectiveCurrentMatchIndex !== currentMatchIndex) {
      setCurrentMatchIndex(effectiveCurrentMatchIndex);
    }

    const activeMatch = matches[effectiveCurrentMatchIndex];
    if (activeMatch?.kind === 'provider') {
      providersRef.current.forEach((provider, providerId) => {
        if (providerId === activeMatch.providerId) {
          provider.activateMatch(activeMatch.localMatchIndex);
          return;
        }

        provider.clearActiveMatch();
      });
      return;
    }

    providersRef.current.forEach((provider) => provider.clearActiveMatch());

    const activeHighlightElements = Array.from(
      bodyElement.querySelectorAll<HTMLElement>(`[${MATCH_INDEX_ATTRIBUTE}="${effectiveCurrentMatchIndex}"]`),
    );
    activeHighlightElements.forEach((element) => {
      element.classList.add(MATCH_ACTIVE_CLASS);
    });

    activeHighlightElements[0]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }, [contentKey, currentMatchIndex, providersVersion, query]);

  useEffect(() => {
    const bodyElement = fullscreenOutputBodyRef.current;
    const providers = providersRef.current;

    return () => {
      if (bodyElement) {
        clearHighlights(bodyElement);
      }

      providers.forEach(clearProviderMatches);
    };
  }, [fullscreenOutputBodyRef]);

  return {
    contextValue,
    currentMatchIndex,
    fullscreenOutputBodyRef,
    goToNextMatch,
    goToPreviousMatch,
    handleSearchInputKeyDown,
    query,
    searchInputRef,
    setQuery,
    totalMatchCount,
  };
}

function clearProviderMatches(provider: SearchProvider): void {
  if (provider.clearMatches) {
    provider.clearMatches();
    return;
  }

  provider.clearActiveMatch();
}
