import { css } from '@emotion/react';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import { useAtom } from 'jotai';
import { type CSSProperties, type FC, type PointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useContextMenu } from '../../hooks/useContextMenu.js';
import { leftSidebarLiveWidthState, leftSidebarWidthState } from '../../state/ui.js';
import { clampLeftSidebarWidth } from '../../utils/leftSidebarWidth.js';
import { resizeCursorStyles } from '../../utils/resizeCursors.js';
import type { EvaluationSuiteReferenceStatus } from './evaluationWorkspaceModel.js';

const styles = css`
  position: relative;
  width: var(--evaluation-sidebar-width);
  height: 100%;
  box-sizing: border-box;
  min-width: 0;
  border-right: 1px solid var(--app-panel-border);
  background-color: var(--app-panel-bg);
  backdrop-filter: blur(2px);
  padding: 16px 0;
  overflow-y: auto;
  user-select: none;

  .resize-handle {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    z-index: 100;
    cursor: var(--resize-edge-horizontal-cursor);
    touch-action: none;
  }

  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: var(--primary);
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .resize-handle:hover::after,
  &.resizing .resize-handle::after {
    opacity: 0.65;
  }

  .evaluation-sidebar-section {
    padding: 0 0 16px;
  }

  .evaluation-sidebar-section + .evaluation-sidebar-section {
    padding-top: 16px;
    border-top: 1px solid var(--grey-darkish);
  }

  .evaluation-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px 12px 16px;
  }

  .evaluation-sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  h2 {
    margin: 0;
    font-size: var(--ui-font-size-base);
  }

  .add-suite,
  .import-resource {
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 5px 8px;
  }

  .add-suite:hover:not(:disabled),
  .import-resource:hover:not(:disabled) {
    background: var(--grey-darkish);
    color: var(--foreground);
  }

  .add-suite:disabled,
  .import-resource:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .suite-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px;
  }

  .suite-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    padding: 9px 10px;
    text-align: left;
  }

  .suite-row:hover {
    background: var(--primary-dark);
    color: var(--foreground-on-primary);
  }

  .suite-row[aria-current='true'] {
    background: var(--primary);
    color: var(--foreground-on-primary);
  }

  .suite-row[aria-current='true']:hover {
    background: var(--primary-dark);
  }

  .suite-row:hover .suite-target,
  .suite-row[aria-current='true'] .suite-target {
    color: color-mix(in srgb, var(--foreground-on-primary) 78%, transparent);
  }

  .suite-copy {
    min-width: 0;
  }

  .suite-name,
  .suite-target {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .suite-name {
    font-weight: 600;
  }

  .suite-target {
    margin-top: 3px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }

  .suite-warning {
    align-self: center;
    color: var(--warning);
  }

  .empty-suite-list {
    margin: 8px 16px;
    color: var(--grey-light);
  }

  @media (max-width: 760px) {
    width: 100%;

    .resize-handle {
      display: none;
    }
  }

`;

const contextMenuStyles = css`
  display: flex;
  width: max-content;
  min-width: 164px;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--popup-menu-border);
  border-radius: 9px;
  background-color: var(--popup-menu-bg);
  backdrop-filter: blur(2px);
  box-shadow: 0 6px 18px color-mix(in srgb, black 32%, transparent);
  color: var(--grey-lighter);

  button {
    display: flex;
    width: 100%;
    min-height: 32px;
    box-sizing: border-box;
    align-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--error);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
  }

  button:hover:not(:disabled),
  button:focus-visible {
    background: color-mix(in srgb, var(--error) 18%, var(--grey-darkish));
    color: var(--error-light);
  }

  button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 1px;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
`;

export const EvaluationSuiteSidebar: FC<{
  canCreateDataset: boolean;
  canCreateSuite: boolean;
  datasets: readonly EvaluationDataset[];
  getDatasetUsage: (dataset: EvaluationDataset) => string;
  selectedSuiteId?: string;
  selectedDatasetId?: string;
  suites: readonly EvaluationSuite[];
  getGraphName: (suite: EvaluationSuite) => string;
  getReferenceStatus: (suite: EvaluationSuite) => EvaluationSuiteReferenceStatus;
  onCreateDataset: () => void;
  onCreateSuite: () => void;
  onDeleteDataset: (datasetId: string) => void;
  onDeleteSuite: (suiteId: string) => void;
  onImportDataset: () => void;
  onImportSuite: () => void;
  onSelectDataset: (datasetId: string) => void;
  onSelectSuite: (suiteId: string) => void;
  runningSuiteId?: string;
}> = ({
  canCreateDataset,
  canCreateSuite,
  datasets,
  getDatasetUsage,
  selectedSuiteId,
  selectedDatasetId,
  suites,
  getGraphName,
  getReferenceStatus,
  onCreateDataset,
  onCreateSuite,
  onDeleteDataset,
  onDeleteSuite,
  onImportDataset,
  onImportSuite,
  onSelectDataset,
  onSelectSuite,
  runningSuiteId,
}) => {
  const [persistedSidebarWidth, setPersistedSidebarWidth] = useAtom(leftSidebarWidthState);
  const [liveSidebarWidth, setLiveSidebarWidth] = useAtom(leftSidebarLiveWidthState);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartClientXRef = useRef(0);
  const dragStartWidthRef = useRef(liveSidebarWidth);
  const liveSidebarWidthRef = useRef(liveSidebarWidth);
  const isResizingRef = useRef(false);
  const { refs, floatingStyles, contextMenuData, handleContextMenu, setShowContextMenu, showContextMenu } =
    useContextMenu();
  const contextSuite =
    contextMenuData.data?.type === 'evaluation-suite'
      ? suites.find((suite) => suite.id === contextMenuData.data?.element.dataset.evaluationsuiteid)
      : undefined;
  const contextDataset =
    contextMenuData.data?.type === 'evaluation-dataset'
      ? datasets.find((dataset) => dataset.id === contextMenuData.data?.element.dataset.evaluationdatasetid)
      : undefined;
  const datasetHasRunningSuite =
    contextDataset != null &&
    suites.some((suite) => suite.datasetId === contextDataset.id && suite.id === runningSuiteId);

  liveSidebarWidthRef.current = liveSidebarWidth;

  useEffect(() => {
    if (!isResizing) {
      setLiveSidebarWidth(clampLeftSidebarWidth(persistedSidebarWidth));
    }
  }, [isResizing, persistedSidebarWidth, setLiveSidebarWidth]);

  useEffect(() => {
    if (isResizing) return;

    const handleWindowResize = () => setLiveSidebarWidth(clampLeftSidebarWidth(persistedSidebarWidth));
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [isResizing, persistedSidebarWidth, setLiveSidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = resizeCursorStyles.horizontal;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartClientXRef.current = event.clientX;
    dragStartWidthRef.current = liveSidebarWidth;
    isResizingRef.current = true;
    setIsResizing(true);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizingRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    const nextWidth = clampLeftSidebarWidth(
      dragStartWidthRef.current + event.clientX - dragStartClientXRef.current,
    );
    liveSidebarWidthRef.current = nextWidth;
    setLiveSidebarWidth(nextWidth);
  };

  const handleResizePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!isResizingRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    isResizingRef.current = false;
    setIsResizing(false);
    setPersistedSidebarWidth(liveSidebarWidthRef.current);
  };

  return (
    <aside
      css={styles}
      className={isResizing ? 'resizing' : undefined}
      aria-label="Evaluations resources"
      style={{ '--evaluation-sidebar-width': `${liveSidebarWidth}px` } as CSSProperties}
      onContextMenu={(event) => {
        event.preventDefault();
        handleContextMenu(event);
      }}
    >
      <div
        aria-label="Resize evaluations panel"
        aria-orientation="vertical"
        className="resize-handle"
        onLostPointerCapture={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        role="separator"
      />
      <section className="evaluation-sidebar-section" aria-labelledby="evaluation-suites-heading">
        <div className="evaluation-sidebar-header">
          <h2 id="evaluation-suites-heading">Evaluation suites</h2>
          <div className="evaluation-sidebar-actions">
            <button
              type="button"
              className="import-resource"
              title="Import evaluation suite and dataset"
              aria-label="Import evaluation suite and dataset"
              onClick={onImportSuite}
            >
              Import
            </button>
            <button
              type="button"
              className="add-suite"
              disabled={!canCreateSuite}
              title={canCreateSuite ? 'Create evaluation suite' : 'Create a graph before creating an evaluation suite'}
              aria-label="Create evaluation suite"
              onClick={onCreateSuite}
            >
              +
            </button>
          </div>
        </div>
        <div className="suite-list">
          {suites.length === 0 ? (
            <p className="empty-suite-list">No evaluation suites yet.</p>
          ) : (
            suites.map((suite) => {
              const status = getReferenceStatus(suite);
              const broken = !status.datasetExists || !status.targetGraphExists || !status.evaluatorGraphsExist;
              return (
                <button
                  type="button"
                  className="suite-row"
                  key={suite.id}
                  data-contextmenutype="evaluation-suite"
                  data-evaluationsuiteid={suite.id}
                  aria-current={suite.id === selectedSuiteId}
                  onClick={() => onSelectSuite(suite.id)}
                >
                  <span className="suite-copy">
                    <span className="suite-name">{suite.name || 'Untitled evaluation suite'}</span>
                    <span className="suite-target">{getGraphName(suite)}</span>
                  </span>
                  {broken ? (
                    <span
                      className="suite-warning"
                      title="This suite has a missing target graph, evaluator graph, or dataset reference"
                    >
                      ⚠
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </section>
      <section className="evaluation-sidebar-section" aria-labelledby="evaluation-datasets-heading">
        <div className="evaluation-sidebar-header">
          <h2 id="evaluation-datasets-heading">Datasets</h2>
          <div className="evaluation-sidebar-actions">
            <button
              type="button"
              className="import-resource"
              title="Import evaluation dataset"
              aria-label="Import evaluation dataset"
              onClick={onImportDataset}
            >
              Import
            </button>
            <button
              type="button"
              className="add-suite"
              disabled={!canCreateDataset}
              title="Create evaluation dataset"
              aria-label="Create evaluation dataset"
              onClick={onCreateDataset}
            >
              +
            </button>
          </div>
        </div>
        <div className="suite-list">
          {datasets.length === 0 ? (
            <p className="empty-suite-list">No evaluation datasets yet.</p>
          ) : (
            datasets.map((dataset) => (
              <button
                type="button"
                className="suite-row"
                key={dataset.id}
                data-contextmenutype="evaluation-dataset"
                data-evaluationdatasetid={dataset.id}
                aria-current={dataset.id === selectedDatasetId}
                onClick={() => onSelectDataset(dataset.id)}
              >
                <span className="suite-copy">
                  <span className="suite-name">{dataset.name || 'Untitled evaluation dataset'}</span>
                  <span className="suite-target">{getDatasetUsage(dataset)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </section>
      {showContextMenu && typeof document !== 'undefined'
        ? createPortal(
            <>
              {showContextMenu && contextSuite != null ? (
                <div
                  ref={refs.setReference}
                  style={{
                    position: 'absolute',
                    zIndex: 500,
                    left: contextMenuData.x,
                    top: contextMenuData.y,
                  }}
                >
                  <div
                    ref={refs.setFloating}
                    css={contextMenuStyles}
                    className="evaluation-resource-context-menu"
                    style={floatingStyles}
                  >
                    <button
                      type="button"
                      disabled={contextSuite.id === runningSuiteId}
                      title={
                        contextSuite.id === runningSuiteId
                          ? 'Cannot delete a suite while it is running'
                          : 'Delete suite'
                      }
                      onClick={() => {
                        setShowContextMenu(false);
                        onDeleteSuite(contextSuite.id);
                      }}
                    >
                      Delete suite
                    </button>
                  </div>
                </div>
              ) : null}
              {showContextMenu && contextDataset != null ? (
                <div
                  ref={refs.setReference}
                  style={{
                    position: 'absolute',
                    zIndex: 500,
                    left: contextMenuData.x,
                    top: contextMenuData.y,
                  }}
                >
                  <div
                    ref={refs.setFloating}
                    css={contextMenuStyles}
                    className="evaluation-resource-context-menu"
                    style={floatingStyles}
                  >
                    <button
                      type="button"
                      disabled={datasetHasRunningSuite}
                      title={
                        datasetHasRunningSuite ? 'Cannot delete a dataset used by a running suite' : 'Delete dataset'
                      }
                      onClick={() => {
                        setShowContextMenu(false);
                        onDeleteDataset(contextDataset.id);
                      }}
                    >
                      Delete dataset
                    </button>
                  </div>
                </div>
              ) : null}
            </>,
            document.body,
          )
        : null}
    </aside>
  );
};
