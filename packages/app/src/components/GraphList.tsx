import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { css } from '@emotion/react';
import { type FC, type MouseEvent, type KeyboardEvent, memo, useMemo, useRef, useState, type SVGProps } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';
import clsx from 'clsx';
import { runningGraphsState } from '../state/dataFlow.js';
import { graphState } from '../state/graph.js';
import { openOrFocusGraphSearchState, searchingGraphState } from '../state/graphBuilder.js';
import { pluginsState } from '../state/plugins.js';
import { projectState, savedGraphsState } from '../state/savedGraphs.js';
import {
  expandedFoldersState,
  overlayOpenState,
  showGraphReferenceIndicatorsState,
  showUnreachableGraphTagsState,
} from '../state/ui.js';
import { useContextMenu } from '../hooks/useContextMenu.js';
import Portal from '@atlaskit/portal';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useGraphOperations } from '../hooks/useGraphOperations';
import { useGraphListDragDrop } from '../hooks/useGraphListDragDrop';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry.js';
import { FolderItem } from './graphList/FolderItem';
import { AppModalHeader } from './AppModalHeader';
import EditPenIcon from 'majesticons/line/edit-pen-2-line.svg?react';
import DuplicateIcon from '../assets/icons/duplicate-icon.svg?react';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import InfoIcon from 'majesticons/line/info-circle-line.svg?react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import { MainGraphIcon } from './graphList/MainGraphIcon';
import { GraphInfoModal } from './GraphInfoModal';
import { ProjectInfoModal } from './ProjectInfoModal';
import {
  buildFolderContextMenuItems,
  buildGraphItemContextMenuItems,
  buildGraphListContextMenuItems,
  type GraphListContextMenuIcons,
  type GraphListContextMenuItem,
} from './graphList/graphListContextMenu.js';
import { useGraphListPresentation } from './graphList/useGraphListPresentation.js';
import { setAllGraphFolderExpansionStates } from './graphList/graphFolders.js';
import { GRAPH_FILTER_INPUT_MARKER } from './graphList/graphFilterFocus.js';
import { PopupMenuItem, popupMenuListStyles } from './PopupMenu.js';
import { Tooltip } from './Tooltip.js';
import { activeProjectComparisonState } from '../state/projectComparison.js';

const styles = css`
  --collapsed-open-graph-folder-color: color-mix(in srgb, var(--primary) 28%, transparent);

  display: flex;
  flex-direction: column;
  flex-shrink: 1;
  min-height: 100%;
  padding: 16px 8px 0;
  color: var(--grey-light);

  .graph-list-container {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;

    &:focus {
      outline: none;
    }
  }

  .project-tree-panel-header {
    margin: -16px -8px 9px;
    padding: 16px 18px 25px;
  }

  .project-tree-header {
    display: flex;
    gap: 4px;
    min-width: 0;
    margin: 0 0 18px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    line-height: calc(20px * var(--ui-font-scale));
  }

  .project-tree-header-label {
    flex-shrink: 0;
    font-weight: 700;
    color: var(--grey-lightest);
  }

  .project-tree-header-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-list-toolbar {
    --project-tree-panel-icon-color: var(--grey-light);

    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 0;
  }

  .graph-list-action-tooltip {
    display: flex;
    width: 100%;
  }

  .graph-list-action,
  .graph-list-filter-label {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: calc(20px * var(--ui-font-scale));
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--grey-lightest);
    font-size: var(--ui-font-size-base);
    line-height: calc(20px * var(--ui-font-scale));
    text-align: left;
  }

  .graph-list-action::before,
  .graph-list-filter-label::before {
    content: '';
    position: absolute;
    inset: -7px -10px;
    border-radius: 10px;
    corner-shape: squircle;
    background: transparent;
    pointer-events: none;
    z-index: 0;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
  }

  .graph-list-action > *,
  .graph-list-filter-label > * {
    position: relative;
    z-index: 1;
  }

  .graph-list-action {
    cursor: pointer;
    isolation: isolate;
  }

  .project-tree-panel-icon {
    color: var(--project-tree-panel-icon-color, currentColor);
    flex-shrink: 0;
    height: var(--project-tree-panel-icon-size, 16px);
    transform: translate(var(--project-tree-panel-icon-x, 0), var(--project-tree-panel-icon-y, 0));
    width: var(--project-tree-panel-icon-size, 16px);
  }

  .project-tree-panel-icon-search {
    --project-tree-panel-icon-x: 0;
    --project-tree-panel-icon-y: -0.1em;
  }

  .project-tree-panel-icon-project-settings {
    --project-tree-panel-icon-x: 0;
    --project-tree-panel-icon-y: -0.1em;
  }

  .project-tree-panel-icon-filter {
    --project-tree-panel-icon-x: 0;
    --project-tree-panel-icon-y: 0;
  }

  .project-tree-panel-icon-filter-clear {
    --project-tree-panel-icon-size: 12px;
    --project-tree-panel-icon-x: 0;
    --project-tree-panel-icon-y: 0;
  }

  .graph-list-action:hover,
  .graph-list-filter:hover .graph-list-filter-label,
  .graph-list-filter:focus-within .graph-list-filter-label {
    color: var(--grey-lightest);
  }

  .graph-list-action:hover::before,
  .graph-list-filter:hover .graph-list-filter-label::before,
  .graph-list-filter:focus-within .graph-list-filter-label::before {
    background-color: var(--grey-darkish);
  }

  .graph-list-filter {
    position: relative;
    isolation: isolate;
  }

  .graph-list-filter-label {
    cursor: text;
  }

  .graph-list-filter input {
    flex: 1 1 auto;
    min-width: 0;
    height: calc(20px * var(--ui-font-scale));
    padding: 0 24px 0 0;
    border: 0 !important;
    border-width: 0 !important;
    outline: 0 !important;
    box-shadow: none !important;
    background: transparent !important;
    color: inherit;
    font-size: var(--ui-font-size-base) !important;
    line-height: calc(20px * var(--ui-font-scale));

    &::placeholder {
      color: currentColor;
      opacity: 1;
    }

    &:focus::placeholder {
      opacity: 0;
    }
  }

  .graph-list {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1 1 auto;
    padding: 0 0 12px;
  }

  .graph-list-heading {
    margin: 0 10px 8px;
    color: color-mix(in srgb, var(--grey-light) 64%, transparent);
    font-size: var(--ui-font-size-base);
    font-weight: 400;
    letter-spacing: 0;
    line-height: calc(16px * var(--ui-font-scale));
  }

  .graph-list,
  .folder-children {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
    flex-shrink: 1;
    margin-top: 0;
  }

  .folder-children {
    display: none;

    &.expanded {
      display: flex;
    }
  }

  .folder-children.with-guide-line::before {
    content: '';
    position: absolute;
    top: -4px;
    bottom: 2px;
    left: calc(10px + var(--graph-item-indent, 0px) + 7px);
    width: 1px;
    background: color-mix(in srgb, var(--grey-light) 26%, transparent);
    pointer-events: none;
    z-index: 1;
  }

  .graph-item {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
    user-select: none;
    padding: 0;
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    line-height: calc(18px * var(--ui-font-scale));

    &:hover .graph-item-select {
      background-color: var(--grey-darkish);
    }
  }

  .graph-item-select {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-height: calc(34px * var(--ui-font-scale));
    padding: 8px 10px 8px calc(10px + var(--graph-item-indent, 0px));
    flex: 1;
    min-width: 0;
    border-radius: 10px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
  }

  .dragging .graph-item-select {
    cursor: grabbing;
  }

  .graph-item-name {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .graph-item-name-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-graph-item .graph-item-name-text {
    font-weight: 700;
  }

  .graph-folder-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: currentColor;
  }

  .graph-main-icon {
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    transform: translateY(-1px);
    color: var(--grey-lightish);
  }

  .graph-folder-count {
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 999px;
    corner-shape: squircle;
    background: var(--grey-lightish);
    color: var(--grey-darkest);
    flex-shrink: 0;
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
  }

  .graph-folder-count > span {
    color: inherit;
  }

  .selected .graph-folder-count > span {
    color: inherit;
  }

  .contains-open-graph .graph-item-select {
    background-color: var(--collapsed-open-graph-folder-color);
    color: var(--grey-lightest);
  }

  .contains-open-graph:hover .graph-item-select {
    background-color: color-mix(in srgb, var(--primary) 38%, var(--grey-darkish));
  }

  .graph-reference-dot {
    position: absolute;
    left: -3px;
    top: 50%;
    width: 6px;
    height: 6px;
    transform: translateY(-50%);
    border-radius: 50%;
    background: var(--primary);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);
  }

  .graph-reference-dot.folder-reference-dot {
    background: var(--collapsed-open-graph-folder-color);
    box-shadow: 0 0 0 1px var(--collapsed-open-graph-folder-color);
  }

  .selected {
    background-color: transparent;

    .graph-item-select {
      background-color: var(--primary);
      color: var(--foreground-on-primary);
    }

    .graph-main-icon {
      color: currentColor;
    }

    &:hover .graph-item-select {
      background-color: var(--primary-dark);
    }
  }

  .spinner {
    display: flex;
    align-items: center;
    justify-content: center;
    color: currentColor;
  }

  .spinner .node-running-indicator {
    width: var(--ui-font-size-base);
    height: var(--ui-font-size-base);
    border-width: max(1px, calc(1.5px * var(--ui-font-scale)));
  }

  .selected .spinner {
    color: var(--foreground-on-primary);
  }

  .graph-list-spacer {
    min-height: 90px;
    flex-grow: 1;
  }

  .dragging-over {
    background: var(--grey-darkish);
  }

  .dragging {
    opacity: 0.5;
  }

  .clear {
    position: absolute;
    right: 0;
    top: 50%;
    z-index: 2;
    width: 20px;
    height: 20px;
    transform: translateY(-50%);
    background: var(--grey);
    border: 1px solid var(--grey-dark);
    border-radius: 16px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 8px;
    }
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;

    &:hover {
      background: var(--grey-lightish);
    }

  }

  .graph-list-notice {
    margin: -2px 10px 10px;
    color: color-mix(in srgb, var(--grey-light) 82%, transparent);
    font-size: var(--ui-font-size-xs);
    line-height: 1.4;
  }

  .unreachable-badge {
    margin-right: 6px;
    padding: 4px 6px;
    border: 1px solid color-mix(in srgb, currentColor 42%, transparent);
    border-radius: 40px;
    corner-shape: superellipse(1.15);
    @supports not (corner-shape: squircle) {
      border-radius: 20px;
    }
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: color-mix(in srgb, currentColor 72%, transparent);
    font-size: var(--ui-font-size-2xs);
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .selected .unreachable-badge {
    border-color: color-mix(in srgb, currentColor 42%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: color-mix(in srgb, currentColor 72%, transparent);
  }

  .graph-compare-badge {
    margin-right: 6px;
    padding: 4px 6px;
    border: 1px solid color-mix(in srgb, currentColor 46%, transparent);
    border-radius: 40px;
    corner-shape: superellipse(1.15);
    background: color-mix(in srgb, currentColor 12%, transparent);
    color: currentColor;
    flex-shrink: 0;
    font-size: var(--ui-font-size-2xs);
    font-weight: 700;
    line-height: 1;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .graph-compare-badge.compare-added {
    color: var(--success);
  }

  .graph-compare-badge.compare-changed {
    color: var(--warning);
  }

  .graph-compare-badge.compare-removed {
    color: var(--error);
  }

  .graph-item.compare-removed-graph {
    opacity: 0.68;
  }

  .graph-item.compare-removed-graph .graph-item-select {
    cursor: default;
  }

  .graph-item.compare-removed-graph:hover .graph-item-select {
    background-color: transparent;
  }
`;

const contextMenuStyles = css`
  ${popupMenuListStyles};
  z-index: 1;

  .context-menu-items {
    display: flex;
    flex-direction: column;
  }
`;

const deleteGraphConfirmBody = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

function isInteractiveGraphListTarget(target: EventTarget): boolean {
  return target instanceof Element
    ? target.closest('a, button, input, select, textarea, [contenteditable="true"], [role="textbox"]') != null
    : false;
}

const graphListContextMenuIcons: GraphListContextMenuIcons = {
  collapseAllFolders: CollapseAllFoldersIcon,
  renameGraph: EditPenIcon,
  duplicateGraph: DuplicateIcon,
  expandAllFolders: ExpandAllFoldersIcon,
  graphInfo: InfoIcon,
  makeMainGraph: MainGraphIcon,
  deleteGraph: DeleteIcon,
  newGraph: PlusIcon,
  newFolder: FolderIcon,
  importGraph: PlusIcon,
};

export const GraphList: FC = memo(() => {
  const {
    graph,
    savedGraphs,
    searchText,
    setSearchText,
    renamingItemFullPath,
    folderedGraphs,
    allFolderPaths,
    loadGraph,
    duplicateGraph,
    importGraph,
    handleNew,
    handleNewFolder,
    handleDelete,
    handleDeleteFolder,
    makeMainGraph,
    startRename,
    cancelRename,
    renameFolderItem,
  } = useGraphOperations();
  const setGraph = useSetAtom(graphState);
  const setSavedGraphs = useSetAtom(savedGraphsState);
  const setGraphSearch = useSetAtom(searchingGraphState);
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const setExpandedFolders = useSetAtom(expandedFoldersState);
  const graphListContainerRef = useRef<HTMLDivElement>(null);

  const { draggingItemFolder, dragOverFolderName, handleDragStart, handleDragEnd, handleDragOver } =
    useGraphListDragDrop(renameFolderItem);
  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );

  const runningGraphs = useAtomValue(runningGraphsState);
  const project = useAtomValue(projectState);
  const plugins = useAtomValue(pluginsState);
  const projectNodeRegistry = useProjectNodeRegistry();
  const [graphPendingDelete, setGraphPendingDelete] = useState<NodeGraph | null>(null);
  const [graphPendingInfo, setGraphPendingInfo] = useState<NodeGraph | null>(null);
  const [isProjectInfoOpen, setIsProjectInfoOpen] = useState(false);
  const showUnreachableGraphTags = useAtomValue(showUnreachableGraphTagsState);
  const showGraphReferenceIndicators = useAtomValue(showGraphReferenceIndicatorsState);
  const activeComparison = useAtomValue(activeProjectComparisonState);

  const { setShowContextMenu, showContextMenu, contextMenuData, handleContextMenu, floatingStyles, setFloatingMenu } =
    useContextMenu();
  const handleSidebarContextMenu = useStableCallback((e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    handleContextMenu(e);
  });

  const {
    contextMenu: graphListContextMenu,
    graphCompareKindByGraphId,
    reachability: graphListReachability,
    referencingSelectedGraphIds,
    visible: graphListVisible,
  } = useGraphListPresentation({
    activeComparison,
    allFolderPaths,
    contextMenuData,
    currentGraph: graph,
    currentGraphId: graph.metadata?.id,
    folderedGraphs,
    plugins,
    project,
    projectNodeRegistry,
    savedGraphs,
    searchText,
    showContextMenu,
    showGraphReferenceIndicators,
    showUnreachableGraphTags,
  });

  const handleSearchKeyDown = useStableCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchText('');
      (e.target as HTMLElement).blur();
    }
  });

  const openGraphSearch = useStableCallback(() => {
    setOpenOverlay(undefined);
    setGraphSearch(openOrFocusGraphSearchState);
  });

  const setAllFoldersExpanded = useStableCallback((isExpanded: boolean) => {
    setExpandedFolders((prev) =>
      setAllGraphFolderExpansionStates({
        expandedFolders: prev,
        folderPaths: graphListVisible.folderPaths,
        isExpanded,
        projectId: project.metadata.id,
      }),
    );
  });

  const handleFolderExpansionMenuSelected = useStableCallback((id: string) => {
    if (id === 'collapse-all-folders') {
      setAllFoldersExpanded(false);
      return true;
    }

    if (id === 'expand-all-folders') {
      setAllFoldersExpanded(true);
      return true;
    }

    return false;
  });

  const currentGraphListName = useMemo(() => {
    const currentGraphId = graph.metadata?.id;
    return savedGraphs.find((savedGraph) => savedGraph.metadata?.id === currentGraphId)?.metadata?.name;
  }, [graph.metadata?.id, savedGraphs]);

  const handleGraphListMouseDown = useStableCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }

    if (isInteractiveGraphListTarget(e.target)) {
      return;
    }

    graphListContainerRef.current?.focus({ preventScroll: true });
  });

  const handleGraphListMouseDownCapture = useStableCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      e.preventDefault();
    }
  });

  const handleGraphListKeyDown = useStableCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'F2' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
      return;
    }

    if (isInteractiveGraphListTarget(e.target)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.repeat || showContextMenu || renamingItemFullPath != null || currentGraphListName == null) {
      return;
    }

    setSearchText('');
    startRename(currentGraphListName);
  });

  const confirmDeleteGraph = useStableCallback(() => {
    if (!graphPendingDelete) {
      return;
    }

    handleDelete(graphPendingDelete);
    setGraphPendingDelete(null);
  });

  const updateGraphInfo = useStableCallback((updatedGraph: NodeGraph) => {
    const updatedGraphId = updatedGraph.metadata?.id;

    if (updatedGraphId == null) {
      setGraphPendingInfo(updatedGraph);
      return;
    }

    setGraphPendingInfo(updatedGraph);
    setSavedGraphs((prev) =>
      prev.map((savedGraph) => (savedGraph.metadata?.id === updatedGraphId ? updatedGraph : savedGraph)),
    );

    if (graph.metadata?.id === updatedGraphId) {
      setGraph(updatedGraph);
    }
  });

  const graphItemMenuItems = buildGraphItemContextMenuItems({
    icons: graphListContextMenuIcons,
    isMainGraph: graphListContextMenu.target?.type === 'graph-item' ? graphListContextMenu.target.isMainGraph : false,
  });
  const folderMenuItems = buildFolderContextMenuItems(graphListContextMenuIcons);
  const graphListMenuItems = buildGraphListContextMenuItems({
    hasFolders: graphListVisible.hasFolders,
    icons: graphListContextMenuIcons,
  });

  const handleGraphItemMenuSelected = useStableCallback((id: string) => {
    const target = graphListContextMenu.target;

    if (target?.type !== 'graph-item') {
      setShowContextMenu(false);
      return;
    }

    switch (id) {
      case 'rename-graph':
        startRename(target.folderPath);
        break;
      case 'duplicate-graph':
        duplicateGraph(target.graph);
        break;
      case 'graph-info':
        setGraphPendingInfo(target.graph);
        break;
      case 'make-main-graph':
        makeMainGraph(target.graph);
        break;
      case 'delete-graph':
        setGraphPendingDelete(target.graph);
        break;
      default:
        break;
    }

    setShowContextMenu(false);
  });

  const handleFolderMenuSelected = useStableCallback((id: string) => {
    if (handleFolderExpansionMenuSelected(id)) {
      setShowContextMenu(false);
      return;
    }

    const target = graphListContextMenu.target;

    if (target?.type !== 'graph-folder') {
      setShowContextMenu(false);
      return;
    }

    switch (id) {
      case 'rename-folder':
        startRename(target.folderPath);
        break;
      case 'new-graph-in-folder':
        handleNew(target.folderPath);
        break;
      case 'new-folder-in-folder':
        handleNewFolder(target.folderPath);
        break;
      case 'delete-folder':
        handleDeleteFolder(target.folderPath);
        break;
      default:
        break;
    }

    setShowContextMenu(false);
  });

  const handleGraphListMenuSelected = useStableCallback((id: string) => {
    if (handleFolderExpansionMenuSelected(id)) {
      setShowContextMenu(false);
      return;
    }

    switch (id) {
      case 'new-graph':
        handleNew();
        break;
      case 'new-folder':
        handleNewFolder();
        break;
      case 'import-graph':
        importGraph();
        break;
      default:
        break;
    }

    setShowContextMenu(false);
  });

  return (
    <div css={styles}>
      <div className="project-tree-panel-header">
        <div className="project-tree-header">
          <span className="project-tree-header-label">Project:</span>
          <span className="project-tree-header-title">{project.metadata.title}</span>
        </div>
        <div className="graph-list-toolbar">
          <Tooltip content="Search (Ctrl/Cmd+F)" placement="right" tag="span" className="graph-list-action-tooltip">
            <button type="button" className="graph-list-action" onClick={openGraphSearch}>
              <SearchIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-search" />
              <span>Search</span>
            </button>
          </Tooltip>
          <button type="button" className="graph-list-action" onClick={() => setIsProjectInfoOpen(true)}>
            <SettingsCogIcon
              aria-hidden="true"
              className="project-tree-panel-icon project-tree-panel-icon-project-settings"
            />
            <span>Project settings</span>
          </button>
          <div className="graph-list-filter">
            <label className="graph-list-filter-label">
              <FilterIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-filter" />
              <input
                {...GRAPH_FILTER_INPUT_MARKER}
                aria-label="Filter graphs"
                autoComplete="off"
                spellCheck={false}
                type="text"
                placeholder="Filter graphs"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
            </label>
            {searchText.length > 0 && (
              <button type="button" className="clear" onClick={() => setSearchText('')} aria-label="Clear graph filter">
                <CrossIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-filter-clear" />
              </button>
            )}
          </div>
        </div>
      </div>
      <div
        className="graph-list-container"
        onContextMenu={handleSidebarContextMenu}
        onKeyDown={handleGraphListKeyDown}
        onMouseDown={handleGraphListMouseDown}
        onMouseDownCapture={handleGraphListMouseDownCapture}
        ref={graphListContainerRef}
        tabIndex={-1}
      >
        <div className="graph-list-heading">Graphs</div>
        {graphListReachability.notice && <div className="graph-list-notice">{graphListReachability.notice}</div>}
        <div
          className={clsx('graph-list', { 'dragging-over': dragOverFolderName === '' && draggingItemFolder !== '' })}
          data-contextmenutype="graph-list"
        >
          <DndContext
            sensors={dragSensors}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragStart={handleDragStart}
          >
            {graphListVisible.folderedGraphs.map((item) => (
              <FolderItem
                key={item.type === 'graph' ? item.graph.metadata?.id : item.fullPath}
                item={item}
                runningGraphs={runningGraphs}
                renamingItemFullPath={renamingItemFullPath}
                graph={graph}
                dragOverFolderName={dragOverFolderName}
                draggingItemFolder={draggingItemFolder}
                graphReachabilityByGraphId={graphListReachability.bucketByGraphId}
                graphCompareKindByGraphId={graphCompareKindByGraphId}
                referencingSelectedGraphIds={referencingSelectedGraphIds}
                depth={0}
                onGraphSelected={loadGraph}
                onRenameItem={renameFolderItem}
                onCancelRename={cancelRename}
                showUnreachableBadges={graphListReachability.showUnreachableBadges}
              />
            ))}
            <GraphListSpacer />
          </DndContext>
          <Portal>
            {graphListContextMenu.showGraphItemContextMenu && (
              <div
                className="graph-item-context-menu"
                css={contextMenuStyles}
                style={{ ...floatingStyles, zIndex: 500 }}
                ref={setFloatingMenu}
              >
                <GraphListContextMenuItems items={graphItemMenuItems} onSelected={handleGraphItemMenuSelected} />
              </div>
            )}
            {graphListContextMenu.showFolderContextMenu && (
              <div
                className="graph-item-context-menu"
                css={contextMenuStyles}
                style={{ ...floatingStyles, zIndex: 500 }}
                ref={setFloatingMenu}
              >
                <GraphListContextMenuItems items={folderMenuItems} onSelected={handleFolderMenuSelected} />
              </div>
            )}
          </Portal>
        </div>
        <Portal>
          {graphListContextMenu.showGraphListContextMenu && (
            <div
              className="graph-list-context-menu"
              css={contextMenuStyles}
              style={{ ...floatingStyles, zIndex: 500 }}
              ref={setFloatingMenu}
            >
              <GraphListContextMenuItems items={graphListMenuItems} onSelected={handleGraphListMenuSelected} />
            </div>
          )}
        </Portal>
        <DeleteGraphConfirmModal
          graph={graphPendingDelete}
          onClose={() => setGraphPendingDelete(null)}
          onConfirm={confirmDeleteGraph}
        />
        <GraphInfoModal graph={graphPendingInfo} onChange={updateGraphInfo} onClose={() => setGraphPendingInfo(null)} />
        <ProjectInfoModal isOpen={isProjectInfoOpen} onClose={() => setIsProjectInfoOpen(false)} />
      </div>
    </div>
  );
});

GraphList.displayName = 'GraphList';

const GraphListContextMenuItems: FC<{
  items: GraphListContextMenuItem[];
  onSelected: (id: string) => void;
}> = ({ items, onSelected }) => (
  <div className="context-menu-items">
    {items.map((item, index) => (
      <PopupMenuItem
        key={item.id}
        icon={item.icon}
        separatorBefore={index > 0 && item.separatorBefore === true}
        tone={item.tone}
        onClick={() => onSelected(item.id)}
      >
        {item.label}
      </PopupMenuItem>
    ))}
  </div>
);

const FilterIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" {...props}>
    <path d="M2.5 3.5h11L9.25 8.35v3.4l-2.5.9v-4.3L2.5 3.5Z" fill="currentColor" />
  </svg>
);

function CollapseAllFoldersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M2.5 5.25c0-.69.56-1.25 1.25-1.25h2.4c.35 0 .68.15.91.41l.66.74c.24.27.58.43.94.43h3.59c.69 0 1.25.56 1.25 1.25v5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V5.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path d="M5.45 9.5h5.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
    </svg>
  );
}

function ExpandAllFoldersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M2.5 5.25c0-.69.56-1.25 1.25-1.25h2.4c.35 0 .68.15.91.41l.66.74c.24.27.58.43.94.43h3.59c.69 0 1.25.56 1.25 1.25v5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V5.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.55"
      />
      <path d="M8 7v5M5.5 9.5h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
    </svg>
  );
}

// Allows the bottom of the list to be a drop target
export const GraphListSpacer: FC = memo(() => {
  const { setNodeRef: setDroppableNodeRef } = useDroppable({ id: '/' });
  return <div className="graph-list-spacer" ref={setDroppableNodeRef} />;
});

GraphListSpacer.displayName = 'GraphListSpacer';

const DeleteGraphConfirmModal: FC<{
  graph: NodeGraph | null;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ graph, onClose, onConfirm }) => {
  const graphName = graph?.metadata?.name ?? 'Untitled graph';

  return (
    <ModalTransition>
      {graph && (
        <Modal autoFocus={false} onClose={onClose} width="small">
          <AppModalHeader title="Delete Graph?" onClose={onClose} />
          <ModalBody>
            <div css={deleteGraphConfirmBody}>
              <p>
                Delete <strong>{graphName}</strong>?
              </p>
              <p>This cannot be undone.</p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={onClose}>Cancel</Button>
            <Button appearance="danger" onClick={onConfirm}>
              Delete
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
