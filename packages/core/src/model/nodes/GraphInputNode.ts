import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type DataType, type DataValue, getDefaultValue, isArrayDataType } from '../DataValue.js';
import { type Inputs } from '../GraphProcessor.js';
import { type InternalProcessContext } from '../ProcessContext.js';
import { type DynamicEditorEditor, type EditorDefinition, type NodeBodySpec } from '../../index.js';
import { dedent } from 'ts-dedent';
import { coerceTypeOptional, inferType } from '../../utils/coerceType.js';

export type GraphInputNode = ChartNode<'graphInput', GraphInputNodeData>;

export type GraphInputNodeData = {
  id: string;
  dataType: DataType;
  defaultValue?: unknown;
  useDefaultValueInput?: boolean;
  editor?: DynamicEditorEditor;
};

export class GraphInputNodeImpl extends NodeImpl<GraphInputNode> {
  static create(): GraphInputNode {
    const chartNode: GraphInputNode = {
      type: 'graphInput',
      title: 'Graph Input',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 300,
      },
      data: {
        id: 'input',
        dataType: 'string',
        defaultValue: undefined,
        useDefaultValueInput: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    if (this.data.useDefaultValueInput) {
      return [
        {
          id: 'default' as PortId,
          title: 'Default Value',
          dataType: this.chartNode.data.dataType as DataType,
        },
      ];
    }

    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'data' as PortId,
        title: this.data.id,
        dataType: this.chartNode.data.dataType as DataType,
      },
    ];
  }

  getEditors(): EditorDefinition<GraphInputNode>[] {
    return [
      {
        type: 'string',
        label: 'ID',
        dataKey: 'id',
      },
      {
        type: 'dataTypeSelector',
        label: 'Data Type',
        dataKey: 'dataType',
      },
      {
        type: 'anyData',
        label: 'Default Value',
        dataKey: 'defaultValue',
        useInputToggleDataKey: 'useDefaultValueInput',
      },
      {
        type: 'dropdown',
        label: 'Editor',
        dataKey: 'editor',
        defaultValue: 'auto',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Auto', value: 'auto' },
          { label: 'String', value: 'string' },
          { label: 'Number', value: 'number' },
          { label: 'Code', value: 'code' },
          { label: 'Data Type', value: 'dataTypeSelector' },
          { label: 'String List', value: 'stringList' },
          { label: 'Key Value Pairs', value: 'keyValuePair' },
          { label: 'Toggle', value: 'toggle' },
        ] satisfies { label: string; value: DynamicEditorEditor }[],
        helperMessage: 'The editor to use when editing this value in the UI. Make sure this matches the data type.',
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return dedent`
      ${this.data.id}
      Type: ${this.data.dataType}
      ${this.data.defaultValue == null ? '' : `Default: ${this.data.defaultValue}`}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Defines an input for the graph which can be passed in when the graph is called, or defines one of the input ports when the graph is a subgraph.
      `,
      infoBoxTitle: 'Graph Input Node',
      contextMenuTitle: 'Graph Input',
      group: ['Input/Output'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Record<string, DataValue>> {
    const value = resolveGraphInputValue(this.data, context.graphInputs[this.data.id], inputs);

    // Store the resolved value in the context for access by other nodes
    context.graphInputNodeValues[this.data.id] = value;

    return { ['data' as PortId]: value };
  }
}

/** One coercion/default policy for ordinary and live graph inputs. */
export function resolveGraphInputValue(
  data: GraphInputNodeData,
  input: DataValue | undefined,
  inputs: Inputs = {},
): DataValue {
  let inputValue = input == null ? undefined : coerceTypeOptional(input, data.dataType);
  if (inputValue == null && data.useDefaultValueInput) {
    inputValue = coerceTypeOptional(inputs['default' as PortId], data.dataType);
  }
  if (inputValue == null) {
    inputValue = coerceTypeOptional(inferType(data.defaultValue), data.dataType) || getDefaultValue(data.dataType);
  }
  if (inputValue == null && isArrayDataType(data.dataType)) {
    inputValue = { type: data.dataType, value: [] } as DataValue;
  }
  return { type: data.dataType, value: inputValue } as DataValue;
}

export const graphInputNode = nodeDefinition(GraphInputNodeImpl, 'Graph Input');
