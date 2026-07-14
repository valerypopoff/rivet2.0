import { nanoid } from 'nanoid/non-secure';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';

export type DidRunNode = ChartNode<'didRun', DidRunNodeData>;

export type DidRunNodeData = {};

const DID_RUN_EXPLANATION =
  'Outputs true when all connected inputs have run. Falsy or empty values still count as having run, so this is useful for adapting "did this branch run at all?" into a boolean If port.';

export class DidRunNodeImpl extends NodeImpl<DidRunNode> {
  static create(): DidRunNode {
    return {
      type: 'didRun',
      title: 'Did Run',
      id: nanoid() as NodeId,
      data: {},
      visualData: {
        x: 0,
        y: 0,
        width: 167,
      },
    };
  }

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'decimal');
    const inputs: NodeInputDefinition[] = [];

    for (let i = 1; i <= inputCount; i++) {
      inputs.push({
        dataType: 'any',
        id: `input${i}` as PortId,
        title: `Input ${i}`,
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        dataType: 'boolean',
        id: 'ran' as PortId,
        title: 'Ran',
      },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: DID_RUN_EXPLANATION,
      infoBoxTitle: 'Did Run Node',
      contextMenuTitle: 'Did Run',
      group: ['Logic'],
    };
  }

  getEditors(): EditorDefinition<DidRunNode>[] {
    return [
      {
        type: 'info',
        label: 'Behavior',
        helperMessage: DID_RUN_EXPLANATION,
      },
    ];
  }

  async process(inputData: Inputs): Promise<Outputs> {
    const hasDynamicInput = Object.keys(inputData).some((key) => key.startsWith('input'));

    if (!hasDynamicInput) {
      return {
        ['ran' as PortId]: {
          type: 'control-flow-excluded',
          value: undefined,
        },
      };
    }

    return {
      ['ran' as PortId]: {
        type: 'boolean',
        value: true,
      },
    };
  }
}

export const didRunNode = nodeDefinition(DidRunNodeImpl, 'Did Run');
