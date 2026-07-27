import {
  getDataBusInputChannelIndex,
  getDataBusOutputChannelIndex,
  type ChartNode,
  type NodeConnection,
  type PortId,
} from '@valerypopoff/rivet2-core';

/**
 * Returns the local connection problem that would make converting this
 * executable Passthrough into a topology-only Data Bus invalid. Only incident
 * edges are considered so unrelated, already-invalid graph data does not hide
 * a safe conversion action.
 */
export function getPassthroughDataBusConversionError(
  node: ChartNode,
  connections: readonly NodeConnection[],
): string | undefined {
  if (node.type !== 'passthrough') {
    return undefined;
  }

  const providersByInputPort = new Map<PortId, number>();

  for (const connection of connections) {
    if (connection.inputNodeId === node.id) {
      const channelIndex = getDataBusInputChannelIndex(connection.inputId);
      if (channelIndex == null) {
        return `Cannot convert: incoming port "${connection.inputId}" is not a valid Data Bus input channel.`;
      }

      providersByInputPort.set(connection.inputId, (providersByInputPort.get(connection.inputId) ?? 0) + 1);
    }

    if (connection.outputNodeId === node.id && getDataBusOutputChannelIndex(connection.outputId) == null) {
      return `Cannot convert: outgoing port "${connection.outputId}" is not a valid Data Bus output channel.`;
    }
  }

  for (const [inputPortId, providerCount] of providersByInputPort) {
    if (providerCount > 1) {
      return `Cannot convert: Data Bus channel "${inputPortId}" has ${providerCount} providers. Disconnect all but one first.`;
    }
  }

  return undefined;
}
