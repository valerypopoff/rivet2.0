import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { dedent } from 'ts-dedent';
import {
  getDataBusInputPortId,
  getDataBusOutputPortId,
  MAX_DATA_BUS_CHANNEL_INDEX,
  parseDataBusChannelIndex,
} from '../DataBusPorts.js';

/**
 * A Data Bus is an authoring-topology primitive. Its channels are expanded
 * into independent effective connections before graph execution, so this node
 * must never be dispatched by GraphProcessor as an ordinary NodeImpl.
 */
export type DataBusNode = ChartNode<'dataBus', Record<string, never>>;

export {
  getDataBusInputPortId,
  getDataBusOutputPortId,
  MAX_DATA_BUS_CHANNEL_INDEX,
  parseDataBusChannelIndex,
} from '../DataBusPorts.js';

function getConnectedChannelIndices(connections: readonly NodeConnection[], nodeId: NodeId): number[] {
  const channelIndices = new Set<number>();

  for (const connection of connections) {
    const inputIndex =
      connection.inputNodeId === nodeId ? parseDataBusChannelIndex(connection.inputId, true) : undefined;
    const outputIndex =
      connection.outputNodeId === nodeId ? parseDataBusChannelIndex(connection.outputId, false) : undefined;

    if (inputIndex != null) {
      channelIndices.add(inputIndex);
    }
    if (outputIndex != null) {
      channelIndices.add(outputIndex);
    }
  }

  return [...channelIndices].sort((left, right) => left - right);
}

function getFirstAvailableChannelIndex(connectedChannelIndices: readonly number[]): number | undefined {
  let availableIndex = 1;

  for (const channelIndex of connectedChannelIndices) {
    if (channelIndex !== availableIndex) {
      break;
    }
    availableIndex += 1;
  }

  return availableIndex <= MAX_DATA_BUS_CHANNEL_INDEX ? availableIndex : undefined;
}

export function isDataBusNode(node: ChartNode | undefined): node is DataBusNode {
  return node?.type === 'dataBus';
}

export class DataBusNodeImpl extends NodeImpl<DataBusNode> {
  static create = (): DataBusNode => ({
    type: 'dataBus',
    title: 'Data Bus',
    id: nanoid() as NodeId,
    data: {},
    visualData: {
      x: 0,
      y: 0,
      width: 175,
    },
  });

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const connectedChannelIndices = getConnectedChannelIndices(connections, this.chartNode.id);
    const availableChannelIndex = getFirstAvailableChannelIndex(connectedChannelIndices);
    const channelIndices =
      availableChannelIndex == null ? connectedChannelIndices : [...connectedChannelIndices, availableChannelIndex];

    return channelIndices.map((channelIndex) => ({
      dataType: 'any',
      id: getDataBusInputPortId(channelIndex),
      title: `Input ${channelIndex}`,
    }));
  }

  getOutputDefinitions(connections: NodeConnection[]): NodeOutputDefinition[] {
    const connectedChannelIndices = getConnectedChannelIndices(connections, this.chartNode.id);

    return connectedChannelIndices.map((channelIndex) => ({
      dataType: 'any',
      id: getDataBusOutputPortId(channelIndex),
      title: `Output ${channelIndex}`,
    }));
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Organizes independent connections in a compact rail at the top of the
        canvas. Data Bus channels are wiring topology, not executable nodes.
      `,
      infoBoxTitle: 'Data Bus',
      contextMenuTitle: 'Data Bus',
      group: ['Logic'],
    };
  }

  async process(_inputData: Inputs): Promise<Outputs> {
    throw new Error('Data Bus nodes are topology-only and must be compiled out before graph execution.');
  }
}

export const dataBusNode = nodeDefinition(DataBusNodeImpl, 'Data Bus');
