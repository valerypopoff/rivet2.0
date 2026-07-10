import PQueueImport from 'p-queue';

/**
 * p-queue v7+ is ESM-only. The CJS bundle (built by bundle.esbuild.cjs) aliases
 * `p-queue` to `p-queue-6` (a CJS-compatible older version). That version wraps
 * the default export so that `import PQueue from 'p-queue'` resolves to
 * `{ default: PQueue }` instead of the class directly. This module normalizes
 * the import so that consumers never need a runtime type check.
 */
const PQueue: typeof PQueueImport =
  typeof PQueueImport === 'function'
    ? PQueueImport
    : (PQueueImport as unknown as { default: typeof PQueueImport }).default;

export default PQueue;
