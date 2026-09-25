import { nanoid } from 'nanoid/non-secure';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';

export const MAX_CAUGHT_STREAMING_CHUNKS = 1024;

export type CatchStreamingChunksNodeData = { count: number };
export type CatchStreamingChunksNode = ChartNode<'catchStreamingChunks', CatchStreamingChunksNodeData>;

/** The processor owns this node's early, once-only output. */
export class CatchStreamingChunksNodeImpl extends NodeImpl<CatchStreamingChunksNode> {
  static create(): CatchStreamingChunksNode {
    return {
      id: nanoid() as NodeId,
      type: 'catchStreamingChunks',
      title: 'Catch streaming chunks',
      data: { count: 1 },
      visualData: { x: 0, y: 0, width: 220 },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ id: 'stream' as PortId, title: 'Streaming Output', dataType: 'any', required: true }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'value' as PortId, title: 'Value', dataType: 'any' }];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Catch streaming chunks',
      group: ['Streaming'],
      infoBoxTitle: 'Catch streaming chunks node',
      infoBoxBody:
        'Returns the first N streaming snapshots as one ordinary value. For N=1 it returns the value itself; for N>1 it returns an array. It completes once and never runs a repeated Watch branch.',
    };
  }

  getEditors(): EditorDefinition<CatchStreamingChunksNode>[] {
    return [{ type: 'number', dataKey: 'count', label: 'Number of chunks', min: 1, max: MAX_CAUGHT_STREAMING_CHUNKS }];
  }

  getBody(): string {
    return `First ${this.data.count ?? 1} ${this.data.count === 1 ? 'chunk' : 'chunks'}`;
  }

  async process(inputs: Inputs): Promise<Outputs> {
    // GraphProcessor schedules connected instances at their stream boundary.
    // Retain the ordinary final-only behavior for direct node tests.
    return { ['value' as PortId]: inputs['stream' as PortId] };
  }
}

export const catchStreamingChunksNode = nodeDefinition(CatchStreamingChunksNodeImpl, 'Catch streaming chunks');
