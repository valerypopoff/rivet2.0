import type { DataValue } from './DataValue.js';
import type { PortId } from './NodeBase.js';
import { cloneExecutionOutputs } from './ExecutionOutputClone.js';

export type GraphInputStreamResult = { value: DataValue; error?: never } | { error: Error; value?: never };
export type GraphInputStream = {
  readonly result: GraphInputStreamResult | undefined;
  readonly settled: Promise<GraphInputStreamResult>;
  subscribe(listener: (value: DataValue, coalesced: number) => void): () => void;
};

/** One invocation/port, one subscriber, bounded pre-start snapshot, one terminal. */
export class GraphInputStreamRelay implements GraphInputStream {
  result: GraphInputStreamResult | undefined;
  readonly settled: Promise<GraphInputStreamResult>;
  #resolve!: (result: GraphInputStreamResult) => void;
  #listener: ((value: DataValue, coalesced: number) => void) | undefined;
  #latest: DataValue | undefined;
  #coalesced = 0;
  #disposed = false;

  constructor() {
    this.settled = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  publish(value: DataValue, coalesced = 0): void {
    if (this.result || this.#disposed) return;
    const snapshot = cloneExecutionOutputs({ ['value' as PortId]: value })['value' as PortId]!;
    if (this.#listener) this.#listener(snapshot, coalesced);
    else {
      this.#coalesced += coalesced;
      if (this.#latest) this.#coalesced++;
      this.#latest = snapshot;
    }
  }

  finish(result: GraphInputStreamResult): void {
    if (this.result) return;
    this.result = result.error
      ? result
      : {
          value: cloneExecutionOutputs({ ['value' as PortId]: result.value! })['value' as PortId]!,
        };
    if (result.error || result.value?.type === 'control-flow-excluded') {
      this.#latest = undefined;
      this.#coalesced = 0;
    }
    this.#resolve(this.result);
  }

  subscribe(listener: (value: DataValue, coalesced: number) => void): () => void {
    if (this.#disposed) return () => {};
    if (this.#listener) throw new Error('Graph input stream already has a subscriber');
    this.#listener = listener;
    const dispose = () => {
      if (this.#listener !== listener) return;
      this.#listener = undefined;
      this.#disposed = true;
      this.#latest = undefined;
    };
    try {
      if (this.#latest) listener(this.#latest, this.#coalesced);
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    } finally {
      this.#latest = undefined;
      this.#coalesced = 0;
    }
  }
}
