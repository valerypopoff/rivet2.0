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
