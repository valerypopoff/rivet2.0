import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { DataValue, FunctionDataValues, ScalarOrArrayDataType } from '../DataValue.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  missingStoredValueDataValue,
  portableStoredValueScalarTypes,
  storedValueToDataValue,
} from './StoredValueNodeUtils.js';

export type GetStoredValueNode = ChartNode<'getStoredValue', GetStoredValueNodeData>;

export type GetStoredValueNodeData = {
  dataType: ScalarOrArrayDataType;
  key: string;
  onDemand: boolean;
  useKeyInput: boolean;
  wait: boolean;
};

export class GetStoredValueNodeImpl extends NodeImpl<GetStoredValueNode> {
  static create(): GetStoredValueNode {
    return {
      type: 'getStoredValue',
      title: 'Get Stored Value',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 220 },
      data: { dataType: 'string', key: 'key', onDemand: false, useKeyInput: false, wait: false },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return this.data.useKeyInput ? [{ id: 'key' as PortId, title: 'Key', dataType: 'string' }] : [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'value' as PortId,
        title: 'Value',
        dataType: this.data.onDemand ? (`fn<${this.data.dataType}>` as const) : this.data.dataType,
      },
      { id: 'found' as PortId, title: 'Found', dataType: 'boolean' },
      { id: 'key' as PortId, title: 'Key', dataType: 'string' },
    ];
  }

  getEditors(): EditorDefinition<GetStoredValueNode>[] {
    return [
      {
        type: 'custom',
        label: 'Search Stored Values',
        customEditorId: 'GetStoredValueSelector',
        autoFocus: true,
      },
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
      {
        type: 'toggle',
        dataKey: 'onDemand',
        label: 'On Demand',
        turnOffDataKeysWhenEnabled: ['wait'],
      },
      {
        type: 'toggle',
        dataKey: 'wait',
        label: 'Wait',
        turnOffDataKeysWhenEnabled: ['onDemand'],
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return dedent`
      ${this.data.useKeyInput ? '(Key from input)' : this.data.key}
      Type: ${this.data.dataType}
      ${this.data.wait ? 'Waits for an in-run Set' : ''}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody:
        'Loads a portable JSON value from the root-run cache or the host persistence store. Missing keys return the selected type default.',
      infoBoxTitle: 'Get Stored Value Node',
      contextMenuTitle: 'Get Stored Value',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    if (this.data.onDemand && this.data.wait) throw new Error('Cannot use On Demand and Wait together');

    const key = this.data.useKeyInput ? coerceType(inputs['key' as PortId], 'string') : this.data.key;
    let result = await context.getStoredValue(key);
    if (!result.found && this.data.wait) {
      result = { found: true, value: await context.waitForStoredValue(key, context.signal) };
    }

    const value = this.data.onDemand
      ? ({
          type: `fn<${this.data.dataType}>`,
          value: () => {
            const cached = context.getCachedStoredValue(key);
            return cached.found
              ? storedValueToDataValue(cached.value, this.data.dataType).value
              : missingStoredValueDataValue(this.data.dataType).value;
          },
        } as FunctionDataValues)
      : result.found
        ? storedValueToDataValue(result.value, this.data.dataType)
        : missingStoredValueDataValue(this.data.dataType);

    return {
      ['value' as PortId]: value as DataValue,
      ['found' as PortId]: { type: 'boolean', value: result.found },
      ['key' as PortId]: { type: 'string', value: key },
    };
  }
}

export const getStoredValueNode = nodeDefinition(GetStoredValueNodeImpl, 'Get Stored Value');
