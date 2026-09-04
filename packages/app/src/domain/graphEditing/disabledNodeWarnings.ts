import {
  canConsumeControlFlowExcludedInput,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
} from '@valerypopoff/rivet2-core';

type DisabledUpstreamInput = {
  inputTitle: string;
  sourceTitle: string;
};

function getConnectionSlotKey(connection: NodeConnection): string {
  return `${connection.inputNodeId}\u0000${connection.inputId}`;
}

function getDisabledUpstreamInputWarning(disabledInputs: readonly DisabledUpstreamInput[]): string {
  if (disabledInputs.length === 1) {
    const { inputTitle, sourceTitle } = disabledInputs[0]!;
    return `Input "${inputTitle}" is connected to disabled node "${sourceTitle}". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.`;
  }

  const dependencies = disabledInputs
    .map(({ inputTitle, sourceTitle }) => `"${inputTitle}" ← "${sourceTitle}"`)
    .join('; ');
  return `Inputs are connected to disabled nodes: ${dependencies}. Disabled connections provide no usable values, so when running, this node will be marked Not Ran.`;
}

/**
 * Returns header-warning text for enabled nodes whose connected input is fed
 * by a disabled node and whose runtime policy does not consume excluded
 * values. `connections` must already exclude missing/stale ports.
 *
 * Runtime execution uses the first valid wire for an input slot. Mirroring
 * that rule here keeps malformed duplicate wires from changing the warning.
 */
export function getDisabledUpstreamInputWarnings({
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

  const disabledInputsByTargetNodeId = new Map<NodeId, DisabledUpstreamInput[]>();

  for (const connection of firstConnectionByInputSlot.values()) {
    const sourceNode = nodesById[connection.outputNodeId];
    const targetNode = nodesById[connection.inputNodeId];

    if (!sourceNode?.disabled || !targetNode || targetNode.disabled) {
      continue;
    }

    const inputDefinition = getInputDefinitions(targetNode.id).find(
      (definition) => definition.id === connection.inputId,
    );
    if (!inputDefinition || canConsumeControlFlowExcludedInput(targetNode)) {
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
      getDisabledUpstreamInputWarning(disabledInputs),
    ]),
  );
}

export function combineNodeHeaderWarnings(...warnings: Array<string | undefined>): string | undefined {
  const uniqueWarnings = [...new Set(warnings.filter((warning): warning is string => Boolean(warning)))];
  return uniqueWarnings.length > 0 ? uniqueWarnings.join('\n\n') : undefined;
}
