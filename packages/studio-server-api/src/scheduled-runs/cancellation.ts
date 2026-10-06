/** Interrupt waiting, not the underlying IO. Late values are disposed, and the
 * caller must still fence every mutation after preparation. */
export function awaitPreparation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let retired = false;
    const abort = () => {
      retired = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Preparation cancelled.'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (retired) disposeLate?.(value);
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          if (!retired) reject(error);
        },
      )
      .catch(() => {
        // A late disposal error must not turn expected cancellation into an
        // unhandled rejection. Nothing from this retired preparation is published.
        console.error('[scheduled-runs] Retired preparation cleanup failed.');
      });
  });
}
