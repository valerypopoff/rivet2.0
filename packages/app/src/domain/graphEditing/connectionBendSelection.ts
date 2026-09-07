import { getProjectConnectionComparisonKey, type NodeConnection } from '@valerypopoff/rivet2-core';

export type ConnectionBendMove = { connectionKey: string; position: { x: number; y: number } };

export function getBoxedConnectionBends(
  connections: readonly NodeConnection[],
  start: { x: number; y: number },
  end: { x: number; y: number },
): string[] {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);

  return connections
    .filter(
      ({ bendPoint: point }) => point && point.x >= left && point.x <= right && point.y >= top && point.y <= bottom,
    )
    .map(getProjectConnectionComparisonKey);
}

export function moveConnectionBends(connections: NodeConnection[], moves: readonly ConnectionBendMove[]) {
  if (moves.length === 0) return connections;
  const byKey = new Map(moves.map((move) => [move.connectionKey, move.position]));
  return connections.map((connection) => {
    const position = byKey.get(getProjectConnectionComparisonKey(connection));
    return position && connection.bendPoint ? { ...connection, bendPoint: { ...position } } : connection;
  });
}

export function offsetConnectionBends(
  moves: readonly ConnectionBendMove[],
  delta: { x: number; y: number },
): ConnectionBendMove[] {
  return moves.map(({ connectionKey, position }) => ({
    connectionKey,
    position: { x: position.x + delta.x, y: position.y + delta.y },
  }));
}
