import {
  type ChartNode,
  type NodeId,
  type NodeOutputDefinition,
  type PortId,
  type NodeInputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type DataType, type DataValue } from '../DataValue.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type InternalProcessContext } from '../ProcessContext.js';
import { dedent } from 'ts-dedent';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type NodeBodySpec } from '../NodeBodySpec.js';
import { commitGraphOutputValue } from '../GraphBoundaryEffects.js';

export type GraphOutputNode = ChartNode<'graphOutput', GraphOutputNodeData>;

export type GraphOutputNodeData = {
  id: string;
  dataType: DataType;
};

function isPlainObjectRecordValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Graph Output applies the same boundary coercion to both its terminal value
 * and a partial value forwarded across a Subgraph boundary. Keeping this
 * conversion here prevents a streamed named output from disagreeing with the
 * value that the Graph Output will eventually publish.
 */
export function coerceGraphOutputValue(value: DataValue, dataType: DataType): DataValue {
  if (value.type === 'control-flow-excluded' || dataType === 'any' || value.type === dataType) {
    return value;
  }

  if (value.type !== 'any') {
    return value;
  }

  if (dataType === 'object' && isPlainObjectRecordValue(value.value)) {
    return {
      type: 'object',
      value: value.value,
    };
  }

  if (dataType === 'object[]' && Array.isArray(value.value) && value.value.every(isPlainObjectRecordValue)) {
    return {
      type: 'object[]',
      value: value.value as Record<string, unknown>[],
    };
  }

  return value;
}

export class GraphOutputNodeImpl extends NodeImpl<GraphOutputNode> {
  static create(): GraphOutputNode {
    const chartNode: GraphOutputNode = {
      type: 'graphOutput',
      title: 'Graph Output',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 300,
      },
      data: {
        id: 'output',
        dataType: 'string',
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'value' as PortId,
        title: this.data.id,
        dataType: this.chartNode.data.dataType as DataType,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'valueOutput' as PortId,
        title: this.data.id,
        dataType: this.chartNode.data.dataType as DataType,
      },
    ];
  }

  getEditors(): EditorDefinition<GraphOutputNode>[] {
    return [
      {
        type: 'string',
        label: 'ID',
        dataKey: 'id',
        commitDebounceMs: 300,
      },
      {
        type: 'dataTypeSelector',
        label: 'Data Type',
        dataKey: 'dataType',
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return dedent`
      ${this.data.id}
      Type: ${this.data.dataType}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Each instance of this node represents an individual output of the graph. The value passed into this node becomes part of the overall output of the graph.
      `,
      infoBoxTitle: 'Graph Output Node',
      contextMenuTitle: 'Graph Output',
      group: ['Input/Output'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const inputValue = inputs['value' as PortId];
    const value = coerceGraphOutputValue(inputValue ?? { type: 'any', value: undefined }, this.data.dataType);

    const isExcluded = value.type === 'control-flow-excluded';

    if (isExcluded && context.graphOutputs[this.data.id] == null) {
      commitGraphOutputValue(context.graphOutputs, this.data.id, {
        type: 'control-flow-excluded',
        value: undefined,
      });
    } else if (inputValue) {
      commitGraphOutputValue(context.graphOutputs, this.data.id, value);
    }

    if (isExcluded) {
      return {
        ['valueOutput' as PortId]: {
          type: 'control-flow-excluded',
          value: undefined,
        },
      };
    }

    return {
      ['valueOutput' as PortId]: context.graphOutputs[this.data.id],
    };
  }
}

export const graphOutputNode = nodeDefinition(GraphOutputNodeImpl, 'Graph Output');
