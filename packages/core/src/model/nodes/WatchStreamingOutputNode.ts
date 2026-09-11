import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import {
  streamingOutputWatchDefaults,
  streamingOutputWatchLimits,
  type StreamingOutputWatchOptions,
} from '../StreamingOutputWatch.js';

export type WatchStreamingOutputNodeData = StreamingOutputWatchOptions;

export type WatchStreamingOutputNode = ChartNode<'watchStreamingOutput', WatchStreamingOutputNodeData>;

export class WatchStreamingOutputNodeImpl extends NodeImpl<WatchStreamingOutputNode> {
  static create(): WatchStreamingOutputNode {
    return {
      data: {
        triggerMode: 'every-update',
        intervalMs: streamingOutputWatchDefaults.intervalMs,
        executionMode: 'sequential',
        maxParallelRuns: streamingOutputWatchDefaults.maxParallelRuns,
        maxQueuedUpdates: streamingOutputWatchDefaults.maxQueuedUpdates,
        queueOverflowBehavior: streamingOutputWatchDefaults.queueOverflowBehavior,
      },
      id: nanoid() as NodeId,
      title: 'Watch Streaming Output',
      type: 'watchStreamingOutput',
      visualData: { x: 0, y: 0, width: 230 },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [{ dataType: 'any', id: 'stream' as PortId, title: 'Streaming Output', required: true }];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { dataType: 'any', id: 'value' as PortId, title: 'Chunk' },
      {
        dataType: 'any[]',
        id: 'allStreamedOutput' as PortId,
        title: 'All Chunks',
        description: 'Every streamed value received so far, in order. Cumulative text streams contribute only new text.',
      },
      { dataType: 'number', id: 'updateIndex' as PortId, title: 'Chunk Index' },
      { dataType: 'boolean', id: 'isFinal' as PortId, title: 'Is Final' },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Watch Streaming Output',
      group: ['Logic'],
      infoBoxTitle: 'Watch Streaming Output Node',
      infoBoxBody: dedent`
        Runs its downstream branch for streaming output snapshots. Without Stop Watching
        Streaming Output, every snapshot runs the branch and the watch finishes with its
        producer. Add one Stop node only when a chosen value must continue through the
        ordinary graph. Non-watched connections still wait for their upstream node's final result.
      `,
    };
  }

  getEditors(): EditorDefinition<WatchStreamingOutputNode>[] {
    return [
      {
        type: 'dropdown',
        dataKey: 'triggerMode',
        label: 'Trigger',
        options: [
          { label: 'Every update', value: 'every-update' },
          { label: 'Every N milliseconds', value: 'interval' },
        ],
      },
      {
        type: 'number',
        dataKey: 'intervalMs',
        hideIf: (data) => data.triggerMode !== 'interval',
        label: 'Interval (ms)',
        min: 1,
        max: streamingOutputWatchLimits.intervalMs,
      },
      {
        type: 'dropdown',
        dataKey: 'executionMode',
        label: 'Branch execution',
        options: [
          { label: 'Sequential', value: 'sequential' },
          { label: 'Parallel', value: 'parallel' },
        ],
      },
      {
        type: 'number',
        dataKey: 'maxParallelRuns',
        hideIf: (data) => data.executionMode !== 'parallel',
        label: 'Maximum parallel runs',
        min: 1,
        max: streamingOutputWatchLimits.maxParallelRuns,
      },
      {
        type: 'number',
        dataKey: 'maxQueuedUpdates',
        label: 'Maximum queued updates',
        min: 1,
        max: streamingOutputWatchLimits.maxQueuedUpdates,
      },
      {
        type: 'dropdown',
        dataKey: 'queueOverflowBehavior',
        label: 'On queue overflow',
        defaultValue: streamingOutputWatchDefaults.queueOverflowBehavior,
        options: [
          { label: 'Fail run', value: 'fail' },
          { label: 'Drop new update', value: 'drop' },
        ],
      },
    ];
  }

  getBody(): string {
    const trigger = this.data.triggerMode === 'interval' ? `Every ${this.data.intervalMs}ms` : 'Every update';
    const execution = this.data.executionMode === 'parallel' ? `Parallel ×${this.data.maxParallelRuns}` : 'Sequential';
    return `${trigger} · ${execution}`;
  }

  async process(inputs: Inputs): Promise<Outputs> {
    // Watch instances are preloaded by GraphProcessor with an immutable snapshot.
    // Returning this fallback keeps direct node tests and legacy execution readable.
    return {
      ['allStreamedOutput' as PortId]: {
        type: 'any[]',
        value: inputs['stream' as PortId] == null ? [] : [inputs['stream' as PortId]!.value],
      },
      ['value' as PortId]: inputs['stream' as PortId],
      ['updateIndex' as PortId]: { type: 'number', value: 0 },
      ['isFinal' as PortId]: { type: 'boolean', value: false },
    };
  }
}

export const watchStreamingOutputNode = nodeDefinition(WatchStreamingOutputNodeImpl, 'Watch Streaming Output');
