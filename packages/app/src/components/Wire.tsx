import { type FC, type MouseEvent, memo } from 'react';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
  type ProjectComparisonChangeKind,
} from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import clsx from 'clsx';
import { ErrorBoundary } from 'react-error-boundary';
import { nodeByIdState } from '../state/graph';
import { type PortPositions } from './NodeCanvas';
import { getWirePath, getWireSegments } from './nodeCanvas/wireGeometry.js';

type WireProps = {
  connection: NodeConnection;
  selected: boolean;
  highlighted: boolean;
  isNotRan: boolean;
  compareChangeKind?: ProjectComparisonChangeKind;
  nodesById: Record<NodeId, ChartNode>;
  portPositions: PortPositions;
  interactive?: boolean;
  bendPoint?: NodeConnection['bendPoint'];
  toolContinuation?: {
    active: boolean;
    kind: 'connected' | 'ambiguous';
    markerId: string;
    title: string;
  };
  onHoverStart?: (event: MouseEvent<SVGPathElement>) => void;
  onHoverMove?: (event: MouseEvent<SVGPathElement>) => void;
  onHoverEnd?: () => void;
  onMouseDown?: (event: MouseEvent<SVGPathElement>) => void;
  onClick?: (event: MouseEvent<SVGPathElement>) => void;
};

export type PartialConnection = {
  nodeId: NodeId;
  portId: PortId;
  toX: number;
  toY: number;
};

export const ConditionallyRenderWire: FC<WireProps> = ({
  connection,
  selected,
  highlighted,
  isNotRan,
  compareChangeKind,
  nodesById,
  portPositions,
  interactive = false,
  bendPoint: bendPointOverride,
  toolContinuation,
  onHoverStart,
  onHoverMove,
  onHoverEnd,
  onMouseDown,
  onClick,
}) => {
  const inputNode = nodesById[connection.inputNodeId]!;
  const outputNode = nodesById[connection.outputNodeId]!;

  if (!inputNode || !outputNode) {
    return null;
  }

  const [outputCacheKey, inputCacheKey] = getConnectionCacheKeys(connection);

  const start = getNodePortPosition(outputNode, connection.outputId, outputCacheKey, portPositions);
  const end = getNodePortPosition(inputNode, connection.inputId, inputCacheKey, portPositions);
  const wireSegments = getWireSegments({
    bendPoint: bendPointOverride ?? connection.bendPoint,
    end,
    start,
  });

  return (
    <ErrorBoundary fallback={<></>}>
      {wireSegments.map((segment, index) => (
        <Wire
          key={`wire-segment-${index}`}
          sx={segment.start.x}
          sy={segment.start.y}
          ex={segment.end.x}
          ey={segment.end.y}
          selected={selected}
          highlighted={highlighted}
          isNotRan={isNotRan}
          compareChangeKind={compareChangeKind}
          toolContinuationKind={toolContinuation?.kind}
          toolContinuationActive={toolContinuation?.active}
          markerStart={index === 0 ? toolContinuation?.markerId : undefined}
          markerEnd={index === wireSegments.length - 1 ? toolContinuation?.markerId : undefined}
        />
      ))}
      {interactive && (
        <>
          {wireSegments.map((segment, index) => (
            <WireInteractionTarget
              key={`wire-hit-segment-${index}`}
              sx={segment.start.x}
              sy={segment.start.y}
              ex={segment.end.x}
              ey={segment.end.y}
              onHoverStart={onHoverStart}
              onHoverMove={onHoverMove}
              onHoverEnd={onHoverEnd}
              onMouseDown={onMouseDown}
              onClick={onClick}
              title={index === 0 ? toolContinuation?.title : undefined}
            />
          ))}
        </>
      )}
    </ErrorBoundary>
  );
};

export const PartialWire: FC<{ connection: PartialConnection; portPositions: PortPositions }> = ({
  connection,
  portPositions,
}) => {
  const node = useAtomValue(nodeByIdState(connection.nodeId));

  if (!node) {
    return null;
  }

  const cacheKey = `${connection.nodeId}-output-${connection.portId}`;

  const start = getNodePortPosition(node, connection.portId, cacheKey, portPositions);
  const end = { x: connection.toX, y: connection.toY };

  return (
    <ErrorBoundary fallback={<></>}>
      <Wire sx={start.x} sy={start.y} ex={end.x} ey={end.y} selected={false} highlighted={false} isNotRan={false} />
    </ErrorBoundary>
  );
};

export const Wire: FC<{
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  selected: boolean;
  highlighted: boolean;
  isNotRan: boolean;
  compareChangeKind?: ProjectComparisonChangeKind;
  markerStart?: string;
  markerEnd?: string;
  toolContinuationActive?: boolean;
  toolContinuationKind?: 'connected' | 'ambiguous';
}> = memo(
  ({
    sx,
    sy,
    ex,
    ey,
    selected,
    highlighted,
    isNotRan,
    compareChangeKind,
    markerStart,
    markerEnd,
    toolContinuationActive,
    toolContinuationKind,
  }) => {
    const isBackwards = sx > ex;
    const wirePath = getWirePath({ sx, sy, ex, ey });

    return (
      <path
        className={clsx('wire', {
          selected,
          highlighted,
          backwards: isBackwards,
          isNotRan,
          'tool-continuation': toolContinuationKind != null,
          'tool-continuation-active': toolContinuationActive,
          'tool-continuation-ambiguous': toolContinuationKind === 'ambiguous',
          [`compare-${compareChangeKind}`]: compareChangeKind && compareChangeKind !== 'unchanged',
        })}
        d={wirePath}
        markerStart={markerStart ? `url(#${markerStart})` : undefined}
        markerEnd={markerEnd ? `url(#${markerEnd})` : undefined}
      />
    );
  },
);

Wire.displayName = 'Wire';

const WireInteractionTarget: FC<{
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  onHoverStart?: (event: MouseEvent<SVGPathElement>) => void;
  onHoverMove?: (event: MouseEvent<SVGPathElement>) => void;
  onHoverEnd?: () => void;
  onMouseDown?: (event: MouseEvent<SVGPathElement>) => void;
  onClick?: (event: MouseEvent<SVGPathElement>) => void;
  title?: string;
}> = memo(({ sx, sy, ex, ey, onHoverStart, onHoverMove, onHoverEnd, onMouseDown, onClick, title }) => {
  return (
    <path
      className="wire-hit-area"
      d={getWirePath({ sx, sy, ex, ey })}
      onMouseEnter={onHoverStart}
      onMouseMove={onHoverMove}
      onMouseLeave={onHoverEnd ? () => onHoverEnd() : undefined}
      onMouseDown={onMouseDown}
      onClick={onClick}
      aria-label={title}
      role={title ? 'img' : undefined}
      tabIndex={title ? 0 : undefined}
    >
      {title && <title>{title}</title>}
    </path>
  );
});

WireInteractionTarget.displayName = 'WireInteractionTarget';

export function getNodePortPosition(
  node: ChartNode,
  portId: PortId,
  cacheKey: string,
  portPositions: PortPositions,
): { x: number; y: number } {
  if (!node) {
    return { x: 0, y: 0 };
  }

  if (portId) {
    const portPosition = portPositions[cacheKey];
    if (portPosition) {
      return { x: portPosition.x, y: portPosition.y };
    } else {
      return {
        x: node.visualData.x + 100,
        y: node.visualData.y + 100,
      };
    }
  }

  return { x: 0, y: 0 };
}

const cacheKeysByConnection = new WeakMap<NodeConnection, readonly [string, string]>();

export function getConnectionCacheKeys(connection: NodeConnection): readonly [string, string] {
  const cached = cacheKeysByConnection.get(connection);
  if (cached) {
    return cached;
  }

  const cacheKeys = [
    `${connection.outputNodeId}-output-${connection.outputId}`,
    `${connection.inputNodeId}-input-${connection.inputId}`,
  ] as const;

  cacheKeysByConnection.set(connection, cacheKeys);

  return cacheKeys;
}
