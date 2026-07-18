export type RivetStoredValue =
  | null
  | boolean
  | number
  | string
  | RivetStoredValue[]
  | { [key: string]: RivetStoredValue };

export interface RivetStoredValueStore {
  get(key: string): RivetStoredValue | undefined | Promise<RivetStoredValue | undefined>;
  set(key: string, value: RivetStoredValue): void | Promise<void>;
}

export type RivetStoredValueRecord = Record<string, RivetStoredValue>;

export type RivetStoredValueReadResult = { found: false; value?: undefined } | { found: true; value: RivetStoredValue };

export type RivetStoredValueSetResult = {
  hadPreviousValue: boolean;
  previousValue: RivetStoredValue | undefined;
  savedValue: RivetStoredValue;
};

export type RivetStoredValueCacheResult =
  | { loaded: false; found: false; value?: undefined }
  | { loaded: true; found: false; value?: undefined }
  | { loaded: true; found: true; value: RivetStoredValue };

type StoredValueWaiter = {
  reject(error: unknown): void;
  resolve(value: RivetStoredValue): void;
};

/**
 * Run-scoped read-through/write-through cache used by Stored Value nodes.
 * A GraphProcessor creates one controller per root run and shares it with every subprocessor.
 */
export class RivetStoredValueController {
  readonly #cache = new Map<string, RivetStoredValueReadResult>();
  readonly #keyOperations = new Map<string, Promise<void>>();
  readonly #loadErrors = new Map<string, unknown>();
  readonly #waiters = new Map<string, Set<StoredValueWaiter>>();

  constructor(readonly store?: RivetStoredValueStore) {}

  async get(key: string): Promise<RivetStoredValueReadResult> {
    const normalizedKey = normalizeRivetStoredValueKey(key);
    return await this.#withKeyLock(normalizedKey, async () => cloneReadResult(await this.#getUnlocked(normalizedKey)));
  }

  getCached(key: string): RivetStoredValueCacheResult {
    const normalizedKey = normalizeRivetStoredValueKey(key);
    const cached = this.#cache.get(normalizedKey);
    if (!cached) return { loaded: false, found: false };
    return cached.found
      ? { loaded: true, found: true, value: cloneRivetStoredValue(cached.value, 'Stored value') }
      : { loaded: true, found: false };
  }

  async set(key: string, value: RivetStoredValue): Promise<RivetStoredValueSetResult> {
    const normalizedKey = normalizeRivetStoredValueKey(key);
    const savedValue = cloneRivetStoredValue(value, 'Stored value');

    return await this.#withKeyLock(normalizedKey, async () => {
      const previous = await this.#getUnlocked(normalizedKey);
      await this.store?.set(normalizedKey, cloneRivetStoredValue(savedValue, 'Stored value'));
      this.#cache.set(normalizedKey, { found: true, value: savedValue });
      this.#resolveWaiters(normalizedKey, savedValue);

      return {
        hadPreviousValue: previous.found,
        previousValue: previous.found ? cloneRivetStoredValue(previous.value, 'Stored value') : undefined,
        savedValue: cloneRivetStoredValue(savedValue, 'Stored value'),
      };
    });
  }

  /** Seeds the run cache without writing to the backing store, used for frozen Set-node replay. */
  async seed(key: string, value: RivetStoredValue): Promise<void> {
    const normalizedKey = normalizeRivetStoredValueKey(key);
    const savedValue = cloneRivetStoredValue(value, 'Stored value');
    await this.#withKeyLock(normalizedKey, () => {
      this.#cache.set(normalizedKey, { found: true, value: savedValue });
      this.#resolveWaiters(normalizedKey, savedValue);
    });
  }

  async waitForSet(key: string, signal?: AbortSignal): Promise<RivetStoredValue> {
    const normalizedKey = normalizeRivetStoredValueKey(key);
    let immediateValue: RivetStoredValue | undefined;
    let waiterPromise: Promise<RivetStoredValue> | undefined;

    signal?.throwIfAborted();
    await this.#withKeyLock(normalizedKey, async () => {
      signal?.throwIfAborted();
      const current = await this.#getUnlocked(normalizedKey);
      signal?.throwIfAborted();
      if (current.found) {
        immediateValue = cloneRivetStoredValue(current.value, 'Stored value');
        return;
      }

      waiterPromise = new Promise<RivetStoredValue>((resolve, reject) => {
        const waiter: StoredValueWaiter = { resolve, reject };
        const waiters = this.#waiters.get(normalizedKey) ?? new Set<StoredValueWaiter>();
        waiters.add(waiter);
        this.#waiters.set(normalizedKey, waiters);

        if (!signal) return;
        const onAbort = () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.#waiters.delete(normalizedKey);
          reject(signal.reason ?? new Error('Stored value wait was aborted.'));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
          const originalResolve = waiter.resolve;
          waiter.resolve = (resolvedValue) => {
            signal.removeEventListener('abort', onAbort);
            originalResolve(resolvedValue);
          };
        }
      });
    });

    signal?.throwIfAborted();
    if (immediateValue !== undefined) return immediateValue;
    return await waiterPromise!;
  }

  async #getUnlocked(key: string): Promise<RivetStoredValueReadResult> {
    const cached = this.#cache.get(key);
    if (cached) return cached;
    if (this.#loadErrors.has(key)) throw this.#loadErrors.get(key);

    try {
      const loaded = await this.store?.get(key);
      const result: RivetStoredValueReadResult =
        loaded === undefined
          ? { found: false }
          : { found: true, value: cloneRivetStoredValue(loaded, 'Stored value returned by the store') };
      this.#cache.set(key, result);
      return result;
    } catch (error) {
      this.#loadErrors.set(key, error);
      throw error;
    }
  }

  #resolveWaiters(key: string, value: RivetStoredValue): void {
    const waiters = this.#waiters.get(key);
    if (!waiters) return;
    this.#waiters.delete(key);
    for (const waiter of waiters) {
      waiter.resolve(cloneRivetStoredValue(value, 'Stored value'));
    }
  }

  async #withKeyLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#keyOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.#keyOperations.set(key, current);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#keyOperations.get(key) === current) this.#keyOperations.delete(key);
    }
  }
}

export function createRivetStoredValueSnapshotStore(initialValues: Readonly<Record<string, unknown>> = {}): {
  getPatch(): RivetStoredValueRecord;
  store: RivetStoredValueStore;
} {
  const currentValues = cloneRivetStoredValueRecord(initialValues, 'Stored value snapshot');
  const patch: RivetStoredValueRecord = {};

  return {
    store: {
      get(key) {
        const normalizedKey = normalizeRivetStoredValueKey(key);
        return Object.prototype.hasOwnProperty.call(currentValues, normalizedKey)
          ? cloneRivetStoredValue(currentValues[normalizedKey]!, 'Stored value')
          : undefined;
      },
      set(key, value) {
        const normalizedKey = normalizeRivetStoredValueKey(key);
        const cloned = cloneRivetStoredValue(value, 'Stored value');
        setStoredValueRecordEntry(currentValues, normalizedKey, cloned);
        setStoredValueRecordEntry(patch, normalizedKey, cloneRivetStoredValue(cloned, 'Stored value'));
      },
    },
    getPatch: () => cloneRivetStoredValueRecord(patch, 'Stored value patch'),
  };
}

export function normalizeRivetStoredValueKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Stored value key must be a non-empty string.');
  }
  return value;
}

function setStoredValueRecordEntry(record: RivetStoredValueRecord, key: string, value: RivetStoredValue): void {
  // Defining an own data property keeps all non-empty JSON string keys safe, including __proto__.
  Object.defineProperty(record, key, { configurable: true, enumerable: true, value, writable: true });
}

export function cloneRivetStoredValue(value: unknown, label = 'Stored value'): RivetStoredValue {
  return clonePortableValue(value, label, new Set<object>());
}

export function cloneRivetStoredValueRecord(
  value: Readonly<Record<string, unknown>>,
  label = 'Stored value record',
): RivetStoredValueRecord {
  const cloned = cloneRivetStoredValue(value, label);
  if (!isPlainRecord(cloned)) throw new Error(`${label} must be a JSON object.`);
  for (const key of Object.keys(cloned)) normalizeRivetStoredValueKey(key);
  return cloned;
}

function cloneReadResult(result: RivetStoredValueReadResult): RivetStoredValueReadResult {
  return result.found ? { found: true, value: cloneRivetStoredValue(result.value, 'Stored value') } : { found: false };
}

function clonePortableValue(value: unknown, label: string, ancestors: Set<object>): RivetStoredValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only portable JSON values.`);
  }
  if (ancestors.has(value)) throw new Error(`${label} must not contain cycles.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const cloned: RivetStoredValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`${label} must not contain sparse arrays.`);
        }
        cloned.push(clonePortableValue(value[index], label, ancestors));
      }
      return cloned;
    }
    if (!isPlainRecord(value)) {
      throw new Error(`${label} must contain only plain JSON objects and arrays.`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clonePortableValue(item, label, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
