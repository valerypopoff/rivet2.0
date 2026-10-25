export type WirePoint = { x: number; y: number };
export type WireSegment = { start: WirePoint; end: WirePoint };
export type WireEndpointDirection = 'horizontal' | 'down';

type WirePathCoordinates = {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  startDirection?: WireEndpointDirection;
  endDirection?: WireEndpointDirection;
};

export type WirePathBounds = { left: number; top: number; right: number; bottom: number };
type WirePathPrimitive =
  | { type: 'line'; start: WirePoint; end: WirePoint }
  | { type: 'cubic'; start: WirePoint; control1: WirePoint; control2: WirePoint; end: WirePoint };

const CUBIC_OFFSET_SAMPLE_COUNT = 48;
const BACKWARDS_BRIDGE_SAMPLE_COUNT = 12;

export function getWireSegments({
  bendPoint,
  end,
  start,
}: {
  bendPoint?: WirePoint;
  end: WirePoint;
  start: WirePoint;
}): WireSegment[] {
  return bendPoint
    ? [
        { start, end: bendPoint },
        { start: bendPoint, end },
      ]
    : [{ start, end }];
}

function getWirePathPrimitives({
  sx,
  sy,
  ex,
  ey,
  startDirection = 'horizontal',
  endDirection = 'horizontal',
}: WirePathCoordinates): WirePathPrimitive[] {
  const start = { x: sx, y: sy };
  const end = { x: ex, y: ey };
  const handleDistance = sx <= ex ? Math.abs(ex - sx) * 0.5 : Math.abs(ey - sy) * 0.6;
  const directionalControls = getDirectionalWireControlPoints({
    sx,
    sy,
    ex,
    ey,
    startDirection,
    endDirection,
    horizontalHandleDistance: handleDistance,
  });

  if (directionalControls) {
    return [{ type: 'cubic', start, end, ...directionalControls }];
  }

  const curveX1 = sx + handleDistance;
  const curveX2 = ex - handleDistance;
  const middleY = (sy + ey) / 2;

  return sx <= ex
    ? [{ type: 'cubic', start, control1: { x: curveX1, y: sy }, control2: { x: curveX2, y: ey }, end }]
    : [
        {
          type: 'cubic',
          start,
          control1: { x: curveX1, y: sy },
          control2: { x: curveX1, y: middleY },
          end: { x: sx, y: middleY },
        },
        { type: 'line', start: { x: sx, y: middleY }, end: { x: ex, y: middleY } },
        {
          type: 'cubic',
          start: { x: ex, y: middleY },
          control1: { x: curveX2, y: middleY },
          control2: { x: curveX2, y: ey },
          end,
        },
      ];
}

export function getWirePath(coordinates: WirePathCoordinates): string {
  return [
    `M${coordinates.sx},${coordinates.sy}`,
    ...getWirePathPrimitives(coordinates).map((segment) =>
      segment.type === 'line'
        ? `L${segment.end.x},${segment.end.y}`
        : `C${segment.control1.x},${segment.control1.y} ${segment.control2.x},${segment.control2.y} ${segment.end.x},${segment.end.y}`,
    ),
  ].join(' ');
}

/** A Bezier stays inside its control hull. Conservative bounds never miss a visible curve. */
export function getWirePathBounds(coordinates: WirePathCoordinates): WirePathBounds {
  const bounds = { left: coordinates.sx, top: coordinates.sy, right: coordinates.sx, bottom: coordinates.sy };
  const include = (point: WirePoint) => {
    bounds.left = Math.min(bounds.left, point.x);
    bounds.top = Math.min(bounds.top, point.y);
    bounds.right = Math.max(bounds.right, point.x);
    bounds.bottom = Math.max(bounds.bottom, point.y);
  };
  for (const segment of getWirePathPrimitives(coordinates)) {
    include(segment.start);
    include(segment.end);
    if (segment.type === 'cubic') {
      include(segment.control1);
      include(segment.control2);
    }
  }
  return bounds;
}

/**
 * Returns the points of a wire after offsetting them perpendicular to the
 * rendered path. This is used for the two lanes of a tool-continuation wire:
 * translating the endpoints alone makes Bézier lanes converge at their bends.
 */
export function getNormalOffsetWirePoints({
  offset,
  ...coordinates
}: WirePathCoordinates & { offset: number }): WirePoint[] {
  const points = getWirePathSamplePoints(coordinates);
  const startDirection = coordinates.startDirection ?? 'horizontal';
  const endDirection = coordinates.endDirection ?? 'horizontal';

  return points.map((point, index) => {
    // Preserve the declared endpoint tangent instead of estimating it from the
    // first short sample, which can pull steep, closely spaced lanes off-port.
    if (index === 0) {
      return startDirection === 'down' ? { x: point.x - offset, y: point.y } : { x: point.x, y: point.y + offset };
    }

    if (index === points.length - 1) {
      return endDirection === 'down' ? { x: point.x + offset, y: point.y } : { x: point.x, y: point.y + offset };
    }

    const previous = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.hypot(tangentX, tangentY);

    if (tangentLength === 0) {
      return point;
    }

    return {
      x: point.x - (tangentY / tangentLength) * offset,
      y: point.y + (tangentX / tangentLength) * offset,
    };
  });
}

export function getNormalOffsetWirePath({ offset, ...coordinates }: WirePathCoordinates & { offset: number }): string {
  return getNormalOffsetWirePoints({ ...coordinates, offset })
    .map(
      (point, index) => `${index === 0 ? 'M' : 'L'}${formatWireCoordinate(point.x)},${formatWireCoordinate(point.y)}`,
    )
    .join(' ');
}

/**
 * Returns short, forward-facing paths on a wire at a regular visual cadence.
 * Callers attach an SVG marker to each path's end, so the marker follows the
 * actual curve (including a user-authored bend) instead of merely pointing
 * along the connection's overall start-to-end vector.
 */
export function getRepeatedWireArrowMarkerSegments({
  segments,
  startDirection,
  endDirection,
  spacing = 48,
  arrowLength = 12,
  startInset = 28,
  endInset = 12,
}: {
  segments: readonly WireSegment[];
  startDirection?: WireEndpointDirection;
  endDirection?: WireEndpointDirection;
  spacing?: number;
  arrowLength?: number;
  startInset?: number;
  endInset?: number;
}): WireSegment[] {
  if (segments.length === 0 || spacing <= 0 || arrowLength <= 0 || startInset < 0 || endInset < 0) {
    return [];
  }

  const points = segments.reduce<WirePoint[]>((allPoints, segment, index) => {
    const sampledPoints = getWirePathSamplePoints({
      sx: segment.start.x,
      sy: segment.start.y,
      ex: segment.end.x,
      ey: segment.end.y,
      startDirection: index === 0 ? startDirection : undefined,
      endDirection: index === segments.length - 1 ? endDirection : undefined,
    });
    return allPoints.length === 0 ? sampledPoints : appendSamplePoints(allPoints, sampledPoints);
  }, []);
  const cumulativeLengths = getCumulativeWireLengths(points);
  const totalLength = cumulativeLengths.at(-1) ?? 0;
  const maximumArrowEnd = totalLength - endInset;

  if (maximumArrowEnd < startInset) {
    return [];
  }

  const markerSegments: WireSegment[] = [];
  for (let arrowEndDistance = startInset; arrowEndDistance <= maximumArrowEnd; arrowEndDistance += spacing) {
    const start = getWirePointAtDistance(points, cumulativeLengths, Math.max(0, arrowEndDistance - arrowLength));
    const end = getWirePointAtDistance(points, cumulativeLengths, arrowEndDistance);

    if (start && end && (start.x !== end.x || start.y !== end.y)) {
      markerSegments.push({ start, end });
    }
  }

  return markerSegments;
}

function getWirePathSamplePoints(coordinates: WirePathCoordinates): WirePoint[] {
  return getWirePathPrimitives(coordinates).reduce<WirePoint[]>((points, segment) => {
    const samples =
      segment.type === 'line'
        ? sampleLinePoints(segment.start, segment.end, BACKWARDS_BRIDGE_SAMPLE_COUNT)
        : sampleCubicPoints(segment.start, segment.control1, segment.control2, segment.end, CUBIC_OFFSET_SAMPLE_COUNT);
    return points.length ? appendSamplePoints(points, samples) : samples;
  }, []);
}

function getCumulativeWireLengths(points: readonly WirePoint[]): number[] {
  const cumulativeLengths = [0];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    cumulativeLengths.push(cumulativeLengths[index - 1]! + Math.hypot(current.x - previous.x, current.y - previous.y));
  }

  return cumulativeLengths;
}

function getWirePointAtDistance(
  points: readonly WirePoint[],
  cumulativeLengths: readonly number[],
  distance: number,
): WirePoint | undefined {
  for (let index = 1; index < points.length; index += 1) {
    const segmentEndDistance = cumulativeLengths[index]!;
    if (distance > segmentEndDistance) {
      continue;
    }

    const segmentStartDistance = cumulativeLengths[index - 1]!;
    const segmentLength = segmentEndDistance - segmentStartDistance;
    if (segmentLength === 0) {
      continue;
    }

    const progress = (distance - segmentStartDistance) / segmentLength;
    const start = points[index - 1]!;
    const end = points[index]!;
    return {
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress,
    };
  }

  return points.at(-1);
}

function getDirectionalWireControlPoints({
  sx,
  sy,
  ex,
  ey,
  startDirection,
  endDirection,
  horizontalHandleDistance,
}: Required<Pick<WirePathCoordinates, 'sx' | 'sy' | 'ex' | 'ey' | 'startDirection' | 'endDirection'>> & {
  horizontalHandleDistance: number;
}): { control1: WirePoint; control2: WirePoint } | undefined {
  if (startDirection !== 'down' && endDirection !== 'down') {
    return undefined;
  }

  const horizontalDistance = Math.max(24, horizontalHandleDistance);
  const verticalDistance = Math.max(24, Math.min(120, Math.max(Math.abs(ey - sy) * 0.35, Math.abs(ex - sx) * 0.15)));

  return {
    control1: startDirection === 'down' ? { x: sx, y: sy + verticalDistance } : { x: sx + horizontalDistance, y: sy },
    control2: endDirection === 'down' ? { x: ex, y: ey + verticalDistance } : { x: ex - horizontalDistance, y: ey },
  };
}

function sampleCubicPoints(
  start: WirePoint,
  control1: WirePoint,
  control2: WirePoint,
  end: WirePoint,
  segmentCount: number,
): WirePoint[] {
  const points: WirePoint[] = [];

  for (let segment = 0; segment <= segmentCount; segment += 1) {
    const t = segment / segmentCount;
    const inverseT = 1 - t;
    points.push({
      x:
        inverseT ** 3 * start.x +
        3 * inverseT ** 2 * t * control1.x +
        3 * inverseT * t ** 2 * control2.x +
        t ** 3 * end.x,
      y:
        inverseT ** 3 * start.y +
        3 * inverseT ** 2 * t * control1.y +
        3 * inverseT * t ** 2 * control2.y +
        t ** 3 * end.y,
    });
  }

  return points;
}

function sampleLinePoints(start: WirePoint, end: WirePoint, segmentCount: number): WirePoint[] {
  const points: WirePoint[] = [];

  for (let segment = 0; segment <= segmentCount; segment += 1) {
    const t = segment / segmentCount;
    points.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    });
  }

  return points;
}

function appendSamplePoints(points: WirePoint[], nextPoints: WirePoint[]): WirePoint[] {
  return points.concat(nextPoints.slice(1));
}

function formatWireCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}
