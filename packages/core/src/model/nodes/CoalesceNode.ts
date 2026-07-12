import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { type DataValue, unwrapDataValue } from '../DataValue.js';
import { nanoid } from 'nanoid/non-secure';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';

const INPUT_PORT_ID_PATTERN = /^input(\d+)$/;
const IGNORE_NULL_LABEL = "Ignore 'null'";
const IGNORE_UNDEFINED_LABEL = "Ignore 'undefined'";

export type CoalesceNode = ChartNode<'coalesce', CoalesceNodeData>;

export type CoalesceNodeData = {
  ignoreNull?: boolean;
  ignoreUndefined?: boolean;
};

export class CoalesceNodeImpl extends NodeImpl<CoalesceNode> {
  static create = (): CoalesceNode => {
    const chartNode: CoalesceNode = {
      type: 'coalesce',
      title: 'Coalesce',
      id: nanoid() as NodeId,
      data: {
        ignoreNull: false,
        ignoreUndefined: false,
      },
      visualData: {
        x: 0,
        y: 0,
        width: 190,
      },
    };
    return chartNode;
  };

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'strict-positive');

    inputs.push({
      dataType: 'boolean',
      id: 'conditional' as PortId,
      title: 'Conditional',
    });

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
        dataType: 'any',
        id: 'output' as PortId,
        title: 'Output',
      },
    ];
  }

  getEditors(): EditorDefinition<CoalesceNode>[] {
    return [
      {
        type: 'toggle',
        label: IGNORE_NULL_LABEL,
        dataKey: 'ignoreNull',
      },
      {
        type: 'toggle',
        label: IGNORE_UNDEFINED_LABEL,
        dataKey: 'ignoreUndefined',
      },
    ];
  }

  getBody(): string | undefined {
    const ignoredValues: string[] = [];

    if (this.data.ignoreNull) {
      ignoredValues.push(IGNORE_NULL_LABEL);
    }

    if (this.data.ignoreUndefined) {
      ignoredValues.push(IGNORE_UNDEFINED_LABEL);
    }

    return ignoredValues.length > 0 ? ignoredValues.join('\n') : undefined;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Takes in any number of inputs and outputs the first value that is not "Not Ran". Useful for consolidating branches after a Match node.

        Null and undefined input values are emitted by default, but the node can be configured to skip either value and continue checking later inputs.
      `,
      infoBoxTitle: 'Coalesce Node',
      contextMenuTitle: 'Coalesce',
      group: ['Logic'],
    };
  }

  async process(inputData: Inputs): Promise<Outputs> {
    const conditional = inputData['conditional' as PortId];

    // This lets the coalesce actually be control-flow-excluded itself, because otherwise
    // the input control-flow-excluded are consumed.
    if (conditional?.type === 'control-flow-excluded') {
      return {
        ['output' as PortId]: {
          type: 'control-flow-excluded',
          value: undefined,
        },
      };
    }

    const inputCount = this.#getInputCountFromValues(inputData);

    for (let i = 1; i <= inputCount; i++) {
      const inputValue = inputData[`input${i}` as PortId];
      if (inputValue && inputValue.type !== 'control-flow-excluded' && !this.#shouldSkipInputValue(inputValue)) {
        return {
          ['output' as PortId]: inputValue,
        };
      }
    }

    return {
      ['output' as PortId]: {
        type: 'control-flow-excluded',
        value: undefined,
      },
    };
  }

  #getInputCountFromValues(inputData: Inputs): number {
    let maxInputNumber = 0;
    for (const inputId of Object.keys(inputData)) {
      const inputNumber = this.#getInputPortNumber(inputId);
      if (inputNumber && inputNumber > maxInputNumber) {
        maxInputNumber = inputNumber;
      }
    }

    return maxInputNumber;
  }

  #getInputPortNumber(inputId: string): number | undefined {
    const match = INPUT_PORT_ID_PATTERN.exec(inputId);
    if (!match) {
      return undefined;
    }

    const inputNumber = Number(match[1]);
    return Number.isSafeInteger(inputNumber) && inputNumber > 0 ? inputNumber : undefined;
  }

  #shouldSkipInputValue(inputValue: DataValue): boolean {
    const value = unwrapDataValue(inputValue).value;

    return (
      (this.data.ignoreNull === true && value === null) || (this.data.ignoreUndefined === true && value === undefined)
    );
  }
}

export const coalesceNode = nodeDefinition(CoalesceNodeImpl, 'Coalesce');
