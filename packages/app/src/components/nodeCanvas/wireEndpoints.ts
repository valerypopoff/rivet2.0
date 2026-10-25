import type { ChartNode, NodeConnection, PortId } from '@valerypopoff/rivet2-core';
import type { WirePoint } from './wireGeometry.js';

export type PortPositions = Record<string, WirePoint>;

/** Shared by drawing and culling, including the existing unmeasured-port fallback. */
export function getNodePortPosition(
  node: ChartNode,
  portId: PortId,
  cacheKey: string,
  portPositions: PortPositions,
): WirePoint {
  if (!node || !portId) return { x: 0, y: 0 };
  const position = portPositions[cacheKey];
  return position ? { x: position.x, y: position.y } : { x: node.visualData.x + 100, y: node.visualData.y + 100 };
}

const cacheKeysByConnection = new WeakMap<NodeConnection, readonly [string, string]>();

export function getConnectionCacheKeys(connection: NodeConnection): readonly [string, string] {
  const cached = cacheKeysByConnection.get(connection);
  if (cached) return cached;
  const keys = [
    `${connection.outputNodeId}-output-${connection.outputId}`,
    `${connection.inputNodeId}-input-${connection.inputId}`,
  ] as const;
  cacheKeysByConnection.set(connection, keys);
  return keys;
}
