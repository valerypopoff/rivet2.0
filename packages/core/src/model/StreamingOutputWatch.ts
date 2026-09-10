import type { Outputs } from './GraphProcessor.js';

export type StreamingOutputWatchSnapshot = {
  outputs: Outputs;
  updateIndex: number;
  isFinal: boolean;
};

export type StreamingOutputWatchOptions = {
  triggerMode: 'every-update' | 'interval';
  intervalMs: number;
  executionMode: 'sequential' | 'parallel';
  maxParallelRuns: number;
  maxQueuedUpdates: number;
  queueOverflowBehavior: 'drop' | 'fail';
};

/** Defaults shared by the persisted node definition and the runtime boundary. */
export const streamingOutputWatchDefaults = {
  intervalMs: 1_000,
  maxParallelRuns: 4,
  maxQueuedUpdates: 32,
  // Preserve the original fail-closed behavior unless a project explicitly
  // opts into skipping updates that cannot be scheduled.
  queueOverflowBehavior: 'fail',
} as const;

/**
 * Hard safety bounds for persisted settings. The node editor exposes the same
 * limits, but the runtime must also defend against manually edited project data.
 */
export const streamingOutputWatchLimits = {
  intervalMs: 3_600_000,
  maxParallelRuns: 32,
  maxQueuedUpdates: 1_024,
} as const;

type ActiveRun = {
  isFinal: boolean;
  updateIndex: number;
  cancel: () => void;
  promise: Promise<void>;
};

function normalizePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

/**
 * Owns bounded, cancellable delivery of a streaming node's immutable output
 * snapshots. It deliberately knows nothing about graph topology: the owning
 * GraphProcessor decides how a snapshot runs and whether accepting Stop is
 * required to complete the watch.
 */
export class StreamingOutputWatch {
  readonly #options: StreamingOutputWatchOptions;
  readonly #run: (snapshot: StreamingOutputWatchSnapshot, registerCancel: (cancel: () => void) => void) => Promise<void>;
  readonly #onFailure: (error: Error) => void;
  readonly #requiresAcceptedStop: boolean;
  readonly #queue: StreamingOutputWatchSnapshot[] = [];
  readonly #activeRuns = new Set<ActiveRun>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #latestIntervalSnapshot: StreamingOutputWatchSnapshot | undefined;
  #producerFinished = false;
  #finalSnapshotSettled = false;
  #stopped = false;
  #failure: Error | undefined;

  constructor(
    options: Partial<StreamingOutputWatchOptions>,
    run: (snapshot: StreamingOutputWatchSnapshot, registerCancel: (cancel: () => void) => void) => Promise<void>,
    onFailure: (error: Error) => void,
    { requiresAcceptedStop = true }: { requiresAcceptedStop?: boolean } = {},
  ) {
    this.#options = {
      triggerMode: options.triggerMode === 'interval' ? 'interval' : 'every-update',
      executionMode: options.executionMode === 'parallel' ? 'parallel' : 'sequential',
      intervalMs: normalizePositiveInteger(
        options.intervalMs,
        streamingOutputWatchDefaults.intervalMs,
        streamingOutputWatchLimits.intervalMs,
      ),
      maxParallelRuns: normalizePositiveInteger(
        options.maxParallelRuns,
        streamingOutputWatchDefaults.maxParallelRuns,
        streamingOutputWatchLimits.maxParallelRuns,
      ),
      maxQueuedUpdates: normalizePositiveInteger(
        options.maxQueuedUpdates,
        streamingOutputWatchDefaults.maxQueuedUpdates,
        streamingOutputWatchLimits.maxQueuedUpdates,
      ),
      queueOverflowBehavior:
        options.queueOverflowBehavior === 'drop' ? 'drop' : streamingOutputWatchDefaults.queueOverflowBehavior,
    };
    this.#run = run;
    this.#onFailure = onFailure;
    this.#requiresAcceptedStop = requiresAcceptedStop;
  }

  get hasPending(): boolean {
    // Stop prevents new delivery, but accepted and failing invocations still
    // belong to the root lifecycle until they settle. Hiding those active runs
    // here lets finalization report a later missing-Stop error instead of the
    // actual child failure.
    return this.#activeRuns.size > 0 || (!this.#stopped && (this.#queue.length > 0 || this.#timer != null));
  }

  get isAwaitingProducer(): boolean {
    return (
      !this.#stopped &&
      !this.#producerFinished &&
      this.#timer != null &&
      this.#queue.length === 0 &&
      this.#activeRuns.size === 0
    );
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * A Stop boundary can enqueue ordinary parent-graph work when its node
   * completes. Until it settles, its result is not safe to expose
   * through the foreground-output boundary.
   */
  get canAffectForegroundOutputs(): boolean {
    return this.#requiresAcceptedStop;
  }

  publish(snapshot: StreamingOutputWatchSnapshot): void {
    if (this.#stopped || this.#failure) {
      return;
    }

    if (this.#options.triggerMode === 'interval' && !snapshot.isFinal) {
      this.#latestIntervalSnapshot = snapshot;
      this.#scheduleInterval();
      return;
    }

    this.#enqueue(snapshot);
  }

  finish(finalSnapshot: StreamingOutputWatchSnapshot): void {
    if (this.#stopped || this.#failure) {
      return;
    }

    this.#producerFinished = true;
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#latestIntervalSnapshot = undefined;
    this.#enqueue(finalSnapshot);
  }

  /** Preserve the winning invocation's siblings; later owner cancellation cancels all. */
  stop(acceptedUpdateIndex?: number): void {
    this.#stopped = true;
    this.#queue.length = 0;
    this.#latestIntervalSnapshot = undefined;
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const activeRun of this.#activeRuns) {
      if (activeRun.updateIndex !== acceptedUpdateIndex) activeRun.cancel();
    }
  }

  async drain(): Promise<void> {
    while (this.#queue.length > 0 || this.#activeRuns.size > 0 || this.#timer != null) {
      if (this.#timer != null && this.#activeRuns.size === 0 && this.#queue.length === 0) {
        // A producer that is still running owns the next interval. Do not turn
        // an ordinary wait between updates into a busy loop.
        return;
      }
      await Promise.all([...this.#activeRuns].map((run) => run.promise));
    }

    if (this.#producerFinished && this.#finalSnapshotSettled && !this.#stopped && this.#requiresAcceptedStop) {
      this.#fail(new Error('The watched streaming output completed before Stop Watching Streaming Output accepted a value.'));
    }
  }

  #scheduleInterval(): void {
    if (this.#timer != null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#stopped || this.#failure) {
        return;
      }
      const snapshot = this.#latestIntervalSnapshot;
      this.#latestIntervalSnapshot = undefined;
      if (snapshot) {
        this.#enqueue(snapshot);
      }
    }, this.#options.intervalMs);
  }

  #enqueue(snapshot: StreamingOutputWatchSnapshot): void {
    if (this.#queue.length >= this.#options.maxQueuedUpdates) {
      if (this.#options.queueOverflowBehavior === 'drop') {
        if (snapshot.isFinal) {
          // A final snapshot is the only chance for a Stop branch to accept a
          // value after its producer has completed. Keep that contract without
          // relaxing the configured queue bound: discard the stalest waiting
          // partial and retain the final snapshot instead.
          this.#queue.shift();
          this.#queue.push(snapshot);
          this.#pump();
        }
        return;
      }
      this.#fail(new Error(
        `Watch Streaming Output exceeded its ${this.#options.maxQueuedUpdates}-update queue limit. ` +
          'Increase the limit, use an interval trigger, or stop the watch sooner.',
      ));
      return;
    }

    this.#queue.push(snapshot);
    this.#pump();
  }

  #pump(): void {
    const concurrency = this.#options.executionMode === 'parallel' ? this.#options.maxParallelRuns : 1;
    while (!this.#stopped && !this.#failure && this.#queue.length > 0 && this.#activeRuns.size < concurrency) {
      const snapshot = this.#queue.shift()!;
      let cancel: () => void = () => undefined;
      let cancelled = false;
      const activeRun: ActiveRun = {
        isFinal: snapshot.isFinal,
        updateIndex: snapshot.updateIndex,
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          cancel();
        },
        promise: Promise.resolve(),
      };
      // Start through a promise boundary so a malformed branch that throws
      // synchronously is still tracked, drained, and reported like an async
      // branch failure.
      activeRun.promise = Promise.resolve()
        .then(() => {
          // stop() may run after this slot is reserved but before its microtask.
          if (this.#stopped) return;
          return this.#run(snapshot, (nextCancel) => {
            cancel = nextCancel;
            if (cancelled) cancel();
          });
        })
        .catch((error) => {
          if (!this.#stopped) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
          }
        })
        .finally(() => {
          if (activeRun.isFinal) {
            this.#finalSnapshotSettled = true;
          }
          this.#activeRuns.delete(activeRun);
          this.#pump();
        });
      this.#activeRuns.add(activeRun);
    }
  }

  #fail(error: Error): void {
    if (this.#failure) {
      return;
    }

    this.#failure = error;
    this.#onFailure(error);
    this.stop();
  }
}
