import {
  canBeCoercedAny,
  isDataTypeAccepted,
  type DataType,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '@valerypopoff/rivet2-core';

export type PortCompatibilityStatus = 'none' | 'compatible' | 'coerced' | 'incompatible';

export function getPortCompatibilityStatus(options: {
  draggingDataType?: DataType | Readonly<DataType[]>;
  portDataType?: DataType | Readonly<DataType[]>;
  canCoerce: boolean;
  isInput: boolean;
}): PortCompatibilityStatus {
  const { draggingDataType, portDataType, canCoerce, isInput } = options;

  if (!isInput || !draggingDataType || !portDataType) {
    return 'none';
  }

  if (isDataTypeAccepted(draggingDataType, portDataType)) {
    return 'compatible';
  }

  if (canCoerce && canBeCoercedAny(draggingDataType, portDataType)) {
    return 'coerced';
  }

  return 'incompatible';
}

export interface InputConnectionWarning {
  status: 'coerced' | 'incompatible';
  sourceType: NodeOutputDefinition['dataType'];
  targetType: NodeInputDefinition['dataType'];
}

/** Advisory only: never modifies or rejects a saved connection. */
export function getConnectedInputWarningDetails(options: {
  nodeId: NodeId;
  connections: readonly NodeConnection[];
  inputDefinitions: readonly NodeInputDefinition[];
  getOutputDefinitions: (nodeId: NodeId) => readonly NodeOutputDefinition[];
}): ReadonlyMap<PortId, readonly InputConnectionWarning[]> {
  const warnings = new Map<PortId, InputConnectionWarning[]>();
  const inputs = new Map(options.inputDefinitions.map((definition) => [definition.id, definition]));
  const sources = new Map<NodeId, Map<PortId, NodeOutputDefinition>>();
  for (const connection of options.connections) {
    if (connection.inputNodeId !== options.nodeId) continue;
    const input = inputs.get(connection.inputId);
    if (!input) continue;
    let outputs = sources.get(connection.outputNodeId);
    if (!outputs) {
      outputs = new Map(
        options.getOutputDefinitions(connection.outputNodeId).map((definition) => [definition.id, definition]),
      );
      sources.set(connection.outputNodeId, outputs);
    }
    const sourceType = outputs.get(connection.outputId)?.dataType;
    const status = getPortCompatibilityStatus({
      draggingDataType: sourceType,
      portDataType: input.dataType,
      canCoerce: input.coerced ?? true,
      isInput: true,
    });
    if (sourceType && (status === 'coerced' || status === 'incompatible')) {
      const details = warnings.get(input.id) ?? [];
      details.push({ status, sourceType, targetType: input.dataType });
      warnings.set(input.id, details);
    }
  }
  return warnings;
}

export function getConnectedInputWarnings(
  options: Parameters<typeof getConnectedInputWarningDetails>[0],
): ReadonlySet<PortId> {
  return new Set(getConnectedInputWarningDetails(options).keys());
}
