import type Emittery from 'emittery';

/**
 * Intentionally fire-and-forget an Emittery event emission.
 *
 * Use this instead of inline `// eslint-disable-next-line @typescript-eslint/no-floating-promises`
 * to make the "detached async" intent explicit and auditable.
 *
 * The returned promise is intentionally detached and listener failures are
 * contained. Call this only for observer events where listener completion or
 * failure must not affect processor ordering.
 */
export function emitDetached<T extends Record<string, unknown>>(
  emitter: Emittery<T>,
  event: keyof T & string,
  data: T[keyof T & string],
): void {
  void emitter.emit(event, data).catch(() => {
    // Detached observers must not alter or terminate graph execution.
  });
}
