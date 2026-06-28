import { DndContext, useDroppable } from '@dnd-kit/core';
import clsx from 'clsx';
import { useMergeRefs } from '@floating-ui/react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { type CSSProperties, type FC, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ChartNode,
  type CommentNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
  resolveNodePrefabInstance,
} from '@valerypopoff/rivet2-core';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';
import { useResizeNodesCommand } from '../commands/resizeNodesCommand';
import { useCanvasHotkeys } from '../hooks/useCanvasHotkeys';
import { useCanvasPositioning } from '../hooks/useCanvasPositioning.js';
import { useContextMenu } from '../hooks/useContextMenu.js';
import { useCopyNodesHotkeys } from '../hooks/useCopyNodesHotkeys';
import { useDraggingNode } from '../hooks/useDraggingNode.js';
import { useDraggingWire } from '../hooks/useDraggingWire.js';
import { useGlobalHotkey } from '../hooks/useGlobalHotkey.js';
import { useNodeHeightCache } from '../hooks/useNodeBodyHeight';
import { useNodePortPositions } from '../hooks/useNodePortPositions';
import { useNodeTypes } from '../hooks/useNodeTypes';
import { useProjectNodeRegistry } from '../hooks/useProjectNodeRegistry';
import { usePortHoverTooltip } from '../hooks/usePortHoverTooltip.js';
import { useSearchGraph } from '../hooks/useSearchGraph';
import { useSelectionBox } from '../hooks/useSelectionBox.js';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useViewportBounds } from '../hooks/useViewportBounds.js';
import { useVisibleCanvasNodes } from '../hooks/useVisibleCanvasNodes';
import { useWireDragScrolling } from '../hooks/useWireDragScrolling';
import { isMacOSPlatform } from '../utils/platform/os.js';
import {
  canvasPositionState,
  editingNodeState,
  searchingGraphState,
  lastCanvasPositionByGraphState,
  lastMousePositionState,
  selectedNodesState,
  draggingWireClosestPortState,
  hoveringNodeState,
  expandedOutputNodeIdsState,
  fullscreenOutputNodeState,
} from '../state/graphBuilder';
import { graphMetadataState } from '../state/graph.js';
import {
  frozenNodeOutputsState,
  graphRunningState,
  lastRunDataByNodeState,
  resolvedGraphSelectionState,
  selectedProcessPageNodesState,
} from '../state/dataFlow';
import { projectState, referencedProjectsState } from '../state/savedGraphs.js';
import {
  canvasBackgroundPatternOpacityState,
  canvasBackgroundPatternState,
  canvasBackgroundColorModeState,
  canvasBackgroundCustomColorState,
  clampCanvasBackgroundPatternOpacity,
  getCanvasBackgroundColor,
  preservePortTextCaseState,
  resolveCanvasBackgroundColorMode,
  resolveCanvasBackgroundPattern,
  selectedExecutorState,
  zoomSensitivityState,
} from '../state/settings';
import { canvasPreviewConnectionsState } from '../state/selectors/canvasGraphSelectors.js';
import { canRunGraphFromEditor } from '../state/selectors/executionSelectors.js';
import { MouseIcon } from './MouseIcon';
import { type ContextMenuContext } from './ContextMenu.js';
import { nodeCanvasStyles } from './nodeCanvas/nodeCanvasStyles.js';
import { NodeCanvasOverlays } from './nodeCanvas/NodeCanvasOverlays.js';
import { MultiNodeAlignmentToolbar } from './nodeCanvas/MultiNodeAlignmentToolbar.js';
import { NodeCanvasViewport } from './nodeCanvas/NodeCanvasViewport.js';
import { useNodeCanvasInteractions } from './nodeCanvas/useNodeCanvasInteractions.js';
import { WireLayer } from './WireLayer.js';
import { applyResizeChangesToNodes, type NodeResizeBounds } from '../utils/nodeResize.js';
import { getCanvasCommentHeight, getCanvasNodeWidth } from '../hooks/canvasVisibilityBounds.js';
import { MEDIUM_GRAPH_NODE_THRESHOLD } from './nodeCanvas/canvasPerformanceBudget.js';
import { getCanvasPerfSnapshot } from './nodeCanvas/canvasPerfDebug.js';
import { CanvasBackgroundPatternLayer } from './nodeCanvas/CanvasBackgroundPattern.js';
import { groupConnectionsByNode } from './nodeCanvas/groupConnectionsByNode.js';
import { getDraggingViewportNodeIds } from './nodeCanvas/draggingViewportNodeIds.js';
import { filterValidSubGraphConnections } from '../domain/graphEditing/connectionValidation.js';
import { useExecutorSessionState } from '../hooks/useExecutorSession.js';
import { loadedRecordingState } from '../state/execution.js';
import { type DragActivatorModifierState } from './nodeCanvas/nodeDragInteraction.js';
import {
  getCanvasHighlightedNodeIds,
  getCanvasSearchMatchingNodeIds,
  getCanvasSelectedInteractionNodeIds,
} from './nodeCanvas/nodeCanvasInteractionModel.js';
import { getNodeCanvasContextMenuContext } from './nodeCanvas/nodeCanvasContextMenuModel.js';
import { subGraphPortRearrangeTargetState, uiFontSizeState, variadicPortRearrangeTargetState } from '../state/ui.js';
import { getMinimumNodeWidthForPortLabels } from '../utils/nodePortLabelWidth.js';
import { getUiFontScale } from '../utils/uiFontSize.js';
import { blurFocusedGraphFilterInput } from './graphList/graphFilterFocus.js';
import { selectedGraphProjectComparisonState } from '../state/projectComparison.js';
import {
  EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE,
  getCanvasProjectComparisonRenderState,
} from './nodeCanvas/projectComparisonCanvas.js';
import {
  type ActiveResizeGroup,
  type ResizeNodeSnapshot,
  createResizeNodeSnapshot,
  getChangedResizeEntries,
  getRenderedMinWidth,
  getResizeChangesForGroup,
  getResizeNodeIds,
  parseFiniteStyleNumber,
} from './nodeCanvas/nodeCanvasResizeModel.js';

const EMPTY_NODE_CONNECTIONS: NodeConnection[] = [];
const EMPTY_EXPANDED_OUTPUT_NODE_IDS: NodeId[] = [];
const EMPTY_RUN_DATA_BY_NODE: Record<NodeId, undefined> = {};
const EMPTY_PROCESS_PAGE_BY_NODE: Record<NodeId, never> = {};

type NodeScopedUiTarget = {
  graphId: string;
  nodeId: NodeId;
  projectId: string;
};

function shouldClearNodeScopedUiTarget(options: {
  currentGraphId: string | undefined;
  currentProjectId: string;
  nodes: readonly ChartNode[];
  target: NodeScopedUiTarget | undefined;
}): boolean {
  if (!options.target) {
    return false;
  }

  return (
    options.target.projectId !== options.currentProjectId ||
    options.target.graphId !== options.currentGraphId ||
    !options.nodes.some((node) => node.id === options.target!.nodeId)
  );
}

export interface NodeCanvasProps {
  nodes: ChartNode[];
  connections: NodeConnection[];
  selectedNodes: ChartNode[];
  onNodesChanged: (nodes: ChartNode[]) => void;
  onConnectionsChanged: (connections: NodeConnection[]) => void;
  onNodeSelected: (node: ChartNode, multi: boolean) => void;
  onNodeStartEditing?: (node: ChartNode) => void;
  onCanvasClick?: () => void;
  onNodesDeleted?: (nodeIds: NodeId[]) => void;
  onContextMenuItemSelected?: (
    menuItemId: string,
    data: unknown,
    context: ContextMenuContext,
    meta: { x: number; y: number },
  ) => void;
  disableConnections?: boolean;
  disableGraphCommands?: boolean;
  pasteCommandsEnabled?: boolean;
}

export type PortPositions = Record<string, { x: number; y: number }>;

export const NodeCanvas: FC<NodeCanvasProps> = ({
  nodes,
  connections: _connections,
  selectedNodes,
  onNodesChanged,
  onConnectionsChanged,
  onNodeSelected,
  onNodeStartEditing,
  onCanvasClick,
  onNodesDeleted,
  onContextMenuItemSelected,
  disableConnections = false,
  disableGraphCommands = false,
  pasteCommandsEnabled = !disableGraphCommands,
}) => {
  const [canvasPosition, setCanvasPosition] = useAtom(canvasPositionState);
  const [editingNodeId, setEditingNodeId] = useAtom(editingNodeState);
  const [selectedNodeIds, setSelectedNodeIds] = useAtom(selectedNodesState);
  const [hoveringNode, setHoveringNode] = useAtom(hoveringNodeState);
  const [subGraphPortRearrangeTarget, setSubGraphPortRearrangeTarget] = useAtom(subGraphPortRearrangeTargetState);
  const [variadicPortRearrangeTarget, setVariadicPortRearrangeTarget] = useAtom(variadicPortRearrangeTargetState);
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, canvasStartX: 0, canvasStartY: 0 });
  const [contextMenuDisabled, setContextMenuDisabled] = useState(true);
  const canvasRootRef = useRef<HTMLDivElement>(null);
  const nodeDragGestureActiveRef = useRef(false);
  const hoverSyncAnimationFrameRef = useRef<number | undefined>();
  const activeResizeGroupRef = useRef<ActiveResizeGroup | null>(null);

  const selectedGraphMetadata = useAtomValue(graphMetadataState);
  const closestPort = useAtomValue(draggingWireClosestPortState);
  const graphSearch = useAtomValue(searchingGraphState);
  const expandedOutputNodeIds = useAtomValue(expandedOutputNodeIdsState);
  const fullscreenOutputNodeId = useAtomValue(fullscreenOutputNodeState);
  const lastRunPerNode = useAtomValue(lastRunDataByNodeState);
  const frozenNodeOutputs = useAtomValue(frozenNodeOutputsState);
  const graphSelection = useAtomValue(resolvedGraphSelectionState);
  const selectedProcessPagePerNode = useAtomValue(selectedProcessPageNodesState);
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const graphRunning = useAtomValue(graphRunningState);
  const loadedRecording = useAtomValue(loadedRecordingState);
  const zoomSensitivity = useAtomValue(zoomSensitivityState);
  const canvasBackgroundColorMode = useAtomValue(canvasBackgroundColorModeState);
  const canvasBackgroundCustomColor = useAtomValue(canvasBackgroundCustomColorState);
  const canvasBackgroundPattern = useAtomValue(canvasBackgroundPatternState);
  const canvasBackgroundPatternOpacity = useAtomValue(canvasBackgroundPatternOpacityState);
  const preservePortCase = useAtomValue(preservePortTextCaseState);
  const uiFontSize = useAtomValue(uiFontSizeState);
  const rawPreviewConnections = useAtomValue(canvasPreviewConnectionsState);
  const project = useAtomValue(projectState);
  const referencedProjects = useAtomValue(referencedProjectsState);
  const selectedGraphComparison = useAtomValue(selectedGraphProjectComparisonState);
  const executorSession = useExecutorSessionState();
  const canStartEditorGraphRun = canRunGraphFromEditor({
    hasLoadedRecording: loadedRecording != null,
    selectedExecutor,
    session: executorSession,
  }) && !disableGraphCommands;
  const freezeUnavailableReason =
    loadedRecording != null
      ? 'Freeze node output is unavailable while viewing a recording.'
      : executorSession.target?.type === 'external-debugger'
        ? 'Freeze node output is unavailable while the Remote Debugger is active.'
        : graphRunning
          ? 'Stop the current run before freezing node outputs.'
          : !canStartEditorGraphRun
            ? 'Freeze node output is unavailable until editor runs are available.'
            : undefined;
  const canUseFrozenNodes = freezeUnavailableReason == null;

  const setLastSavedCanvasPosition = useSetAtom(lastCanvasPositionByGraphState);
  const setLastMousePosition = useSetAtom(lastMousePositionState);
  const normalizedCanvasBackgroundPattern = resolveCanvasBackgroundPattern(canvasBackgroundPattern);
  const normalizedCanvasBackgroundPatternOpacity = clampCanvasBackgroundPatternOpacity(canvasBackgroundPatternOpacity);
  const canvasBackgroundColor = getCanvasBackgroundColor({
    mode: resolveCanvasBackgroundColorMode(canvasBackgroundColorMode),
    customColor: canvasBackgroundCustomColor,
  });

  const { clientToCanvasPosition } = useCanvasPositioning();
  const removeNodes = useDeleteNodesCommand();
  const resizeNodes = useResizeNodesCommand();
  const cache = useNodeHeightCache();
  const nodeTypes = useNodeTypes();
  const projectNodeRegistry = useProjectNodeRegistry();
  const canvasNodesById = useMemo(() => Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<NodeId, ChartNode>, [nodes]);
  const canvasEffectiveNodesById = useMemo(
    () =>
      Object.fromEntries(nodes.map((node) => [node.id, resolveNodePrefabInstance(project, node)])) as Record<
        NodeId,
        ChartNode
      >,
    [nodes, project],
  );

  const connections = useMemo(
    () =>
      filterValidSubGraphConnections({
        connections: _connections,
        nodesById: canvasEffectiveNodesById,
        project,
        projectNodeRegistry,
        referencedProjects,
      }),
    [_connections, canvasEffectiveNodesById, project, projectNodeRegistry, referencedProjects],
  );
  const previewConnections = useMemo(
    () =>
      disableConnections
        ? []
        : filterValidSubGraphConnections({
            connections: rawPreviewConnections,
            nodesById: canvasEffectiveNodesById,
            project,
            projectNodeRegistry,
            referencedProjects,
          }),
    [canvasEffectiveNodesById, disableConnections, project, projectNodeRegistry, rawPreviewConnections, referencedProjects],
  );

  useEffect(() => {
    if (connections.length === _connections.length) {
      return;
    }

    onConnectionsChanged(connections);
  }, [_connections.length, connections, onConnectionsChanged]);

  useEffect(() => {
    const targetOptions = {
      currentGraphId: selectedGraphMetadata?.id,
      currentProjectId: project.metadata.id,
      nodes,
    };

    if (shouldClearNodeScopedUiTarget({ ...targetOptions, target: subGraphPortRearrangeTarget })) {
      setSubGraphPortRearrangeTarget(undefined);
    }

    if (shouldClearNodeScopedUiTarget({ ...targetOptions, target: variadicPortRearrangeTarget })) {
      setVariadicPortRearrangeTarget(undefined);
    }
  }, [
    nodes,
    project.metadata.id,
    selectedGraphMetadata?.id,
    setSubGraphPortRearrangeTarget,
    setVariadicPortRearrangeTarget,
    subGraphPortRearrangeTarget,
    variadicPortRearrangeTarget,
  ]);

  const projectWithCanvasGraph = useMemo(() => {
    if (!selectedGraphMetadata?.id) {
      return project;
    }

    return {
      ...project,
      graphs: {
        ...project.graphs,
        [selectedGraphMetadata.id]: {
          metadata: selectedGraphMetadata,
          nodes,
          connections,
        },
      },
    };
  }, [connections, nodes, project, selectedGraphMetadata]);

  const { selectionBox, startSelectionBox, updateSelectionBox, endSelectionBox } = useSelectionBox();
  const {
    hoveringPort,
    hoveringShowPortInfo,
    onPortMouseOver: showPortTooltip,
    onPortMouseOut: hidePortTooltip,
    floatingStyles,
    floatingRefs,
  } = usePortHoverTooltip();

  const {
    dragAxisLock,
    dragDelta,
    dragMode,
    draggingConnectionSourceNodeIds,
    draggedHoverControlSourceNodeIds,
    draggingNodes,
    draggedSourceNodeIds,
    onNodeDragActivatorPointerDown,
    onNodeDragCancelled,
    onNodeDraggedMove,
    onNodeStartDrag,
    onNodeDragged,
  } = useDraggingNode({
    graphCommandsEnabled: !disableGraphCommands,
    nodes,
    onNodesChanged,
  });
  const {
    clearDraggingWire: cancelWireDrag,
    draggingWire,
    onWireStartDrag,
    onWireEndDrag,
  } = useDraggingWire({
    connections,
    enabled: !disableConnections,
    nodesById: canvasEffectiveNodesById,
  });
  useEffect(() => {
    if (disableConnections) {
      cancelWireDrag();
    }
  }, [cancelWireDrag, disableConnections]);

  const visibleDraggingWire = disableConnections ? undefined : draggingWire;
  const visibleClosestPort = disableConnections ? undefined : closestPort;
  const isDraggingNode = draggingNodes.length > 0;
  const isDraggingWire = !!visibleDraggingWire;

  const isNodeDragGestureActive = useStableCallback(() => nodeDragGestureActiveRef.current);

  const clearNodeDragGesture = useStableCallback(() => {
    nodeDragGestureActiveRef.current = false;
  });

  const handleNodeDragActivatorPointerDown = useStableCallback((modifierState: DragActivatorModifierState) => {
    nodeDragGestureActiveRef.current = true;
    setIsDraggingCanvas(false);
    onNodeDragActivatorPointerDown(modifierState);
  });

  useEffect(() => {
    window.addEventListener('pointercancel', clearNodeDragGesture);
    window.addEventListener('pointerup', clearNodeDragGesture);
    window.addEventListener('mouseup', clearNodeDragGesture);
    window.addEventListener('blur', clearNodeDragGesture);

    return () => {
      window.removeEventListener('pointercancel', clearNodeDragGesture);
      window.removeEventListener('pointerup', clearNodeDragGesture);
      window.removeEventListener('mouseup', clearNodeDragGesture);
      window.removeEventListener('blur', clearNodeDragGesture);
    };
  }, [clearNodeDragGesture]);

  useEffect(
    () => () => {
      if (hoverSyncAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(hoverSyncAnimationFrameRef.current);
      }
    },
    [],
  );

  const shouldRenderWires = !disableConnections && canvasPosition.zoom > 0.15;
  const viewportBounds = useViewportBounds(canvasRootRef);
  const draggingViewportNodeIds = useMemo(
    () => getDraggingViewportNodeIds({ draggedSourceNodeIds, draggingNodes }),
    [draggedSourceNodeIds, draggingNodes],
  );

  const {
    contextMenuRef,
    showContextMenu,
    contextMenuData,
    handleContextMenu,
    setShowContextMenu,
    setContextMenuData,
  } = useContextMenu();

  const connectionsByNodeId = useMemo(() => groupConnectionsByNode(previewConnections), [previewConnections]);
  const graphStateOverlaysEnabled = !disableGraphCommands;
  const comparisonRenderState = useMemo(
    () =>
      graphStateOverlaysEnabled
        ? getCanvasProjectComparisonRenderState(selectedGraphComparison)
        : EMPTY_CANVAS_PROJECT_COMPARISON_RENDER_STATE,
    [graphStateOverlaysEnabled, selectedGraphComparison],
  );
  const nodesWithConnections = useMemo(
    () =>
      nodes.map((node) => ({
        node,
        nodeConnections: connectionsByNodeId[node.id] ?? EMPTY_NODE_CONNECTIONS,
      })),
    [connectionsByNodeId, nodes],
  );

  const draggingNodeConnections = useMemo(() => {
    const draggingNodeIdSet = new Set(draggingConnectionSourceNodeIds);

    return previewConnections.filter(
      (connection) => draggingNodeIdSet.has(connection.inputNodeId) || draggingNodeIdSet.has(connection.outputNodeId),
    );
  }, [draggingConnectionSourceNodeIds, previewConnections]);

  const contextMenuItemSelected = useStableCallback(
    (itemId: string, data: unknown, context: ContextMenuContext, meta: { x: number; y: number }) => {
      onContextMenuItemSelected?.(itemId, data, context, meta);
      setShowContextMenu(false);
    },
  );

  const handleCanvasContextMenuRequest = useStableCallback(
    (event: { clientX: number; clientY: number; target: EventTarget }) => {
      if (visibleDraggingWire) {
        cancelWireDrag();
        setShowContextMenu(false);
        return;
      }

      handleContextMenu(event);
    },
  );

  const {
    canvasMouseDown,
    canvasMouseMove,
    canvasMouseUp,
    handleCanvasContextMenu,
    handleZoom,
    lastMouseInfoRef,
  } = useNodeCanvasInteractions({
    canvasPosition,
    clientToCanvasPosition,
    dragStart,
    endSelectionBox,
    isDraggingCanvas,
    nodes,
    onCanvasClick,
    onCanvasContextMenu: handleCanvasContextMenuRequest,
    selectedGraphId: selectedGraphMetadata?.id,
    selectedNodeIds,
    selectionBox,
    setCanvasPosition,
    setDragStart,
    setEditingNodeId,
    setIsDraggingCanvas,
    setLastMousePosition,
    setLastSavedCanvasPosition,
    setSelectedNodeIds,
    startSelectionBox,
    isNodeDragGestureActive,
    updateSelectionBox,
    zoomSensitivity,
  });

  const handleCanvasMouseDownCapture = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
    blurFocusedGraphFilterInput(event.currentTarget.ownerDocument);
  });

  useWireDragScrolling();

  const getRenderedNodeElement = useStableCallback((nodeId: NodeId): HTMLElement | undefined => {
    const root = canvasRootRef.current;
    if (!root) {
      return undefined;
    }

    for (const element of root.querySelectorAll<HTMLElement>('.node[data-nodeid]:not(.overlayNode)')) {
      if (element.dataset.nodeid === nodeId) {
        return element;
      }
    }

    return undefined;
  });

  const getResizeMinWidthForNode = useStableCallback(
    (node: ChartNode, computedStyle: CSSStyleDeclaration | undefined): number => {
      const renderedMinWidth = getRenderedMinWidth(computedStyle);
      if (node.type === 'comment') {
        return renderedMinWidth;
      }

      try {
        const instance = projectNodeRegistry.createDynamicImpl(node);
        const nodeConnections = connectionsByNodeId[node.id] ?? EMPTY_NODE_CONNECTIONS;
        const inputDefinitions = instance.getInputDefinitionsIncludingBuiltIn(
          nodeConnections,
          canvasEffectiveNodesById,
          project,
          referencedProjects,
        );
        const outputDefinitions = instance.getOutputDefinitions(
          nodeConnections,
          canvasEffectiveNodesById,
          project,
          referencedProjects,
        );

        return Math.max(
          renderedMinWidth,
          getMinimumNodeWidthForPortLabels({
            inputDefinitions,
            outputDefinitions,
            preservePortCase,
            uiFontScale: getUiFontScale(uiFontSize),
          }),
        );
      } catch {
        return renderedMinWidth;
      }
    },
  );

  const getResizeSnapshotForNode = useStableCallback((node: ChartNode): ResizeNodeSnapshot => {
    const nodeElement = getRenderedNodeElement(node.id);
    const computedStyle = nodeElement ? window.getComputedStyle(nodeElement) : undefined;
    const fallbackWidth = getCanvasNodeWidth(node);
    const fallbackHeight = node.type === 'comment' ? getCanvasCommentHeight(node as CommentNode) : undefined;
    const width = parseFiniteStyleNumber(computedStyle?.width, fallbackWidth);
    const minWidth = getResizeMinWidthForNode(node, computedStyle);

    return createResizeNodeSnapshot({
      node,
      width,
      minWidth,
      height: node.type === 'comment' ? parseFiniteStyleNumber(computedStyle?.height, fallbackHeight ?? width) : undefined,
    });
  });

  const getResizeGroupForNode = useStableCallback((node: ChartNode): ActiveResizeGroup => {
    const activeGroup = activeResizeGroupRef.current;
    if (activeGroup?.sourceNodeId === node.id) {
      return activeGroup;
    }

    const resizeNodeIds = getResizeNodeIds(node.id, selectedNodeIds);
    const snapshots = nodes
      .filter((candidate) => resizeNodeIds.has(candidate.id))
      .map((candidate) => getResizeSnapshotForNode(candidate));

    if (!snapshots.some((snapshot) => snapshot.nodeId === node.id)) {
      snapshots.push(getResizeSnapshotForNode(node));
    }

    const nextGroup = {
      sourceNodeId: node.id,
      snapshots,
    };

    activeResizeGroupRef.current = nextGroup;
    return nextGroup;
  });

  const getResizeChangesForNode = useStableCallback((node: ChartNode, nextBounds: NodeResizeBounds) => {
    const resizeGroup = getResizeGroupForNode(node);
    return getResizeChangesForGroup({
      sourceNodeId: node.id,
      sourceNextBounds: nextBounds,
      snapshots: resizeGroup.snapshots,
    });
  });

  const onNodeSizeChanged = useStableCallback((node: ChartNode, nextBounds: NodeResizeBounds) => {
    const resizeChanges = getResizeChangesForNode(node, nextBounds);
    if (resizeChanges.length === 0) {
      return;
    }

    onNodesChanged(applyResizeChangesToNodes(nodes, resizeChanges));
  });

  const onNodeMouseEnter = useStableCallback((_e: MouseEvent<HTMLElement>, nodeId: NodeId) => {
    setHoveringNode(nodeId);
  });

  const onNodeMouseLeave = useStableCallback(() => {
    setHoveringNode(undefined);
  });

  const onPortMouseOver = useStableCallback(
    (
      event: MouseEvent<HTMLElement>,
      nodeId: NodeId,
      isInput: boolean,
      portId: PortId,
      definition: NodeInputDefinition | NodeOutputDefinition,
    ) => {
      setHoveringNode(nodeId);
      showPortTooltip(event, nodeId, isInput, portId, definition);
    },
  );

  const onPortMouseOut = useStableCallback(() => {
    hidePortTooltip();
  });

  const clearHoveringNode = useStableCallback(() => {
    setHoveringNode(undefined);
  });

  const syncHoveringNodeFromPointer = useStableCallback(() => {
    if (hoverSyncAnimationFrameRef.current !== undefined) {
      window.cancelAnimationFrame(hoverSyncAnimationFrameRef.current);
    }

    hoverSyncAnimationFrameRef.current = window.requestAnimationFrame(() => {
      hoverSyncAnimationFrameRef.current = undefined;
      const element = document.elementFromPoint(lastMouseInfoRef.current.x, lastMouseInfoRef.current.y);
      const nodeElement = element?.closest<HTMLElement>('.node[data-nodeid]:not(.overlayNode)');
      setHoveringNode((nodeElement?.dataset.nodeid as NodeId | undefined) ?? undefined);
    });
  });

  const preserveMoveDragHoverOnDrop = useStableCallback((nodeId: NodeId) => {
    if (dragMode === 'move') {
      setHoveringNode(nodeId);
    }
  });

  const selectedViewportNodeIds = useMemo(
    () =>
      getCanvasSelectedInteractionNodeIds({
        editingNodeId: graphStateOverlaysEnabled ? editingNodeId : null,
        fullscreenOutputNodeId: graphStateOverlaysEnabled ? fullscreenOutputNodeId : null,
        selectedNodeIds,
      }),
    [editingNodeId, fullscreenOutputNodeId, graphStateOverlaysEnabled, selectedNodeIds],
  );

  const searchMatchingNodeIds = useMemo(
    () =>
      getCanvasSearchMatchingNodeIds({
        matches: graphStateOverlaysEnabled ? graphSearch.matches : [],
        panelOpen: graphStateOverlaysEnabled && graphSearch.panelOpen,
        query: graphStateOverlaysEnabled ? graphSearch.query : '',
        searching: graphStateOverlaysEnabled && graphSearch.searching,
        selectedGraphId: selectedGraphMetadata?.id,
      }),
    [
      graphSearch.matches,
      graphSearch.panelOpen,
      graphSearch.query,
      graphSearch.searching,
      graphStateOverlaysEnabled,
      selectedGraphMetadata?.id,
    ],
  );

  const highlightedNodes = useMemo(
    () =>
      getCanvasHighlightedNodeIds({
        hoveringNodeId: hoveringNode,
        isPortHovered: !!hoveringPort,
        selectedNodeIds: selectedViewportNodeIds,
      }),
    [hoveringNode, hoveringPort, selectedViewportNodeIds],
  );
  const { heavyContentNodeIdSet, nearViewportNodeIdSet, visibleNodeIdSet } = useVisibleCanvasNodes({
    draggingNodeIds: draggingViewportNodeIds,
    editingNodeId,
    expandedOutputNodeIds,
    hoveringNodeId: hoveringNode,
    nodes,
    selectedNodeIds: selectedViewportNodeIds,
    viewportBounds,
  });

  const {
    nodePortPositions,
    canvasRef,
    recalculate: recalculatePortPositions,
  } = useNodePortPositions({
    enabled: shouldRenderWires,
    isDraggingNode,
    isDraggingWire,
    nodes,
    visibleNodeIdSet,
  });

  const { setNodeRef } = useDroppable({ id: 'NodeCanvas' });
  const setCanvasRef = useMergeRefs([setNodeRef, canvasRef, canvasRootRef]);

  const nodeSelected = useStableCallback((node: ChartNode, multi: boolean) => {
    onNodeSelected?.(node, multi);
  });

  const nodeStartEditing = useStableCallback((node: ChartNode) => {
    onNodeStartEditing?.(node);
  });
  const supportsBackspaceDeleteHotkey = isMacOSPlatform();

  useGlobalHotkey(
    'Space',
    (e) => {
      e.preventDefault();
      handleContextMenu({
        clientX: lastMouseInfoRef.current.x,
        clientY: lastMouseInfoRef.current.y,
        target: lastMouseInfoRef.current.target!,
      });
    },
    { notWhenInputFocused: true },
  );

  const deleteSelectedNodesFromHotkey = useStableCallback((event: KeyboardEvent) => {
    event.preventDefault();
    if (selectedNodeIds.length === 0) {
      return;
    }

    if (disableGraphCommands) {
      onNodesDeleted?.(selectedNodeIds);
      return;
    }

    removeNodes({ nodeIds: selectedNodeIds });
    setSelectedNodeIds([]);
  });

  useGlobalHotkey('Delete', deleteSelectedNodesFromHotkey, { notWhenInputFocused: true });

  useGlobalHotkey(
    'Backspace',
    (event) => {
      if (!supportsBackspaceDeleteHotkey || selectedNodeIds.length === 0) {
        return;
      }

      deleteSelectedNodesFromHotkey(event);
    },
    { notWhenInputFocused: true },
  );

  useEffect(() => {
    if (!visibleDraggingWire) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancelWireDrag();
    };

    const handleDocumentMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;

      if (target instanceof Node && canvasRootRef.current?.contains(target)) {
        return;
      }

      cancelWireDrag();
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    document.addEventListener('mousedown', handleDocumentMouseDown, true);

    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
      document.removeEventListener('mousedown', handleDocumentMouseDown, true);
    };
  }, [cancelWireDrag, visibleDraggingWire]);

  const hydratedContextMenuData = useMemo(
    (): ContextMenuContext =>
      getNodeCanvasContextMenuContext({
        canStartEditorGraphRun,
        canUseFrozenNodes,
        contextMenuData,
        freezeUnavailableReason,
        frozenNodeOutputs,
        graphSelection,
        lastRunPerNode,
        nodesById: canvasNodesById,
        project: projectWithCanvasGraph,
        projectNodeRegistry,
        selectedGraphId: selectedGraphMetadata?.id,
        selectedNodeIds,
        graphCommandsEnabled: !disableGraphCommands,
        pasteCommandsEnabled,
      }),
    [
      canStartEditorGraphRun,
      canUseFrozenNodes,
      contextMenuData,
      freezeUnavailableReason,
      frozenNodeOutputs,
      graphSelection,
      lastRunPerNode,
      canvasNodesById,
      disableGraphCommands,
      projectNodeRegistry,
      projectWithCanvasGraph,
      selectedGraphMetadata?.id,
      selectedNodeIds,
      pasteCommandsEnabled,
    ],
  );

  useCanvasHotkeys({ graphCommandsEnabled: !disableGraphCommands });
  useSearchGraph(!disableGraphCommands);

  const isZoomedOut = canvasPosition.zoom < 0.4;
  const isReallyZoomedOut = canvasPosition.zoom < 0.2;

  const onResizeFinish = useStableCallback(
    (node: ChartNode, nextBounds: NodeResizeBounds) => {
      try {
        const resizeChanges = getResizeChangesForNode(node, nextBounds);

        if (disableGraphCommands) {
          if (resizeChanges.length > 0) {
            onNodesChanged(applyResizeChangesToNodes(nodes, resizeChanges));
          }
          return;
        }

        const resizeGroup = getResizeGroupForNode(node);
        const changedResizeEntries = getChangedResizeEntries({
          changes: resizeChanges,
          snapshots: resizeGroup.snapshots,
        });

        if (changedResizeEntries.length > 0) {
          resizeNodes({ changes: changedResizeEntries });
        }
      } finally {
        activeResizeGroupRef.current = null;
      }
    },
  );

  const canvasViewContextValue = useMemo(
    () => ({
      canvasZoom: canvasPosition.zoom,
      closestPortToDraggingWire: visibleClosestPort,
      draggingWire: visibleDraggingWire,
      graphStateOverlaysEnabled,
      heightCache: cache,
      isReallyZoomedOut,
      isZoomedOut,
    }),
    [
      cache,
      canvasPosition.zoom,
      graphStateOverlaysEnabled,
      isReallyZoomedOut,
      isZoomedOut,
      visibleClosestPort,
      visibleDraggingWire,
    ],
  );

  const canvasHandlersContextValue = useMemo(
    () => ({
      onNodeMouseEnter,
      onNodeMouseLeave,
      onNodeSelected: nodeSelected,
      onNodeSizeChanged,
      onNodeStartEditing: nodeStartEditing,
      onPortMouseOut,
      onPortMouseOver,
      onResizeFinish,
      onWireEndDrag: disableConnections ? undefined : onWireEndDrag,
      onWireStartDrag: disableConnections ? undefined : onWireStartDrag,
    }),
    [
      disableConnections,
      nodeSelected,
      nodeStartEditing,
      onNodeMouseEnter,
      onNodeMouseLeave,
      onNodeSizeChanged,
      onPortMouseOut,
      onPortMouseOver,
      onResizeFinish,
      onWireEndDrag,
      onWireStartDrag,
    ],
  );

  return (
    <DndContext
      onDragStart={(event) => {
        setIsDraggingCanvas(false);
        onNodeStartDrag(event);
        clearHoveringNode();
      }}
      onDragMove={onNodeDraggedMove}
      onDragEnd={(event) => {
        clearNodeDragGesture();
        preserveMoveDragHoverOnDrop(event.active.id as NodeId);
        try {
          onNodeDragged(event);
        } finally {
          syncHoveringNodeFromPointer();
        }
      }}
      onDragCancel={() => {
        clearNodeDragGesture();
        try {
          onNodeDragCancelled();
        } finally {
          syncHoveringNodeFromPointer();
        }
      }}
    >
      <div
        ref={setCanvasRef}
        className={clsx('node-canvas', {
          'dragging-node': isDraggingNode,
          'dragging-canvas': isDraggingCanvas,
        })}
        css={nodeCanvasStyles}
        style={{ '--canvas-background-color': canvasBackgroundColor } as CSSProperties}
        onContextMenu={handleCanvasContextMenu}
        onMouseDownCapture={handleCanvasMouseDownCapture}
        onMouseDown={canvasMouseDown}
        onMouseMove={canvasMouseMove.run}
        onMouseUp={canvasMouseUp}
        onMouseLeave={canvasMouseUp}
        onWheel={handleZoom}
      >
        <CanvasBackgroundPatternLayer
          canvasPosition={canvasPosition}
          opacity={normalizedCanvasBackgroundPatternOpacity}
          pattern={normalizedCanvasBackgroundPattern}
        />
        <MouseIcon isDraggingNode={isDraggingNode} />
        {!disableGraphCommands && <CopyNodesHotkeys />}
        <DebugOverlay enabled={false} />
        <NodeCanvasViewport
          canvasHandlersContextValue={canvasHandlersContextValue}
          canvasPositionX={canvasPosition.x}
          canvasPositionY={canvasPosition.y}
          canvasZoom={canvasPosition.zoom}
          canvasViewContextValue={canvasViewContextValue}
          dragAxisLock={dragAxisLock}
          dragDelta={dragDelta}
          dragMode={dragMode}
          draggingHoverControlSourceNodeIds={draggedHoverControlSourceNodeIds}
          draggingNodeConnections={draggingNodeConnections}
          draggingNodes={draggingNodes}
          draggingSourceNodeIds={draggedSourceNodeIds}
          heavyContentNodeIdSet={heavyContentNodeIdSet}
          hoveredNodeId={hoveringNode}
          lastRunPerNode={graphStateOverlaysEnabled ? lastRunPerNode : EMPTY_RUN_DATA_BY_NODE}
          layer="comments"
          nodeTypes={nodeTypes}
          nodeCompareKindsById={comparisonRenderState.nodeCompareKindsById}
          compareRemovedNodes={comparisonRenderState.compareRemovedNodes}
          nodesWithConnections={nodesWithConnections}
          onNodeDragActivatorPointerDown={handleNodeDragActivatorPointerDown}
          expandedOutputNodeIds={graphStateOverlaysEnabled ? expandedOutputNodeIds : EMPTY_EXPANDED_OUTPUT_NODE_IDS}
          searchMatchingNodeIds={searchMatchingNodeIds}
          selectedNodeIds={selectedViewportNodeIds}
          selectedProcessPagePerNode={graphStateOverlaysEnabled ? selectedProcessPagePerNode : EMPTY_PROCESS_PAGE_BY_NODE}
          visibleNodeIdSet={visibleNodeIdSet}
        />
        {shouldRenderWires && (
          <WireLayer
            connections={previewConnections}
            draggingWire={visibleDraggingWire}
            compareNodesById={comparisonRenderState.compareNodesById}
            compareRemovedConnections={comparisonRenderState.compareRemovedConnections}
            connectionCompareKindsByKey={comparisonRenderState.connectionCompareKindsByKey}
            highlightedNodes={highlightedNodes}
            highlightedPort={hoveringPort}
            nearViewportNodeIdSet={nearViewportNodeIdSet}
            portPositions={nodePortPositions}
            visibleNodeIdSet={visibleNodeIdSet}
            viewportClientRect={viewportBounds.clientRect}
            draggingNode={isDraggingNode}
          />
        )}
        <NodeCanvasViewport
          canvasHandlersContextValue={canvasHandlersContextValue}
          canvasPositionX={canvasPosition.x}
          canvasPositionY={canvasPosition.y}
          canvasZoom={canvasPosition.zoom}
          canvasViewContextValue={canvasViewContextValue}
          dragAxisLock={dragAxisLock}
          dragDelta={dragDelta}
          dragMode={dragMode}
          draggingHoverControlSourceNodeIds={draggedHoverControlSourceNodeIds}
          draggingNodeConnections={draggingNodeConnections}
          draggingNodes={draggingNodes}
          draggingSourceNodeIds={draggedSourceNodeIds}
          heavyContentNodeIdSet={heavyContentNodeIdSet}
          hoveredNodeId={hoveringNode}
          lastRunPerNode={graphStateOverlaysEnabled ? lastRunPerNode : EMPTY_RUN_DATA_BY_NODE}
          layer="nodes"
          nodeTypes={nodeTypes}
          nodeCompareKindsById={comparisonRenderState.nodeCompareKindsById}
          compareRemovedNodes={comparisonRenderState.compareRemovedNodes}
          nodesWithConnections={nodesWithConnections}
          onNodeDragActivatorPointerDown={handleNodeDragActivatorPointerDown}
          expandedOutputNodeIds={graphStateOverlaysEnabled ? expandedOutputNodeIds : EMPTY_EXPANDED_OUTPUT_NODE_IDS}
          searchMatchingNodeIds={searchMatchingNodeIds}
          selectedNodeIds={selectedViewportNodeIds}
          selectedProcessPagePerNode={graphStateOverlaysEnabled ? selectedProcessPagePerNode : EMPTY_PROCESS_PAGE_BY_NODE}
          visibleNodeIdSet={visibleNodeIdSet}
        />
        {hydratedContextMenuData && (
          <NodeCanvasOverlays
            context={hydratedContextMenuData}
            contextMenuDisabled={contextMenuDisabled}
            contextMenuRef={contextMenuRef}
            contextMenuX={contextMenuData.x}
            contextMenuY={contextMenuData.y}
            floatingStyles={floatingStyles}
            hoveringPort={hoveringPort}
            hoveringShowPortInfo={hoveringShowPortInfo}
            onContextMenuEntered={() => {
              setContextMenuDisabled(false);
            }}
            onContextMenuExited={() => {
              setContextMenuData({ x: 0, y: 0, data: null });
              setContextMenuDisabled(true);
            }}
            onContextMenuItemSelected={contextMenuItemSelected}
            selectionBox={selectionBox}
            setFloating={floatingRefs.setFloating}
            showContextMenu={showContextMenu}
          />
        )}
        <MultiNodeAlignmentToolbar
          canvasRootRef={canvasRef}
          selectedNodes={selectedNodes}
          nodes={disableGraphCommands ? nodes : undefined}
          onNodesChanged={disableGraphCommands ? onNodesChanged : undefined}
        />
      </div>
    </DndContext>
  );
};

const DebugOverlay: FC<{ enabled: boolean }> = ({ enabled }) => {
  const canvasPosition = useAtomValue(canvasPositionState);
  const lastMousePosition = useAtomValue(lastMousePositionState);
  const { clientToCanvasPosition } = useCanvasPositioning();

  if (!enabled) {
    return null;
  }

  const perfSnapshot = getCanvasPerfSnapshot();

  return (
    <div className="debug-overlay">
      <div>Translation: {`(${canvasPosition.x.toFixed(2)}, ${canvasPosition.y.toFixed(2)})`}</div>
      <div>Scale: {canvasPosition.zoom.toFixed(2)}</div>
      <div>Mouse Position: {`(${lastMousePosition.x.toFixed(2)}, ${lastMousePosition.y.toFixed(2)})`}</div>
      <div>
        Translated Mouse Position:{' '}
        {`(${clientToCanvasPosition(lastMousePosition.x, lastMousePosition.y).x.toFixed(2)}, ${clientToCanvasPosition(
          lastMousePosition.x,
          lastMousePosition.y,
        ).y.toFixed(2)})`}
      </div>
      <div>Medium graph threshold: {MEDIUM_GRAPH_NODE_THRESHOLD}</div>
      {perfSnapshot.map(({ name, value }) => (
        <div key={name}>
          {name}: {value.toFixed(2)}
        </div>
      ))}
    </div>
  );
};

export const CopyNodesHotkeys: FC = () => {
  useCopyNodesHotkeys();
  return null;
};
