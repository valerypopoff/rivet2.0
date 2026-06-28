import { type DragStartEvent, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useSetAtom } from 'jotai';
import { canvasPositionState, selectedNodesState } from '../state/graphBuilder.js';
import { nodesByIdState, nodesState } from '../state/graph.js';
import { useMoveNodeCommand } from '../commands/moveNodeCommand';
import { useDuplicateNodesCommand } from '../commands/duplicateNodesCommand.js';
import { duplicateNodesWithConnections } from '../domain/graphEditing/nodeActions.js';
import {
  constrainDragDeltaToAxisLock,
  createDragDuplicatePreviewNodes,
  getDraggingConnectionSourceNodeIds,
  getDraggingPreviewNodes,
  resolveCommentEnclosureDraggedNodeIds,
  resolveDragAxisLock,
  resolveDraggedNodeIds,
  resolveDraggedSourceNodes,
  resolveDragModeFromAlt,
  shouldDisableCommentEnclosureDragOnKeyUp,
  shouldDisableStraightLineDragOnKeyUp,
  shouldEnableCommentEnclosureDragOnKeyDown,
  shouldEnableStraightLineDragOnKeyDown,
  shouldUseDuplicateDragModeOnKeyDown,
  shouldUseMoveDragModeOnKeyUp,
  type DragActivatorModifierState,
  type DragAxisLock,
  type DragDelta,
  type DragMode,
} from '../components/nodeCanvas/nodeDragInteraction.js';

type DragStartPositionMap = Map<NodeId, { x: number; y: number }>;

type UseDraggingNodeOptions = {
  nodes?: ChartNode[];
  onNodesChanged?: (nodes: ChartNode[]) => void;
  graphCommandsEnabled?: boolean;
};

function createDragStartPositionMap(nodes: ChartNode[]): DragStartPositionMap {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        x: node.visualData.x,
        y: node.visualData.y,
      },
    ]),
  );
}

function areNodeIdsEqual(left: NodeId[], right: NodeId[]): boolean {
  return left.length === right.length && left.every((nodeId, index) => nodeId === right[index]);
}

function bringNodesToFront(nodes: ChartNode[], nodeIdsToFront: NodeId[]): ChartNode[] {
  if (nodeIdsToFront.length === 0) {
    return nodes;
  }

  const nodeIdSet = new Set(nodeIdsToFront);
  const maxZIndex = nodes.reduce(
    (max, node) =>
      Math.max(max, node.visualData.zIndex && !Number.isNaN(node.visualData.zIndex) ? node.visualData.zIndex : 0),
    0,
  );

  return nodes.map((node) =>
    nodeIdSet.has(node.id) ? { ...node, visualData: { ...node.visualData, zIndex: maxZIndex + 1 } } : node,
  );
}

export const useDraggingNode = (options: UseDraggingNodeOptions = {}) => {
  const selectedNodeIds = useAtomValue(selectedNodesState);
  const setSelectedNodeIds = useSetAtom(selectedNodesState);
  const canvasPosition = useAtomValue(canvasPositionState);
  const graphNodes = useAtomValue(nodesState);
  const graphNodesById = useAtomValue(nodesByIdState);
  const setNodes = useSetAtom(nodesState);
  const controlledNodes = options.nodes;
  const controlledOnNodesChanged = options.onNodesChanged;
  const graphCommandsEnabled = options.graphCommandsEnabled ?? true;
  const controlledCanvas = Boolean(controlledNodes && controlledOnNodesChanged);
  const duplicateDragEnabled = graphCommandsEnabled || controlledCanvas;
  const nodes = controlledNodes ?? graphNodes;
  const nodesById = useMemo(
    () =>
      controlledNodes
        ? (Object.fromEntries(controlledNodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>)
        : graphNodesById,
    [controlledNodes, graphNodesById],
  );

  const [draggedSourceNodes, setDraggedSourceNodesState] = useState<ChartNode[]>([]);
  const [draggedHoverControlSourceNodeIds, setDraggedHoverControlSourceNodeIds] = useState<NodeId[]>([]);
  const [duplicatePreviewNodes, setDuplicatePreviewNodesState] = useState<ChartNode[]>([]);
  const [dragMode, setDragMode] = useState<DragMode>('move');
  const [dragAxisLock, setDragAxisLock] = useState<DragAxisLock>();
  const [dragDelta, setDragDelta] = useState<DragDelta>({ x: 0, y: 0 });
  const [isDragActive, setIsDragActive] = useState(false);

  const startPositionsRef = useRef<DragStartPositionMap>(new Map());
  const baseDraggedSourceNodeIdsRef = useRef<NodeId[]>([]);
  const draggedSourceNodeIdsRef = useRef<NodeId[]>([]);
  const dragModeRef = useRef<DragMode>('move');
  const dragAxisLockRef = useRef<DragAxisLock>();
  const isShiftDragConstraintEnabledRef = useRef(false);
  const lastDragDeltaRef = useRef<DragDelta>({ x: 0, y: 0 });
  const lastDragActivatorAltRef = useRef(false);
  const lastDragActivatorCommentEnclosureRef = useRef(false);
  const lastDragActivatorHoverControlsVisibleRef = useRef(false);
  const lastDragActivatorNodeIdRef = useRef<NodeId | undefined>();
  const lastDragActivatorShiftRef = useRef(false);
  const dragIncludesCommentRef = useRef(false);

  const moveNode = useMoveNodeCommand();
  const duplicateNodes = useDuplicateNodesCommand();

  const setSessionStartPositions = useCallback((positions: DragStartPositionMap) => {
    startPositionsRef.current = positions;
  }, []);

  const setSessionSourceNodeIds = useCallback((nodeIds: NodeId[]) => {
    draggedSourceNodeIdsRef.current = nodeIds;
  }, []);

  const setSessionSourceNodes = useCallback((sourceNodes: ChartNode[]) => {
    setDraggedSourceNodesState(sourceNodes);
  }, []);

  const setSessionPreviewNodes = useCallback((previewNodes: ChartNode[]) => {
    setDuplicatePreviewNodesState(previewNodes);
  }, []);

  const setSessionDragMode = useCallback((nextDragMode: DragMode) => {
    dragModeRef.current = nextDragMode;
    setDragMode(nextDragMode);
  }, []);

  const setSessionDragAxisLock = useCallback((nextDragAxisLock: DragAxisLock) => {
    dragAxisLockRef.current = nextDragAxisLock;
    setDragAxisLock(nextDragAxisLock);
  }, []);

  const resetDragSession = useCallback(() => {
    lastDragActivatorAltRef.current = false;
    lastDragActivatorCommentEnclosureRef.current = false;
    lastDragActivatorHoverControlsVisibleRef.current = false;
    lastDragActivatorNodeIdRef.current = undefined;
    lastDragActivatorShiftRef.current = false;
    dragIncludesCommentRef.current = false;
    isShiftDragConstraintEnabledRef.current = false;
    lastDragDeltaRef.current = { x: 0, y: 0 };
    setDragDelta({ x: 0, y: 0 });
    baseDraggedSourceNodeIdsRef.current = [];
    setSessionStartPositions(new Map());
    setSessionSourceNodeIds([]);
    setSessionSourceNodes([]);
    setDraggedHoverControlSourceNodeIds([]);
    setSessionPreviewNodes([]);
    setSessionDragMode('move');
    setSessionDragAxisLock(undefined);
    setIsDragActive(false);
  }, [
    setSessionDragAxisLock,
    setSessionDragMode,
    setSessionPreviewNodes,
    setSessionSourceNodeIds,
    setSessionSourceNodes,
    setSessionStartPositions,
  ]);

  const updateDragSourceNodes = useCallback(
    (baseDraggedNodeIds: NodeId[], includeEnclosedNodes: boolean) => {
      const nextDraggedNodeIds = resolveCommentEnclosureDraggedNodeIds({
        draggedNodeIds: baseDraggedNodeIds,
        includeEnclosedNodes,
        nodes,
      });
      const { sourceNodeIds, sourceNodes } = resolveDraggedSourceNodes(nextDraggedNodeIds, nodesById);

      if (!areNodeIdsEqual(sourceNodeIds, draggedSourceNodeIdsRef.current)) {
        setSessionSourceNodeIds(sourceNodeIds);
        setSessionSourceNodes(sourceNodes);
        setSessionPreviewNodes(createDragDuplicatePreviewNodes(sourceNodes));
        setSessionStartPositions(createDragStartPositionMap(sourceNodes));
        setDraggedHoverControlSourceNodeIds(
          lastDragActivatorHoverControlsVisibleRef.current &&
            lastDragActivatorNodeIdRef.current &&
            sourceNodeIds.includes(lastDragActivatorNodeIdRef.current)
            ? [lastDragActivatorNodeIdRef.current]
            : [],
        );
      }

      return {
        sourceNodeIds,
        sourceNodes,
      };
    },
    [
      nodes,
      nodesById,
      setSessionPreviewNodes,
      setSessionSourceNodeIds,
      setSessionSourceNodes,
      setSessionStartPositions,
    ],
  );

  useEffect(() => {
    if (!isDragActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (duplicateDragEnabled && shouldUseDuplicateDragModeOnKeyDown(event)) {
        setSessionDragMode('duplicate');
      }

      if (shouldEnableStraightLineDragOnKeyDown(event)) {
        isShiftDragConstraintEnabledRef.current = true;
        setSessionDragAxisLock(
          resolveDragAxisLock({
            axisLock: dragAxisLockRef.current,
            shiftKey: true,
            delta: lastDragDeltaRef.current,
          }),
        );
      }

      if (shouldEnableCommentEnclosureDragOnKeyDown(event)) {
        updateDragSourceNodes(baseDraggedSourceNodeIdsRef.current, true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (shouldUseMoveDragModeOnKeyUp(event)) {
        setSessionDragMode('move');
      }

      if (shouldDisableStraightLineDragOnKeyUp(event)) {
        isShiftDragConstraintEnabledRef.current = false;
        setSessionDragAxisLock(undefined);
      }

      if (shouldDisableCommentEnclosureDragOnKeyUp(event)) {
        updateDragSourceNodes(baseDraggedSourceNodeIdsRef.current, false);
      }
    };

    const handleBlur = () => {
      setSessionDragMode('move');
      updateDragSourceNodes(baseDraggedSourceNodeIdsRef.current, false);
      isShiftDragConstraintEnabledRef.current = false;
      setSessionDragAxisLock(undefined);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [duplicateDragEnabled, isDragActive, setSessionDragAxisLock, setSessionDragMode, updateDragSourceNodes]);

  const draggingNodes = useMemo(
    () =>
      getDraggingPreviewNodes({
        dragMode,
        sourceNodes: draggedSourceNodes,
        previewNodes: duplicatePreviewNodes,
      }),
    [dragMode, draggedSourceNodes, duplicatePreviewNodes],
  );

  const draggedSourceNodeIds = useMemo(() => draggedSourceNodes.map((node) => node.id), [draggedSourceNodes]);

  const draggingConnectionSourceNodeIds = useMemo(
    () =>
      getDraggingConnectionSourceNodeIds({
        dragMode,
        sourceNodeIds: draggedSourceNodeIds,
      }),
    [dragMode, draggedSourceNodeIds],
  );

  const onNodeDragActivatorPointerDown = useCallback((modifierState: DragActivatorModifierState) => {
    lastDragActivatorAltRef.current = modifierState.altKey;
    lastDragActivatorCommentEnclosureRef.current = modifierState.ctrlKey || modifierState.metaKey;
    lastDragActivatorHoverControlsVisibleRef.current = modifierState.hoverControlsVisible;
    lastDragActivatorNodeIdRef.current = modifierState.nodeId;
    lastDragActivatorShiftRef.current = modifierState.shiftKey;
  }, []);

  const onNodeStartDrag = useCallback(
    (e: DragStartEvent) => {
      const draggedNodeId = e.active.id as NodeId;
      const baseDraggedNodeIds = resolveDraggedNodeIds(selectedNodeIds, draggedNodeId);
      baseDraggedSourceNodeIdsRef.current = baseDraggedNodeIds;
      const { sourceNodes } = updateDragSourceNodes(baseDraggedNodeIds, lastDragActivatorCommentEnclosureRef.current);
      if (sourceNodes.length === 0) {
        resetDragSession();
        return;
      }

      dragIncludesCommentRef.current = sourceNodes.some((node) => node.type === 'comment');
      isShiftDragConstraintEnabledRef.current = lastDragActivatorShiftRef.current;
      lastDragDeltaRef.current = { x: 0, y: 0 };
      setSessionDragAxisLock(undefined);
      setSessionDragMode(duplicateDragEnabled ? resolveDragModeFromAlt(lastDragActivatorAltRef.current) : 'move');
      setIsDragActive(true);
    },
    [
      duplicateDragEnabled,
      resetDragSession,
      selectedNodeIds,
      setSessionDragAxisLock,
      setSessionDragMode,
      updateDragSourceNodes,
    ],
  );

  const onNodeDraggedMove = useCallback(
    ({ delta }: DragMoveEvent) => {
      const nextDelta = {
        x: delta.x,
        y: delta.y,
      };

      lastDragDeltaRef.current = nextDelta;
      if (dragIncludesCommentRef.current) {
        setDragDelta(nextDelta);
      }
      setSessionDragAxisLock(
        resolveDragAxisLock({
          axisLock: dragAxisLockRef.current,
          shiftKey: isShiftDragConstraintEnabledRef.current,
          delta: nextDelta,
        }),
      );
    },
    [setSessionDragAxisLock],
  );

  const onNodeDragged = useCallback(
    ({ delta }: DragEndEvent) => {
      const actualDelta = constrainDragDeltaToAxisLock(
        {
          x: delta.x / canvasPosition.zoom,
          y: delta.y / canvasPosition.zoom,
        },
        dragAxisLockRef.current,
      );

      const finalDragMode = dragModeRef.current;
      const sourceNodeIds = draggedSourceNodeIdsRef.current;
      const initialPositions = startPositionsRef.current;

      try {
        if (finalDragMode === 'duplicate') {
          if (sourceNodeIds.length === 0) {
            return;
          }

          if (!graphCommandsEnabled && controlledOnNodesChanged) {
            const { newNodes } = duplicateNodesWithConnections({
              nodes,
              nodeIds: sourceNodeIds,
              connections: [],
              delta: actualDelta,
            });

            controlledOnNodesChanged(bringNodesToFront([...nodes, ...newNodes], newNodes.map((node) => node.id)));
            setSelectedNodeIds(newNodes.map((node) => node.id));
            return;
          }

          duplicateNodes({
            nodeIds: sourceNodeIds,
            delta: actualDelta,
          });

          return;
        }

        if (sourceNodeIds.length === 0) {
          return;
        }

        if (!graphCommandsEnabled) {
          controlledOnNodesChanged?.(
            bringNodesToFront(
              nodes.map((node) => {
                const initialPosition = initialPositions.get(node.id);
                if (!initialPosition) {
                  return node;
                }

                return {
                  ...node,
                  visualData: {
                    ...node.visualData,
                    x: initialPosition.x + actualDelta.x,
                    y: initialPosition.y + actualDelta.y,
                  },
                };
              }),
              sourceNodeIds,
            ),
          );
          return;
        }

        moveNode({
          moves: sourceNodeIds.map((nodeId) => {
            const initialPosition = initialPositions.get(nodeId);
            if (!initialPosition) {
              throw new Error(`Initial position not found for nodeId ${nodeId}`);
            }

            return {
              nodeId,
              position: {
                x: initialPosition.x + actualDelta.x,
                y: initialPosition.y + actualDelta.y,
              },
            };
          }),
        });
        setNodes((currentNodes) => bringNodesToFront(currentNodes, sourceNodeIds));
      } finally {
        resetDragSession();
      }
    },
    [
      canvasPosition.zoom,
      controlledOnNodesChanged,
      duplicateNodes,
      graphCommandsEnabled,
      moveNode,
      nodes,
      resetDragSession,
      setSelectedNodeIds,
      setNodes,
    ],
  );

  const onNodeDragCancelled = useCallback(() => {
    resetDragSession();
  }, [resetDragSession]);

  return {
    dragAxisLock,
    dragDelta,
    dragMode,
    draggingConnectionSourceNodeIds,
    draggingNodes,
    draggedSourceNodeIds,
    draggedHoverControlSourceNodeIds,
    onNodeDragActivatorPointerDown,
    onNodeDragCancelled,
    onNodeDraggedMove,
    onNodeStartDrag,
    onNodeDragged,
  };
};
