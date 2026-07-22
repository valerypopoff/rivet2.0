import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';

export type StartBackgroundBranchNode = ChartNode<'startBackgroundBranch', StartBackgroundBranchNodeData>;

export type StartBackgroundBranchNodeData = {};

export class StartBackgroundBranchNodeImpl extends NodeImpl<StartBackgroundBranchNode> {
  static create = (): StartBackgroundBranchNode => ({
    type: 'startBackgroundBranch',
    title: 'Start Async Branch',
    id: nanoid() as NodeId,
    data: {},
    visualData: {
      x: 0,
      y: 0,
      width: 200,
    },
  });

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'decimal');

    return Array.from({ length: inputCount }, (_, index) => ({
      dataType: 'any',
      id: `input${index + 1}` as PortId,
      title: `Async Input ${index + 1}`,
    }));
  }

  getOutputDefinitions(connections: NodeConnection[]): NodeOutputDefinition[] {
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'decimal');

    return Array.from({ length: Math.max(0, inputCount - 1) }, (_, index) => ({
      dataType: 'any',
      id: `output${index + 1}` as PortId,
      title: `Async Output ${index + 1}`,
    }));
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Starts its downstream branch asynchronously. The foreground graph continues immediately, while the root run waits for the async branch before it ends.
      `,
      infoBoxTitle: 'Start Async Branch Node',
      contextMenuTitle: 'Start Async Branch',
      group: ['Logic'],
    };
  }

  getBody(): string {
    return 'Starts downstream asynchronously; the root run still waits';
  }

  async process(inputData: Inputs): Promise<Outputs> {
    const outputs: Outputs = {};

    for (const [inputId, value] of Object.entries(inputData)) {
      const match = /^input([1-9]\d*)$/.exec(inputId);
      if (match && value != null) {
        outputs[`output${match[1]}` as PortId] = value;
      }
    }

    return outputs;
  }
}

export const startBackgroundBranchNode = nodeDefinition(StartBackgroundBranchNodeImpl, 'Start Async Branch');
