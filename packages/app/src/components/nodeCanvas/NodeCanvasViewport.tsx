import { DragOverlay } from '@dnd-kit/core';
import clsx from 'clsx';
import { type FC, type ContextType, memo, useMemo } from 'react';
import {
  getNodePrefabInstancePrefabId,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { CanvasHandlersContext, CanvasViewContext } from '../CanvasContext.js';
import { DraggableNode } from '../DraggableNode.js';
import { VisualNode } from '../VisualNode.js';
import { countCanvasPerf } from './canvasPerfDebug.js';
import {
  constrainDragDeltaToAxisLock,
  type DragActivatorModifierState,
  type DragAxisLock,
  type DragMode,
} from './nodeDragInteraction.js';
import type { useNodeTypes } from '../../hooks/useNodeTypes.js';
import type { PageValue, ProcessDataForNode } from '../../state/dataFlow.js';
import { resolveDraggingExecutionContext } from './dragOverlayExecutionContext.js';
import { projectState } from '../../state/savedGraphs.js';
import { resolveCanvasExecutionProcessPage } from '../../state/selectors/executionSelectors.js';

type CanvasViewValue = ContextType<typeof CanvasViewContext>;
type CanvasHandlersValue = ContextType<typeof CanvasHandlersContext>;
type NodeTypes = ReturnType<typeof useNodeTypes>;
export type NodeCanvasLayer = 'comments' | 'nodes';

export interface NodeCanvasViewportProps {
  canvasHandlersContextValue: CanvasHandlersValue;
  canvasPositionX: number;
  canvasPositionY: number;
  canvasZoom: number;
  canvasViewContextValue: CanvasViewValue;
  dragAxisLock: DragAxisLock;
  dragDelta: { x: number; y: number };
  dragMode: DragMode;
  draggingHoverControlSourceNodeIds: NodeId[];
  draggingNodeConnections: NodeConnection[];
  draggingNodes: ChartNode[];
  draggingSourceNodeIds: NodeId[];
  heavyContentNodeIdSet: ReadonlySet<NodeId>;
  hoveredNodeId: NodeId | undefined;
  lastRunPerNode: Record<NodeId, ProcessDataForNode[] | undefined>;
  layer: NodeCanvasLayer;
  nodeTypes: NodeTypes;
  nodeCompareKindsById: Record<NodeId, ProjectComparisonChangeKind | undefined>;
  compareRemovedNodes: ChartNode[];
  nodesWithConnections: Array<{ node: ChartNode; nodeConnections: NodeConnection[] }>;
  onNodeDragActivatorPointerDown: (modifierState: DragActivatorModifierState) => void;
  expandedOutputNodeIds: NodeId[];
  searchMatchingNodeIds: NodeId[];
  selectedNodeIds: NodeId[];
  selectedProcessPagePerNode: Record<NodeId, PageValue>;
  visibleNodeIdSet: ReadonlySet<NodeId>;
}

export const NodeCanvasViewport: FC<NodeCanvasViewportProps> = ({
  canvasPositionX,
  canvasPositionY,
  canvasZoom,
  layer,
  ...sceneProps
}) => {
  return (
    <div
      className={clsx('canvas-contents', layer === 'comments' ? 'canvas-comment-contents' : 'canvas-node-contents')}
      style={{
        transform: `scale(${canvasZoom}, ${canvasZoom}) translate(${canvasPositionX}px, ${canvasPositionY}px)`,
      }}
    >
      <NodeCanvasScene canvasZoom={canvasZoom} layer={layer} {...sceneProps} />
    </div>
  );
};

const NodeCanvasScene: FC<Omit<NodeCanvasViewportProps, 'canvasPositionX' | 'canvasPositionY'>> = memo(
  ({
    canvasHandlersContextValue,
    canvasViewContextValue,
    canvasZoom,
    dragAxisLock,
    dragDelta,
    dragMode,
    draggingHoverControlSourceNodeIds,
    draggingNodeConnections,
    draggingNodes,
    draggingSourceNodeIds,
    heavyContentNodeIdSet,
    hoveredNodeId,
    lastRunPerNode,
    layer,
    nodeTypes,
    nodeCompareKindsById,
    compareRemovedNodes,
    nodesWithConnections,
    onNodeDragActivatorPointerDown,
    expandedOutputNodeIds,
    searchMatchingNodeIds,
    selectedNodeIds,
    selectedProcessPagePerNode,
    visibleNodeIdSet,
  }) => {
    countCanvasPerf('NodeCanvasScene:renders');
    const project = useAtomValue(projectState);
    const isKnownNodeType = (node: ChartNode) => {
      const prefabId = getNodePrefabInstancePrefabId(node);
      const effectiveType = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode.type ?? node.type : node.type;
      return effectiveType in nodeTypes;
    };
    const draggingNodeEntries = useMemo(() => draggingNodes.map((node, index) => ({ node, index })), [draggingNodes]);
    const draggingNodeIdSet = useMemo(() => new Set(draggingNodes.map((node) => node.id)), [draggingNodes]);
    const backgroundCommentDragEntries = useMemo(
      () => (layer === 'comments' ? draggingNodeEntries.filter(({ node }) => node.type === 'comment') : []),
      [draggingNodeEntries, layer],
    );
    const foregroundDragEntries = useMemo(
      () => (layer === 'nodes' ? draggingNodeEntries.filter(({ node }) => node.type !== 'comment') : []),
      [draggingNodeEntries, layer],
    );
    const draggingHoverControlSourceNodeIdSet = useMemo(
      () => new Set(draggingHoverControlSourceNodeIds),
      [draggingHoverControlSourceNodeIds],
    );
    const expandedOutputNodeIdSet = useMemo(() => new Set(expandedOutputNodeIds), [expandedOutputNodeIds]);
    const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
    const searchMatchingNodeIdSet = useMemo(() => new Set(searchMatchingNodeIds), [searchMatchingNodeIds]);
    const constrainedCommentDragDelta = useMemo(() => {
      const constrainedDelta = constrainDragDeltaToAxisLock(dragDelta, dragAxisLock);

      return {
        x: constrainedDelta.x / canvasZoom,
        y: constrainedDelta.y / canvasZoom,
      };
    }, [canvasZoom, dragAxisLock, dragDelta]);

    return (
      <CanvasViewContext.Provider value={canvasViewContextValue}>
        <CanvasHandlersContext.Provider value={canvasHandlersContextValue}>
          <div className="nodes">
            {compareRemovedNodes
              .filter((node) => (layer === 'comments' ? node.type === 'comment' : node.type !== 'comment'))
              .map((node) => (
                <VisualNode
                  key={`compare-removed-${node.id}`}
                  node={node}
                  compareChangeKind="removed"
                  isKnownNodeType={isKnownNodeType(node)}
                  isOutputExpanded={false}
                  processPage={0}
                  renderHeavyContent={false}
                />
              ))}
            {backgroundCommentDragEntries.map(({ node, index }) => {
              const { isOutputExpanded, lastRun, processPage, executionSourceNodeId } =
                resolveDraggingExecutionContext({
                  dragMode,
                  draggingNodeId: node.id,
                  draggingSourceNodeIds,
                  index,
                  expandedOutputNodeIdSet,
                  lastRunPerNode,
                  selectedProcessPagePerNode,
                });

              return (
                <VisualNode
                  key={`comment-drag-preview-${node.id}`}
                  node={node}
                  xDelta={constrainedCommentDragDelta.x}
                  yDelta={constrainedCommentDragDelta.y}
                  isOverlay
                  isKnownNodeType={isKnownNodeType(node)}
                  isOutputExpanded={isOutputExpanded}
                  isSelected={selectedNodeIdSet.has(executionSourceNodeId)}
                  compareChangeKind={nodeCompareKindsById[node.id]}
                  lastRun={lastRun}
                  processPage={processPage}
                  renderHeavyContent
                  shouldShowHoverControls={draggingHoverControlSourceNodeIdSet.has(executionSourceNodeId)}
                />
              );
            })}
            {nodesWithConnections.map(({ node, nodeConnections }) => {
              const belongsToLayer = layer === 'comments' ? node.type === 'comment' : node.type !== 'comment';

              if (!belongsToLayer) {
                return null;
              }

              if (!visibleNodeIdSet.has(node.id) || draggingNodeIdSet.has(node.id)) {
                return null;
              }

              return (
                <DraggableNode
                  key={node.id}
                  dragAxisLock={dragAxisLock}
                  dragMode={dragMode}
                  node={node}
                  connections={nodeConnections}
                  compareChangeKind={nodeCompareKindsById[node.id]}
                  isHovered={hoveredNodeId === node.id}
                  isSelected={selectedNodeIdSet.has(node.id)}
                  isSearchMatch={searchMatchingNodeIdSet.has(node.id)}
                  isKnownNodeType={isKnownNodeType(node)}
                  lastRun={lastRunPerNode[node.id]}
                  onDragActivatorPointerDown={onNodeDragActivatorPointerDown}
                  isOutputExpanded={expandedOutputNodeIdSet.has(node.id)}
                  processPage={resolveCanvasExecutionProcessPage(selectedProcessPagePerNode[node.id])}
                  renderHeavyContent={heavyContentNodeIdSet.has(node.id)}
                />
              );
            })}
          </div>
          {foregroundDragEntries.length > 0 && (
            <DragOverlay
              dropAnimation={null}
              style={{ position: 'absolute', top: 0, left: 0 }}
              modifiers={[
                (args) => {
                  const constrainedTransform = constrainDragDeltaToAxisLock(args.transform, dragAxisLock);

                  return {
                    ...constrainedTransform,
                    scaleX: 1,
                    scaleY: 1,
                    x: constrainedTransform.x / canvasZoom,
                    y: constrainedTransform.y / canvasZoom,
                  };
                },
              ]}
            >
              {foregroundDragEntries.map(({ node, index }) => {
                const { isOutputExpanded, lastRun, processPage, executionSourceNodeId } =
                  resolveDraggingExecutionContext({
                    dragMode,
                    draggingNodeId: node.id,
                    draggingSourceNodeIds,
                    index,
                    expandedOutputNodeIdSet,
                    lastRunPerNode,
                    selectedProcessPagePerNode,
                  });

                return (
                  <VisualNode
                    key={node.id}
                    node={node}
                    connections={draggingNodeConnections}
                    compareChangeKind={nodeCompareKindsById[node.id]}
                    isOverlay
                    isKnownNodeType={isKnownNodeType(node)}
                    isOutputExpanded={isOutputExpanded}
                    lastRun={lastRun}
                    processPage={processPage}
                    renderHeavyContent
                    shouldShowHoverControls={draggingHoverControlSourceNodeIdSet.has(executionSourceNodeId)}
                  />
                );
              })}
            </DragOverlay>
          )}
        </CanvasHandlersContext.Provider>
      </CanvasViewContext.Provider>
    );
  },
);

NodeCanvasScene.displayName = 'NodeCanvasScene';
