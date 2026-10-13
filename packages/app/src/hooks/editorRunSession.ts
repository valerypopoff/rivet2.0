import { logRuntimeDebug } from '@valerypopoff/rivet2-core';

/** A run owner, not a socket owner. Foreground output never releases the execution tail. */
export class EditorRunSession {
  readonly controller = new AbortController();
  #cancelExecution: (() => void | Promise<void>) | undefined;
  #disposed = false;
  #cleanup: Array<() => void | Promise<void>> = [];
  #disposal: Promise<void> | undefined;

  constructor(signal?: AbortSignal) {
    const abort = () => this.abort(signal?.reason);
    if (signal?.aborted) abort();
    else if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      this.#cleanup.push(() => signal.removeEventListener('abort', abort));
    }
  }

  get signal() {
    return this.controller.signal;
  }

  bindCancellation(cancel: () => void | Promise<void>): void {
    if (this.#disposed) throw new Error('Editor run session is disposed.');
    this.#cancelExecution = cancel;
    if (this.signal.aborted) this.#requestCancellation();
  }

  abort(reason?: unknown): void {
    if (this.#disposed || this.signal.aborted) return;
    this.controller.abort(reason);
    this.#requestCancellation();
  }

  #requestCancellation(): void {
    try {
      void Promise.resolve(this.#cancelExecution?.()).catch((error) =>
        logRuntimeDebug('Editor execution cancellation failed.', { error }),
      );
    } catch (error) {
      logRuntimeDebug('Editor execution cancellation failed.', { error });
    }
  }

  onDispose(cleanup: () => void | Promise<void>): void {
    if (this.#disposed) throw new Error('Editor run session is disposed.');
    this.#cleanup.push(cleanup);
  }

  /** Caller waits for its actual processor/request completion before releasing ownership. */
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    this.#cancelExecution = undefined;
    // Start cleanup in a microtask so a reentrant disposer observes this same
    // promise rather than starting a second cleanup while it is being assigned.
    this.#disposal = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled(this.#cleanup.splice(0).map(async (cleanup) => cleanup()));
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.#disposal;
  }

  /** Terminal transport callbacks cannot await, but must still observe failures. */
  disposeInBackground(): void {
    void this.dispose().catch((error) => logRuntimeDebug('Editor run cleanup failed.', { error }));
  }
}
