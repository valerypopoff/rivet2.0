import { css } from '@emotion/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FC,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
} from 'react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  clearGraphSearchQueryState,
  emptyGraphSearchState,
  goToSearchState,
  hideGraphSearchPanelState,
  searchingGraphState,
  selectedNodesState,
} from '../state/graphBuilder';
import { Tooltip } from './Tooltip';
import { useSearchProject, type FuseResultMatch, type SearchedItem, type RangeTuple } from '../hooks/useSearchProject';
import { projectState } from '../state/savedGraphs';
import clsx from 'clsx';
import { useGoToNode } from '../hooks/useGoToNode';
import { type GraphId, type NodeId } from '@valerypopoff/rivet2-core';
import {
  getGraphSearchStats,
  formatGraphSearchStats,
  groupGraphSearchMatches,
  NODE_LIBRARY_GRAPH_SEARCH_ID,
  type GraphSearchNodeMatch,
  type GraphSearchStats,
} from '../hooks/graphSearch';
import { useLoadGraph } from '../hooks/useLoadGraph';
import { graphState } from '../state/graph';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions';
import { graphSearchPanelHeightState } from '../state/ui';
import { resizeCursorStyles } from '../utils/resizeCursors';
import { getGraphSearchPanelMaxHeight, getNextGraphSearchPanelHeight } from './graphSearch/graphSearchPanelModel';
import { useOpenNodeLibrary } from '../hooks/useOpenNodeLibrary';
import { useOpenUiGraph } from '../hooks/useOpenUiGraph';

const GRAPH_SEARCH_FOCUS_ZOOM = 0.8;
const MIN_GRAPH_SEARCH_PANEL_HEIGHT = 180;
const GRAPH_SEARCH_PANEL_BOTTOM_MARGIN = 16;

const styles = css`
  position: fixed;
  inset: 0;
  z-index: 50;
  pointer-events: none;

  button {
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    border-radius: var(--ui-button-radius);
    corner-shape: squircle;
    background: transparent;
    padding: 8px;
    width: 32px;
    height: 32px;
    justify-content: center;
    box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);

    &:hover {
      background-color: rgba(255, 255, 255, 0.2);
    }

    svg {
      width: 16px;
      height: 16px;
    }
  }

  .search {
    background: var(--grey-darker);
    border: 1px solid var(--grey-darkish);
    border-radius: 12px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 6px;
    }
    box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    left: 50%;
    max-height: calc(
      100vh - var(--project-selector-height) - var(--data-bus-full-row-height, 0px) - var(
          --run-activity-drawer-reserved-height,
          0px
        ) - 36px
    );
    max-width: calc(100vw - 32px);
    min-width: 360px;
    overflow: hidden;
    position: fixed;
    pointer-events: auto;
    top: calc(var(--project-selector-height) + var(--data-bus-full-row-height, 0px) + 20px);
    transform: translateX(-50%);
    width: 30vw;

    @media (max-width: 720px) {
      max-height: calc(100vh - var(--project-selector-height) - var(--data-bus-full-row-height, 0px) - 36px);
    }

    .search-controls {
      align-items: center;
      display: flex;
      flex-shrink: 0;
      gap: 4px;
      padding: 6px;
    }

    input {
      background: var(--grey-darkish);
      border: none;
      border-radius: var(--ui-button-radius-sm);
      corner-shape: squircle;
      padding: 4px 8px;
      color: var(--grey-lightest);
      width: 200px;
      flex: 1;
      height: 32px;
      font-size: var(--ui-font-size-base);
      font-family: var(--font-family);
      font-weight: 500;
      outline: none;
      box-shadow: none;

      &:focus {
        background: var(--grey);
        outline: none;
      }
    }

    .stopSearching {
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: none;
      color: var(--foreground);

      width: 32px;
      height: 32px;

      &:hover {
        background: var(--form-control-bg-hover);
        color: var(--foreground-bright);
      }

      svg {
        width: 24px;
        height: 24px;
      }
    }

    .stop-searching-tooltip {
      display: flex;
    }

    .search-results {
      border-top: 1px solid var(--grey-darkish);
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 0 12px;
    }

    .search-results-fallback-note {
      color: var(--grey-light);
      font-size: var(--ui-font-size-sm);
      font-weight: 500;
      padding: 2px 12px 8px;
    }

    .search-results-summary {
      color: var(--grey-lighter);
      font-size: var(--ui-font-size-sm);
      font-weight: 600;
      padding: 2px 12px 8px;
    }

    .search-resize-handle {
      bottom: 0;
      cursor: var(--resize-edge-vertical-cursor);
      height: 8px;
      left: 0;
      position: absolute;
      width: 100%;
    }

    .search-result-group + .search-result-group {
      margin-top: 8px;
    }

    .search-result-group-title {
      color: var(--grey-light);
      font-size: var(--ui-font-size-base);
      font-weight: 500;
      padding: 6px 12px 4px;
    }

    .search-result-group-title-button {
      align-items: flex-start;
      box-shadow: none;
      color: inherit;
      display: block;
      font: inherit;
      height: auto;
      justify-content: flex-start;
      padding: 0;
      text-align: left;
      width: auto;

      &:hover {
        background: transparent;
        color: var(--grey-lightest);
      }
    }

    .search-result-group-title-tooltip {
      display: inline-flex;
      max-width: 100%;
    }

    .search-result-graph-label {
      font-weight: 300;
    }

    .search-result-graph-name {
      font-weight: 700;
    }

    .search-result-row {
      align-items: flex-start;
      background: var(--node-body-bg);
      border-radius: 12px;
      corner-shape: squircle;
      @supports not (corner-shape: squircle) {
        border-radius: 6px;
      }
      box-shadow: none;
      color: var(--grey-lightest);
      display: flex;
      flex-direction: column;
      font-family: var(--font-family);
      font-size: var(--ui-font-size-compact);
      gap: 4px;
      height: auto;
      justify-content: flex-start;
      line-height: 1.3;
      margin: 8px 8px;
      min-width: 0;
      outline: 1px solid transparent;
      outline-offset: -1px;
      overflow: hidden;
      padding: 0;
      text-align: left;
      width: calc(100% - 16px);

      &:hover,
      &:focus-visible {
        outline-color: var(--primary);
      }
    }

    .search-result-row-header {
      align-items: flex-start;
      background: var(--node-color-0);
      display: flex;
      gap: 8px;
      padding: 7px 12px;
      width: 100%;
    }

    .search-result-node-title {
      color: var(--node-color-0-foreground);
      flex: 1;
      min-width: 0;
    }

    .search-result-node-type {
      color: var(--node-color-0-foreground);
      flex: 0 1 auto;
      font-size: var(--ui-font-size-xs);
      font-weight: 600;
      max-width: 45%;
      opacity: 0.5;
      overflow: hidden;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .search-result-content-snippets {
      background: var(--node-body-bg);
      border-radius: 0 0 12px 12px;
      corner-shape: squircle;
      @supports not (corner-shape: squircle) {
        border-radius: 0 0 6px 6px;
      }
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 12px 9px;
      width: 100%;
    }

    .search-result-content-snippet {
      color: var(--foreground);
      display: block;
      font-size: var(--ui-font-size-sm);
      line-height: 1.35;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .search-result-content-snippet * {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
  }

  .go-to {
    pointer-events: auto;
    position: fixed;
    top: 100px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;

    input {
      background: var(--grey-dark);
      border: none;
      border-radius: var(--ui-button-radius-sm);
      corner-shape: squircle;
      padding: 18px 18px;
      color: var(--grey-lightest);
      width: 200px;
      height: 32px;
      font-size: var(--ui-font-size-base);
      font-family: var(--font-family);
      font-weight: 500;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      width: 500px;
    }

    .entries {
      border-radius: var(--ui-button-radius-sm);
      corner-shape: squircle;
      box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
      max-height: 300px;
      overflow-y: auto;
      width: 500px;

      .entry {
        cursor: pointer;

        .search-result-item {
          padding: 8px;
          border-radius: 8px;
          corner-shape: squircle;
          @supports not (corner-shape: squircle) {
            border-radius: 4px;
          }
          background: var(--grey-darkerish);

          .title {
            font-weight: 500;
            font-size: var(--ui-font-size-lg);
            margin-bottom: 4px;
            display: inline;
          }

          .graph {
            font-size: var(--ui-font-size-sm);
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .description {
            font-size: var(--ui-font-size-base);
            color: var(--grey-light);
            margin-bottom: 4px;
            display: inline;
            margin-left: 8px;
          }

          .data {
            font-size: var(--ui-font-size-sm);
            color: var(--grey-light);
            display: inline;
            margin-left: 16px;
          }

          &.selected {
            background: var(--grey-darkish);
          }
        }
      }
    }
  }

  .highlighted {
    background: var(--highlighted-text);
    color: var(--highlighted-text-contrast);
  }
`;

export const NavigationBar: FC = () => {
  const [searching, setSearching] = useAtom(searchingGraphState);
  const [graphSearchPanelHeight, setGraphSearchPanelHeight] = useAtom(graphSearchPanelHeightState);
  const goToNode = useGoToNode();
  const setSelectedNodes = useSetAtom(selectedNodesState);
  const openNodeLibrary = useOpenNodeLibrary();
  const loadGraph = useLoadGraph();
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const graphSearchInputRef = useRef<HTMLInputElement>(null);
  const graphSearchPanelRef = useRef<HTMLDivElement>(null);
  const graphSearchResultsRef = useRef<HTMLDivElement>(null);
  const graphSearchResultsScrollTopRef = useRef(searching.resultsScrollTop);

  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);

  const graphSearchHasQuery = searching.query.trim().length > 0;
  const graphSearchGroups = useMemo(() => groupGraphSearchMatches(searching.matches), [searching.matches]);
  const graphSearchStats = useMemo(() => getGraphSearchStats(searching.matches), [searching.matches]);
  const graphSearchHasResults = graphSearchHasQuery && graphSearchGroups.length > 0;

  const hideGraphSearchPanel = useCallback(() => {
    const resultsScrollTop = graphSearchResultsRef.current?.scrollTop;
    setSearching((state) =>
      hideGraphSearchPanelState(resultsScrollTop == null ? state : { ...state, resultsScrollTop }),
    );
  }, [setSearching]);

  useEffect(() => {
    if (!searching.searching || !searching.panelOpen) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      graphSearchInputRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [searching.focusRequestId, searching.panelOpen, searching.searching]);

  useEffect(() => {
    graphSearchResultsScrollTopRef.current = searching.resultsScrollTop;
  }, [searching.resultsScrollTop]);

  useEffect(() => {
    if (!searching.searching || !searching.panelOpen || !graphSearchHasResults) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (graphSearchResultsRef.current) {
        graphSearchResultsRef.current.scrollTop = graphSearchResultsScrollTopRef.current;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [graphSearchHasResults, searching.focusRequestId, searching.panelOpen, searching.query, searching.searching]);

  useEffect(() => {
    if (!searching.searching || !searching.panelOpen) {
      return;
    }

    const handleWindowPointerDown = (event: PointerEvent) => {
      if (graphSearchPanelRef.current?.contains(event.target as Node)) {
        return;
      }

      hideGraphSearchPanel();
    };

    window.addEventListener('pointerdown', handleWindowPointerDown, true);

    return () => {
      window.removeEventListener('pointerdown', handleWindowPointerDown, true);
    };
  }, [hideGraphSearchPanel, searching.panelOpen, searching.searching]);

  function closeGraphSearch() {
    setSearching(emptyGraphSearchState);
  }

  function updateGraphSearchQuery(query: string) {
    if (query.trim().length === 0) {
      setSearching(clearGraphSearchQueryState);
      return;
    }

    setSearching((state) => ({
      ...state,
      query,
      selectedIndex: 0,
      searching: true,
      panelOpen: true,
      resultsScrollTop: 0,
    }));
  }

  function updateGraphSearchResultsScroll(e: UIEvent<HTMLDivElement>) {
    const resultsScrollTop = e.currentTarget.scrollTop;
    graphSearchResultsScrollTopRef.current = resultsScrollTop;
    setSearching((state) => (state.resultsScrollTop === resultsScrollTop ? state : { ...state, resultsScrollTop }));
  }

  function startGraphSearchPanelResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();

    const panel = e.currentTarget.closest('.search');
    const panelRect = panel?.getBoundingClientRect();
    const startY = e.clientY;
    const startHeight = panelRect?.height ?? graphSearchPanelHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const maxHeight = getGraphSearchPanelMaxHeight({
      bottomMargin: GRAPH_SEARCH_PANEL_BOTTOM_MARGIN,
      minHeight: MIN_GRAPH_SEARCH_PANEL_HEIGHT,
      panelTop: panelRect?.top ?? 0,
      viewportHeight: window.innerHeight,
    });
    document.body.style.cursor = resizeCursorStyles.vertical;
    document.body.style.userSelect = 'none';

    const resize = (event: PointerEvent) => {
      const nextHeight = getNextGraphSearchPanelHeight({
        maxHeight,
        minHeight: MIN_GRAPH_SEARCH_PANEL_HEIGHT,
        pointerY: event.clientY,
        startHeight,
        startY,
      });
      setGraphSearchPanelHeight(nextHeight);
    };

    const stopResize = () => {
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize, { once: true });
    window.addEventListener('pointercancel', stopResize, { once: true });
  }

  function selectGraphSearchMatch(match: GraphSearchNodeMatch, selectedIndex: number) {
    if (match.graphId === NODE_LIBRARY_GRAPH_SEARCH_ID) {
      setSearching((state) => ({ ...state, selectedIndex }));
      openNodeLibrary({ selectedNodeIds: [match.nodeId] });
      return;
    }

    const panelBottom = Math.min(
      window.innerHeight,
      Math.max(0, graphSearchPanelRef.current?.getBoundingClientRect().bottom ?? 0),
    );
    const viewportCenter = {
      x: window.innerWidth / 2,
      y: panelBottom + (window.innerHeight - panelBottom) / 2,
    };

    setSearching((state) => ({ ...state, selectedIndex }));
    goToNode(match.nodeId, { graphId: match.graphId, zoom: GRAPH_SEARCH_FOCUS_ZOOM, viewportCenter });
    setSelectedNodes([match.nodeId]);
  }

  function selectGraphSearchGroup(graphId: GraphId) {
    if (graphId === NODE_LIBRARY_GRAPH_SEARCH_ID) {
      openNodeLibrary();
      return;
    }

    const graph = graphId === currentGraph.metadata?.id ? currentGraph : project.graphs[graphId];

    if (graph) {
      loadGraph(graph, { graphView: createRootGraphViewContext(graphId) });
    }
  }

  function handleGoToKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      setGoToSearch({ searching: false, query: '', selectedIndex: 0, entries: [] });
    }

    if (e.key === 'ArrowDown') {
      setGoToSearch((state) => {
        const newIndex = state.selectedIndex + 1 >= state.entries.length ? 0 : state.selectedIndex + 1;

        return {
          ...state,
          selectedIndex: newIndex,
        };
      });
    }

    if (e.key === 'ArrowUp') {
      setGoToSearch((state) => {
        const newIndex = state.selectedIndex - 1 < 0 ? state.entries.length - 1 : state.selectedIndex - 1;

        return {
          ...state,
          selectedIndex: newIndex,
        };
      });
    }
  }

  return (
    <div css={styles}>
      {searching.searching && searching.panelOpen && (
        <div
          ref={graphSearchPanelRef}
          className={clsx('search', { 'has-results': graphSearchHasResults })}
          style={graphSearchHasResults ? { maxHeight: graphSearchPanelHeight } : undefined}
        >
          <div className="search-controls">
            <input
              ref={graphSearchInputRef}
              type="text"
              placeholder="Search..."
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={searching.query}
              onChange={(e) => updateGraphSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  hideGraphSearchPanel();
                }
              }}
            />
            <Tooltip content="Close graph search" placement="bottom" tag="span" className="stop-searching-tooltip">
              <button className="stopSearching" onClick={closeGraphSearch}>
                <CrossIcon />
              </button>
            </Tooltip>
          </div>
          {graphSearchHasResults && (
            <GraphSearchResults
              groups={graphSearchGroups}
              fallbackToTerms={searching.fallbackToTerms}
              query={searching.query}
              resultsRef={graphSearchResultsRef}
              stats={graphSearchStats}
              onSelectGraph={selectGraphSearchGroup}
              onSelect={selectGraphSearchMatch}
              onScroll={updateGraphSearchResultsScroll}
            />
          )}
          {graphSearchHasResults && (
            <div className="search-resize-handle" onPointerDown={startGraphSearchPanelResize} />
          )}
        </div>
      )}

      {goToSearch.searching && (
        <div className="go-to">
          <div className="go-to-search">
            <input
              type="text"
              placeholder="Go to..."
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={goToSearch.query}
              onChange={(e) =>
                setGoToSearch((search) => ({
                  searching: true,
                  query: e.target.value,
                  selectedIndex: 0,
                  entries: search.entries,
                }))
              }
              onKeyDown={handleGoToKeyDown}
            />
          </div>
          <GoToSearchResults />
        </div>
      )}
    </div>
  );
};

const GoToSearchResults: FC = () => {
  const [goToSearch, setGoToSearch] = useAtom(goToSearchState);

  const results = useSearchProject(goToSearch.query, goToSearch.searching);

  useEffect(() => {
    setGoToSearch((search) => ({
      ...search,
      entries: results,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((result) => getSearchResultKey(result)).join(','), setGoToSearch]);

  return (
    <div className="entries">
      {goToSearch.entries.map((entry, index) => (
        <div key={getSearchResultKey(entry)} className="entry">
          <SearchResultItem entry={entry} selected={index === goToSearch.selectedIndex} searchText={goToSearch.query} />
        </div>
      ))}
    </div>
  );
};

const GraphSearchResults: FC<{
  groups: ReturnType<typeof groupGraphSearchMatches>;
  fallbackToTerms: boolean;
  query: string;
  resultsRef: RefObject<HTMLDivElement>;
  stats: GraphSearchStats;
  onSelectGraph: (graphId: GraphId) => void;
  onSelect: (match: GraphSearchNodeMatch, selectedIndex: number) => void;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
}> = ({ groups, fallbackToTerms, query, resultsRef, stats, onSelectGraph, onSelect, onScroll }) => {
  if (groups.length === 0) {
    return null;
  }

  return (
    <div ref={resultsRef} className="search-results" onScroll={onScroll}>
      <div className="search-results-summary">{formatGraphSearchStats(stats)}</div>
      {fallbackToTerms && (
        <div className="search-results-fallback-note">
          No exact match found. Showing results that match separate words.
        </div>
      )}
      {groups.map((group) => (
        <div className="search-result-group" key={group.key}>
          <div className="search-result-group-title">
            <Tooltip content="Open graph" placement="right" tag="span" className="search-result-group-title-tooltip">
              <button className="search-result-group-title-button" onClick={() => onSelectGraph(group.graphId)}>
                <span className="search-result-graph-label">
                  {group.graphId === NODE_LIBRARY_GRAPH_SEARCH_ID ? 'Library ' : 'Graph '}
                </span>
                <HighlightedText
                  className="search-result-graph-name"
                  text={group.graphName}
                  searchText={query}
                  contextAmount={60}
                  splitSearchWords={fallbackToTerms}
                />
              </button>
            </Tooltip>
          </div>
          {group.matches.map(({ match, index }) => (
            <button
              className="search-result-row"
              key={`${match.graphId}:${match.nodeId}:${index}`}
              onClick={() => onSelect(match, index)}
            >
              <span className="search-result-row-header">
                <HighlightedText
                  className="search-result-node-title"
                  text={match.nodeTitle}
                  searchText={query}
                  contextAmount={60}
                  splitSearchWords={fallbackToTerms}
                />
                <span className="search-result-node-type">{match.nodeType}</span>
              </span>
              {match.contentSnippets.length > 0 && (
                <span className="search-result-content-snippets">
                  {match.contentSnippets.map((snippet, snippetIndex) => (
                    <HighlightedText
                      className="search-result-content-snippet"
                      contextAmount={160}
                      key={`${match.graphId}:${match.nodeId}:${snippetIndex}`}
                      searchText={query}
                      splitSearchWords={fallbackToTerms}
                      text={snippet}
                    />
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};

const SearchResultItem: FC<{
  entry: SearchedItem;
  searchText: string;
  selected: boolean;
}> = ({ entry, selected, searchText }) => {
  const project = useAtomValue(projectState);
  const openNodeLibrary = useOpenNodeLibrary();
  const openUiGraph = useOpenUiGraph();

  const goToNode = useGoToNode();
  const entryItem = entry.item;
  const entryItemType = entryItem.type;
  const entryItemId = entryItem.id;
  const entryContainerGraph = entryItem.type === 'uiGraph' ? undefined : entryItem.containerGraph;
  const entryUiGraphId = entryItem.type === 'uiGraph' ? entryItem.uiGraphId : undefined;

  useEffect(() => {
    if (selected) {
      // Scroll into view
      const element = document.querySelector('.search-result-item.selected');
      element?.scrollIntoView({ block: 'nearest' });

      if (entryItemType === 'uiGraph') {
        if (entryUiGraphId) {
          openUiGraph(entryUiGraphId);
        }
        return;
      }

      if (entryContainerGraph === NODE_LIBRARY_GRAPH_SEARCH_ID) {
        openNodeLibrary({ selectedNodeIds: [entryItemId as NodeId] });
        return;
      }

      goToNode(entryItemId as NodeId);
    }
  }, [
    selected,
    entryItemType,
    entryItemId,
    entryContainerGraph,
    entryUiGraphId,
    goToNode,
    openNodeLibrary,
    openUiGraph,
  ]);

  const containerName =
    entryItemType === 'uiGraph'
      ? 'Web Apps'
      : entryContainerGraph === NODE_LIBRARY_GRAPH_SEARCH_ID
        ? 'Node library'
        : entryContainerGraph
          ? project.graphs[entryContainerGraph]?.metadata?.name ?? 'Unknown Graph'
          : 'Unknown Graph';

  return (
    <div className={clsx('search-result-item', { selected })}>
      <div className="title">
        <HighlightedText text={entryItem.title} searchText={searchText} />
      </div>
      <div className="graph">in {containerName}</div>
      <div className="description">
        <HighlightedText text={entryItem.description} searchText={searchText} />
      </div>
      <div className="data">
        <HighlightedText text={entryItem.joinedData} searchText={searchText} />
      </div>
    </div>
  );
};

function getSearchResultKey(entry: SearchedItem): string {
  return `${entry.item.type}:${entry.item.id}`;
}

interface HighlightedTextProps {
  text: string;
  searchText: string;
  className?: string;
  highlightClassName?: string;
  contextAmount?: number;
  splitSearchWords?: boolean;
}

interface Range {
  start: number;
  end: number;
}

const HighlightedText: FC<HighlightedTextProps> = ({
  text,
  searchText,
  className = '',
  highlightClassName = 'highlighted',
  contextAmount = 100,
  splitSearchWords = true,
}) => {
  if (!searchText.trim() || !text) {
    return <span className={className}>{text}</span>;
  }

  const searchWords = splitSearchWords
    ? searchText
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 0)
    : [searchText.toLowerCase().trim()].filter((word) => word.length > 0);

  if (searchWords.length === 0) {
    return <span className={className}>{text}</span>;
  }

  // Find all matching ranges
  const ranges: Range[] = [];

  searchWords.forEach((word) => {
    const textLower = text.toLowerCase();
    let startIndex = 0;

    while (startIndex < text.length) {
      const matchIndex = textLower.indexOf(word, startIndex);
      if (matchIndex === -1) break;

      ranges.push({
        start: matchIndex,
        end: matchIndex + word.length,
      });
      startIndex = matchIndex + 1;
    }
  });

  if (ranges.length === 0) {
    return <span className={className}>{text.substring(0, contextAmount)}</span>;
  }

  // Sort ranges by start position
  const sortedRanges = ranges.sort((a, b) => a.start - b.start);

  // Merge overlapping ranges
  const mergedRanges = sortedRanges.reduce<Range[]>((acc, curr) => {
    if (acc.length === 0) return [curr];

    const prev = acc[acc.length - 1]!;

    if (curr.start <= prev.end) {
      // Ranges overlap, merge them
      acc[acc.length - 1] = {
        start: prev.start,
        end: Math.max(prev.end, curr.end),
      };
    } else {
      // Ranges don't overlap, add new range
      acc.push(curr);
    }
    return acc;
  }, []);

  // Calculate the visible text range with context
  const firstMatch = mergedRanges[0]!;
  const lastMatch = mergedRanges[mergedRanges.length - 1];

  if (!firstMatch || !lastMatch) {
    return <span className={className}>{text}</span>;
  }

  const visibleStart = Math.max(0, firstMatch.start - contextAmount);
  const visibleEnd = Math.min(text.length, lastMatch.end + contextAmount);

  // Adjust ranges to be relative to the trimmed text
  const adjustedRanges = mergedRanges.map((range) => ({
    start: range.start - visibleStart,
    end: range.end - visibleStart,
  }));

  const trimmedText = text.slice(visibleStart, visibleEnd);
  const showStartEllipsis = visibleStart > 0;
  const showEndEllipsis = visibleEnd < text.length;

  // Build the highlighted text segments
  const segments: JSX.Element[] = [];
  let lastIndex = 0;

  if (showStartEllipsis) {
    segments.push(<span key="start-ellipsis">...</span>);
  }

  adjustedRanges.forEach((range, idx) => {
    if (range.start > lastIndex) {
      segments.push(<span key={`text-${idx}`}>{trimmedText.substring(lastIndex, range.start)}</span>);
    }

    segments.push(
      <span key={`highlight-${idx}`} className={highlightClassName}>
        {trimmedText.substring(range.start, range.end)}
      </span>,
    );

    lastIndex = range.end;
  });

  if (lastIndex < trimmedText.length) {
    segments.push(<span key={`text-${adjustedRanges.length}`}>{trimmedText.substring(lastIndex)}</span>);
  }

  if (showEndEllipsis) {
    segments.push(<span key="end-ellipsis">...</span>);
  }

  return <span className={className}>{segments}</span>;
};
