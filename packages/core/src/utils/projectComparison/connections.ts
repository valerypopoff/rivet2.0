import stableStringify from 'safe-stable-stringify';
import type { ChartNode, NodeConnection } from '../../model/NodeBase.js';
import type { ProjectConnectionComparison } from '../projectComparison.js';
import { unionKeys } from './values.js';

export function getProjectConnectionComparisonKey(connection: NodeConnection): string {
  return stableStringify([
    connection.outputNodeId,
    connection.outputId,
    connection.inputNodeId,
    connection.inputId,
  ])!;
}

export function getComparableGraphConnections(connections: NodeConnection[], nodes: ChartNode[]): NodeConnection[] {
  const commentNodeIds = new Set(nodes.filter((node) => node.type === 'comment').map((node) => node.id));
  return connections.filter(
    (connection) => !commentNodeIds.has(connection.outputNodeId) && !commentNodeIds.has(connection.inputNodeId),
  );
}

export function compareConnections(
  beforeConnections: NodeConnection[],
  afterConnections: NodeConnection[],
): Record<string, ProjectConnectionComparison> {
  const beforeByKey = new Map(beforeConnections.map((connection) => [getProjectConnectionComparisonKey(connection), connection]));
  const afterByKey = new Map(afterConnections.map((connection) => [getProjectConnectionComparisonKey(connection), connection]));
  const removedKeys = beforeConnections.map(getProjectConnectionComparisonKey).filter((key) => !afterByKey.has(key));
  const addedKeys = afterConnections.map(getProjectConnectionComparisonKey).filter((key) => !beforeByKey.has(key));
  const changedRemovedKeys = new Set<string>();
  const changedAddedKeys = new Set<string>();

  for (const addedKey of addedKeys) {
    const addedConnection = afterByKey.get(addedKey)!;
    const matchingRemovedKey = removedKeys.find((removedKey) => {
      if (changedRemovedKeys.has(removedKey)) {
        return false;
      }

      const removedConnection = beforeByKey.get(removedKey)!;
      return (
        removedConnection.outputNodeId === addedConnection.outputNodeId &&
        removedConnection.inputNodeId === addedConnection.inputNodeId
      );
    });

    if (matchingRemovedKey) {
      changedRemovedKeys.add(matchingRemovedKey);
      changedAddedKeys.add(addedKey);
    }
  }

  return Object.fromEntries(
    unionKeys(Object.fromEntries(beforeByKey), Object.fromEntries(afterByKey)).map((key) => {
      const before = beforeByKey.get(key);
      const after = afterByKey.get(key);
      const kind = changedAddedKeys.has(key) || changedRemovedKeys.has(key)
        ? 'changed'
        : !before && after
          ? 'added'
          : before && !after
            ? 'removed'
            : 'unchanged';

      return [
        key,
        {
          key,
          kind,
          before,
          after,
        } satisfies ProjectConnectionComparison,
      ];
    }),
  );
}
