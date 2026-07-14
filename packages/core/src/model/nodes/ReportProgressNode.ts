import { nanoid } from 'nanoid/non-secure';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import type { DataValue } from '../DataValue.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';

export type ReportProgressNode = ChartNode<'reportProgress', ReportProgressNodeData>;

export type ReportProgressNodeData = {
  message: string;
  percent?: number;
  useMessageInput: boolean;
  usePercentInput: boolean;
};

export class ReportProgressNodeImpl extends NodeImpl<ReportProgressNode> {
  static create(): ReportProgressNode {
    return {
      id: nanoid() as NodeId,
      type: 'reportProgress',
      title: 'Report Progress',
      visualData: { x: 0, y: 0, width: 200 },
      data: { message: '', useMessageInput: true, usePercentInput: true },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      { dataType: 'any', id: 'value' as PortId, required: true, title: 'Value' },
      ...(this.data.useMessageInput
        ? [{ dataType: 'string' as const, id: 'message' as PortId, title: 'Message' }]
        : []),
      ...(this.data.usePercentInput
        ? [{ dataType: 'number' as const, id: 'percent' as PortId, title: 'Percent' }]
        : []),
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ dataType: 'any', id: 'value' as PortId, title: 'Value' }];
  }

  getEditors(): EditorDefinition<ReportProgressNode>[] {
    return [
      { type: 'string', label: 'Message', dataKey: 'message', useInputToggleDataKey: 'useMessageInput' },
      { type: 'number', label: 'Percent', dataKey: 'percent', useInputToggleDataKey: 'usePercentInput' },
    ];
  }

  getBody() {
    return this.data.message || 'Reports progress to the host';
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Report Progress',
      group: ['Advanced'],
      infoBoxTitle: 'Report Progress',
      infoBoxBody: 'Reports a public status message and/or percentage to progress-aware hosts such as Rivet web apps.',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Record<string, DataValue>> {
    const message = this.data.useMessageInput
      ? coerceTypeOptional(inputs['message' as PortId], 'string')
      : this.data.message;
    const percent = this.data.usePercentInput
      ? coerceTypeOptional(inputs['percent' as PortId], 'number')
      : this.data.percent;
    context.reportProgress({ message, percent });

    return { value: inputs['value' as PortId] as DataValue };
  }
}

export const reportProgressNode = nodeDefinition(ReportProgressNodeImpl, 'Report Progress');
