import { type FC, memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  getProjectConnectionComparisonKey,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import { ConditionallyRenderWire, PartialWire } from './Wire.js';
import { useCanvasPositioning } from '../hooks/useCanvasPositioning.js';
import { ErrorBoundary } from 'react-error-boundary';
import { draggingWireClosestPortState } from '../state/graphBuilder.js';
import { nodesByIdState } from '../state/graph';
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
  const [closestPort, setClosestPort] = useAtom(draggingWireClosestPortState);
  const store = useStore();

  const lastRunDataByNode = useAtomValue(lastRunDataByNodeState);
  const selectedProcessPageNodes = useAtomValue(selectedProcessPageNodesState);
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);

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

  useEffect(() => {
    if (!hoveredConnectionKey) {
      return;
    }

    const hoveredConnectionIsRenderable = renderableWires.some(
      (connection) => getProjectConnectionComparisonKey(connection) === hoveredConnectionKey,
    );

    if (!hoveredConnectionIsRenderable) {
      setHoveredConnectionKey(undefined);
    }
  }, [hoveredConnectionKey, renderableWires]);

  useEffect(() => {
    if (draggingNode || draggingWire) {
      setHoveredConnectionKey(undefined);
    }
  }, [draggingNode, draggingWire]);

  const handleConnectionHoverStart = useStableCallback((connectionKey: string) => {
    setHoveredConnectionKey(connectionKey);
  });

  const handleConnectionHoverEnd = useStableCallback((connectionKey: string) => {
    setHoveredConnectionKey((current) => (current === connectionKey ? undefined : current));
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
          allowConnectionHover={!draggingNode && !draggingWire}
          highlightedNodes={highlightedNodes}
          highlightedPort={highlightedPort}
          hoveredConnectionKey={hoveredConnectionKey}
          lastRunDataByNode={lastRunDataByNode}
          onConnectionHoverEnd={handleConnectionHoverEnd}
          onConnectionHoverStart={handleConnectionHoverStart}
          compareRemovedConnections={compareRemovedConnections}
          connectionCompareKindsByKey={connectionCompareKindsByKey}
          nodesById={renderNodesById}
          portPositions={portPositions}
          renderableWires={renderableWires}
          runningNodeIdSet={runningNodeIdSet}
          selectedProcessPageNodes={selectedProcessPageNodes}
        />
      </g>
    </svg>
  );
};

const StaticWireContents = memo(
  ({
    allowConnectionHover,
    compareRemovedConnections,
    connectionCompareKindsByKey,
    graphSelectionOptions,
    highlightedNodes,
    highlightedPort,
    hoveredConnectionKey,
    lastRunDataByNode,
    nodesById,
    onConnectionHoverEnd,
    onConnectionHoverStart,
    portPositions,
    renderableWires,
    runningNodeIdSet,
    selectedProcessPageNodes,
  }: {
    allowConnectionHover: boolean;
    compareRemovedConnections: NodeConnection[];
    connectionCompareKindsByKey: Record<string, ProjectComparisonChangeKind | undefined>;
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
    onConnectionHoverEnd: (connectionKey: string) => void;
    onConnectionHoverStart: (connectionKey: string) => void;
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
          return (
            <ErrorBoundary fallback={<></>} key={`wire-${connectionKey}`}>
              <ConditionallyRenderWire
                connection={connection}
                selected={false}
                highlighted={!!highlighted}
                nodesById={nodesById}
                portPositions={portPositions}
                isNotRan={isNotRan}
                compareChangeKind={compareChangeKind}
                interactive={allowConnectionHover}
                onHoverStart={() => onConnectionHoverStart(connectionKey)}
                onHoverEnd={() => onConnectionHoverEnd(connectionKey)}
              />
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
