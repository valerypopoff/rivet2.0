import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import { type ScalarOrArrayDataType, unwrapDataValue } from '../DataValue.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { cloneRivetStoredValue } from '../StoredValueStore.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  missingStoredValueDataValue,
  portableStoredValueScalarTypes,
  storedValueToDataValue,
} from './StoredValueNodeUtils.js';

export type SetStoredValueNode = ChartNode<'setStoredValue', SetStoredValueNodeData>;

export type SetStoredValueNodeData = {
  dataType: ScalarOrArrayDataType;
  key: string;
  useKeyInput: boolean;
};

export class SetStoredValueNodeImpl extends NodeImpl<SetStoredValueNode> {
  static create(): SetStoredValueNode {
    return {
      type: 'setStoredValue',
      title: 'Set Stored Value',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 220 },
      data: { dataType: 'string', key: 'key', useKeyInput: false },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    if (this.data.useKeyInput) {
      inputs.push({ id: 'key' as PortId, title: 'Key', dataType: 'string' });
    }
    inputs.push({ id: 'value' as PortId, title: 'Value', dataType: this.data.dataType });
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'saved-value' as PortId, title: 'Saved Value', dataType: this.data.dataType },
      { id: 'previous-value' as PortId, title: 'Previous Value', dataType: this.data.dataType },
      { id: 'had-previous-value' as PortId, title: 'Had Previous Value', dataType: 'boolean' },
      { id: 'key' as PortId, title: 'Key', dataType: 'string' },
    ];
  }

  getEditors(): EditorDefinition<SetStoredValueNode>[] {
    return [
      {
        type: 'string',
        dataKey: 'key',
        useInputToggleDataKey: 'useKeyInput',
        label: 'Key',
        includeInGraphSearch: true,
      },
      {
        type: 'dataTypeSelector',
        dataKey: 'dataType',
        label: 'Data Type',
        allowedDataTypes: portableStoredValueScalarTypes,
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return dedent`
      ${this.data.useKeyInput ? '(Key from input)' : this.data.key}
      Type: ${this.data.dataType}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody:
        'Stores a portable JSON value in the current root run and, when the host supplies persistence, across later runs.',
      infoBoxTitle: 'Set Stored Value Node',
      contextMenuTitle: 'Set Stored Value',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const inputValue = inputs['value' as PortId];
    if (!inputValue) throw new Error('Missing stored value');

    const key = this.data.useKeyInput ? coerceType(inputs['key' as PortId], 'string') : this.data.key;
    const coercedValue =
      this.data.dataType === 'any' ? unwrapDataValue(inputValue).value : coerceType(inputValue, this.data.dataType);
    const storedValue = cloneRivetStoredValue(coercedValue, 'Stored Value node input');
    const result = await context.setStoredValue(key, storedValue);

    return {
      ['saved-value' as PortId]: storedValueToDataValue(result.savedValue, this.data.dataType),
      ['previous-value' as PortId]: result.hadPreviousValue
        ? storedValueToDataValue(result.previousValue!, this.data.dataType)
        : missingStoredValueDataValue(this.data.dataType),
      ['had-previous-value' as PortId]: { type: 'boolean', value: result.hadPreviousValue },
      ['key' as PortId]: { type: 'string', value: key },
    };
  }
}

export const setStoredValueNode = nodeDefinition(SetStoredValueNodeImpl, 'Set Stored Value');
