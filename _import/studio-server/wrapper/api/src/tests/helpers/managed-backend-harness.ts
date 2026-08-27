import {
  MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL,
} from '../../routes/workflows/managed/execution-invalidation.js';

export class FakeListener {
  notificationHandler: ((message: { channel: string; payload?: string | null }) => void) | null = null;
  errorHandler: ((error: unknown) => void) | null = null;
  endHandler: (() => void) | null = null;
  queries: Array<{ text: string; values?: unknown[] }> = [];
  ended = false;

  async connect(): Promise<this> {
    return this;
  }

  async query(text?: string, values?: unknown[]): Promise<void> {
    if (text != null) {
      this.queries.push({ text, values });
    }
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  on(event: 'notification' | 'error' | 'end', handler: (...args: any[]) => void): void {
    if (event === 'notification') {
      this.notificationHandler = handler as (message: { channel: string; payload?: string | null }) => void;
      return;
    }

    if (event === 'error') {
      this.errorHandler = handler as (error: unknown) => void;
      return;
    }

    this.endHandler = handler as () => void;
  }

  removeAllListeners(): void {
    this.notificationHandler = null;
    this.errorHandler = null;
    this.endHandler = null;
  }

  emitNotification(payload: unknown): void {
    this.notificationHandler?.({
      channel: MANAGED_WORKFLOW_EXECUTION_INVALIDATION_CHANNEL,
      payload: JSON.stringify(payload),
    });
  }

  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }
}

export class DeferredConnectListener extends FakeListener {
  readonly #connectDeferred = createDeferred<this>();

  override async connect(): Promise<this> {
    return this.#connectDeferred.promise;
  }

  resolveConnect(): void {
    this.#connectDeferred.resolve(this);
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
}
