/**
 * Rivet's browser stores intentionally resolve at individual request completion,
 * matching their native IndexedDB predecessors. Observe idb's additional
 * transaction promise so a request failure does not also become an unhandled
 * transaction rejection.
 */
export function preserveIndexedDbRequestTiming<T extends { done: Promise<unknown> }>(transaction: T): T {
  void transaction.done.catch(() => undefined);
  return transaction;
}

/**
 * Cache one IndexedDB connection until the browser reports that it is no
 * longer usable. Open failures are not cached, so a later operation can retry.
 */
export function createRecoverableIndexedDbConnection<Database>(
  open: (onUnavailable: () => void) => Promise<Database>,
): () => Promise<Database> {
  let databasePromise: Promise<Database> | undefined;
  let connectionVersion = 0;

  return () => {
    if (databasePromise == null) {
      const openedVersion = ++connectionVersion;
      const reset = () => {
        if (connectionVersion === openedVersion) {
          databasePromise = undefined;
        }
      };

      databasePromise = Promise.resolve()
        .then(() => open(reset))
        .catch((error: unknown) => {
          reset();
          throw error;
        });
    }

    return databasePromise;
  };
}
