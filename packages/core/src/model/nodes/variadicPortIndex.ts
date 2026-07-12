import type { NodeConnection, NodeId } from '../NodeBase.js';

export type VariadicPortIndexPolicy = 'legacy' | 'decimal' | 'strict-positive';

export function getHighestVariadicPortIndex(
  connections: readonly NodeConnection[],
  inputNodeId: NodeId,
  prefix: string,
  policy: VariadicPortIndexPolicy,
): number {
  let highestIndex = 0;

  for (const connection of connections) {
    if (connection.inputNodeId !== inputNodeId || !connection.inputId.startsWith(prefix)) {
      continue;
    }

    const index = parseVariadicPortIndex(connection.inputId, prefix, policy);
    if (index != null && index > highestIndex) {
      highestIndex = index;
    }
  }

  return highestIndex;
}

export function getNextVariadicPortIndex(
  connections: readonly NodeConnection[],
  inputNodeId: NodeId,
  prefix: string,
  policy: VariadicPortIndexPolicy,
): number {
  return getHighestVariadicPortIndex(connections, inputNodeId, prefix, policy) + 1;
}

function parseVariadicPortIndex(portId: string, prefix: string, policy: VariadicPortIndexPolicy): number | undefined {
  if (policy === 'legacy') {
    const index = parseInt(portId.replace(prefix, ''));
    return Number.isNaN(index) ? undefined : index;
  }

  if (policy === 'decimal') {
    const index = parseInt(portId.replace(prefix, ''), 10);
    return Number.isNaN(index) ? undefined : index;
  }

  const indexText = portId.slice(prefix.length);
  if (!/^\d+$/.test(indexText)) {
    return undefined;
  }

  const index = Number(indexText);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}
