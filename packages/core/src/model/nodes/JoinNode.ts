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
import { isArrayDataValue } from '../DataValue.js';
import { nanoid } from 'nanoid/non-secure';
import { coerceType, coerceTypeOptional, inferType } from '../../utils/coerceType.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { dedent } from 'ts-dedent';
import { type EditorDefinition } from '../EditorDefinition.js';
import { handleEscapeCharacters } from '../../utils/index.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';

export type JoinNode = ChartNode<'join', JoinNodeData>;

export type JoinNodeData = {
  flatten?: boolean;
  joinString: string;
  useJoinStringInput?: boolean;
};

export class JoinNodeImpl extends NodeImpl<JoinNode> {
  static create = (): JoinNode => {
    const chartNode: JoinNode = {
      type: 'join',
      title: 'Join',
      id: nanoid() as NodeId,
      data: {
        flatten: true,
        joinString: '\n',
      },
      visualData: {
        x: 0,
        y: 0,
        width: 150,
      },
    };
    return chartNode;
  };

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'decimal');

    if (this.data.useJoinStringInput) {
      inputs.push({
        dataType: 'string',
        id: 'joinString' as PortId,
        title: 'Join String',
      });
    }

    for (let i = 1; i <= inputCount; i++) {
      inputs.push({
        dataType: 'string',
        id: `input${i}` as PortId,
        title: `Input ${i}`,
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        dataType: 'string',
        id: 'output' as PortId,
        title: 'Joined',
      },
    ];
  }

  getEditors(): EditorDefinition<JoinNode>[] {
    return [
      {
        type: 'toggle',
        label: 'Flatten',
        dataKey: 'flatten',
      },
      {
        type: 'code',
        label: 'Join String',
        dataKey: 'joinString',
        useInputToggleDataKey: 'useJoinStringInput',
        language: 'plaintext',
      },
    ];
  }

  getBody(): string | undefined {
    return this.data.useJoinStringInput
      ? '(Join value is input)'
      : this.data.joinString === '\n'
        ? '(New line)'
        : this.data.joinString === '\t'
          ? '(Tab)'
          : this.data.joinString === ' '
            ? '(Space)'
            : this.data.joinString;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Takes an array of strings, and joins them using the configured delimiter.

        Defaults to a newline.
      `,
      infoBoxTitle: 'Join Node',
      contextMenuTitle: 'Join',
      group: ['Text'],
    };
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const joinString = this.data.useJoinStringInput
      ? coerceTypeOptional(inputs['joinString' as PortId], 'string') ?? this.data.joinString
      : this.data.joinString;

    const normalizedJoinString = handleEscapeCharacters(joinString);

    const inputKeys = Object.keys(inputs).filter((key) => key.startsWith('input'));

    const inputValueStrings: string[] = [];

    for (let i = 1; i <= inputKeys.length; i++) {
      const inputValue = inputs[`input${i}` as PortId];
      if (isArrayDataValue(inputValue) && this.data.flatten) {
        for (const value of inputValue.value) {
          inputValueStrings.push(coerceType(inferType(value), 'string'));
        }
      } else if (inputValue) {
        inputValueStrings.push(coerceType(inputValue, 'string'));
      }
    }

    const outputValue = inputValueStrings.join(normalizedJoinString);

    return {
      ['output' as PortId]: {
        type: 'string',
        value: outputValue,
      },
    };
  }
}

export const joinNode = nodeDefinition(JoinNodeImpl, 'Coalesce');
