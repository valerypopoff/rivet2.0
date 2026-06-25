import { type FC, type MouseEvent as ReactMouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { isReadOnlyGraphState, nodesByIdState } from '../state/graph.js';
import { type PortPositions } from './NodeCanvas';
import {
  lastRunDataByNodeState,
  resolvedGraphSelectionState,
  selectedProcessPageNodesState,
  type RunDataByNodeId,
} from '../state/dataFlow';
import { useStableCallback } from '../hooks/useStableCallback';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { getSelectedProcessData } from '../state/selectors/executionSelectors.js';
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

  .wire-hit-area {
    cursor: inherit;
    fill: none;
    pointer-events: stroke;
    stroke: transparent;
    stroke-linecap: round;
    stroke-width: 16px;
    vector-effect: non-scaling-stroke;
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
`;

export type WireDef = {
  startNodeId: NodeId;
  startPortId: PortId;
  endNodeId?: NodeId;
  endPortId?: PortId;
  startPortIsInput: boolean;
};

type WireLayerProps = {
  connections: NodeConnection[];
  compareNodesById?: Record<NodeId, ChartNode>;
  compareRemovedConnections?: NodeConnection[];
  connectionCompareKindsByKey?: Record<string, ProjectComparisonChangeKind | undefined>;
  draggingWire?: WireDef;
  draggingNode: boolean;
  highlightedNodes?: NodeId[];
  highlightedPort?: {
    isInput: boolean;
    nodeId: NodeId;
    portId: PortId;
  };
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
  draggingWire,
  draggingNode,
  highlightedNodes,
  highlightedPort,
  nearViewportNodeIdSet,
  portPositions,
  visibleNodeIdSet,
  viewportClientRect,
}) => {
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
            store.get(canvasIoDefinitionsForNodeState(nodeId))?.inputDefinitions.find((definition) => definition.id === portId),
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

  const { canvasPosition, clientToCanvasPosition, canvasToClientPosition } = useCanvasPositioning();
  const mousePositionCanvas = clientToCanvasPosition(mousePosition.x, mousePosition.y);
  const nodesById = useAtomValue(nodesByIdState);
  const renderNodesById = useMemo(() => ({ ...compareNodesById, ...nodesById }), [compareNodesById, nodesById]);

  const getConnectionPointFromMouseEvent = useStableCallback(
    (event: ReactMouseEvent<SVGElement> | MouseEvent): ConnectionBendPoint => {
      const point = clientToCanvasPosition(event.clientX, event.clientY);
      return { x: point.x, y: point.y };
    },
  );

  const runningNodeIdSet = useMemo(() => {
    const nextRunningNodeIdSet = new Set<NodeId>();

    for (const [nodeId, processData] of Object.entries(lastRunDataByNode) as Array<[NodeId, RunDataByNodeId[NodeId]]>) {
      const selectedProcessData = getSelectedProcessData(
        processData,
        selectedProcessPageNodes[nodeId] ?? 0,
        graphSelectionOptions,
      );

      if (selectedProcessData?.data.status?.type === 'running') {
        nextRunningNodeIdSet.add(nodeId);
      }
    }

    return nextRunningNodeIdSet;
  }, [graphSelectionOptions, lastRunDataByNode, selectedProcessPageNodes]);

  const renderableWires = useRenderableWires({
    canvasToClientPosition,
    connections,
    draggingNode,
    draggingWire: !!draggingWire,
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

  return (
    <svg css={wiresStyles}>
      <g transform={`scale(${canvasPosition.zoom}) translate(${canvasPosition.x}, ${canvasPosition.y})`}>
        {draggingWire && (
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
                highlighted={!!(draggingWire.endNodeId && draggingWire.endPortId)}
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
        )}
        <StaticWireContents
          graphSelectionOptions={graphSelectionOptions}
          allowConnectionBendEditing={allowConnectionBendEditing}
          allowConnectionHover={!draggingNode && !draggingWire}
          draggingBendPreview={draggingBendPreview}
          highlightedNodes={highlightedNodes}
          highlightedPort={highlightedPort}
          hoveredConnectionKey={hoveredConnectionKey}
          lastRunDataByNode={lastRunDataByNode}
          onConnectionBendDoubleClick={handleConnectionBendDoubleClick}
          onConnectionBendMouseEnter={handleConnectionBendMouseEnter}
          onConnectionBendMouseDown={handleConnectionBendMouseDown}
          onConnectionClick={handleConnectionClick}
          onConnectionHoverEnd={handleConnectionHoverEnd}
          onConnectionMouseDown={handleConnectionMouseDown}
          onConnectionHoverMove={handleConnectionHoverMove}
          onConnectionHoverStart={handleConnectionHoverStart}
          compareRemovedConnections={compareRemovedConnections}
          connectionCompareKindsByKey={connectionCompareKindsByKey}
          nodesById={renderNodesById}
          portPositions={portPositions}
          renderableWires={renderableWires}
          runningNodeIdSet={runningNodeIdSet}
          selectedProcessPageNodes={selectedProcessPageNodes}
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
    hoveredConnectionKey: string | undefined;
    lastRunDataByNode: RunDataByNodeId;
    nodesById: Record<NodeId, ChartNode>;
    onConnectionBendDoubleClick: (
      connection: NodeConnection,
      event: ReactMouseEvent<SVGCircleElement>,
    ) => void;
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
    selectedProcessPageNodes: Record<NodeId, number | 'latest'>;
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
          const highlighted = isHighlightedNode || isCurrentlyRunning || isHighlightedPort || isHoveredConnection;
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
                interactive={allowConnectionHover}
                onHoverStart={(event) => onConnectionHoverStart(connectionKey, event)}
                onHoverMove={(event) => onConnectionHoverMove(connectionKey, event)}
                onHoverEnd={() => onConnectionHoverEnd(connectionKey)}
                onMouseDown={(event) => onConnectionMouseDown(connectionKey, event)}
                onClick={(event) => onConnectionClick(connection, connectionKey, event)}
              />
              {bendPoint && (
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
  selectedProcessPageNodes: Record<NodeId, number | 'latest'>,
  lastRunDataByNode: RunDataByNodeId,
  graphSelectionOptions: Parameters<typeof getSelectedProcessData>[2],
) {
  const inputNodeSelectedExecution = getSelectedProcessData(
    lastRunDataByNode[connection.inputNodeId],
    selectedProcessPageNodes[connection.inputNodeId] ?? 0,
    graphSelectionOptions,
  );
  const outputNodeSelectedExecution = getSelectedProcessData(
    lastRunDataByNode[connection.outputNodeId],
    selectedProcessPageNodes[connection.outputNodeId] ?? 0,
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
