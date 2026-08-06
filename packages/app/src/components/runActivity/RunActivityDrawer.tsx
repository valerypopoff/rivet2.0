import Portal from '@atlaskit/portal';
import Select from '@atlaskit/select';
import { css } from '@emotion/react';
import clsx from 'clsx';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import FilterIcon from 'majesticons/line/filter-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import {
  type ChangeEvent,
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SegmentedEditor } from '../editors/SegmentedEditor.js';
import { CollapsiblePanel } from '../CollapsiblePanel.js';
import { Tooltip } from '../Tooltip.js';
import { formatRunActivityDuration } from '../../utils/runActivityDuration.js';
import {
  DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
  clampRunActivityColumnWidth,
  getRunActivityColumnWidthBounds,
  normalizeRunActivityColumnWidths,
  type RunActivityColumnWidthKey,
  type RunActivityColumnWidths,
} from '../../features/runActivity/runActivityColumnWidths.js';
import type {
  RunActivityDrawerProps,
  RunActivityFilter,
  RunActivityItemStatus,
  RunActivityItemViewModel,
  RunActivityStatus,
  RunActivityViewModel,
} from './types.js';
import { filterRunActivityItems } from './filterRunActivityItems.js';

export const DEFAULT_RUN_ACTIVITY_DRAWER_HEIGHT = 360;
export const MIN_RUN_ACTIVITY_DRAWER_HEIGHT = 220;
export const MAX_RUN_ACTIVITY_DRAWER_VIEWPORT_RATIO = 0.72;
const NARROW_VIEWPORT_QUERY = '(max-width: 720px)';
const RESIZE_KEYBOARD_STEP = 24;
const COLUMN_RESIZE_KEYBOARD_STEP = 16;

type GraphFilterOption = { label: string; value: string };

type ColumnResizeState = {
  key: RunActivityColumnWidthKey;
  startX: number;
  startWidth: number;
  previousBodyCursor: string;
};

type PointerFocusedHeaderControl = 'graph-filter' | 'search' | undefined;

const drawerStyles = css`
  --run-activity-control-height: var(--form-control-select-height);

  position: fixed;
  z-index: 90;
  right: 0;
  bottom: 0;
  left: var(--data-bus-full-row-left, 0px);
  display: flex;
  flex-direction: column;
  container-name: run-activity-drawer;
  container-type: inline-size;
  min-height: ${MIN_RUN_ACTIVITY_DRAWER_HEIGHT}px;
  overflow: visible;
  color: var(--foreground);
  background: var(--app-panel-bg);
  border-top: 1px solid var(--app-panel-border);
  backdrop-filter: blur(2px);

  .run-activity-resize-handle {
    position: absolute;
    z-index: 2;
    top: -5px;
    right: 0;
    left: 0;
    height: 11px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: var(--resize-edge-vertical-cursor, ns-resize);
    touch-action: none;
  }

  .run-activity-resize-handle::after {
    position: absolute;
    top: 5px;
    right: 0;
    left: 0;
    height: 2px;
    background: var(--primary);
    content: '';
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .run-activity-resize-handle:hover::after,
  .run-activity-resize-handle.is-resizing::after,
  .run-activity-resize-handle:focus-visible::after {
    opacity: 0.65;
  }

  .run-activity-resize-handle:focus-visible {
    outline: 1px solid var(--primary);
    outline-offset: -2px;
  }

  .run-activity-header {
    display: flex;
    flex: none;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    min-height: 48px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--app-strip-divider-color);
    background: var(--app-strip-bg);
  }

  .run-activity-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: none;
  }

  .run-activity-heading h2 {
    margin: 0;
    color: var(--foreground);
    font-size: var(--ui-font-size-lg);
    line-height: 1.2;
  }

  .run-activity-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    white-space: nowrap;
  }

  .run-activity-status::before {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--foreground-dim);
    content: '';
  }

  .run-activity-status.status-running::before,
  .run-activity-status.status-outputs-ready::before {
    background: var(--primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--primary) 48%, transparent);
  }

  .run-activity-status.status-completed::before {
    background: var(--success);
  }

  .run-activity-status.status-failed::before,
  .run-activity-status.status-aborted::before {
    background: var(--error);
  }

  .run-activity-header-actions,
  .run-activity-row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .run-activity-header-actions {
    flex: none;
    margin-left: auto;
  }

  .run-activity-follow {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    cursor: pointer;
    user-select: none;
  }

  .run-activity-follow input {
    margin: 0;
  }

  .run-activity-icon-button,
  .run-activity-action-button,
  .run-activity-new-items {
    border: 1px solid transparent;
    border-radius: var(--ui-button-radius-sm, 6px);
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
  }

  .run-activity-icon-button {
    display: grid;
    width: 32px;
    height: 32px;
    padding: 0;
    place-items: center;
  }

  .run-activity-icon-button svg {
    width: 18px;
    height: 18px;
  }

  .run-activity-icon-button:hover,
  .run-activity-action-button:hover,
  .run-activity-new-items:hover {
    background: var(--form-control-bg-hover);
  }

  .run-activity-icon-button:focus-visible,
  .run-activity-action-button:focus-visible,
  .run-activity-child-action:focus-visible,
  .run-activity-new-items:focus-visible,
  .run-activity-row-toggle:focus-visible,
  .run-activity-column-resize-handle:focus-visible {
    outline: 1px solid var(--primary);
    outline-offset: 1px;
  }

  .run-activity-filter-row {
    display: flex;
    flex: none;
    align-items: center;
    min-height: 48px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--app-strip-divider-color);
    background: var(--app-panel-bg);
    min-width: 0;
    gap: 8px;
  }

  .run-activity-filter-button.is-active {
    border-color: color-mix(in srgb, var(--primary) 52%, var(--form-control-border));
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    color: var(--primary-light);
  }

  .run-activity-filters {
    flex: none;
    min-width: 0;
  }

  .run-activity-filters .segmented-choice {
    min-height: var(--run-activity-control-height);
    margin-left: 0;
  }

  .run-activity-graph-filter {
    width: min(220px, 22vw);
    min-width: 160px;
    flex: none;
  }

  .run-activity-search {
    position: relative;
    width: clamp(220px, 20vw, 360px);
    min-width: 180px;
    flex: 1 1 220px;
  }

  .run-activity-search svg {
    position: absolute;
    top: 50%;
    left: 10px;
    z-index: 1;
    width: 16px;
    height: 16px;
    color: var(--foreground-dim);
    pointer-events: none;
    transform: translateY(-50%);
  }

  .run-activity-search input {
    box-sizing: border-box;
    width: 100%;
    height: var(--run-activity-control-height);
    padding: 0 10px 0 33px;
    border-color: var(--form-control-border);
    border-radius: var(--ui-button-radius-sm, 6px);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-search.is-pointer-focused input:focus {
    border-color: var(--form-control-border) !important;
    background-color: var(--form-control-bg) !important;
    outline: none !important;
    box-shadow: none !important;
  }

  .run-activity-graph-filter.is-pointer-focused [class*='-control']:has(input:focus) {
    border-color: var(--form-control-border) !important;
    background-color: var(--form-control-bg) !important;
    box-shadow: none !important;
  }

  .run-activity-summary {
    flex: none;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    white-space: nowrap;
  }

  .run-activity-notice {
    flex: none;
    margin: 10px 16px 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--warning) 44%, var(--app-panel-border));
    border-radius: 7px;
    background: color-mix(in srgb, var(--warning) 7%, var(--modal-surface-bg));
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
  }

  .run-activity-list-wrap {
    position: relative;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }

  .run-activity-list {
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0 16px 20px;
  }

  .run-activity-column-header,
  .run-activity-row-toggle {
    display: grid;
    grid-template-columns:
      12px
      minmax(150px, var(--run-activity-column-node-name))
      minmax(130px, var(--run-activity-column-graph-name))
      minmax(120px, var(--run-activity-column-node-type))
      minmax(180px, 1fr)
      84px
      72px
      24px;
    gap: 10px;
  }

  .run-activity-column-header {
    position: sticky;
    z-index: 2;
    top: 0;
    min-height: 32px;
    align-items: stretch;
    padding: 10px 11px 5px;
    background: var(--app-panel-bg);
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-compact);
    font-weight: 700;
    line-height: 1.2;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .run-activity-column-header-cell {
    position: relative;
    display: flex;
    min-width: 0;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-activity-column-header-cell.align-end {
    justify-content: flex-end;
  }

  .run-activity-column-resize-handle {
    position: absolute;
    z-index: 3;
    top: -4px;
    right: -8px;
    bottom: -4px;
    width: 16px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
  }

  .run-activity-column-resize-handle::after {
    position: absolute;
    top: 7px;
    bottom: 7px;
    left: 7px;
    width: 1px;
    border-radius: 1px;
    background: transparent;
    content: '';
    transition: background-color 0.12s ease-out;
  }

  .run-activity-column-header-cell:hover .run-activity-column-resize-handle::after,
  .run-activity-column-resize-handle:hover::after,
  .run-activity-column-resize-handle:focus-visible::after {
    background: var(--primary);
  }

  .run-activity-empty {
    display: grid;
    min-height: 130px;
    color: var(--foreground-dim);
    text-align: center;
    place-items: center;
  }

  .run-activity-new-items {
    position: absolute;
    right: 20px;
    bottom: 16px;
    z-index: 2;
    padding: 7px 11px;
    border-color: var(--form-control-border);
    background: var(--modal-surface-bg);
    box-shadow: 0 3px 12px rgb(0 0 0 / 35%);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-row {
    --collapsible-panel-padding-x: 0px;
    content-visibility: auto;
    contain-intrinsic-size: auto 66px;
  }

  .run-activity-row + .run-activity-row {
    margin-top: 8px;
  }

  .run-activity-row.status-error > .Collapsible > .collapsible-panel-toggle-container,
  .run-activity-row.status-interrupted > .Collapsible > .collapsible-panel-toggle-container,
  .run-activity-row.status-error > .Collapsible > .collapsible-panel-toggle-container.open + .Collapsible__contentOuter,
  .run-activity-row.status-interrupted
    > .Collapsible
    > .collapsible-panel-toggle-container.open
    + .Collapsible__contentOuter {
    border-color: color-mix(in srgb, var(--error) 58%, var(--app-panel-border));
  }

  .run-activity-row.status-running > .Collapsible > .collapsible-panel-toggle-container,
  .run-activity-row.status-running
    > .Collapsible
    > .collapsible-panel-toggle-container.open
    + .Collapsible__contentOuter {
    border-color: color-mix(in srgb, var(--primary) 48%, var(--app-panel-border));
  }

  .run-activity-row.status-waiting > .Collapsible > .collapsible-panel-toggle-container,
  .run-activity-row.status-waiting
    > .Collapsible
    > .collapsible-panel-toggle-container.open
    + .Collapsible__contentOuter {
    border-color: color-mix(in srgb, var(--warning) 46%, var(--app-panel-border));
  }

  .run-activity-row-toggle {
    display: grid;
    align-items: center;
    justify-content: initial;
    width: 100%;
    min-height: 50px;
    padding: 8px 11px;
    margin: 0;
    text-align: left;
  }

  .run-activity-row-toggle > .label {
    display: contents;
  }

  .run-activity-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--foreground-dim);
  }

  .run-activity-status-dot.status-success {
    background: var(--success);
  }

  .run-activity-status-dot.status-running {
    background: var(--primary);
  }

  .run-activity-status-dot.status-waiting {
    background: var(--warning);
  }

  .run-activity-status-dot.status-error,
  .run-activity-status-dot.status-interrupted {
    background: var(--error);
  }

  .run-activity-status-dot.status-not-ran,
  .run-activity-status-dot.status-unknown {
    border: 1px solid var(--foreground-dim);
    background: transparent;
  }

  .run-activity-identity,
  .run-activity-graph-name,
  .run-activity-node-type,
  .run-activity-preview {
    min-width: 0;
  }

  .run-activity-node-title {
    overflow: hidden;
    color: var(--foreground);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-activity-node-meta,
  .run-activity-graph-name,
  .run-activity-node-type,
  .run-activity-preview,
  .run-activity-started-at,
  .run-activity-duration,
  .run-activity-detail-label,
  .run-activity-child-secondary {
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-graph-name,
  .run-activity-node-type,
  .run-activity-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-activity-preview.error {
    color: var(--error-light);
  }

  .run-activity-started-at,
  .run-activity-duration {
    min-width: 0;
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-activity-node-meta {
    display: none;
  }

  .run-activity-row-toggle > .indicator {
    display: grid;
    place-items: center;
  }

  .run-activity-row-toggle > .indicator svg {
    width: 18px;
    height: 18px;
  }

  .run-activity-row-detail {
    padding: 4px 14px 14px 31px;
  }

  .run-activity-detail-message {
    margin: 10px 0;
    color: var(--foreground);
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .run-activity-detail-message.error {
    color: var(--error-light);
  }

  .run-activity-detail-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 8px;
    margin: 10px 0;
  }

  .run-activity-detail-list > div {
    min-width: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--form-control-bg);
  }

  .run-activity-detail-value {
    margin-top: 3px;
    overflow-wrap: anywhere;
  }

  .run-activity-children {
    margin: 10px 0;
    padding: 0;
    list-style: none;
  }

  .run-activity-child {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) max-content max-content;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    border-top: 1px solid var(--app-panel-border);
  }

  .run-activity-row-actions {
    justify-content: flex-end;
    margin-top: 10px;
  }

  .run-activity-action-button {
    min-height: 30px;
    padding: 0 10px;
    border-color: var(--form-control-border);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-child-action {
    grid-column: 4;
    min-height: 26px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--primary);
    font-size: var(--ui-font-size-sm);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .run-activity-child-action:hover {
    color: var(--primary-light);
  }

  @container run-activity-drawer (max-width: 1100px) {
    .run-activity-summary {
      display: none;
    }
  }

  @container run-activity-drawer (max-width: 1180px) {
    .run-activity-row-toggle {
      grid-template-columns:
        12px
        minmax(150px, var(--run-activity-column-node-name))
        minmax(130px, var(--run-activity-column-graph-name))
        minmax(180px, 1fr)
        84px
        72px
        24px;
    }

    .run-activity-column-header {
      grid-template-columns:
        12px
        minmax(150px, var(--run-activity-column-node-name))
        minmax(130px, var(--run-activity-column-graph-name))
        minmax(180px, 1fr)
        84px
        72px
        24px;
    }

    .run-activity-node-type,
    .run-activity-column-header-cell.node-type,
    .run-activity-column-resize-handle.node-type {
      display: none;
    }
  }

  @container run-activity-drawer (max-width: 900px) {
    .run-activity-row-toggle,
    .run-activity-column-header {
      grid-template-columns:
        12px
        minmax(150px, 1fr)
        minmax(130px, var(--run-activity-column-graph-name))
        84px
        72px
        24px;
    }

    .run-activity-preview,
    .run-activity-column-header-cell.preview {
      display: none;
    }

    .run-activity-filter-row {
      flex-wrap: wrap;
    }

    .run-activity-search {
      min-width: min(100%, 260px);
    }
  }

  @media (max-width: 720px) {
    z-index: 10010;
    top: var(--project-selector-height, 0px);
    left: 0;
    height: auto !important;
    min-height: 0;
    border-top: 0;
    overflow: hidden;
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 55%);

    .run-activity-resize-handle {
      display: none;
    }

    .run-activity-header {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 8px;
      min-height: 54px;
    }

    .run-activity-heading {
      display: grid;
      gap: 3px;
    }

    .run-activity-status {
      white-space: normal;
    }

    .run-activity-header-actions {
      width: auto;
      margin-left: auto;
    }

    .run-activity-follow span {
      display: none;
    }

    .run-activity-filter-row {
      display: grid;
      width: 100%;
      grid-template-columns: 1fr;
    }

    .run-activity-filters {
      width: 100%;
    }

    .run-activity-filters .segmented-editor-control,
    .run-activity-filters .segmented-choice {
      width: 100%;
    }

    .run-activity-filters .segmented-choice-option {
      flex: 1 1 0;
    }

    .run-activity-graph-filter,
    .run-activity-search {
      width: 100%;
    }

    .run-activity-summary {
      display: none;
    }

    .run-activity-column-header {
      display: none;
    }

    .run-activity-row-toggle {
      grid-template-columns: 10px minmax(0, 1fr) 22px;
    }

    .run-activity-graph-name,
    .run-activity-started-at,
    .run-activity-duration,
    .run-activity-column-resize-handle {
      display: none;
    }

    .run-activity-node-meta {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .run-activity-row-detail {
      padding-left: 14px;
    }

    .run-activity-row-actions {
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }
`;

const FILTERS: ReadonlyArray<{ value: RunActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'llm-tools', label: 'LLM and tools' },
  { value: 'errors', label: 'Errors' },
];

export const RunActivityDrawer: FC<RunActivityDrawerProps> = ({
  open,
  viewModel,
  onClose,
  onLocate,
  onOpenFullOutput,
  onOpenToolResult,
  onInspectResponse,
  onCopyDiagnostics,
  height = DEFAULT_RUN_ACTIVITY_DRAWER_HEIGHT,
  onHeightChange,
  columnWidths,
  onColumnWidthsChange,
  renderExpandedContent,
  className,
}) => {
  const [filter, setFilter] = useState<RunActivityFilter>('all');
  const [graphFilter, setGraphFilter] = useState('');
  const [query, setQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [graphMenuPortalTarget, setGraphMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const [uncontrolledColumnWidths, setUncontrolledColumnWidths] = useState<RunActivityColumnWidths>(
    DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS,
  );
  const [followLive, setFollowLive] = useState(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [displayHeight, setDisplayHeight] = useState(() => clampRunActivityDrawerHeight(height));
  const [isDrawerResizing, setIsDrawerResizing] = useState(false);
  const [pointerFocusedHeaderControl, setPointerFocusedHeaderControl] = useState<PointerFocusedHeaderControl>();
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const previousItemCountRef = useRef(viewModel.items.length);
  const previousRootRunIdRef = useRef(viewModel.rootRunId);
  const resizeStateRef = useRef<{ startY: number; startHeight: number }>();
  const drawerResizeCleanupRef = useRef<(() => void) | undefined>();
  const columnResizeCleanupRef = useRef<(() => void) | undefined>();
  const currentColumnWidthsRef = useRef<RunActivityColumnWidths>(DEFAULT_RUN_ACTIVITY_COLUMN_WIDTHS);
  const onColumnWidthsChangeRef = useRef(onColumnWidthsChange);
  const isColumnWidthsControlledRef = useRef(columnWidths !== undefined);
  const onCloseRef = useRef(onClose);
  const isNarrowViewport = useNarrowViewport();

  const effectiveColumnWidths = useMemo(
    () => normalizeRunActivityColumnWidths(columnWidths ?? uncontrolledColumnWidths),
    [columnWidths, uncontrolledColumnWidths],
  );

  currentColumnWidthsRef.current = effectiveColumnWidths;
  onColumnWidthsChangeRef.current = onColumnWidthsChange;
  isColumnWidthsControlledRef.current = columnWidths !== undefined;
  onCloseRef.current = onClose;

  const graphOptions = useMemo(() => {
    if (viewModel.graphOptions) return viewModel.graphOptions;
    const graphNames = new Map<string, string>();
    for (const item of viewModel.items) graphNames.set(item.graphId, item.graphName);
    return [...graphNames].map(([graphId, graphName]) => ({ graphId, graphName }));
  }, [viewModel.graphOptions, viewModel.items]);

  const graphFilterOptions = useMemo<GraphFilterOption[]>(
    () => [
      { label: 'All graphs', value: '' },
      ...graphOptions.map(({ graphId, graphName }) => ({ label: graphName, value: graphId })),
    ],
    [graphOptions],
  );

  const selectedGraphFilterOption = useMemo(
    () => graphFilterOptions.find((option) => option.value === graphFilter) ?? graphFilterOptions[0],
    [graphFilter, graphFilterOptions],
  );

  const filteredItems = useMemo(
    () => filterRunActivityItems(viewModel.items, { filter, graphId: graphFilter, query }),
    [filter, graphFilter, query, viewModel.items],
  );

  useEffect(() => {
    const clampedHeight = clampRunActivityDrawerHeight(height);
    setDisplayHeight(clampedHeight);
    if (!isNarrowViewport && clampedHeight !== height) onHeightChange?.(clampedHeight);
  }, [height, isNarrowViewport, onHeightChange]);

  useEffect(() => {
    if (graphFilter && !graphOptions.some((option) => option.graphId === graphFilter)) setGraphFilter('');
  }, [graphFilter, graphOptions]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !hasAnotherOpenModal(drawerRef.current)) {
        onCloseRef.current();
      }
      if (!isNarrowViewport || event.key !== 'Tab' || drawerRef.current == null) return;
      trapFocus(drawerRef.current, event);
    };
    window.addEventListener('keydown', handleKeyDown);
    if (isNarrowViewport) {
      previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
      closeButtonRef.current?.focus();
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (isNarrowViewport) previouslyFocusedElementRef.current?.focus();
    };
  }, [isNarrowViewport, open]);

  useEffect(() => {
    if (previousRootRunIdRef.current === viewModel.rootRunId) return;
    previousRootRunIdRef.current = viewModel.rootRunId;
    previousItemCountRef.current = viewModel.items.length;
    setExpandedKeys(new Set());
    setNewActivityCount(0);
    setIsNearBottom(true);
  }, [viewModel.items.length, viewModel.rootRunId]);

  useEffect(() => {
    const previousCount = previousItemCountRef.current;
    const nextCount = viewModel.items.length;
    previousItemCountRef.current = nextCount;
    if (!open || nextCount <= previousCount) return;

    const added = nextCount - previousCount;
    if (followLive && isNearBottom) {
      const frame = window.requestAnimationFrame(() => scrollActivityListToBottom(listRef.current));
      return () => window.cancelAnimationFrame(frame);
    }
    setNewActivityCount((current) => current + added);
  }, [followLive, isNearBottom, open, viewModel.items.length]);

  useEffect(() => {
    if (followLive && isNearBottom) setNewActivityCount(0);
  }, [followLive, isNearBottom]);

  useEffect(() => {
    if (!open || !followLive) return;
    const frame = window.requestAnimationFrame(() => scrollActivityListToBottom(listRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [followLive, open]);

  const commitHeight = useCallback(
    (nextHeight: number) => {
      const clamped = clampRunActivityDrawerHeight(nextHeight);
      setDisplayHeight(clamped);
      onHeightChange?.(clamped);
    },
    [onHeightChange],
  );

  useEffect(() => {
    const handleViewportResize = () => {
      if (window.matchMedia(NARROW_VIEWPORT_QUERY).matches) return;
      const nextHeight = clampRunActivityDrawerHeight(displayHeight);
      if (nextHeight !== displayHeight) commitHeight(nextHeight);
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, [commitHeight, displayHeight]);

  const handleResizePointerMove = useCallback(
    (event: PointerEvent) => {
      const resize = resizeStateRef.current;
      if (!resize) return;
      commitHeight(resize.startHeight + resize.startY - event.clientY);
    },
    [commitHeight],
  );

  const stopDrawerResize = useCallback(() => {
    drawerResizeCleanupRef.current?.();
    drawerResizeCleanupRef.current = undefined;
  }, []);

  useEffect(() => stopDrawerResize, [stopDrawerResize]);

  const commitColumnWidth = useCallback((key: RunActivityColumnWidthKey, value: number) => {
    const current = currentColumnWidthsRef.current;
    const nextWidth = clampRunActivityColumnWidth(key, value);
    if (current[key] === nextWidth) return;

    const next = { ...current, [key]: nextWidth };
    currentColumnWidthsRef.current = next;
    if (!isColumnWidthsControlledRef.current) setUncontrolledColumnWidths(next);
    onColumnWidthsChangeRef.current?.(next);
  }, []);

  const stopColumnResize = useCallback(() => {
    columnResizeCleanupRef.current?.();
    columnResizeCleanupRef.current = undefined;
  }, []);

  useEffect(() => stopColumnResize, [stopColumnResize]);

  useEffect(() => {
    if (!open || isNarrowViewport) {
      stopDrawerResize();
      stopColumnResize();
    }
  }, [isNarrowViewport, open, stopColumnResize, stopDrawerResize]);

  const markHeaderControlPointerFocused = (control: Exclude<PointerFocusedHeaderControl, undefined>) => {
    setPointerFocusedHeaderControl(control);
  };

  const clearHeaderControlPointerFocus = (control: Exclude<PointerFocusedHeaderControl, undefined>) => {
    setPointerFocusedHeaderControl((current) => (current === control ? undefined : current));
  };

  const handleColumnResizePointerDown = (
    key: RunActivityColumnWidthKey,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    stopColumnResize();

    const start: ColumnResizeState = {
      key,
      startX: event.clientX,
      startWidth: currentColumnWidthsRef.current[key],
      previousBodyCursor: document.body.style.cursor,
    };
    document.body.style.cursor = 'col-resize';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      commitColumnWidth(start.key, start.startWidth + moveEvent.clientX - start.startX);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('blur', cleanup);
      document.body.style.cursor = start.previousBodyCursor;
      if (columnResizeCleanupRef.current === cleanup) columnResizeCleanupRef.current = undefined;
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
    window.addEventListener('blur', cleanup, { once: true });
    columnResizeCleanupRef.current = cleanup;
  };

  const handleColumnResizeKeyDown = (key: RunActivityColumnWidthKey, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const { minWidth, maxWidth } = getRunActivityColumnWidthBounds(key);
    const current = currentColumnWidthsRef.current[key];
    const step = event.shiftKey ? COLUMN_RESIZE_KEYBOARD_STEP * 3 : COLUMN_RESIZE_KEYBOARD_STEP;
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = current - step;
    if (event.key === 'ArrowRight') next = current + step;
    if (event.key === 'Home') next = minWidth;
    if (event.key === 'End') next = maxWidth;
    if (next == null) return;
    event.preventDefault();
    commitColumnWidth(key, next);
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    stopDrawerResize();
    setIsDrawerResizing(true);
    resizeStateRef.current = { startY: event.clientY, startHeight: displayHeight };
    window.addEventListener('pointermove', handleResizePointerMove);
    const cleanup = () => {
      resizeStateRef.current = undefined;
      setIsDrawerResizing(false);
      window.removeEventListener('pointermove', handleResizePointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('blur', cleanup);
      if (drawerResizeCleanupRef.current === cleanup) drawerResizeCleanupRef.current = undefined;
    };
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
    window.addEventListener('blur', cleanup, { once: true });
    drawerResizeCleanupRef.current = cleanup;
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextHeight: number | undefined;
    if (event.key === 'ArrowUp') nextHeight = displayHeight + RESIZE_KEYBOARD_STEP;
    if (event.key === 'ArrowDown') nextHeight = displayHeight - RESIZE_KEYBOARD_STEP;
    if (event.key === 'Home') nextHeight = MIN_RUN_ACTIVITY_DRAWER_HEIGHT;
    if (event.key === 'End') nextHeight = Number.POSITIVE_INFINITY;
    if (nextHeight == null) return;
    event.preventDefault();
    commitHeight(nextHeight);
  };

  const handleListScroll = () => {
    const nearBottom = isActivityListNearBottom(listRef.current);
    setIsNearBottom(nearBottom);
    if (nearBottom) setNewActivityCount(0);
  };

  const handleFollowChange = (event: ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setFollowLive(checked);
    if (checked) {
      setIsNearBottom(true);
      setNewActivityCount(0);
      window.requestAnimationFrame(() => scrollActivityListToBottom(listRef.current));
    }
  };

  const revealNewActivities = () => {
    setFollowLive(true);
    setIsNearBottom(true);
    setNewActivityCount(0);
    scrollActivityListToBottom(listRef.current);
  };

  const toggleExpanded = (activityKey: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(activityKey)) next.delete(activityKey);
      else next.add(activityKey);
      return next;
    });
  };

  if (!open) return null;

  const rootStatus = describeRootStatus(viewModel.status, viewModel.backgroundWorkPending);
  const itemSummary = `${filteredItems.length} of ${viewModel.items.length} ${viewModel.items.length === 1 ? 'activity' : 'activities'}`;
  const hasActiveFilters = filter !== 'all' || graphFilter !== '' || query.trim() !== '';
  const drawerInlineStyle: CSSProperties & Record<`--run-activity-column-${string}`, string> = {
    height: displayHeight,
    '--run-activity-column-node-name': `${effectiveColumnWidths.nodeName}px`,
    '--run-activity-column-graph-name': `${effectiveColumnWidths.graphName}px`,
    '--run-activity-column-node-type': `${effectiveColumnWidths.nodeType}px`,
  };

  return (
    <aside
      ref={drawerRef}
      css={drawerStyles}
      className={clsx('run-activity-drawer', className)}
      aria-label="Run Activity"
      aria-modal={isNarrowViewport || undefined}
      role={isNarrowViewport ? 'dialog' : 'complementary'}
      style={drawerInlineStyle}
    >
      <button
        type="button"
        aria-label="Resize Run Activity"
        aria-orientation="horizontal"
        aria-valuemax={getMaximumRunActivityDrawerHeight()}
        aria-valuemin={MIN_RUN_ACTIVITY_DRAWER_HEIGHT}
        aria-valuenow={displayHeight}
        className={clsx('run-activity-resize-handle', { 'is-resizing': isDrawerResizing })}
        role="separator"
        tabIndex={isNarrowViewport ? -1 : 0}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      />
      <header className="run-activity-header">
        <div className="run-activity-heading">
          <h2>Run Activity</h2>
          <span className={`run-activity-status status-${viewModel.status}`}>
            {rootStatus}
            {viewModel.durationMs == null ? '' : ` / ${formatRunActivityDuration(viewModel.durationMs)}`}
          </span>
          {viewModel.accounting && (
            <span className="run-activity-summary">{formatAccounting(viewModel.accounting)}</span>
          )}
        </div>
        <div className="run-activity-header-actions">
          <Tooltip content={filtersOpen ? 'Hide filters' : 'Show filters'} tag="span">
            <button
              type="button"
              className={clsx('run-activity-icon-button', 'run-activity-filter-button', {
                'is-active': hasActiveFilters,
              })}
              aria-label={filtersOpen ? 'Hide Run Activity filters' : 'Show Run Activity filters'}
              aria-controls="run-activity-filter-row"
              aria-expanded={filtersOpen}
              title={isNarrowViewport ? (filtersOpen ? 'Hide filters' : 'Show filters') : undefined}
              onClick={() => setFiltersOpen((current) => !current)}
            >
              <FilterIcon aria-hidden="true" />
            </button>
          </Tooltip>
          <label className="run-activity-follow">
            <input type="checkbox" checked={followLive} onChange={handleFollowChange} />
            <span>Follow live</span>
          </label>
          {onCopyDiagnostics && (
            <Tooltip content="Copy diagnostics" tag="span">
              <button
                type="button"
                className="run-activity-icon-button"
                aria-label="Copy diagnostics"
                title={isNarrowViewport ? 'Copy diagnostics' : undefined}
                onClick={onCopyDiagnostics}
              >
                <CopyIcon aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="run-activity-icon-button"
            aria-label="Close Run Activity"
            title="Close"
            onClick={onClose}
          >
            <CrossIcon aria-hidden="true" />
          </button>
        </div>
      </header>
      {filtersOpen && (
        <div id="run-activity-filter-row" className="run-activity-filter-row">
          <div className="run-activity-filters">
            <SegmentedEditor
              label=""
              ariaLabel="Activity type"
              value={filter}
              options={FILTERS}
              isDisabled={false}
              isReadonly={false}
              allowOptionWrap={false}
              onChange={(value) => setFilter(value as RunActivityFilter)}
            />
          </div>
          {graphOptions.length > 1 && (
            <div
              className={clsx('run-activity-graph-filter', {
                'is-pointer-focused': pointerFocusedHeaderControl === 'graph-filter',
              })}
              onBlur={() => clearHeaderControlPointerFocus('graph-filter')}
              onKeyDownCapture={() => clearHeaderControlPointerFocus('graph-filter')}
              onPointerDown={(event) => {
                if (event.button === 0 && event.isPrimary) markHeaderControlPointerFocused('graph-filter');
              }}
            >
              <Select
                instanceId="run-activity-graph-filter"
                classNamePrefix="run-activity-graph-select"
                aria-label="Filter by graph"
                options={graphFilterOptions}
                value={selectedGraphFilterOption}
                isSearchable={false}
                menuPlacement="auto"
                menuPosition={isNarrowViewport ? 'absolute' : 'fixed'}
                menuPortalTarget={isNarrowViewport ? undefined : graphMenuPortalTarget ?? undefined}
                onChange={(selected) => setGraphFilter(selected?.value ?? '')}
              />
              {!isNarrowViewport && (
                <Portal zIndex={1000}>
                  <div ref={setGraphMenuPortalTarget} />
                </Portal>
              )}
            </div>
          )}
          <label
            className={clsx('run-activity-search', {
              'is-pointer-focused': pointerFocusedHeaderControl === 'search',
            })}
            onBlur={() => clearHeaderControlPointerFocus('search')}
            onKeyDownCapture={() => clearHeaderControlPointerFocus('search')}
            onPointerDown={(event) => {
              if (event.button === 0 && event.isPrimary) markHeaderControlPointerFocused('search');
            }}
          >
            <SearchIcon aria-hidden="true" />
            <input
              type="search"
              aria-label="Search Run Activity by node title or metadata"
              placeholder="Search node titles, graphs, tools, or models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="run-activity-summary" aria-live="polite">
            {itemSummary}
          </span>
        </div>
      )}
      {viewModel.partialReason && (
        <div className="run-activity-notice">Partial activity: {viewModel.partialReason}</div>
      )}
      {viewModel.omittedItemCount != null && viewModel.omittedItemCount > 0 && (
        <div className="run-activity-notice">
          {viewModel.omittedItemCount} older activities are omitted by the in-memory activity limit.
        </div>
      )}
      <div className="run-activity-list-wrap">
        <div ref={listRef} className="run-activity-list" onScroll={handleListScroll}>
          {filteredItems.length === 0 ? (
            <div className="run-activity-empty">
              {getEmptyStateMessage(viewModel.items.length, filter, graphFilter, query)}
            </div>
          ) : (
            <>
              <RunActivityColumnHeader
                columnWidths={effectiveColumnWidths}
                onPointerDown={handleColumnResizePointerDown}
                onKeyDown={handleColumnResizeKeyDown}
              />
              {filteredItems.map((item) => (
                <RunActivityRow
                  key={item.activityKey}
                  item={item}
                  expanded={expandedKeys.has(item.activityKey)}
                  onToggle={() => toggleExpanded(item.activityKey)}
                  onLocate={onLocate}
                  onOpenFullOutput={onOpenFullOutput}
                  onOpenToolResult={onOpenToolResult}
                  onInspectResponse={onInspectResponse}
                  renderExpandedContent={renderExpandedContent}
                />
              ))}
            </>
          )}
        </div>
        {newActivityCount > 0 && (
          <button type="button" className="run-activity-new-items" onClick={revealNewActivities} aria-live="polite">
            {newActivityCount} new {newActivityCount === 1 ? 'activity' : 'activities'}
          </button>
        )}
      </div>
    </aside>
  );
};

const RunActivityColumnHeader: FC<{
  columnWidths: RunActivityColumnWidths;
  onPointerDown(key: RunActivityColumnWidthKey, event: ReactPointerEvent<HTMLButtonElement>): void;
  onKeyDown(key: RunActivityColumnWidthKey, event: ReactKeyboardEvent<HTMLButtonElement>): void;
}> = ({ columnWidths, onPointerDown, onKeyDown }) => (
  <div className="run-activity-column-header" aria-label="Run Activity columns">
    <span aria-hidden="true" />
    <RunActivityColumnHeaderCell
      label="Node name"
      widthKey="nodeName"
      width={columnWidths.nodeName}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
    <RunActivityColumnHeaderCell
      label="Graph name"
      widthKey="graphName"
      width={columnWidths.graphName}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
    <RunActivityColumnHeaderCell
      label="Node type"
      className="node-type"
      widthKey="nodeType"
      width={columnWidths.nodeType}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
    <span className="run-activity-column-header-cell preview">Output</span>
    <span className="run-activity-column-header-cell align-end">Started</span>
    <span className="run-activity-column-header-cell align-end">Duration</span>
    <span aria-hidden="true" />
  </div>
);

const RunActivityColumnHeaderCell: FC<{
  label: string;
  widthKey: RunActivityColumnWidthKey;
  width: number;
  className?: string;
  onPointerDown(key: RunActivityColumnWidthKey, event: ReactPointerEvent<HTMLButtonElement>): void;
  onKeyDown(key: RunActivityColumnWidthKey, event: ReactKeyboardEvent<HTMLButtonElement>): void;
}> = ({ label, widthKey, width, className, onPointerDown, onKeyDown }) => {
  const { minWidth, maxWidth } = getRunActivityColumnWidthBounds(widthKey);
  return (
    <span className={clsx('run-activity-column-header-cell', className)}>
      {label}
      <button
        type="button"
        className={clsx('run-activity-column-resize-handle', className)}
        aria-label={`Resize ${label} column`}
        title={`Drag to resize ${label}`}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        role="separator"
        onPointerDown={(event) => onPointerDown(widthKey, event)}
        onKeyDown={(event) => onKeyDown(widthKey, event)}
      />
    </span>
  );
};

const RunActivityRow: FC<{
  item: RunActivityItemViewModel;
  expanded: boolean;
  onToggle(): void;
  onLocate?: RunActivityDrawerProps['onLocate'];
  onOpenFullOutput?: RunActivityDrawerProps['onOpenFullOutput'];
  onOpenToolResult?: RunActivityDrawerProps['onOpenToolResult'];
  onInspectResponse?: RunActivityDrawerProps['onInspectResponse'];
  renderExpandedContent?: RunActivityDrawerProps['renderExpandedContent'];
}> = ({
  item,
  expanded,
  onToggle,
  onLocate,
  onOpenFullOutput,
  onOpenToolResult,
  onInspectResponse,
  renderExpandedContent,
}) => {
  const preview = item.error ?? item.preview ?? describeActivity(item);
  const detailId = `run-activity-detail-${toDomId(item.activityKey)}`;
  return (
    <CollapsiblePanel
      className={clsx('run-activity-row', `status-${item.status}`)}
      rootProps={{ 'data-activity-key': item.activityKey }}
      ariaControls={detailId}
      open={expanded}
      onToggle={onToggle}
      toggleClassName="run-activity-row-toggle"
      label={
        <>
          <span className={`run-activity-status-dot status-${item.status}`} aria-hidden="true" />
          <span className="run-activity-identity">
            <span className="run-activity-node-title">{item.nodeTitle}</span>
            <span className="run-activity-node-meta">
              {item.graphName} / {item.nodeType}
            </span>
          </span>
          <span className="run-activity-graph-name">{item.graphName}</span>
          <span className="run-activity-node-type">{item.nodeType}</span>
          <span className={clsx('run-activity-preview', { error: item.error })}>{preview}</span>
          <span className="run-activity-started-at">
            {item.startedAt != null && (
              <time dateTime={new Date(item.startedAt).toISOString()}>{formatTime(item.startedAt)}</time>
            )}
          </span>
          <span className="run-activity-duration">
            {item.durationMs != null && formatRunActivityDuration(item.durationMs)}
          </span>
        </>
      }
    >
      {expanded && (
        <div className="run-activity-row-detail" id={detailId}>
          {(item.error != null || item.preview != null) && (
            <div className={clsx('run-activity-detail-message', { error: item.error })}>
              {item.error ?? item.preview}
            </div>
          )}
          <ActivityDetails item={item} />
          {renderExpandedContent?.(item)}
          {item.children && item.children.length > 0 && (
            <ul className="run-activity-children" aria-label="Invocation child activities">
              {item.children.map((child) => (
                <li key={child.id} className="run-activity-child">
                  <span className={`run-activity-status-dot status-${child.status ?? 'unknown'}`} aria-hidden="true" />
                  <span>
                    <span>{child.label}</span>
                    {child.secondaryText && (
                      <span className="run-activity-child-secondary"> / {child.secondaryText}</span>
                    )}
                  </span>
                  {child.durationMs != null && (
                    <span className="run-activity-child-secondary">{formatRunActivityDuration(child.durationMs)}</span>
                  )}
                  {child.toolResultTarget && onOpenToolResult && (
                    <button
                      type="button"
                      className="run-activity-child-action"
                      onClick={() => onOpenToolResult(child.toolResultTarget!)}
                    >
                      Open tool result
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="run-activity-row-actions">
            {item.navigable && onLocate && (
              <button type="button" className="run-activity-action-button" onClick={() => onLocate(item)}>
                Locate on canvas
              </button>
            )}
            {item.fullOutputAvailable && onOpenFullOutput && (
              <button type="button" className="run-activity-action-button" onClick={() => onOpenFullOutput(item)}>
                {item.fullOutputActionLabel ?? 'Open full output'}
              </button>
            )}
            {item.inspectable && onInspectResponse && (
              <button type="button" className="run-activity-action-button" onClick={() => onInspectResponse(item)}>
                Inspect response
              </button>
            )}
          </div>
        </div>
      )}
    </CollapsiblePanel>
  );
};

const ActivityDetails: FC<{ item: RunActivityItemViewModel }> = ({ item }) => {
  const rows = [
    item.provider && { label: 'Provider', value: item.provider },
    item.model && { label: 'Model', value: item.model },
    item.toolName && { label: 'Tool', value: item.toolName },
    item.modelCallCount != null && { label: 'Model calls', value: String(item.modelCallCount) },
    item.toolCallCount != null && { label: 'Tool calls', value: String(item.toolCallCount) },
    item.splitCount != null && { label: 'Split results', value: String(item.splitCount) },
    ...(item.detailRows ?? []),
  ].filter((row): row is { label: string; value: string } => Boolean(row));
  if (rows.length === 0) return null;
  return (
    <div className="run-activity-detail-list">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`}>
          <div className="run-activity-detail-label">{row.label}</div>
          <div className="run-activity-detail-value">{row.value}</div>
        </div>
      ))}
    </div>
  );
};

export function clampRunActivityDrawerHeight(
  requestedHeight: number,
  viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight,
): number {
  const maximum = getMaximumRunActivityDrawerHeight(viewportHeight);
  if (!Number.isFinite(requestedHeight)) return maximum;
  return Math.min(maximum, Math.max(MIN_RUN_ACTIVITY_DRAWER_HEIGHT, Math.round(requestedHeight)));
}

export function getMaximumRunActivityDrawerHeight(
  viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight,
): number {
  return Math.max(MIN_RUN_ACTIVITY_DRAWER_HEIGHT, Math.round(viewportHeight * MAX_RUN_ACTIVITY_DRAWER_VIEWPORT_RATIO));
}

function describeActivity(item: RunActivityItemViewModel): string {
  if (item.status === 'waiting') return 'Waiting for input';
  if (item.status === 'running') return 'Running';
  if (item.status === 'not-ran') return 'Not run';
  if (item.category === 'model') return 'Model response';
  if (item.category === 'tool') return item.toolName ? `Tool: ${item.toolName}` : 'Tool execution';
  return item.status === 'success' ? 'Completed' : 'Activity details';
}

function describeRootStatus(status: RunActivityStatus, backgroundWorkPending?: boolean): string {
  if (backgroundWorkPending && (status === 'outputs-ready' || status === 'running')) {
    return 'Outputs ready; async work still running';
  }
  const labels: Record<RunActivityStatus, string> = {
    idle: 'No run yet',
    running: 'Running',
    'outputs-ready': 'Outputs ready',
    completed: 'Completed',
    failed: 'Failed',
    aborted: 'Aborted',
  };
  return labels[status];
}

function getEmptyStateMessage(
  totalItemCount: number,
  filter: RunActivityFilter,
  graphFilter: string,
  query: string,
): string {
  if (totalItemCount === 0) return 'Run a graph to see its activity.';
  if (query.trim()) return 'No activity metadata matches this search.';
  if (graphFilter) return 'No activity in this graph matches the selected type.';
  if (filter === 'llm-tools') return 'No LLM or tool activity was recorded in this run.';
  if (filter === 'errors') return 'No errors were recorded in this run.';
  return 'No activity matches the current filters.';
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
}

function formatAccounting(accounting: NonNullable<RunActivityViewModel['accounting']>): string {
  const parts = [
    `${accounting.modelCallCount} model ${accounting.modelCallCount === 1 ? 'call' : 'calls'}`,
    `${accounting.toolCallCount} tool ${accounting.toolCallCount === 1 ? 'call' : 'calls'}`,
  ];
  if (accounting.promptTokens != null || accounting.completionTokens != null) {
    parts.push(`${accounting.promptTokens ?? 0} in / ${accounting.completionTokens ?? 0} out tokens`);
  }
  const tokenDetails = [
    accounting.cachedTokens == null ? undefined : `${accounting.cachedTokens} cached`,
    accounting.reasoningTokens == null ? undefined : `${accounting.reasoningTokens} reasoning`,
  ].filter((detail): detail is string => detail != null);
  if (tokenDetails.length > 0) parts.push(tokenDetails.join(', '));
  if (accounting.costStatus !== 'unknown') {
    parts.push(`$${accounting.knownCostUsd.toFixed(6)}${accounting.costStatus === 'partial' ? ' partial' : ''}`);
  }
  return parts.join(' · ');
}

function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function isActivityListNearBottom(element: HTMLDivElement | null): boolean {
  if (!element) return true;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

function scrollActivityListToBottom(element: HTMLDivElement | null): void {
  element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
}

function trapFocus(container: HTMLElement, event: KeyboardEvent): void {
  const focusable = [
    ...container.querySelectorAll<HTMLElement>('button, input, select, [tabindex]:not([tabindex="-1"])'),
  ].filter(
    (element) =>
      element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function hasAnotherOpenModal(drawer: HTMLElement | null): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some(
    (modal) => modal !== drawer && !drawer?.contains(modal),
  );
}

function useNarrowViewport(): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia(NARROW_VIEWPORT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return matches;
}
