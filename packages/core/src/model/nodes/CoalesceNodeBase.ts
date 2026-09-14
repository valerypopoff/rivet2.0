import { nanoid } from 'nanoid/non-secure';
import { type DataValue, unwrapDataValue } from '../DataValue.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { NodeImpl } from '../NodeImpl.js';
import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';

const INPUT_PORT_ID_PATTERN = /^input(\d+)$/;
const IGNORE_NULL_LABEL = "Ignore 'null'";
const IGNORE_UNDEFINED_LABEL = "Ignore 'undefined'";

export type CoalesceNodeData = {
  ignoreNull?: boolean;
  ignoreUndefined?: boolean;
};

export function createCoalesceNode<T extends string>(type: T, title: string): ChartNode<T, CoalesceNodeData> {
  return {
    type,
    title,
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
}

/** Shared fallback behavior for the current and compatibility Coalesce nodes. */
export abstract class CoalesceNodeBase<T extends ChartNode<string, CoalesceNodeData>> extends NodeImpl<T> {
  protected abstract readonly includesLegacyConditionalInput: boolean;

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    const inputCount = getNextVariadicPortIndex(connections, this.chartNode.id, 'input', 'strict-positive');

    if (this.includesLegacyConditionalInput) {
      inputs.push({
        dataType: 'boolean',
        id: 'conditional' as PortId,
        title: 'Conditional',
      });
    }

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

  getEditors(): EditorDefinition<T>[] {
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
    ] as EditorDefinition<T>[];
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

  async process(inputData: Inputs): Promise<Outputs> {
    const conditional = inputData['conditional' as PortId];

    // Only the legacy dedicated port gates fallback selection here.
    // The processor handles the standard If option for both node types.
    if (this.includesLegacyConditionalInput && conditional?.type === 'control-flow-excluded') {
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
