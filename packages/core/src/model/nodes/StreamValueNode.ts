import { nanoid } from 'nanoid/non-secure';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';

export type StreamValueNode = ChartNode<'streamValue', Record<string, never>>;

/** Emits one partial snapshot without changing the ordinary final value. */
export class StreamValueNodeImpl extends NodeImpl<StreamValueNode> {
  static create(): StreamValueNode {
    return {
      id: nanoid() as NodeId,
      type: 'streamValue',
      title: 'Stream value',
      data: {},
      visualData: { x: 0, y: 0, width: 220 },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ id: 'value' as PortId, title: 'Value', dataType: 'any', required: true, coerced: false }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'value' as PortId, title: 'Value', dataType: 'any' }];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Stream value',
      group: ['Streaming'],
      infoBoxTitle: 'Stream value node',
      infoBoxBody:
        'Emits one streaming update as soon as its input is ready, then passes the same value through normally. Connect directly to Graph Output to send it to a caller before the child graph finishes.',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const value = inputs['value' as PortId];
    if (!value) throw new Error('Stream value requires a value.');
    const outputs = { ['value' as PortId]: value };
    context.onPartialOutputs?.(outputs);
    return outputs;
  }
}

export const streamValueNode = nodeDefinition(StreamValueNodeImpl, 'Stream value');
