import type { Outputs } from '../GraphProcessor.js';

/**
 * Copies displayed LLM Chat outputs at an ownership boundary. Provider and
 * continuation code intentionally continues to accumulate messages, usage,
 * reasoning, and direct results after intermediate rounds complete; historical
 * pages must therefore never retain those mutable references.
 */
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

/** Cycle-safe clone shared by the editor cache and LLM logical-round snapshots. */
export function cloneLLMChatV2Outputs(outputs: Outputs): Outputs {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(outputs) as Outputs;
    } catch {
      // Fall through for values structuredClone cannot copy.
    }
  }

  return cloneOutputValue(outputs);
}
