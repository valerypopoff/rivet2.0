import type { Outputs } from './GraphProcessor.js';

function cloneOutputValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  const existing = seen.get(value);
  if (existing != null) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    clone.push(...value.map((item) => cloneOutputValue(item, seen)));
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneOutputValue(item, seen);
  }
  return clone as T;
}

/**
 * Creates a cycle-safe copy at an execution-output ownership boundary.
 *
 * Providers may continue mutating output objects after a partial event. A
 * snapshot, recorder, or deferred branch must therefore never retain the
 * producer-owned reference.
 */
export function cloneExecutionOutputs(outputs: Outputs): Outputs {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(outputs) as Outputs;
    } catch {
      // Fall through for values structuredClone cannot copy.
    }
  }

  return cloneOutputValue(outputs);
}
