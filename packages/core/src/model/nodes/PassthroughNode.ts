import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { dedent } from 'ts-dedent';

export type PassthroughNode = ChartNode<'passthrough', Record<string, never>>;

const INPUT_PORT_PATTERN = /^input(\d+)$/;
const OUTPUT_PORT_PATTERN = /^output(\d+)$/;
/** @deprecated Use MAX_DATA_BUS_CHANNEL_INDEX for Data Bus channels. */
export const MAX_PASSTHROUGH_PORT_INDEX = 10_000;

function parsePositivePortIndex(portId: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(portId);
  const index = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(index) && index > 0 && index <= MAX_PASSTHROUGH_PORT_INDEX ? index : undefined;
}

function getHighestConnectedSlotIndex(connections: readonly NodeConnection[], nodeId: NodeId): number {
  let highestIndex = 0;

  for (const connection of connections) {
    const inputIndex =
      connection.inputNodeId === nodeId ? parsePositivePortIndex(connection.inputId, INPUT_PORT_PATTERN) : undefined;
    const outputIndex =
      connection.outputNodeId === nodeId ? parsePositivePortIndex(connection.outputId, OUTPUT_PORT_PATTERN) : undefined;

    highestIndex = Math.max(highestIndex, inputIndex ?? 0, outputIndex ?? 0);
  }

  return highestIndex;
}

export class PassthroughNodeImpl extends NodeImpl<PassthroughNode> {
  static create = (): PassthroughNode => {
    const chartNode: PassthroughNode = {
      type: 'passthrough',
      title: 'Passthrough',
      id: nanoid() as NodeId,
      data: {},
      visualData: {
        x: 0,
        y: 0,
        width: 175,
      },
    };
    return chartNode;
  };

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    const inputCount = Math.min(
      getHighestConnectedSlotIndex(connections, this.chartNode.id) + 1,
      MAX_PASSTHROUGH_PORT_INDEX,
    );

    for (let i = 1; i <= inputCount; i++) {
      inputs.push({
        dataType: 'any',
        id: `input${i}` as PortId,
        title: `Input ${i}`,
      });
    }

    return inputs;
  }

  getOutputDefinitions(connections: NodeConnection[]): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];
    const outputCount = getHighestConnectedSlotIndex(connections, this.chartNode.id);

    for (let i = 1; i <= outputCount; i++) {
      outputs.push({
        dataType: 'any',
        id: `output${i}` as PortId,
        title: `Output ${i}`,
      });
    }

    return outputs;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Simply passes the input value to the output without any modifications.
      `,
      infoBoxTitle: 'Passthrough Node',
      contextMenuTitle: 'Passthrough',
      group: ['Logic'],
    };
  }

  async process(inputData: Inputs): Promise<Outputs> {
    const outputs: Outputs = {};

    for (const [portId, input] of Object.entries(inputData)) {
      const index = parsePositivePortIndex(portId, INPUT_PORT_PATTERN);

      if (index != null) {
        outputs[`output${index}` as PortId] = input;
      }
    }

    return outputs;
  }
}

export const passthroughNode = nodeDefinition(PassthroughNodeImpl, 'Passthrough');
