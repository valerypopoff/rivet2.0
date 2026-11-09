import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createHttpError } from '../../../utils/httpError.js';

const admitted = new WeakMap<Pool, number>();
export const REFERENCE_QUERY_TIMEOUT_MS = 5_000;

/** No unbounded admission queue, abandoned query, or leaked transaction-local settings. */
export async function queryReferences<Row extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values: unknown[],
  signal: AbortSignal,
  options: { timeoutMs?: number; write?: boolean } = {},
): Promise<Row[]> {
  const timeoutMs = options.timeoutMs ?? REFERENCE_QUERY_TIMEOUT_MS;
  signal.throwIfAborted();
  if ((admitted.get(pool) ?? 0) >= 2) throw createHttpError(503, 'Reference checks are busy. Try again shortly.');
  admitted.set(pool, (admitted.get(pool) ?? 0) + 1);
  const deadline = Date.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const bounded = AbortSignal.any([signal, timeout]);
  let client: PoolClient | undefined;
  let released = false;
  let acquiring = true;
  let finished = false;
  const freeSlot = () => admitted.set(pool, (admitted.get(pool) ?? 1) - 1);
  const destroy = () => {
    if (client && !released) {
      released = true;
      client.release(true);
    }
  };
  bounded.addEventListener('abort', destroy, { once: true });
  const wait = <T>(promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(bounded.reason);
      bounded.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => bounded.removeEventListener('abort', abort));
      if (bounded.aborted) abort();
    });
  try {
    client = await wait(
      pool.connect().then(
        (lease) => {
          acquiring = false;
          if (bounded.aborted) {
            lease.release(true);
            if (finished) freeSlot();
            throw bounded.reason;
          }
          return lease;
        },
        (error) => {
          acquiring = false;
          if (finished) freeSlot();
          throw error;
        },
      ),
    );
    bounded.throwIfAborted();
    await wait(client.query(options.write ? 'BEGIN' : 'BEGIN READ ONLY'));
    await wait(
      client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, deadline - Date.now()))]),
    );
    const result = await wait(client.query<Row>(sql, values));
    await wait(client.query(options.write ? 'COMMIT' : 'ROLLBACK'));
    bounded.throwIfAborted();
    return result.rows;
  } catch (error) {
    destroy();
    signal.throwIfAborted();
    if (timeout.aborted || (error as { code?: string })?.code === '57014')
      throw createHttpError(503, 'Reference checking timed out. Try again shortly.');
    throw error;
  } finally {
    finished = true;
    bounded.removeEventListener('abort', destroy);
    if (client && !released) {
      released = true;
      client.release();
    }
    // A timed-out pool acquisition keeps its admission slot until its late lease
    // is returned. Otherwise repeated requests could grow pg's waiting queue.
    if (!acquiring) freeSlot();
  }
}
