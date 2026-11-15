import { AsyncResource } from 'node:async_hooks';
import type { MessagePort } from 'node:worker_threads';
import type { RivetStoredValue, RivetStoredValueStore } from '@valerypopoff/rivet2-node';
import { prototypeFailure, type PrototypeFailure } from './protocol.js';

type StoreRequest = { rootId: number; operationId: number } & (
  | { method: 'get'; key: string }
  | { method: 'set'; key: string; value: RivetStoredValue }
);
type StoreReply = { rootId: number; operationId: number } & (
  | { value?: RivetStoredValue; failure?: never }
  | { failure: PrototypeFailure }
);

const MAX_PENDING = 64;

/** One root's explicit host-store capability. Closing fences new calls, not
 * writes already accepted by the store. No operation is automatically replayed.
 * This local seam does not initialize a settings repository or SQL pool. */
export class ParentStoredValues {
  readonly #pending = new Set<Promise<void>>();
  readonly #invoke: (request: StoreRequest) => Promise<RivetStoredValue | undefined>;
  #closed = false;
  #lastId = 0;

  constructor(
    readonly rootId: number,
    store: RivetStoredValueStore,
  ) {
    // Capture the accepting request's settings/authorization context, rather
    // than inheriting whichever root last touched this worker's message handler.
    this.#invoke = AsyncResource.bind(async (request: StoreRequest) => {
      if (request.method === 'get') return await store.get(request.key);
      await store.set(request.key, request.value);
      return undefined;
    });
  }

  get pending(): number {
    return this.#pending.size;
  }

  handle(request: StoreRequest, reply: (value: StoreReply) => void): void {
    const identity = { rootId: request.rootId, operationId: request.operationId };
    if (
      this.#closed ||
      request.rootId !== this.rootId ||
      !Number.isSafeInteger(request.operationId) ||
      request.operationId !== this.#lastId + 1 ||
      this.#pending.size >= MAX_PENDING ||
      (request.method !== 'get' && request.method !== 'set') ||
      typeof request.key !== 'string'
    ) {
      reply({ ...identity, failure: prototypeFailure(new Error('Host-store operation is not admitted.')) });
      return;
    }
    this.#lastId = request.operationId;
    // Schedule invocation only after it enters the parent's drain inventory.
    const operation = Promise.resolve()
      .then(() => this.#invoke(request))
      .then(
        (value) => reply({ ...identity, value }),
        (error) => reply({ ...identity, failure: prototypeFailure(error) }),
      )
      // A lost worker/reply cannot turn a committed write into a retry.
      .catch(() => undefined)
      .finally(() => this.#pending.delete(operation));
    this.#pending.add(operation);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#pending]);
  }
}

/** A per-root store adapter on a separate control port, beside the actual
 * processor. Intermediate graph values and ordinary HTTP outputs do not use it. */
export class WorkerStoredValues implements RivetStoredValueStore {
  readonly #pending = new Map<number, { resolve(value?: RivetStoredValue): void; reject(error: Error): void }>();
  #nextId = 0;
  #closed = false;
  readonly #receive = (reply: StoreReply) => {
    if (reply.rootId !== this.rootId) return;
    const pending = this.#pending.get(reply.operationId);
    if (!pending) return;
    this.#pending.delete(reply.operationId);
    if (reply.failure) pending.reject(Object.assign(new Error(reply.failure.message), reply.failure));
    else pending.resolve(reply.value);
  };

  constructor(
    readonly rootId: number,
    readonly port: MessagePort,
  ) {
    port.on('message', this.#receive);
    port.unref();
  }

  get(key: string): Promise<RivetStoredValue | undefined> {
    return this.#call({ method: 'get', key });
  }

  async set(key: string, value: RivetStoredValue): Promise<void> {
    await this.#call({ method: 'set', key, value });
  }

  close(): void {
    this.#closed = true;
    this.port.off('message', this.#receive);
    for (const pending of this.#pending.values()) pending.reject(new Error('Host-store root closed.'));
    this.#pending.clear();
  }

  #call(
    request:
      | Omit<Extract<StoreRequest, { method: 'get' }>, 'rootId' | 'operationId'>
      | Omit<Extract<StoreRequest, { method: 'set' }>, 'rootId' | 'operationId'>,
  ): Promise<RivetStoredValue | undefined> {
    if (this.#closed || this.#pending.size >= MAX_PENDING)
      return Promise.reject(new Error('Host-store root is closed or at capacity.'));
    return new Promise((resolve, reject) => {
      const operationId = ++this.#nextId;
      this.#pending.set(operationId, { resolve, reject });
      try {
        this.port.postMessage({ ...request, rootId: this.rootId, operationId });
      } catch (error) {
        this.#pending.delete(operationId);
        reject(error);
      }
    });
  }
}
