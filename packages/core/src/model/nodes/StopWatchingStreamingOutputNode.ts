import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';

export type StopWatchingStreamingOutputNode = ChartNode<'stopWatchingStreamingOutput', Record<string, never>>;

export class StopWatchingStreamingOutputNodeImpl extends NodeImpl<StopWatchingStreamingOutputNode> {
  static create(): StopWatchingStreamingOutputNode {
    return {
      data: {},
      id: nanoid() as NodeId,
      title: 'Stop Watching Streaming Output',
      type: 'stopWatchingStreamingOutput',
      visualData: { x: 0, y: 0, width: 230 },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ dataType: 'any', id: 'value' as PortId, title: 'Value', required: true }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ dataType: 'any', id: 'value' as PortId, title: 'Value' }];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Stop Watching Streaming Output',
      group: ['Logic'],
      infoBoxTitle: 'Stop Watching Streaming Output Node',
      infoBoxBody: dedent`
        Accepts a value from a Watch Streaming Output branch, stops future streaming
        snapshots, and lets its completed output continue through the ordinary graph.
        In parallel mode, the first completed branch to reach this node wins.
      `,
    };
  }

  getBody(): string {
    return 'First completed Stop continues';
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const value = inputs['value' as PortId];
    if (!value) {
      throw new Error('Stop Watching Streaming Output requires a value.');
    }
    if (!context.acceptStreamingWatchStop) {
      throw new Error('Stop Watching Streaming Output must be downstream of Watch Streaming Output.');
    }
    context.acceptStreamingWatchStop();
    return { ['value' as PortId]: value };
  }
}

export const stopWatchingStreamingOutputNode = nodeDefinition(
  StopWatchingStreamingOutputNodeImpl,
  'Stop Watching Streaming Output',
);
