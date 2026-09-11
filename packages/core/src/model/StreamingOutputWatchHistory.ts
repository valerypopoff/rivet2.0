import type { ProcessEvents } from './GraphProcessor.js';
import type { GraphRunId } from './ProcessContext.js';
import type { StreamingOutputWatchRuntimeSummary } from './StreamingOutputWatch.js';
import { cloneExecutionValue } from './ExecutionOutputClone.js';

/** The number of early Watch iterations retained as representative evidence. */
export const streamingOutputWatchRetainedInitialIterations = 3;

export type StreamingOutputWatchHistorySummary = StreamingOutputWatchRuntimeSummary & {
  completedIterations: number;
  failedIterations: number;
  cancelledIterations: number;
  omittedIterations: number;
  retainedIterationUpdateIndexes: number[];
  selectedIteration?: {
    updateIndex: number;
    reason: 'failure' | 'stop' | 'latest';
  };
};

type ForwardedEvent = {
  [K in keyof ProcessEvents]: { event: K; data: ProcessEvents[K]; occurredAt: number };
}[keyof ProcessEvents];

type Iteration = {
  graphRunId: GraphRunId;
  ordinal: number;
  updateIndex: number;
  events: ForwardedEvent[];
  completed: boolean;
  failed: boolean;
  cancelled: boolean;
  retainedImmediately: boolean;
};

export type StreamingOutputWatchHistoryIteration = Readonly<Pick<Iteration, 'graphRunId' | 'ordinal' | 'updateIndex'>>;

export type StreamingOutputWatchHistoryOptions = {
  /** Internal clock injection keeps deferred-event timestamp tests deterministic. */
  now?: () => number;
};

/**
 * Retains only useful Watch branch evidence before it reaches the outer event
 * emitter. The first three started iterations are delivered live. Later
 * iterations are held only while they can still become the first failure, a
 * Stop winner, or the final/latest iteration. This bounds editor history and
 * recordings without changing the branch's actual execution.
 */
export class StreamingOutputWatchHistory {
  // This is deliberately not a complete run history. It contains only active
  // iterations and the few candidates that can still affect retained
  // evidence. Keeping a Map entry for every streamed increment would leave
  // an unbounded metadata leak after we had bounded the event payloads.
  readonly #iterationsByRunId = new Map<GraphRunId, Iteration>();
  #latestStarted: Iteration | undefined;
  #firstFailure: Iteration | undefined;
  #stopWinner: Iteration | undefined;
  #startedIterations = 0;
  readonly #retainedInitialUpdateIndexes: number[] = [];
  #completedIterations = 0;
  #failedIterations = 0;
  #cancelledIterations = 0;
  #finalized = false;
  #finalizedSelected: Iteration | undefined;

  readonly #now: () => number;

  constructor({ now = Date.now }: StreamingOutputWatchHistoryOptions = {}) {
    this.#now = now;
  }

  start(graphRunId: GraphRunId, updateIndex: number): StreamingOutputWatchHistoryIteration {
    if (this.#finalized) {
      throw new Error('Cannot start a Watch Streaming Output history iteration after finalization.');
    }

    const previousLatest = this.#latestStarted;
    const ordinal = this.#startedIterations + 1;
    const iteration: Iteration = {
      graphRunId,
      ordinal,
      updateIndex,
      events: [],
      completed: false,
      failed: false,
      cancelled: false,
      retainedImmediately: ordinal <= streamingOutputWatchRetainedInitialIterations,
    };
    this.#startedIterations = ordinal;
    if (iteration.retainedImmediately) {
      this.#retainedInitialUpdateIndexes.push(updateIndex);
    }
    this.#iterationsByRunId.set(graphRunId, iteration);
    this.#latestStarted = iteration;
    this.#releaseIfNoLongerNeeded(previousLatest);
    return iteration;
  }

  forward<K extends keyof ProcessEvents>(
    iteration: StreamingOutputWatchHistoryIteration,
    event: K,
    data: ProcessEvents[K],
    forward: (event: K, data: ProcessEvents[K]) => Promise<void>,
  ): Promise<void> | undefined {
    const owned = this.#getIteration(iteration);
    if (owned.retainedImmediately) {
      return forward(event, data);
    }

    // Later selected evidence is emitted only after the Watch has settled.
    // Capture both the value and its original clock now: retaining a mutable
    // output reference or using the later flush time would make recordings
    // disagree with the execution that actually occurred.
    owned.events.push({ event, data: cloneExecutionValue(data), occurredAt: this.#now() } as ForwardedEvent);
    return undefined;
  }

  complete(iteration: StreamingOutputWatchHistoryIteration): void {
    const owned = this.#getIteration(iteration);
    if (owned.completed) return;
    owned.completed = true;
    // Keep terminal outcomes disjoint. A failure/cancellation still settles an
    // iteration, but callers should not have to subtract it from the completed
    // count to understand the compact summary.
    if (!owned.failed && !owned.cancelled) {
      this.#completedIterations += 1;
    }
    this.#releaseIfNoLongerNeeded(owned);
  }

  fail(iteration: StreamingOutputWatchHistoryIteration): void {
    const owned = this.#getIteration(iteration);
    if (!owned.failed) {
      owned.failed = true;
      this.#failedIterations += 1;
    }
    this.#firstFailure ??= owned;
    this.#releaseIfNoLongerNeeded(owned);
  }

  cancel(iteration: StreamingOutputWatchHistoryIteration): void {
    const owned = this.#getIteration(iteration);
    if (!owned.cancelled) {
      owned.cancelled = true;
      this.#cancelledIterations += 1;
    }
    this.#releaseIfNoLongerNeeded(owned);
  }

  acceptStop(iteration: StreamingOutputWatchHistoryIteration): void {
    this.#stopWinner ??= this.#getIteration(iteration);
  }

  get hasAcceptedStop(): boolean {
    return this.#stopWinner != null;
  }

  async finalize(
    runtime: StreamingOutputWatchRuntimeSummary,
    forward: <K extends keyof ProcessEvents>(event: K, data: ProcessEvents[K]) => Promise<void>,
  ): Promise<StreamingOutputWatchHistorySummary> {
    if (this.#finalized) {
      return this.#buildSummary(runtime, this.#finalizedSelected);
    }
    this.#finalized = true;

    const selected = this.#firstFailure ?? this.#stopWinner ?? this.#latestStarted;
    this.#finalizedSelected = selected;
    if (selected && !selected.retainedImmediately) {
      for (const { event, data, occurredAt } of selected.events) {
        await forward(event, withEventOccurredAt(data, occurredAt));
      }
    }

    return this.#buildSummary(runtime, selected);
  }

  #getIteration(iteration: StreamingOutputWatchHistoryIteration): Iteration {
    const owned = this.#iterationsByRunId.get(iteration.graphRunId);
    if (!owned) {
      throw new Error('Watch Streaming Output history iteration does not belong to this watcher.');
    }
    return owned;
  }

  #releaseIfNoLongerNeeded(iteration: Iteration | undefined): void {
    if (
      !iteration?.completed ||
      iteration === this.#latestStarted ||
      iteration === this.#firstFailure ||
      iteration === this.#stopWinner
    ) {
      return;
    }

    iteration.events.length = 0;
    this.#iterationsByRunId.delete(iteration.graphRunId);
  }

  #buildSummary(
    runtime: StreamingOutputWatchRuntimeSummary,
    selected: Iteration | undefined,
  ): StreamingOutputWatchHistorySummary {
    const retainedIterationUpdateIndexes = [
      ...this.#retainedInitialUpdateIndexes,
      ...(selected && !selected.retainedImmediately ? [selected.updateIndex] : []),
    ];
    return {
      ...runtime,
      completedIterations: this.#completedIterations,
      failedIterations: this.#failedIterations,
      cancelledIterations: this.#cancelledIterations,
      omittedIterations: this.#startedIterations - retainedIterationUpdateIndexes.length,
      retainedIterationUpdateIndexes,
      selectedIteration:
        selected == null
          ? undefined
          : {
              updateIndex: selected.updateIndex,
              reason: selected === this.#firstFailure ? 'failure' : selected === this.#stopWinner ? 'stop' : 'latest',
            },
    };
  }
}

function withEventOccurredAt<T>(data: T, eventOccurredAt: number): T {
  if (data == null || typeof data !== 'object') {
    return data;
  }

  return { ...data, eventOccurredAt } as T;
}
