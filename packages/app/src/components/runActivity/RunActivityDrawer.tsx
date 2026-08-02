import { css } from '@emotion/react';
import clsx from 'clsx';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import {
  type ChangeEvent,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  RunActivityDrawerProps,
  RunActivityFilter,
  RunActivityItemStatus,
  RunActivityItemViewModel,
  RunActivityStatus,
} from './types.js';
import { filterRunActivityItems } from './filterRunActivityItems.js';

export const DEFAULT_RUN_ACTIVITY_DRAWER_HEIGHT = 360;
export const MIN_RUN_ACTIVITY_DRAWER_HEIGHT = 220;
export const MAX_RUN_ACTIVITY_DRAWER_VIEWPORT_RATIO = 0.72;
const NARROW_VIEWPORT_QUERY = '(max-width: 720px)';
const RESIZE_KEYBOARD_STEP = 24;

const drawerStyles = css`
  position: fixed;
  z-index: 90;
  right: 0;
  bottom: 0;
  left: var(--data-bus-full-row-left, 0px);
  display: flex;
  flex-direction: column;
  min-height: ${MIN_RUN_ACTIVITY_DRAWER_HEIGHT}px;
  overflow: hidden;
  color: var(--foreground);
  background: var(--app-panel-bg);
  border-top: 1px solid var(--app-panel-border);
  backdrop-filter: blur(2px);
  box-shadow: 0 -8px 30px rgb(0 0 0 / 28%);

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
    cursor: ns-resize;
    touch-action: none;
  }

  .run-activity-resize-handle::after {
    position: absolute;
    top: 4px;
    left: 50%;
    width: 46px;
    height: 3px;
    border-radius: 3px;
    background: var(--app-panel-border);
    content: '';
    transform: translateX(-50%);
  }

  .run-activity-resize-handle:hover::after,
  .run-activity-resize-handle:focus-visible::after {
    background: var(--primary);
  }

  .run-activity-resize-handle:focus-visible {
    outline: 1px solid var(--primary);
    outline-offset: -2px;
  }

  .run-activity-header {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
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
  .run-activity-new-items:focus-visible,
  .run-activity-filter:focus-visible,
  .run-activity-row-toggle:focus-visible {
    outline: 1px solid var(--primary);
    outline-offset: 1px;
  }

  .run-activity-toolbar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--app-panel-border);
    background: var(--modal-surface-bg);
  }

  .run-activity-filters {
    display: inline-flex;
    flex: none;
    align-items: center;
    padding: 2px;
    border-radius: var(--ui-button-radius-sm, 6px);
    background: var(--form-control-neutral-bg);
  }

  .run-activity-filter {
    min-height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: calc(var(--ui-button-radius-sm, 6px) - 2px);
    background: transparent;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    cursor: pointer;
  }

  .run-activity-filter[aria-pressed='true'] {
    background: var(--form-control-selected-bg);
    color: var(--foreground);
  }

  .run-activity-graph-filter {
    width: min(220px, 24vw);
    min-width: 130px;
    height: 32px;
    padding: 0 28px 0 9px;
    color: var(--foreground);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-search {
    position: relative;
    min-width: 150px;
    flex: 1;
  }

  .run-activity-search svg {
    position: absolute;
    top: 50%;
    left: 9px;
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
    height: 32px;
    padding: 0 10px 0 32px;
    font-size: var(--ui-font-size-sm);
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
  }

  .run-activity-list {
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 10px 16px 20px;
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
    overflow: hidden;
    border: 1px solid var(--app-panel-border);
    border-radius: 8px;
    background: var(--node-body-bg);
    content-visibility: auto;
    contain-intrinsic-size: auto 66px;
  }

  .run-activity-row + .run-activity-row {
    margin-top: 8px;
  }

  .run-activity-row.status-error,
  .run-activity-row.status-interrupted {
    border-color: color-mix(in srgb, var(--error) 58%, var(--app-panel-border));
  }

  .run-activity-row.status-running {
    border-color: color-mix(in srgb, var(--primary) 48%, var(--app-panel-border));
  }

  .run-activity-row-toggle {
    display: grid;
    grid-template-columns: 10px minmax(180px, 1.2fr) minmax(140px, 1fr) max-content 22px;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 50px;
    padding: 8px 11px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .run-activity-row-toggle:hover {
    background: color-mix(in srgb, var(--surface-row-hover-bg) 42%, transparent);
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
  .run-activity-preview,
  .run-activity-row-timing,
  .run-activity-detail-label,
  .run-activity-child-secondary {
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
  }

  .run-activity-node-meta,
  .run-activity-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-activity-preview.error {
    color: var(--error-light);
  }

  .run-activity-row-timing {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    white-space: nowrap;
  }

  .run-activity-chevron {
    display: grid;
    place-items: center;
  }

  .run-activity-chevron svg {
    width: 18px;
    height: 18px;
  }

  .run-activity-row-detail {
    padding: 4px 14px 14px 31px;
    border-top: 1px solid var(--app-panel-border);
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
    grid-template-columns: 8px minmax(0, 1fr) max-content;
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

  @media (max-width: 900px) {
    .run-activity-row-toggle {
      grid-template-columns: 10px minmax(160px, 1fr) max-content 22px;
    }

    .run-activity-preview {
      display: none;
    }

    .run-activity-toolbar {
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
      width: 100%;
      justify-content: flex-end;
    }

    .run-activity-follow span {
      display: none;
    }

    .run-activity-toolbar {
      display: grid;
      grid-template-columns: 1fr;
    }

    .run-activity-filters {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }

    .run-activity-graph-filter,
    .run-activity-search {
      width: 100%;
    }

    .run-activity-summary {
      display: none;
    }

    .run-activity-row-toggle {
      grid-template-columns: 10px minmax(0, 1fr) 22px;
    }

    .run-activity-row-timing {
      display: none;
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
  onInspectResponse,
  onCopyDiagnostics,
  height = DEFAULT_RUN_ACTIVITY_DRAWER_HEIGHT,
  onHeightChange,
  renderExpandedContent,
  className,
}) => {
  const [filter, setFilter] = useState<RunActivityFilter>('all');
  const [graphFilter, setGraphFilter] = useState('');
  const [query, setQuery] = useState('');
  const [followLive, setFollowLive] = useState(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [displayHeight, setDisplayHeight] = useState(() => clampRunActivityDrawerHeight(height));
  const listRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const previousItemCountRef = useRef(viewModel.items.length);
  const previousRootRunIdRef = useRef(viewModel.rootRunId);
  const resizeStateRef = useRef<{ startY: number; startHeight: number }>();
  const isNarrowViewport = useNarrowViewport();

  const graphOptions = useMemo(() => {
    if (viewModel.graphOptions) return viewModel.graphOptions;
    const graphNames = new Map<string, string>();
    for (const item of viewModel.items) graphNames.set(item.graphId, item.graphName);
    return [...graphNames].map(([graphId, graphName]) => ({ graphId, graphName }));
  }, [viewModel.graphOptions, viewModel.items]);

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
      if (event.key === 'Escape' && !hasAnotherOpenModal(drawerRef.current)) onClose();
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
  }, [isNarrowViewport, onClose, open]);

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

  const handleResizePointerUp = useCallback(() => {
    resizeStateRef.current = undefined;
    window.removeEventListener('pointermove', handleResizePointerMove);
    window.removeEventListener('pointerup', handleResizePointerUp);
  }, [handleResizePointerMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleResizePointerMove);
      window.removeEventListener('pointerup', handleResizePointerUp);
    };
  }, [handleResizePointerMove, handleResizePointerUp]);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeStateRef.current = { startY: event.clientY, startHeight: displayHeight };
    window.addEventListener('pointermove', handleResizePointerMove);
    window.addEventListener('pointerup', handleResizePointerUp);
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

  return (
    <aside
      ref={drawerRef}
      css={drawerStyles}
      className={clsx('run-activity-drawer', className)}
      aria-label="Run Activity"
      aria-modal={isNarrowViewport || undefined}
      role={isNarrowViewport ? 'dialog' : 'complementary'}
      style={{ height: displayHeight }}
    >
      <button
        type="button"
        aria-label="Resize Run Activity"
        aria-orientation="horizontal"
        aria-valuemax={getMaximumRunActivityDrawerHeight()}
        aria-valuemin={MIN_RUN_ACTIVITY_DRAWER_HEIGHT}
        aria-valuenow={displayHeight}
        className="run-activity-resize-handle"
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
            {viewModel.durationMs == null ? '' : ` / ${formatDuration(viewModel.durationMs)}`}
          </span>
        </div>
        <div className="run-activity-header-actions">
          <label className="run-activity-follow">
            <input type="checkbox" checked={followLive} onChange={handleFollowChange} />
            <span>Follow live</span>
          </label>
          {onCopyDiagnostics && (
            <button type="button" className="run-activity-action-button" onClick={onCopyDiagnostics}>
              Copy diagnostics
            </button>
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
      <div className="run-activity-toolbar">
        <div className="run-activity-filters" aria-label="Activity type" role="group">
          {FILTERS.map((option) => (
            <button
              type="button"
              key={option.value}
              className="run-activity-filter"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {graphOptions.length > 1 && (
          <select
            className="run-activity-graph-filter"
            aria-label="Filter by graph"
            value={graphFilter}
            onChange={(event) => setGraphFilter(event.target.value)}
          >
            <option value="">All graphs</option>
            {graphOptions.map((option) => (
              <option key={option.graphId} value={option.graphId}>
                {option.graphName}
              </option>
            ))}
          </select>
        )}
        <label className="run-activity-search">
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
            filteredItems.map((item) => (
              <RunActivityRow
                key={item.activityKey}
                item={item}
                expanded={expandedKeys.has(item.activityKey)}
                onToggle={() => toggleExpanded(item.activityKey)}
                onLocate={onLocate}
                onOpenFullOutput={onOpenFullOutput}
                onInspectResponse={onInspectResponse}
                renderExpandedContent={renderExpandedContent}
              />
            ))
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

const RunActivityRow: FC<{
  item: RunActivityItemViewModel;
  expanded: boolean;
  onToggle(): void;
  onLocate?: RunActivityDrawerProps['onLocate'];
  onOpenFullOutput?: RunActivityDrawerProps['onOpenFullOutput'];
  onInspectResponse?: RunActivityDrawerProps['onInspectResponse'];
  renderExpandedContent?: RunActivityDrawerProps['renderExpandedContent'];
}> = ({ item, expanded, onToggle, onLocate, onOpenFullOutput, onInspectResponse, renderExpandedContent }) => {
  const preview = item.error ?? item.preview ?? describeActivity(item);
  return (
    <article className={`run-activity-row status-${item.status}`} data-activity-key={item.activityKey}>
      <button
        type="button"
        className="run-activity-row-toggle"
        aria-expanded={expanded}
        aria-controls={`run-activity-detail-${toDomId(item.activityKey)}`}
        onClick={onToggle}
      >
        <span className={`run-activity-status-dot status-${item.status}`} aria-hidden="true" />
        <span className="run-activity-identity">
          <span className="run-activity-node-title">{item.nodeTitle}</span>
          <span className="run-activity-node-meta">
            {item.graphName} / {item.nodeType}
          </span>
        </span>
        <span className={clsx('run-activity-preview', { error: item.error })}>{preview}</span>
        <span className="run-activity-row-timing">
          {item.startedAt != null && (
            <time dateTime={new Date(item.startedAt).toISOString()}>{formatTime(item.startedAt)}</time>
          )}
          {item.durationMs != null && <span>{formatDuration(item.durationMs)}</span>}
        </span>
        <span className="run-activity-chevron" aria-hidden="true">
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </span>
      </button>
      {expanded && (
        <div className="run-activity-row-detail" id={`run-activity-detail-${toDomId(item.activityKey)}`}>
          {(item.error || item.preview) && (
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
                    <span className="run-activity-child-secondary">{formatDuration(child.durationMs)}</span>
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
                Open full output
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
    </article>
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

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`;
  const seconds = value / 1_000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} sec`;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
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
