const tails = new WeakMap<object, Promise<unknown>>();

/** The cache is shared by tabs. Clear/hydrate, edits and startup reads must not
 * interleave, even when they come from different hook instances. */
export function runStaticDataCacheOperation<T>(cache: object, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(cache) ?? Promise.resolve()).then(operation);
  tails.set(
    cache,
    result.catch(() => undefined),
  );
  return result;
}
