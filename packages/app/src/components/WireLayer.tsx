import {
  type FC,
  type MouseEvent as ReactMouseEvent,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getProjectConnectionComparisonKey,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import clsx from 'clsx';
import { ConditionallyRenderWire, PartialWire } from './Wire.js';
import { useCanvasPositioning } from '../hooks/useCanvasPositioning.js';
import { ErrorBoundary } from 'react-error-boundary';
import { draggingWireClosestPortState } from '../state/graphBuilder.js';
import { effectiveNodesByIdState, isReadOnlyGraphState, nodesByIdState } from '../state/graph.js';
import { type PortPositions } from './NodeCanvas';
import {
  lastRunDataByNodeState,
  resolvedGraphSelectionState,
  selectedProcessPageNodesState,
  type PageValue,
  type RunDataByNodeId,
} from '../state/dataFlow';
import { useStableCallback } from '../hooks/useStableCallback';
import { useAtom, useAtomValue, useStore } from 'jotai';
import {
  getSelectedProcessData,
  hasRunningProcessData,
  resolveCanvasExecutionProcessPage,
} from '../state/selectors/executionSelectors.js';
import { canvasIoDefinitionsForNodeState } from '../state/selectors/canvasGraphSelectors.js';
import { resolveClosestWireDropTargetFromPoint } from '../utils/wireDropTarget.js';
import { useRenderableWires } from './nodeCanvas/useRenderableWires.js';
import type { LineClipRect } from '../utils/lineClipping.js';
import { useSetConnectionBendPointCommand } from '../commands/setConnectionBendPointCommand.js';
import {
  getGhostConnectionBendPoint,
  shouldCommitConnectionBendClick,
  updateConnectionBendDrag,
  type ConnectionBendClickStart,
  type ConnectionBendPoint,
  type DraggingConnectionBend,
} from './nodeCanvas/connectionBendInteraction.js';
import {
  getToolContinuationWireStates,
  type ToolContinuationWireState,
} from './nodeCanvas/toolContinuationWireState.js';
import { definitionValidConnectionsState } from '../state/selectors/ioDefinitions.js';
import {
  connectionMatchesDataBusChannelKeys,
  isDataBusChannelPort,
  shouldRenderDataBusConnection,
  type DataBusTopology,
} from './nodeCanvas/dataBusModel.js';

const wiresStyles = css`
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;

  path {
    stroke-linecap: butt;
    fill: none;
    stroke: gray;
  }

  .wire.isNotRan {
    stroke: var(--grey-lightish);
    stroke-dasharray: 5;
  }

  .wire.highlighted {
    stroke: var(--primary);
    transition: stroke 0.2s ease-out;
  }

  .wire.compare-added {
    stroke: var(--success);
    stroke-width: 3px;
  }

  .wire.compare-changed {
    stroke: var(--warning);
    stroke-width: 3px;
  }

  .wire.compare-removed {
    stroke: var(--error);
    stroke-width: 3px;
    stroke-dasharray: 8 5;
    opacity: 0.75;
  }

  .wire.tool-continuation:not(.tool-continuation-paired):not(.compare-added):not(.compare-changed):not(
      .compare-removed
    ) {
    stroke: var(--primary);
    stroke-width: 2px;
  }

  .wire.tool-continuation-active {
    animation: tool-continuation-wire-flow 0.8s linear infinite;
    stroke-dasharray: 8 5;
  }

  .wire.tool-continuation.tool-continuation-ambiguous {
    animation: none;
    stroke: var(--error);
    stroke-dasharray: 5 4;
  }

  .wire.tool-continuation-paired {
    stroke-width: 1px;
  }

  .tool-continuation-marker-default {
    fill: gray;
    stroke: none;
  }

  .tool-continuation-marker-added {
    fill: var(--success);
    stroke: none;
  }

  .tool-continuation-marker-changed {
    fill: var(--warning);
    stroke: none;
  }

  .tool-continuation-marker-error {
    fill: var(--error);
    stroke: none;
  }

  @keyframes tool-continuation-wire-flow {
    to {
      stroke-dashoffset: -13;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .wire.tool-continuation-active {
      animation: none;
    }
  }

  .wire-hit-area {
    cursor: inherit;
    fill: none;
    pointer-events: stroke;
    stroke: transparent;
    stroke-linecap: round;
    stroke-width: 16px;
    vector-effect: non-scaling-stroke;
  }

  .wire-hit-area:focus-visible {
    outline: none;
    stroke: var(--primary);
    stroke-opacity: 0.35;
    stroke-width: 4px;
  }

  .wire-bend-point {
    fill: var(--grey-dark);
    pointer-events: none;
    stroke: var(--primary);
    stroke-width: 2px;
    vector-effect: non-scaling-stroke;
  }

  .wire-bend-point.editable {
    cursor: grab;
    pointer-events: all;
  }

  .wire-bend-point:hover,
  .wire-bend-point.dragging {
    fill: var(--primary);
  }

  .wire-bend-point-ghost {
    cursor: inherit;
    fill: var(--primary);
    opacity: 0.5;
    pointer-events: none;
    stroke: var(--primary-dark);
  }
`;

const hoverRevealedWiresStyles = css`
  position: fixed;
  inset: 0;
  z-index: 2;
  width: 100vw;
  height: 100vh;
  overflow: visible;
  pointer-events: none;
`;

export type WireDef = {
  startNodeId: NodeId;
  startPortId: PortId;
  endNodeId?: NodeId;
  endPortId?: PortId;
  startPortIsInput: boolean;
};

type ToolContinuationMarkerIds = {
  default: string;
  added: string;
  changed: string;
  error: string;
};

const ToolContinuationMarkerDefinitions: FC<{ markerIds: ToolContinuationMarkerIds }> = ({ markerIds }) => (
  <defs>
    {(
      [
        [markerIds.default, 'tool-continuation-marker-default'],
        [markerIds.added, 'tool-continuation-marker-added'],
        [markerIds.changed, 'tool-continuation-marker-changed'],
        [markerIds.error, 'tool-continuation-marker-error'],
      ] as const
    ).map(([id, className]) => (
      <marker
        key={id}
        id={id}
        markerHeight="7"
        markerUnits="userSpaceOnUse"
        markerWidth="7"
        orient="auto-start-reverse"
        refX="6"
        refY="3"
      >
        <path className={className} d="M 0 0 L 6 3 L 0 6 z" />
      </marker>
    ))}
  </defs>
);

function getToolContinuationMarkerId(
  kind: ToolContinuationWireState['kind'],
  compareChangeKind: ProjectComparisonChangeKind | undefined,
  markerIds: ToolContinuationMarkerIds,
): string {
  if (kind === 'ambiguous' || compareChangeKind === 'removed') {
    return markerIds.error;
  }

  if (compareChangeKind === 'added') {
    return markerIds.added;
  }

  if (compareChangeKind === 'changed') {
    return markerIds.changed;
  }

  return markerIds.default;
}

type WireLayerProps = {
  connections: NodeConnection[];
  compareNodesById?: Record<NodeId, ChartNode>;
  compareRemovedConnections?: NodeConnection[];
  connectionCompareKindsByKey?: Record<string, ProjectComparisonChangeKind | undefined>;
  dataBusTopology: DataBusTopology;
  draggingWire?: WireDef;
  draggingNode: boolean;
  highlightedNodes?: NodeId[];
  highlightedPort?: {
    isInput: boolean;
    nodeId: NodeId;
    portId: PortId;
  };
  hoveredDataBusChannelKeys?: readonly string[];
  nearViewportNodeIdSet: ReadonlySet<NodeId>;
  portPositions: PortPositions;
  visibleNodeIdSet: ReadonlySet<NodeId>;
  viewportClientRect: LineClipRect;
};

export const WireLayer: FC<WireLayerProps> = ({
  connections,
  compareNodesById = {},
  compareRemovedConnections = [],
  connectionCompareKindsByKey = {},
  dataBusTopology,
  draggingWire,
  draggingNode,
  highlightedNodes,
  highlightedPort,
  hoveredDataBusChannelKeys = [],
  nearViewportNodeIdSet,
  portPositions,
  visibleNodeIdSet,
  viewportClientRect,
}) => {
  const toolContinuationMarkerPrefix = `tool-continuation-${useId().replaceAll(':', '')}`;
  const toolContinuationMarkerIds = useMemo<ToolContinuationMarkerIds>(
    () => ({
      default: toolContinuationMarkerPrefix,
      added: `${toolContinuationMarkerPrefix}-added`,
      changed: `${toolContinuationMarkerPrefix}-changed`,
      error: `${toolContinuationMarkerPrefix}-error`,
    }),
    [toolContinuationMarkerPrefix],
  );
  const hoverOverlayToolContinuationMarkerIds = useMemo<ToolContinuationMarkerIds>(
    () => ({
      default: `${toolContinuationMarkerPrefix}-overlay`,
      added: `${toolContinuationMarkerPrefix}-overlay-added`,
      changed: `${toolContinuationMarkerPrefix}-overlay-changed`,
      error: `${toolContinuationMarkerPrefix}-overlay-error`,
    }),
    [toolContinuationMarkerPrefix],
  );
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoveredConnectionKey, setHoveredConnectionKey] = useState<string | undefined>();
  const [hoveredConnectionPoint, setHoveredConnectionPoint] = useState<ConnectionBendPoint | undefined>();
  const [draggingBendPreview, setDraggingBendPreview] = useState<
    { connectionKey: string; point: ConnectionBendPoint } | undefined
  >();
  const draggingBendRef = useRef<DraggingConnectionBend | undefined>();
  const wireClickStartRef = useRef<ConnectionBendClickStart | undefined>();
  const [closestPort, setClosestPort] = useAtom(draggingWireClosestPortState);
  const store = useStore();

  const lastRunDataByNode = useAtomValue(lastRunDataByNodeState);
  const selectedProcessPageNodes = useAtomValue(selectedProcessPageNodesState);
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
  const isReadOnlyGraph = useAtomValue(isReadOnlyGraphState);
  const setConnectionBendPoint = useSetConnectionBendPointCommand();

  const handleMouseDown = useStableCallback((event: MouseEvent) => {
    const { clientX, clientY } = event;
    setMousePosition({ x: clientX, y: clientY });
  });

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!draggingWire && !draggingNode) {
        return;
      }

      const { clientX, clientY } = event;
      setMousePosition({ x: clientX, y: clientY });

      if (draggingWire) {
        const dropTarget = resolveClosestWireDropTargetFromPoint({
          clientX,
          clientY,
          getInputDefinition: (nodeId, portId) =>
            store
              .get(canvasIoDefinitionsForNodeState(nodeId))
              ?.inputDefinitions.find((definition) => definition.id === portId),
        });

        setClosestPort(dropTarget);
      } else if (closestPort !== undefined) {
        setClosestPort(undefined);
      }
    },
    [closestPort, draggingNode, draggingWire, setClosestPort, store],
  );

  useEffect(() => {
    if (!closestPort) {
      return;
    }

    if (!closestPort.element.isConnected) {
      setClosestPort(undefined);
      return;
    }

    const io = store.get(canvasIoDefinitionsForNodeState(closestPort.nodeId));
    const definition = io?.inputDefinitions.find((candidate) => candidate.id === closestPort.portId);

    if (!definition?.dataType) {
      setClosestPort(undefined);
    }
  }, [closestPort, setClosestPort, store]);

  useEffect(() => {
    window.addEventListener('mousedown', handleMouseDown, { capture: true });
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [handleMouseDown, handleMouseMove]);

  const { canvasClientOffset, canvasPosition, clientToCanvasPosition, canvasToClientPosition } = useCanvasPositioning();
  const mousePositionCanvas = clientToCanvasPosition(mousePosition.x, mousePosition.y);
  const nodesById = useAtomValue(nodesByIdState);
  const effectiveNodesById = useAtomValue(effectiveNodesByIdState);
  const definitionValidConnections = useAtomValue(definitionValidConnectionsState);
  const renderNodesById = useMemo(() => ({ ...compareNodesById, ...nodesById }), [compareNodesById, nodesById]);
  const toolContinuationWireStates = useMemo(
    () =>
      getToolContinuationWireStates({
        connections: definitionValidConnections,
        nodes: Object.values(effectiveNodesById),
      }),
    [definitionValidConnections, effectiveNodesById],
  );
  const establishedConnectionKeySet = useMemo(
    () => new Set(definitionValidConnections.map(getProjectConnectionComparisonKey)),
    [definitionValidConnections],
  );
  const { hoverRevealedDataBusConnectionKeySet, visibleConnections } = useMemo(() => {
    const hoveredDataBusChannelKeySet = new Set(hoveredDataBusChannelKeys);
    const nextHoverRevealedDataBusConnectionKeySet = new Set<string>();
    const nextVisibleConnections = connections.filter((connection) => {
      const connectionKey = getProjectConnectionComparisonKey(connection);
      const hoverRevealed =
        hoveredDataBusChannelKeySet.size > 0 &&
        establishedConnectionKeySet.has(connectionKey) &&
        connectionMatchesDataBusChannelKeys({
          connection,
          topology: dataBusTopology,
          channelKeys: hoveredDataBusChannelKeySet,
        });

      if (hoverRevealed) {
        nextHoverRevealedDataBusConnectionKeySet.add(connectionKey);
      }

      return shouldRenderDataBusConnection({
        connection,
        forceVisible: connectionCompareKindsByKey[connectionKey] != null || hoverRevealed,
        isDefinitionValid: establishedConnectionKeySet.has(connectionKey),
        topology: dataBusTopology,
      });
    });

    return {
      hoverRevealedDataBusConnectionKeySet: nextHoverRevealedDataBusConnectionKeySet,
      visibleConnections: nextVisibleConnections,
    };
  }, [
    connectionCompareKindsByKey,
    connections,
    dataBusTopology,
    establishedConnectionKeySet,
    hoveredDataBusChannelKeys,
  ]);

  const getConnectionPointFromMouseEvent = useStableCallback(
    (event: ReactMouseEvent<SVGElement> | MouseEvent): ConnectionBendPoint => {
      const point = clientToCanvasPosition(event.clientX, event.clientY);
      return { x: point.x, y: point.y };
    },
  );

  const runningNodeIdSet = useMemo(() => {
    const nextRunningNodeIdSet = new Set<NodeId>();

    for (const [nodeId, processData] of Object.entries(lastRunDataByNode) as Array<[NodeId, RunDataByNodeId[NodeId]]>) {
      if (hasRunningProcessData(processData, graphSelectionOptions)) {
        nextRunningNodeIdSet.add(nodeId);
      }
    }

    return nextRunningNodeIdSet;
  }, [graphSelectionOptions, lastRunDataByNode]);

  const renderableWires = useRenderableWires({
    canvasToClientPosition,
    connections: visibleConnections,
    draggingNode,
    draggingWire: !!draggingWire,
    forceRenderableConnectionKeySet: hoverRevealedDataBusConnectionKeySet,
    highlightedNodes,
    highlightedPort,
    nearViewportNodeIdSet,
    nodesById: renderNodesById,
    portPositions,
    runningNodeIdSet,
    visibleNodeIdSet,
    viewportClientRect,
  });
  const renderableConnectionKeySet = useMemo(
    () => new Set(renderableWires.map(getProjectConnectionComparisonKey)),
    [renderableWires],
  );
  const { hoverOverlayRenderableWires, mainRenderableWires } = useMemo(() => {
    const nextHoverOverlayRenderableWires: NodeConnection[] = [];
    const nextMainRenderableWires: NodeConnection[] = [];

    for (const connection of renderableWires) {
      const target = hoverRevealedDataBusConnectionKeySet.has(getProjectConnectionComparisonKey(connection))
        ? nextHoverOverlayRenderableWires
        : nextMainRenderableWires;
      target.push(connection);
    }

    return {
      hoverOverlayRenderableWires: nextHoverOverlayRenderableWires,
      mainRenderableWires: nextMainRenderableWires,
    };
  }, [hoverRevealedDataBusConnectionKeySet, renderableWires]);

  const allowConnectionBendEditing = !isReadOnlyGraph && !draggingNode && !draggingWire;

  const hoveredRenderableConnection = useMemo(() => {
    if (!hoveredConnectionKey) {
      return undefined;
    }

    return renderableWires.find((connection) => getProjectConnectionComparisonKey(connection) === hoveredConnectionKey);
  }, [hoveredConnectionKey, renderableWires]);

  const ghostBendPoint = getGhostConnectionBendPoint({
    allowEditing: allowConnectionBendEditing,
    hoveredConnection: hoveredRenderableConnection,
    hoveredConnectionPoint,
  });

  useEffect(() => {
    if (!hoveredConnectionKey) {
      return;
    }

    if (!renderableConnectionKeySet.has(hoveredConnectionKey)) {
      setHoveredConnectionKey(undefined);
      setHoveredConnectionPoint(undefined);
    }
  }, [hoveredConnectionKey, renderableConnectionKeySet]);

  useEffect(() => {
    if (draggingNode || draggingWire) {
      setHoveredConnectionKey(undefined);
      setHoveredConnectionPoint(undefined);
    }
  }, [draggingNode, draggingWire]);

  useEffect(() => {
    const draggingBend = draggingBendRef.current;
    if (!draggingBend) {
      return;
    }

    if (!renderableConnectionKeySet.has(draggingBend.connectionKey)) {
      draggingBendRef.current = undefined;
      setDraggingBendPreview(undefined);
    }
  }, [renderableConnectionKeySet]);

  const handleConnectionHoverStart = useStableCallback(
    (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => {
      setHoveredConnectionKey(connectionKey);
      setHoveredConnectionPoint(getConnectionPointFromMouseEvent(event));
    },
  );

  const handleConnectionHoverMove = useStableCallback(
    (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => {
      setHoveredConnectionKey(connectionKey);
      setHoveredConnectionPoint(getConnectionPointFromMouseEvent(event));
    },
  );

  const handleConnectionMouseDown = useStableCallback(
    (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => {
      if (event.button !== 0) {
        wireClickStartRef.current = undefined;
        return;
      }

      wireClickStartRef.current = {
        connectionKey,
        clientX: event.clientX,
        clientY: event.clientY,
      };
    },
  );

  const handleConnectionClick = useStableCallback(
    (connection: NodeConnection, connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => {
      const clickStart = wireClickStartRef.current;
      wireClickStartRef.current = undefined;

      if (
        !shouldCommitConnectionBendClick({
          clickStart,
          connectionKey,
          clientX: event.clientX,
          clientY: event.clientY,
          hasBendPoint: !!connection.bendPoint,
          isDraggingBend: !!draggingBendRef.current,
          isReadOnlyGraph,
        })
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setConnectionBendPoint({ connection, bendPoint: getConnectionPointFromMouseEvent(event) });
    },
  );

  const handleConnectionBendMouseDown = useStableCallback(
    (connection: NodeConnection, connectionKey: string, event: ReactMouseEvent<SVGCircleElement>) => {
      if (isReadOnlyGraph || event.button !== 0 || draggingBendRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const point = connection.bendPoint ?? getConnectionPointFromMouseEvent(event);
      draggingBendRef.current = {
        connection,
        connectionKey,
        point,
        hasMoved: false,
        startClientX: event.clientX,
        startClientY: event.clientY,
      };
      setDraggingBendPreview({ connectionKey, point });
      setHoveredConnectionKey(connectionKey);
      setHoveredConnectionPoint(undefined);
    },
  );

  const handleConnectionBendDoubleClick = useStableCallback(
    (connection: NodeConnection, event: ReactMouseEvent<SVGCircleElement>) => {
      if (isReadOnlyGraph) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      draggingBendRef.current = undefined;
      setDraggingBendPreview(undefined);
      setConnectionBendPoint({ connection, bendPoint: undefined });
    },
  );

  const handleConnectionBendMouseEnter = useStableCallback((connectionKey: string) => {
    setHoveredConnectionKey(connectionKey);
    setHoveredConnectionPoint(undefined);
  });

  const handleWindowBendMouseMove = useStableCallback((event: MouseEvent) => {
    const draggingBend = draggingBendRef.current;
    if (!draggingBend) {
      return;
    }

    const point = getConnectionPointFromMouseEvent(event);
    const nextDrag = updateConnectionBendDrag({
      clientX: event.clientX,
      clientY: event.clientY,
      drag: draggingBend,
      point,
    });

    if (!nextDrag) {
      return;
    }

    draggingBendRef.current = nextDrag;
    setDraggingBendPreview({ connectionKey: nextDrag.connectionKey, point: nextDrag.point });
  });

  const handleWindowBendMouseUp = useStableCallback(() => {
    const draggingBend = draggingBendRef.current;
    if (!draggingBend) {
      return;
    }

    draggingBendRef.current = undefined;
    setDraggingBendPreview(undefined);
    if (!draggingBend.hasMoved) {
      return;
    }

    setConnectionBendPoint({
      connection: draggingBend.connection,
      bendPoint: draggingBend.point,
    });
  });

  const draggingBendConnectionKey = draggingBendPreview?.connectionKey;

  useEffect(() => {
    if (!draggingBendConnectionKey) {
      return;
    }

    window.addEventListener('mousemove', handleWindowBendMouseMove);
    window.addEventListener('mouseup', handleWindowBendMouseUp);
    window.addEventListener('blur', handleWindowBendMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowBendMouseMove);
      window.removeEventListener('mouseup', handleWindowBendMouseUp);
      window.removeEventListener('blur', handleWindowBendMouseUp);
    };
  }, [draggingBendConnectionKey, handleWindowBendMouseMove, handleWindowBendMouseUp]);

  const handleConnectionHoverEnd = useStableCallback((connectionKey: string) => {
    if (hoveredConnectionKey === connectionKey) {
      setHoveredConnectionKey(undefined);
      setHoveredConnectionPoint(undefined);
    }
  });

  const sharedStaticWireContentsProps = {
    graphSelectionOptions,
    allowConnectionBendEditing,
    allowConnectionHover: !draggingNode && !draggingWire,
    draggingBendPreview,
    highlightedNodes,
    highlightedPort,
    hoverRevealedDataBusConnectionKeySet,
    hoveredConnectionKey,
    lastRunDataByNode,
    onConnectionBendDoubleClick: handleConnectionBendDoubleClick,
    onConnectionBendMouseEnter: handleConnectionBendMouseEnter,
    onConnectionBendMouseDown: handleConnectionBendMouseDown,
    onConnectionClick: handleConnectionClick,
    onConnectionHoverEnd: handleConnectionHoverEnd,
    onConnectionMouseDown: handleConnectionMouseDown,
    onConnectionHoverMove: handleConnectionHoverMove,
    onConnectionHoverStart: handleConnectionHoverStart,
    connectionCompareKindsByKey,
    nodesById: renderNodesById,
    portPositions,
    runningNodeIdSet,
    selectedProcessPageNodes,
    toolContinuationWireStates,
  };
  const hoverOverlayHost =
    typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.app') ?? document.body;
  const draggingWireTouchesDataBus =
    !!draggingWire &&
    (isDataBusChannelPort({
      input: draggingWire.startPortIsInput,
      nodeId: draggingWire.startNodeId,
      nodesById: effectiveNodesById,
      portId: draggingWire.startPortId,
    }) ||
      (!!draggingWire.endNodeId &&
        !!draggingWire.endPortId &&
        isDataBusChannelPort({
          input: true,
          nodeId: draggingWire.endNodeId,
          nodesById: effectiveNodesById,
          portId: draggingWire.endPortId,
        })));
  const draggingWireContents = draggingWire && (
    <ErrorBoundary fallback={<></>} key="wire-inprogress">
      {draggingWire.endNodeId && draggingWire.endPortId ? (
        <ConditionallyRenderWire
          connection={{
            outputNodeId: draggingWire.startNodeId,
            outputId: draggingWire.startPortId,
            inputNodeId: draggingWire.endNodeId,
            inputId: draggingWire.endPortId,
          }}
          selected={false}
          highlighted
          nodesById={renderNodesById}
          portPositions={portPositions}
          isNotRan={false}
        />
      ) : (
        <PartialWire
          connection={{
            nodeId: draggingWire.startNodeId,
            portId: draggingWire.startPortId,
            toX: mousePositionCanvas.x,
            toY: mousePositionCanvas.y,
          }}
          portPositions={portPositions}
        />
      )}
    </ErrorBoundary>
  );

  return (
    <>
      <svg css={wiresStyles}>
        <ToolContinuationMarkerDefinitions markerIds={toolContinuationMarkerIds} />
        <g transform={`scale(${canvasPosition.zoom}) translate(${canvasPosition.x}, ${canvasPosition.y})`}>
          {!draggingWireTouchesDataBus && draggingWireContents}
          <StaticWireContents
            {...sharedStaticWireContentsProps}
            compareRemovedConnections={compareRemovedConnections}
            renderableWires={mainRenderableWires}
            toolContinuationMarkerIds={toolContinuationMarkerIds}
          />
          {ghostBendPoint && (
            <circle
              className="wire-bend-point wire-bend-point-ghost"
              cx={ghostBendPoint.x}
              cy={ghostBendPoint.y}
              r={7}
            />
          )}
        </g>
      </svg>
      {draggingWireContents &&
        draggingWireTouchesDataBus &&
        hoverOverlayHost &&
        createPortal(
          <svg aria-hidden="true" className="data-bus-drag-wire-overlay" css={[wiresStyles, hoverRevealedWiresStyles]}>
            <g transform={`translate(${canvasClientOffset.x}, ${canvasClientOffset.y})`}>
              <g transform={`scale(${canvasPosition.zoom}) translate(${canvasPosition.x}, ${canvasPosition.y})`}>
                {draggingWireContents}
              </g>
            </g>
          </svg>,
          hoverOverlayHost,
        )}
      {hoverOverlayRenderableWires.length > 0 &&
        hoverOverlayHost &&
        createPortal(
          <svg aria-hidden="true" className="data-bus-hover-wire-overlay" css={[wiresStyles, hoverRevealedWiresStyles]}>
            <ToolContinuationMarkerDefinitions markerIds={hoverOverlayToolContinuationMarkerIds} />
            <g transform={`translate(${canvasClientOffset.x}, ${canvasClientOffset.y})`}>
              <g transform={`scale(${canvasPosition.zoom}) translate(${canvasPosition.x}, ${canvasPosition.y})`}>
                <StaticWireContents
                  {...sharedStaticWireContentsProps}
                  allowConnectionBendEditing={false}
                  allowConnectionHover={false}
                  compareRemovedConnections={[]}
                  renderableWires={hoverOverlayRenderableWires}
                  toolContinuationMarkerIds={hoverOverlayToolContinuationMarkerIds}
                />
              </g>
            </g>
          </svg>,
          hoverOverlayHost,
        )}
    </>
  );
};

const StaticWireContents = memo(
  ({
    allowConnectionHover,
    allowConnectionBendEditing,
    compareRemovedConnections,
    connectionCompareKindsByKey,
    draggingBendPreview,
    graphSelectionOptions,
    highlightedNodes,
    highlightedPort,
    hoverRevealedDataBusConnectionKeySet,
    hoveredConnectionKey,
    lastRunDataByNode,
    nodesById,
    onConnectionBendDoubleClick,
    onConnectionBendMouseEnter,
    onConnectionBendMouseDown,
    onConnectionClick,
    onConnectionHoverEnd,
    onConnectionMouseDown,
    onConnectionHoverMove,
    onConnectionHoverStart,
    portPositions,
    renderableWires,
    runningNodeIdSet,
    selectedProcessPageNodes,
    toolContinuationMarkerIds,
    toolContinuationWireStates,
  }: {
    allowConnectionHover: boolean;
    allowConnectionBendEditing: boolean;
    compareRemovedConnections: NodeConnection[];
    connectionCompareKindsByKey: Record<string, ProjectComparisonChangeKind | undefined>;
    draggingBendPreview: { connectionKey: string; point: ConnectionBendPoint } | undefined;
    graphSelectionOptions: Parameters<typeof getSelectedProcessData>[2];
    highlightedNodes: NodeId[] | undefined;
    highlightedPort:
      | {
          isInput: boolean;
          nodeId: NodeId;
          portId: PortId;
        }
      | undefined;
    hoverRevealedDataBusConnectionKeySet: ReadonlySet<string>;
    hoveredConnectionKey: string | undefined;
    lastRunDataByNode: RunDataByNodeId;
    nodesById: Record<NodeId, ChartNode>;
    onConnectionBendDoubleClick: (connection: NodeConnection, event: ReactMouseEvent<SVGCircleElement>) => void;
    onConnectionBendMouseEnter: (connectionKey: string) => void;
    onConnectionBendMouseDown: (
      connection: NodeConnection,
      connectionKey: string,
      event: ReactMouseEvent<SVGCircleElement>,
    ) => void;
    onConnectionClick: (
      connection: NodeConnection,
      connectionKey: string,
      event: ReactMouseEvent<SVGPathElement>,
    ) => void;
    onConnectionHoverEnd: (connectionKey: string) => void;
    onConnectionMouseDown: (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => void;
    onConnectionHoverMove: (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => void;
    onConnectionHoverStart: (connectionKey: string, event: ReactMouseEvent<SVGPathElement>) => void;
    portPositions: PortPositions;
    renderableWires: NodeConnection[];
    runningNodeIdSet: ReadonlySet<NodeId>;
    selectedProcessPageNodes: Record<NodeId, PageValue>;
    toolContinuationMarkerIds: ToolContinuationMarkerIds;
    toolContinuationWireStates: ReadonlyMap<NodeConnection, ToolContinuationWireState>;
  }) => {
    const highlightedNodeIdSet = useMemo(
      () => (highlightedNodes ? new Set(highlightedNodes) : undefined),
      [highlightedNodes],
    );
    return (
      <>
        {compareRemovedConnections.map((connection) => (
          <ErrorBoundary fallback={<></>} key={`compare-removed-wire-${getProjectConnectionComparisonKey(connection)}`}>
            <ConditionallyRenderWire
              connection={connection}
              selected={false}
              highlighted={false}
              nodesById={nodesById}
              portPositions={portPositions}
              isNotRan={false}
              compareChangeKind="removed"
            />
          </ErrorBoundary>
        ))}
        {renderableWires.map((connection) => {
          const connectionKey = getProjectConnectionComparisonKey(connection);
          const compareChangeKind = connectionCompareKindsByKey[connectionKey];
          const isHighlightedNode =
            highlightedNodeIdSet?.has(connection.inputNodeId) || highlightedNodeIdSet?.has(connection.outputNodeId);

          const isCurrentlyRunning =
            runningNodeIdSet.has(connection.inputNodeId) || runningNodeIdSet.has(connection.outputNodeId);

          const isHighlightedPort =
            highlightedPort &&
            (highlightedPort.isInput ? connection.inputId : connection.outputId) === highlightedPort.portId &&
            (highlightedPort.isInput ? connection.inputNodeId : connection.outputNodeId) === highlightedPort.nodeId;

          const isNotRan = getIsNotRan(connection, selectedProcessPageNodes, lastRunDataByNode, graphSelectionOptions);

          const isHoveredConnection = hoveredConnectionKey === connectionKey;
          const isHoverRevealedDataBusConnection = hoverRevealedDataBusConnectionKeySet.has(connectionKey);
          const highlighted =
            isHighlightedNode ||
            isCurrentlyRunning ||
            isHighlightedPort ||
            isHoveredConnection ||
            isHoverRevealedDataBusConnection;
          const toolContinuationWireState = toolContinuationWireStates.get(connection);
          const toolContinuation = toolContinuationWireState
            ? {
                active:
                  toolContinuationWireState.kind === 'connected' &&
                  runningNodeIdSet.has(toolContinuationWireState.delegateNodeId),
                kind: toolContinuationWireState.kind,
                markerId: getToolContinuationMarkerId(
                  toolContinuationWireState.kind,
                  compareChangeKind,
                  toolContinuationMarkerIds,
                ),
                title:
                  toolContinuationWireState.kind === 'ambiguous'
                    ? 'Invalid tool continuation: Auto-continue requires exactly one connected Delegate Tool Call node.'
                    : 'Tool continuation: The LLM sends tool calls to this Delegate Tool Call node and resumes with its results.',
              }
            : undefined;
          const bendPoint =
            draggingBendPreview?.connectionKey === connectionKey ? draggingBendPreview.point : connection.bendPoint;

          return (
            <ErrorBoundary fallback={<></>} key={`wire-${connectionKey}`}>
              <ConditionallyRenderWire
                connection={connection}
                selected={false}
                highlighted={!!highlighted}
                nodesById={nodesById}
                portPositions={portPositions}
                bendPoint={bendPoint}
                isNotRan={isNotRan}
                compareChangeKind={compareChangeKind}
                toolContinuation={toolContinuation}
                interactive={allowConnectionHover && !isHoverRevealedDataBusConnection}
                onHoverStart={(event) => onConnectionHoverStart(connectionKey, event)}
                onHoverMove={(event) => onConnectionHoverMove(connectionKey, event)}
                onHoverEnd={() => onConnectionHoverEnd(connectionKey)}
                onMouseDown={(event) => onConnectionMouseDown(connectionKey, event)}
                onClick={(event) => onConnectionClick(connection, connectionKey, event)}
              />
              {bendPoint && !isHoverRevealedDataBusConnection && (
                <circle
                  className={clsx('wire-bend-point', {
                    dragging: draggingBendPreview?.connectionKey === connectionKey,
                    editable: allowConnectionBendEditing,
                  })}
                  cx={bendPoint.x}
                  cy={bendPoint.y}
                  r={7}
                  onDoubleClick={(event) => onConnectionBendDoubleClick(connection, event)}
                  onMouseDown={(event) => onConnectionBendMouseDown(connection, connectionKey, event)}
                  onMouseEnter={() => onConnectionBendMouseEnter(connectionKey)}
                  onMouseLeave={() => onConnectionHoverEnd(connectionKey)}
                />
              )}
            </ErrorBoundary>
          );
        })}
      </>
    );
  },
);

StaticWireContents.displayName = 'StaticWireContents';

function getIsNotRan(
  connection: NodeConnection,
  selectedProcessPageNodes: Record<NodeId, PageValue>,
  lastRunDataByNode: RunDataByNodeId,
  graphSelectionOptions: Parameters<typeof getSelectedProcessData>[2],
) {
  const inputNodeSelectedExecution = getSelectedProcessData(
    lastRunDataByNode[connection.inputNodeId],
    resolveCanvasExecutionProcessPage(selectedProcessPageNodes[connection.inputNodeId]),
    graphSelectionOptions,
  );
  const outputNodeSelectedExecution = getSelectedProcessData(
    lastRunDataByNode[connection.outputNodeId],
    resolveCanvasExecutionProcessPage(selectedProcessPageNodes[connection.outputNodeId]),
    graphSelectionOptions,
  );

  if (inputNodeSelectedExecution?.data.inputData && outputNodeSelectedExecution?.data.outputData) {
    return (
      inputNodeSelectedExecution.data.inputData[connection.inputId]?.type === 'control-flow-excluded' ||
      outputNodeSelectedExecution.data.outputData[connection.outputId]?.type === 'control-flow-excluded'
    );
  }

  return false;
}
