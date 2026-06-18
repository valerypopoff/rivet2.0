import { type FC, type MouseEvent, memo } from 'react';
import { type ChartNode, type NodeConnection, type NodeId, type PortId, type ProjectComparisonChangeKind } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import clsx from 'clsx';
import { ErrorBoundary } from 'react-error-boundary';
import { nodeByIdState } from '../state/graph';
import { type PortPositions } from './NodeCanvas';

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
  const bendPoint = bendPointOverride ?? connection.bendPoint;
  const wireSegments = bendPoint
    ? [
        { start, end: bendPoint },
        { start: bendPoint, end },
      ]
    : [{ start, end }];

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
}> = memo(({ sx, sy, ex, ey, selected, highlighted, isNotRan, compareChangeKind }) => {
  const isBackwards = sx > ex;
  const wirePath = getWirePath({ sx, sy, ex, ey });

  return (
    <path
      className={clsx('wire', {
        selected,
        highlighted,
        backwards: isBackwards,
        isNotRan,
        [`compare-${compareChangeKind}`]: compareChangeKind && compareChangeKind !== 'unchanged',
      })}
      d={wirePath}
    />
  );
});

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
}> = memo(({ sx, sy, ex, ey, onHoverStart, onHoverMove, onHoverEnd, onMouseDown, onClick }) => {
  return (
    <path
      className="wire-hit-area"
      d={getWirePath({ sx, sy, ex, ey })}
      onMouseEnter={onHoverStart}
      onMouseMove={onHoverMove}
      onMouseLeave={onHoverEnd ? () => onHoverEnd() : undefined}
      onMouseDown={onMouseDown}
      onClick={onClick}
    />
  );
});

WireInteractionTarget.displayName = 'WireInteractionTarget';

function getWirePath({ sx, sy, ex, ey }: { sx: number; sy: number; ex: number; ey: number }): string {
  const deltaX = Math.abs(ex - sx);
  const handleDistance = sx <= ex ? deltaX * 0.5 : Math.abs(ey - sy) * 0.6;

  const curveX1 = sx + handleDistance;
  const curveY1 = sy;
  const curveX2 = ex - handleDistance;
  const curveY2 = ey;

  const middleY = (sy + ey) / 2;

  return sx <= ex
    ? `M${sx},${sy} C${curveX1},${curveY1} ${curveX2},${curveY2} ${ex},${ey}`
    : `M${sx},${sy} C${curveX1},${curveY1} ${curveX1},${middleY} ${sx},${middleY} ` +
        `L${ex},${middleY} C${curveX2},${middleY} ${curveX2},${curveY2} ${ex},${ey}`;
}

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
