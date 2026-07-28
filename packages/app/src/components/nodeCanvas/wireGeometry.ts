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

export function getWirePath({
  sx,
  sy,
  ex,
  ey,
  startDirection = 'horizontal',
  endDirection = 'horizontal',
}: WirePathCoordinates): string {
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
    return (
      `M${sx},${sy} C${directionalControls.control1.x},${directionalControls.control1.y} ` +
      `${directionalControls.control2.x},${directionalControls.control2.y} ${ex},${ey}`
    );
  }

  const curveX1 = sx + handleDistance;
  const curveX2 = ex - handleDistance;
  const middleY = (sy + ey) / 2;

  return sx <= ex
    ? `M${sx},${sy} C${curveX1},${sy} ${curveX2},${ey} ${ex},${ey}`
    : `M${sx},${sy} C${curveX1},${sy} ${curveX1},${middleY} ${sx},${middleY} ` +
        `L${ex},${middleY} C${curveX2},${middleY} ${curveX2},${ey} ${ex},${ey}`;
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
      return startDirection === 'down'
        ? { x: point.x - offset, y: point.y }
        : { x: point.x, y: point.y + offset };
    }

    if (index === points.length - 1) {
      return endDirection === 'down'
        ? { x: point.x + offset, y: point.y }
        : { x: point.x, y: point.y + offset };
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

function getWirePathSamplePoints({
  sx,
  sy,
  ex,
  ey,
  startDirection = 'horizontal',
  endDirection = 'horizontal',
}: WirePathCoordinates): WirePoint[] {
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
    return sampleCubicPoints(
      { x: sx, y: sy },
      directionalControls.control1,
      directionalControls.control2,
      { x: ex, y: ey },
      CUBIC_OFFSET_SAMPLE_COUNT,
    );
  }

  const curveX1 = sx + handleDistance;
  const curveX2 = ex - handleDistance;
  const middleY = (sy + ey) / 2;

  if (sx <= ex) {
    return sampleCubicPoints(
      { x: sx, y: sy },
      { x: curveX1, y: sy },
      { x: curveX2, y: ey },
      { x: ex, y: ey },
      CUBIC_OFFSET_SAMPLE_COUNT,
    );
  }

  return appendSamplePoints(
    appendSamplePoints(
      sampleCubicPoints(
        { x: sx, y: sy },
        { x: curveX1, y: sy },
        { x: curveX1, y: middleY },
        { x: sx, y: middleY },
        CUBIC_OFFSET_SAMPLE_COUNT,
      ),
      sampleLinePoints({ x: sx, y: middleY }, { x: ex, y: middleY }, BACKWARDS_BRIDGE_SAMPLE_COUNT),
    ),
    sampleCubicPoints(
      { x: ex, y: middleY },
      { x: curveX2, y: middleY },
      { x: curveX2, y: ey },
      { x: ex, y: ey },
      CUBIC_OFFSET_SAMPLE_COUNT,
    ),
  );
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
  const verticalDistance = Math.max(
    24,
    Math.min(120, Math.max(Math.abs(ey - sy) * 0.35, Math.abs(ex - sx) * 0.15)),
  );

  return {
    control1:
      startDirection === 'down' ? { x: sx, y: sy + verticalDistance } : { x: sx + horizontalDistance, y: sy },
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
