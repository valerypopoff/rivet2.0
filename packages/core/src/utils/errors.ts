/** Gets an Error from an unknown error object (strict unknown errors is enabled, helper util). */
export function getError(error: unknown): Error {
  const errorInstance =
    typeof error === 'object' && error instanceof Error
      ? error
      : new Error(error != null ? error.toString() : 'Unknown error');
  return errorInstance;
}

/** Full failure text for graph error outputs, including nested causes. */
export function formatCaughtRunError(error: unknown, seen = new Set<unknown>()): string {
  try {
    if (error && typeof error === 'object') {
      if (seen.has(error)) return '[Circular error reference]';
      seen.add(error);
    }
    const errorLike = error != null && typeof error === 'object' ? (error as Partial<Error>) : undefined;
    // Error identity is realm-local; iframe/provider errors still have the
    // standard name/message/stack shape, usually with non-enumerable fields.
    if (
      errorLike &&
      (error instanceof Error || (typeof errorLike.name === 'string' && typeof errorLike.message === 'string'))
    ) {
      const text =
        (typeof errorLike.stack === 'string' && errorLike.stack.trim()) ||
        `${errorLike.name}: ${errorLike.message}`.trim();
      return errorLike.cause == null ? text : `${text}\n\nCaused by: ${formatCaughtRunError(errorLike.cause, seen)}`;
    }
    return typeof error === 'object' && error != null ? JSON.stringify(error, null, 2) ?? String(error) : String(error);
  } catch {
    // Arbitrary thrown values can have no prototype, cycles or throwing getters.
    // Formatting their error output must never become a second graph failure.
    try {
      return String(error);
    } catch {
      return '[Unprintable thrown value]';
    }
  }
}

/** Caller cancellation wins over provider failure, including cross-realm errors. */
export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  try {
    return error != null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
  } catch {
    return false;
  }
}
