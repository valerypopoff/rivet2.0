export type WirePoint = { x: number; y: number };
export type WireSegment = { start: WirePoint; end: WirePoint };

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

export function getWirePath({ sx, sy, ex, ey }: { sx: number; sy: number; ex: number; ey: number }): string {
  const handleDistance = sx <= ex ? Math.abs(ex - sx) * 0.5 : Math.abs(ey - sy) * 0.6;

  const curveX1 = sx + handleDistance;
  const curveX2 = ex - handleDistance;
  const middleY = (sy + ey) / 2;

  return sx <= ex
    ? `M${sx},${sy} C${curveX1},${sy} ${curveX2},${ey} ${ex},${ey}`
    : `M${sx},${sy} C${curveX1},${sy} ${curveX1},${middleY} ${sx},${middleY} ` +
        `L${ex},${middleY} C${curveX2},${middleY} ${curveX2},${ey} ${ex},${ey}`;
}
