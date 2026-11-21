import { types } from 'node:util';
import type { ExecutionRecorder, RecordedEvents } from '@valerypopoff/rivet2-core';

const MiB = 1024 * 1024;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const arrayBufferBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedBufferBytes = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;
const stringValue = String.prototype.valueOf;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
export class RecordingMemoryCapacityError extends Error {
  readonly status = 503;
  readonly code = 'recording_capacity_exceeded';
  constructor() {
    super('Recording memory capacity is exhausted.');
  }
}
export function isRecordingMemoryCapacityError(error: unknown): boolean {
  try {
    return !types.isProxy(error) && error instanceof RecordingMemoryCapacityError;
  } catch {
    return false; // A thrown value's prototype chain must not bypass cleanup.
  }
}

type Limits = { bytes: number; captureBytes: number; captures: number; events: number; inspectedValues: number };
const defaultLimits: Limits = {
  bytes: 256 * MiB,
  captureBytes: 64 * MiB,
  captures: 256,
  events: 100_000,
  inspectedValues: 250_000,
};

/** Conservative retained-data estimate, never JSON serialization or user property reads.
 * Aliases are revisited with a fresh estimator before persistence to catch mutation.
 * Opaque objects/closures are estimates, not a hard V8 heap or allocation limit. */
class Footprint {
  #seen = new WeakSet<object>();
  #strings = new Set<string>();
  #stack: unknown[] = [];
  bytes = 0;
  constructor(private readonly limits: Limits) {}
  add(value: unknown): number {
    const stack = this.#stack;
    stack.push(value);
    let inspected = 0;
    try {
      while (stack.length) {
        if (++inspected > this.limits.inspectedValues || this.bytes > this.limits.captureBytes)
          throw new RecordingMemoryCapacityError();
        const item = stack.pop();
        if (typeof item === 'string') {
          if (item.length > 128) {
            if (this.#strings.has(item)) continue;
            this.#strings.add(item);
          }
          this.bytes += 24 + item.length * 2;
        } else if ((typeof item === 'object' && item !== null) || typeof item === 'function') {
          if (this.#seen.has(item)) continue;
          this.#seen.add(item);
          this.bytes += 64;
          if (types.isProxy(item) || typeof item === 'function') {
            this.bytes += 4096;
            continue;
          }
          if (ArrayBuffer.isView(item)) {
            stack.push((types.isDataView(item) ? dataViewBuffer : typedArrayBuffer).call(item));
            continue;
          }
          if (types.isAnyArrayBuffer(item)) {
            this.bytes += (types.isSharedArrayBuffer(item) ? sharedBufferBytes : arrayBufferBytes).call(item);
            continue;
          }
          if (types.isStringObject(item)) {
            // Enumerating a boxed string allocates one key per character.
            stack.push(stringValue.call(item));
            continue;
          }
          const nativeError = types.isNativeError(item);
          if (nativeError) this.bytes += 4096; // Keep lazy stack formatting out of accounting.
          if (Array.isArray(item)) {
            if (item.length > this.limits.inspectedValues - inspected) throw new RecordingMemoryCapacityError();
            this.bytes += item.length * 8; // Holes also occupy array slots and expand during serialization.
          } else if (types.isMap(item)) {
            const size = mapSize.call(item) as number;
            if (size * 2 > this.limits.inspectedValues - inspected) throw new RecordingMemoryCapacityError();
            this.bytes += size * 64;
            mapForEach.call(item, (value, key) => {
              stack.push(key, value);
            });
          } else if (types.isSet(item)) {
            const size = setSize.call(item) as number;
            if (size > this.limits.inspectedValues - inspected) throw new RecordingMemoryCapacityError();
            this.bytes += size * 64;
            setForEach.call(item, (value) => {
              stack.push(value);
            });
          }
          // Separate native string/symbol enumeration is substantially cheaper
          // here than Reflect.ownKeys, with the same own-property coverage/order.
          const keys: (string | symbol)[] = Object.getOwnPropertyNames(item);
          const symbols = Object.getOwnPropertySymbols(item);
          if (keys.length + symbols.length > this.limits.inspectedValues - inspected)
            throw new RecordingMemoryCapacityError();
          for (const symbol of symbols) keys.push(symbol);
          for (const key of keys) {
            if (nativeError && key === 'stack') continue;
            this.bytes += 24 + (typeof key === 'string' ? key.length * 2 : 16);
            const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
            if ('value' in descriptor) stack.push(descriptor.value);
            else this.bytes += 4096; // Do not invoke accessors or their closed-over state.
          }
        } else this.bytes += 8;
      }
      if (this.bytes > this.limits.captureBytes) throw new RecordingMemoryCapacityError();
      return this.bytes;
    } finally {
      // Reuse the traversal workspace, never retain its payloads after an
      // inspection (including an early capacity failure).
      stack.length = 0;
    }
  }
}

function addEventData(footprint: Footprint, event: RecordedEvents): number {
  if (event.type === 'nodeStart') {
    footprint.add(event.data.inputs);
    if (event.data.inputConnections !== undefined) footprint.add(event.data.inputConnections);
    return 1024;
  }
  if (event.type === 'nodeFinish') {
    footprint.add(event.data.outputs);
    if (event.data.splitRunDurationMs !== undefined) footprint.add(event.data.splitRunDurationMs);
    return 1024;
  }
  if (event.data !== undefined) footprint.add(event.data);
  return 96;
}

class CaptureReservation {
  bytes = 0;
  #closed = false;
  #events = 0;
  #writeReserved = false;
  #envelopes = 0;
  #footprint: Footprint | undefined;
  constructor(
    private readonly pool: RecordingMemoryBudget,
    private readonly limits: Limits,
    private recordedEvents?: readonly RecordedEvents[],
  ) {
    this.#footprint = recordedEvents ? new Footprint(limits) : undefined;
  }
  retain(event: RecordedEvents): boolean {
    if (this.#closed) return false;
    try {
      const footprint = this.#footprint!;
      if (++this.#events > this.limits.events) throw new RecordingMemoryCapacityError();
      // These envelopes are created by Core, not returned by user code. Charge
      // their bounded metadata once; inspect and later recheck their payloads.
      // Other event kinds retain the generic path when the protocol grows.
      this.#envelopes += addEventData(footprint, event);
      const bytes = footprint.bytes + this.#envelopes;
      if (bytes > this.limits.captureBytes) throw new RecordingMemoryCapacityError();
      this.resize(bytes);
      return true;
    } catch {
      this.pool.reject();
      return false;
    }
  }
  measure(values: unknown[]): number {
    if (this.#closed) throw new RecordingMemoryCapacityError();
    const fresh = new Footprint(this.limits);
    let envelopes = 0;
    if (this.recordedEvents) {
      if (this.recordedEvents.length > this.limits.events) throw new RecordingMemoryCapacityError();
      for (const event of this.recordedEvents) envelopes += addEventData(fresh, event);
    }
    for (const value of values) fresh.add(value);
    const bytes = fresh.bytes + envelopes;
    if (bytes > this.limits.captureBytes) throw new RecordingMemoryCapacityError();
    this.#footprint = fresh;
    this.#envelopes = envelopes;
    this.#writeReserved = false;
    return bytes;
  }
  resize(bytes: number): void {
    if (this.#closed || !this.pool.resize(this.bytes, bytes)) throw new RecordingMemoryCapacityError();
    this.bytes = bytes;
  }
  reserveWrite(): void {
    if (!this.#writeReserved) {
      this.resize(Math.max(4096, this.bytes * 2));
      this.#writeReserved = true;
    }
  }
  release(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.pool.release(this.bytes);
    this.bytes = 0;
    this.recordedEvents = undefined;
    this.#footprint = undefined;
  }
}

/** One accounting owner, shared by captures and direct prepared uploads. No IO. */
export class RecordingMemoryBudget {
  #bytes = 0;
  #captures = 0;
  #rejections = 0;
  #reservations = new WeakMap<ExecutionRecorder, CaptureReservation>();
  readonly #limits: Limits;
  constructor(limits: Partial<Limits> = {}) {
    this.#limits = { ...defaultLimits, ...limits };
  }
  snapshot() {
    return {
      estimatedBytes: this.#bytes,
      captures: this.#captures,
      rejections: this.#rejections,
      maxBytes: this.#limits.bytes,
    };
  }
  reject(): void {
    this.#rejections++;
  }
  resize(previous: number, next: number): boolean {
    if (this.#bytes - previous + next > this.#limits.bytes) return false;
    this.#bytes += next - previous;
    return true;
  }
  release(bytes: number): void {
    this.#bytes -= bytes;
    this.#captures--;
  }
  #acquire(recorder?: ExecutionRecorder): CaptureReservation {
    if (this.#captures >= this.#limits.captures) throw new RecordingMemoryCapacityError();
    this.#captures++;
    const reservation = new CaptureReservation(this, this.#limits, recorder?.events);
    if (recorder) this.#reservations.set(recorder, reservation);
    return reservation;
  }
  createCapturePolicy = (recorder: ExecutionRecorder) => {
    try {
      return this.#acquire(recorder);
    } catch (error) {
      this.reject();
      throw error;
    }
  };
  retainedBytes(recorder: ExecutionRecorder): number {
    return this.#reservations.get(recorder)?.bytes ?? 0;
  }
  /** Recheck the completed capture and its queue-owned snapshots before admission. */
  retain(recorder: ExecutionRecorder, value: unknown): boolean {
    if (recorder.captureDiscarded) return false;
    try {
      const reservation = this.#reservations.get(recorder) ?? this.#acquire(recorder);
      reservation.resize(reservation.measure([value]));
      return true;
    } catch {
      this.reject();
      this.discard(recorder);
      return false;
    }
  }
  serialize(recorder: ExecutionRecorder, retained: unknown[] = []): string {
    if (recorder.captureDiscarded) throw new RecordingMemoryCapacityError();
    try {
      const reservation = this.#reservations.get(recorder) ?? this.#acquire(recorder);
      const rawBytes = reservation.measure(retained);
      // Reserve codec scratch space before creating the encoded representation.
      reservation.resize(Math.max(4096, rawBytes * 3));
      const serialized = recorder.serialize();
      reservation.resize(rawBytes + serialized.length * 2);
      return serialized;
    } catch (error) {
      if (isRecordingMemoryCapacityError(error)) this.reject();
      this.discard(recorder);
      throw error;
    }
  }
  discard(recorder: ExecutionRecorder): void {
    recorder.discard();
    this.#reservations.get(recorder)?.release();
    this.#reservations.delete(recorder);
  }
  prepared<T>(values: unknown[], run: () => Promise<T>, recorder?: ExecutionRecorder): Promise<T> {
    const capture = recorder && this.#reservations.get(recorder);
    if (capture) {
      // The settled capture was already inspected. Borrow its lease instead of
      // walking the same project again or counting it as another capture.
      try {
        capture.reserveWrite();
        return run();
      } catch (error) {
        if (isRecordingMemoryCapacityError(error)) this.reject();
        return Promise.reject(error);
      }
    }
    let reservation: CaptureReservation | undefined;
    try {
      reservation = this.#acquire();
      const rawBytes = reservation.measure(values);
      // UTF-8 conversion and concurrent compression can coexist with JS strings.
      reservation.resize(Math.max(4096, rawBytes * 4));
      return run().finally(() => reservation!.release());
    } catch (error) {
      if (isRecordingMemoryCapacityError(error)) this.reject();
      reservation?.release();
      return Promise.reject(error);
    }
  }
}

export const recordingMemory = new RecordingMemoryBudget();
