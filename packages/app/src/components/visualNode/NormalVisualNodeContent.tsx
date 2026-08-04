import clsx from 'clsx';
import {
  type FC,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  memo,
  useState,
} from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useSetAtom } from 'jotai';
import {
  type ChartNode,
  type CommentNode,
  type GraphId,
  type NodeConnection,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import type { HeightCache } from '../../hooks/useNodeBodyHeight';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import BookIcon from 'majesticons/line/book-open-line.svg?react';
import { ResizeHandle } from '../ResizeHandle.js';
import { useCanvasPositioning } from '../../hooks/useCanvasPositioning.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { NodePortsRenderer } from '../NodePorts.js';
import { useDependsOnPlugins } from '../../hooks/useDependsOnPlugins';
import { viewingNodeChangesState } from '../../state/graphBuilder';
import { Tooltip } from '../Tooltip';
import { useCanvasHandlersContext } from '../CanvasContext';
import { NodeBody } from '../NodeBody.js';
import { NodeOutput } from '../NodeOutput.js';
import { SubGraphHeaderLink } from './SubGraphHeaderLink.js';
import { SplitRunSummary } from './SplitRunSummary.js';
import { NodeRunningIndicator } from './NodeRunningIndicator.js';
import { NodeTitleLabel } from './NodeTitleLabel.js';
import {
  computeBoxNodeResizeBounds,
  computeHorizontalNodeResizeBounds,
  haveNodeResizeBoundsChanged,
  type BoxNodeResizeDirection,
  type NodeResizeBounds,
} from '../../utils/nodeResize.js';
import { getCanvasCommentHeight, getCanvasNodeWidth } from '../../hooks/canvasVisibilityBounds.js';
import { getBoxResizeCursor } from '../../utils/resizeCursors.js';
import { NodeHeaderWarningIcon } from './NodeHeaderWarningIcon.js';
import { ConditionalIfPort } from './ConditionalIfPort.js';
import { viewingProjectComparisonNodeState } from '../../state/projectComparison.js';
import { SubgraphLinkIcon } from './SubgraphLinkIcon.js';

export const NormalVisualNodeContent: FC<{
  heightCache: HeightCache;
  node: ChartNode;
  connections?: NodeConnection[];
  handleAttributes?: HTMLAttributes<HTMLDivElement>;
  isKnownNodeType: boolean;
  isHistoricalChanged: boolean;
  isFrozen: boolean;
  isOutputPreviewHovered: boolean;
  showRunningIndicator: boolean;
  renderHeavyContent: boolean;
  minimumNodeWidth: number;
  headerWarning?: string;
  compareChangeKind?: ProjectComparisonChangeKind;
  graphId?: GraphId;
  editTargetNode?: ChartNode;
  isNodePrefabInstance?: boolean;
}> = memo(
  ({
    heightCache,
    node,
    connections = [],
    handleAttributes,
    isKnownNodeType,
    isHistoricalChanged,
    isFrozen,
    isOutputPreviewHovered,
    showRunningIndicator,
    renderHeavyContent,
    minimumNodeWidth,
    headerWarning,
    compareChangeKind,
    graphId,
    editTargetNode,
    isNodePrefabInstance = false,
  }) => {
    useDependsOnPlugins();
    const { onNodeSelected, onNodeSizeChanged, onNodeStartEditing, onResizeFinish } = useCanvasHandlersContext();
    const { clientToCanvasPosition } = useCanvasPositioning();
    const setViewingNodeChanges = useSetAtom(viewingNodeChangesState);
    const setViewingProjectComparisonNode = useSetAtom(viewingProjectComparisonNodeState);

    const [resizeState, setResizeState] = useState<{
      direction: BoxNodeResizeDirection;
      initialHeight: number;
      initialWidth: number;
      initialX: number;
      initialY: number;
      initialMouseX: number;
      initialMouseY: number;
    } | null>(null);
    const [shiftHeld, setShiftHeld] = useState(false);
    const isComment = node.type === 'comment';
    const getNodeHeight = () => (node.type === 'comment' ? getCanvasCommentHeight(node as CommentNode) : 0);

    const getNodeCurrentBounds = (elementOrChild: HTMLElement): Required<NodeResizeBounds> => {
      const nodeElement = elementOrChild.closest('.node');
      if (!nodeElement) {
        return {
          x: node.visualData.x,
          y: node.visualData.y,
          width: getCanvasNodeWidth(node),
          height: getNodeHeight(),
        };
      }

      const computedStyle = window.getComputedStyle(nodeElement);
      const width = Number.parseFloat(computedStyle.width);
      const height = Number.parseFloat(computedStyle.height);

      return {
        x: node.visualData.x,
        y: node.visualData.y,
        width: Number.isFinite(width) ? width : getCanvasNodeWidth(node),
        height: Number.isFinite(height) ? height : getNodeHeight(),
      };
    };

    const handleEditClick = useStableCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onNodeStartEditing?.(editTargetNode ?? node);
    });

    const handleEditMouseDown = useStableCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
    });

    const handleEditPointerDown = useStableCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    });

    const getNextResizeBounds = useStableCallback((event: globalThis.MouseEvent) => {
      if (!resizeState) {
        return null;
      }

      const initialMousePositionCanvas = clientToCanvasPosition(resizeState.initialMouseX, resizeState.initialMouseY);
      const newMousePositionCanvas = clientToCanvasPosition(event.clientX, event.clientY);
      const deltaX = newMousePositionCanvas.x - initialMousePositionCanvas.x;
      const deltaY = newMousePositionCanvas.y - initialMousePositionCanvas.y;

      if (isComment) {
        return computeBoxNodeResizeBounds({
          direction: resizeState.direction,
          initialHeight: resizeState.initialHeight,
          initialWidth: resizeState.initialWidth,
          initialX: resizeState.initialX,
          initialY: resizeState.initialY,
          deltaX,
          deltaY,
          minWidth: minimumNodeWidth,
        });
      }

      return computeHorizontalNodeResizeBounds({
        direction: resizeState.direction === 'left' ? 'left' : 'right',
        initialWidth: resizeState.initialWidth,
        initialX: resizeState.initialX,
        deltaX,
        minWidth: minimumNodeWidth,
      });
    });

    const handleResizeStart = useStableCallback((direction: BoxNodeResizeDirection, event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const currentBounds = getNodeCurrentBounds(event.target as HTMLElement);

      setResizeState({
        direction,
        initialHeight: currentBounds.height,
        initialWidth: currentBounds.width,
        initialX: currentBounds.x,
        initialY: currentBounds.y,
        initialMouseX: event.clientX,
        initialMouseY: event.clientY,
      });
    });

    const handleResizeMove = useStableCallback((event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const nextBounds = getNextResizeBounds(event);
      const currentWidth = Number.isFinite(node.visualData.width)
        ? node.visualData.width!
        : resizeState?.initialWidth ?? getCanvasNodeWidth(node);
      const currentBounds = isComment
        ? {
            x: node.visualData.x,
            y: node.visualData.y,
            width: currentWidth,
            height: getNodeHeight(),
          }
        : {
            x: node.visualData.x,
            width: currentWidth,
          };

      if (nextBounds && haveNodeResizeBoundsChanged(currentBounds, nextBounds)) {
        onNodeSizeChanged?.(node, nextBounds);
      }
    });

    const handleResizeEnd = useStableCallback((event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const nextBounds = getNextResizeBounds(event);

      if (resizeState && nextBounds) {
        onResizeFinish?.(node, nextBounds);
      }

      setResizeState(null);
    });

    const watchShift = useStableCallback((event: ReactMouseEvent) => {
      if (event.shiftKey !== shiftHeld) {
        setShiftHeld(event.shiftKey);
      }
    });

    const handleGrabClick = useStableCallback((event: ReactMouseEvent) => {
      event.stopPropagation();
      event.currentTarget.closest<HTMLElement>('.node')?.blur();
      onNodeSelected?.(node, event.shiftKey);
    });

    const viewChanges = () => {
      if (isHistoricalChanged) {
        setViewingNodeChanges(node.id);
      }
    };
    const viewProjectCompareChanges = () => {
      if (graphId && compareChangeKind === 'changed') {
        setViewingProjectComparisonNode({ graphId, nodeId: node.id });
      }
    };

    const nodeDescription = node.description?.trim();
    const resizeDirections: BoxNodeResizeDirection[] = isComment
      ? ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
      : ['left', 'right'];

    return (
      <>
        <div
          className={clsx('node-title', { grabbable: !shiftHeld })}
          {...(shiftHeld ? {} : handleAttributes)}
          onMouseMove={watchShift}
          onClick={handleGrabClick}
        >
          <div className={clsx('grab-area', { 'has-subgraph-header-link': node.type === 'subGraph' })}>
            <SubGraphHeaderLink node={node} />
            <div className="title-text">
              <NodeTitleLabel node={node} />
              {nodeDescription && <span className="title-text-description">{nodeDescription}</span>}
              <SplitRunSummary node={node} editTargetNode={editTargetNode} isKnownNodeType={isKnownNodeType} />
            </div>
          </div>
          <div className="title-controls">
            {isHistoricalChanged && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  viewChanges();
                }}
                onPointerDown={handleEditPointerDown}
                onMouseDown={handleEditMouseDown}
                className="changed-button"
              >
                <Tooltip content="This node was changed, click to view changes">
                  <BookIcon />
                </Tooltip>
              </button>
            )}
            {graphId && compareChangeKind === 'changed' && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  viewProjectCompareChanges();
                }}
                onPointerDown={handleEditPointerDown}
                onMouseDown={handleEditMouseDown}
                className="changed-button project-compare-changes-button"
              >
                <Tooltip content="View project comparison changes">
                  <BookIcon />
                </Tooltip>
              </button>
            )}
            <NodeRunningIndicator isRunning={showRunningIndicator} delayMs={0} />
            {isNodePrefabInstance && (
              <Tooltip className="node-prefab-instance-tooltip" content="Open library node">
                <button
                  type="button"
                  className="node-prefab-instance-indicator"
                  aria-label="Open library node"
                  onClick={handleEditClick}
                  onPointerDown={handleEditPointerDown}
                  onMouseDown={handleEditMouseDown}
                >
                  <SubgraphLinkIcon />
                </button>
              </Tooltip>
            )}
            {headerWarning && (
              <Tooltip className="node-header-warning-tooltip" content={headerWarning} tag="span" wrap width={260}>
                <span className="node-header-warning" role="img" aria-label={headerWarning}>
                  <NodeHeaderWarningIcon />
                </span>
              </Tooltip>
            )}
            {!isNodePrefabInstance && (
              <Tooltip className="edit-button-tooltip" content="Edit Node">
                <button
                  type="button"
                  className="edit-button"
                  onClick={(event) => {
                    if (isKnownNodeType) {
                      handleEditClick(event);
                    }
                  }}
                  onPointerDown={handleEditPointerDown}
                  onMouseDown={handleEditMouseDown}
                >
                  <SettingsCogIcon />
                </button>
              </Tooltip>
            )}
          </div>
        </div>

        {node.isConditional && <ConditionalIfPort node={node} connections={connections} />}

        <ErrorBoundary fallback={<div>Error rendering node body</div>}>
          {isKnownNodeType ? (
            <NodeBody
              heightCache={heightCache}
              interactive={!isNodePrefabInstance}
              node={node}
              suspended={!renderHeavyContent}
            />
          ) : (
            <div>Unknown node type {node.type} - are you missing a plugin?</div>
          )}
        </ErrorBoundary>

        {isKnownNodeType && <NodePortsRenderer node={node} connections={connections} />}

        <ErrorBoundary fallback={<div>Error rendering node output</div>}>
          <NodeOutput
            node={node}
            suspended={!renderHeavyContent}
            isFrozen={isFrozen}
            isHovered={isOutputPreviewHovered}
          />
        </ErrorBoundary>
        <div className="node-resize-handles">
          {resizeDirections.map((direction) => (
            <ResizeHandle
              key={direction}
              className={`resize-handle resize-handle-${direction}`}
              dragCursor={getBoxResizeCursor(direction)}
              onResizeStart={(event) => handleResizeStart(direction, event)}
              onResizeMove={handleResizeMove}
              onResizeEnd={handleResizeEnd}
            />
          ))}
        </div>
      </>
    );
  },
);

NormalVisualNodeContent.displayName = 'NormalVisualNodeContent';
