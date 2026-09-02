import type { ChartNode, NodeConnection, NodeId, NodeInputDefinition } from '@valerypopoff/rivet2-core';

type DisabledRequiredInput = {
  inputTitle: string;
  sourceTitle: string;
};

function getConnectionSlotKey(connection: NodeConnection): string {
  return `${connection.inputNodeId}\u0000${connection.inputId}`;
}

function getRequiredInputWarning(disabledInputs: readonly DisabledRequiredInput[]): string {
  if (disabledInputs.length === 1) {
    const { inputTitle, sourceTitle } = disabledInputs[0]!;
    return `Required input "${inputTitle}" is connected to disabled node "${sourceTitle}". It will not provide a value, so this node is marked Not Ran. Enable the source or remove or replace the connection.`;
  }

  const dependencies = disabledInputs
    .map(({ inputTitle, sourceTitle }) => `"${inputTitle}" ← "${sourceTitle}"`)
    .join('; ');
  return `Required inputs are connected to disabled nodes: ${dependencies}. They will not provide values, so this node is marked Not Ran. Enable the sources or remove or replace the connections.`;
}

/**
 * Returns header-warning text for enabled nodes whose required input is fed by
 * a disabled node. `connections` must already exclude missing/stale ports.
 *
 * Runtime execution uses the first valid wire for an input slot. Mirroring
 * that rule here keeps malformed duplicate wires from changing the warning.
 */
export function getDisabledRequiredInputWarnings({
  connections,
  getInputDefinitions,
  nodesById,
}: {
  connections: readonly NodeConnection[];
  getInputDefinitions: (nodeId: NodeId) => readonly NodeInputDefinition[];
  nodesById: Readonly<Partial<Record<NodeId, ChartNode>>>;
}): ReadonlyMap<NodeId, string> {
  const firstConnectionByInputSlot = new Map<string, NodeConnection>();

  for (const connection of connections) {
    const inputSlotKey = getConnectionSlotKey(connection);
    if (!firstConnectionByInputSlot.has(inputSlotKey)) {
      firstConnectionByInputSlot.set(inputSlotKey, connection);
    }
  }

  const disabledInputsByTargetNodeId = new Map<NodeId, DisabledRequiredInput[]>();

  for (const connection of firstConnectionByInputSlot.values()) {
    const sourceNode = nodesById[connection.outputNodeId];
    const targetNode = nodesById[connection.inputNodeId];

    if (!sourceNode?.disabled || !targetNode || targetNode.disabled) {
      continue;
    }

    const inputDefinition = getInputDefinitions(targetNode.id).find(
      (definition) => definition.id === connection.inputId && definition.required,
    );
    if (!inputDefinition) {
      continue;
    }

    const disabledInputs = disabledInputsByTargetNodeId.get(targetNode.id) ?? [];
    disabledInputs.push({
      inputTitle: inputDefinition.title || (inputDefinition.id as string),
      sourceTitle: sourceNode.title,
    });
    disabledInputsByTargetNodeId.set(targetNode.id, disabledInputs);
  }

  return new Map(
    [...disabledInputsByTargetNodeId.entries()].map(([nodeId, disabledInputs]) => [
      nodeId,
      getRequiredInputWarning(disabledInputs),
    ]),
  );
}

export function combineNodeHeaderWarnings(...warnings: Array<string | undefined>): string | undefined {
  const uniqueWarnings = [...new Set(warnings.filter((warning): warning is string => Boolean(warning)))];
  return uniqueWarnings.length > 0 ? uniqueWarnings.join('\n\n') : undefined;
}
