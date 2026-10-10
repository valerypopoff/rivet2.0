import type { DataType, DataValue } from './DataValue.js';
import type { ChartNode, NodeId, PortId } from './NodeBase.js';
import type { NodeGraph } from './NodeGraph.js';
import type { Outputs } from './GraphProcessor.js';
import type { CatchStreamingChunksNode } from './nodes/CatchStreamingChunksNode.js';
import type { StreamingOutputWatch } from './StreamingOutputWatch.js';
import type {
  StreamingOutputWatchHistory,
  StreamingOutputWatchHistoryIteration,
} from './StreamingOutputWatchHistory.js';
import type { GraphInputStream, GraphInputStreamRelay } from './GraphInputStream.js';

export type SchedulerBoundaryFailure = {
  error: Error;
  triggerNode: ChartNode;
  nodeErrors: Array<{ error: Error | string; node: ChartNode }>;
};
export type StreamingOutputWatchPlan = {
  graph: NodeGraph;
  /** Only retain and snapshot the cumulative history when a branch consumes it. */
  includeAllStreamedOutput: boolean;
  sourceOutputId: PortId;
  /**
   * A Stop boundary is optional. Without one, every snapshot runs the entire
   * contained branch and the watch completes normally with its producer.
   */
  stopNodeId?: NodeId;
  /**
   * Immutable stream increments observed for this run. Cumulative string
   * snapshots contribute only their new suffix so an LLM response does not
   * retain N copies of its whole prefix.
   */
  streamedOutput: unknown[];
  previousStreamedValue: unknown;
  watchNode: ChartNode;
  nextUpdateIndex: number;
  history: StreamingOutputWatchHistory;
  historySummaryEmitted: boolean;
  /** True once normal stream exhaustion has excluded the parent Stop boundary. */
  unmatchedStopResolved: boolean;
};
export type StreamingOutputCatchPlan = {
  node: CatchStreamingChunksNode;
  sourceOutputId: PortId;
  count: number;
  chunks: DataValue[];
  settled: boolean;
};
export type StreamingOutputWatchInvocation = {
  plan: StreamingOutputWatchPlan;
  historyIteration: StreamingOutputWatchHistoryIteration;
  /**
   * Atomically claims the parent Watch's one accepted Stop value. The claim is
   * made before the child's nodeFinish is emitted so that event can identify
   * the actual terminal branch, but its parent-dataflow effects are committed
   * only after that lifecycle event has been published.
   */
  claimStop: (value: DataValue) => StreamingOutputWatchStopClaim | undefined;
  /**
   * Set only by the live Stop node implementation. The output that re-enters
   * the parent is deliberately taken from the completed node result instead:
   * split nodes aggregate their per-item outputs only at that boundary.
   */
  stopReached: boolean;
};

export type StreamingOutputWatchStopClaim = {
  commit: () => void;
};

export type GraphOutputPartialBinding = {
  dataType: DataType;
  graphOutputId: string;
  sourceOutputId: PortId;
};

/** Invocation-owned boundary resources; no scheduling or event-emission policy. */
export class GraphSchedulerBoundaryState {
  streamingWatchPlansBySourceNodeId = new Map<NodeId, StreamingOutputWatchPlan[]>();
  streamingWatchPlansByWatchNodeId = new Map<NodeId, StreamingOutputWatchPlan>();
  streamingOutputWatches = new Map<NodeId, StreamingOutputWatch>();
  streamingCatchPlansBySourceNodeId = new Map<NodeId, StreamingOutputCatchPlan[]>();
  streamingCatchTasks = new Set<Promise<void>>();
  graphOutputPartialBindingsBySourceNodeId = new Map<NodeId, GraphOutputPartialBinding[]>();
  graphInputStreams: Readonly<Record<string, GraphInputStream>> = {};
  callerInputStreams = new Map<NodeId, Record<string, GraphInputStreamRelay>>();
  inputStreamRoutes = new Map<NodeId, Array<{ port: PortId; relay: GraphInputStreamRelay }>>();
  streamCallerTasks = new Set<Promise<unknown>>();
  inputStreamDisposers: Array<() => void> = [];
  pendingGraphInputFinals = new Map<NodeId, Outputs>();
  streamingWatchFailures: SchedulerBoundaryFailure[] = [];

  resetTopology(): void {
    this.streamingWatchPlansBySourceNodeId = new Map();
    this.streamingWatchPlansByWatchNodeId = new Map();
    this.streamingOutputWatches = new Map();
    this.streamingCatchPlansBySourceNodeId = new Map();
    this.streamingCatchTasks = new Set();
    this.graphOutputPartialBindingsBySourceNodeId = new Map();
    this.streamingWatchFailures = [];
  }

  /** Called after invocation initialization, before subscriptions can be admitted. */
  initializeInputStreams(streams: Readonly<Record<string, GraphInputStream>> = {}): void {
    this.graphInputStreams = streams;
    this.callerInputStreams = new Map();
    this.inputStreamRoutes = new Map();
    this.streamCallerTasks = new Set();
    this.inputStreamDisposers = [];
    this.pendingGraphInputFinals = new Map();
  }

  /** Release every subscription/relay, even if one host-provided disposer fails. */
  releaseInputStreams(): void {
    const failures: unknown[] = [];
    const release = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const dispose of this.inputStreamDisposers.splice(0)) release(dispose);
    this.pendingGraphInputFinals.clear();
    for (const streams of this.callerInputStreams.values()) {
      for (const relay of Object.values(streams))
        release(() => relay.finish({ error: new Error('Graph input stream owner finished') }));
    }
    this.callerInputStreams.clear();
    this.inputStreamRoutes.clear();
    this.graphInputStreams = {};
    if (failures.length) throw new AggregateError(failures, 'Graph input stream cleanup failed');
  }

  async drainCatchTasks(waitForQueue: () => Promise<unknown>): Promise<void> {
    while (this.streamingCatchTasks.size > 0) {
      await Promise.all([...this.streamingCatchTasks]);
      await waitForQueue();
    }
  }
}
