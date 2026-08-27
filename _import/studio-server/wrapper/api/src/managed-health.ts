import type { Pool } from 'pg';
import { Agent as HttpsAgent } from 'node:https';
import type { NodeHttpHandlerOptions } from '@smithy/node-http-handler';

import type { RuntimeHealthCheckContext } from './runtime-health.js';

export const MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS = 10_000;
export const MANAGED_OBJECT_STORAGE_CONNECTION_TIMEOUT_MS = 10_000;
export const MANAGED_OBJECT_STORAGE_SOCKET_TIMEOUT_MS = 60_000;

export function createManagedObjectStorageHttpHandlerOptions(): NodeHttpHandlerOptions {
  return {
    httpsAgent: new HttpsAgent({
      keepAlive: true,
      maxSockets: 64,
      keepAliveMsecs: 30_000,
    }),
    connectionTimeout: MANAGED_OBJECT_STORAGE_CONNECTION_TIMEOUT_MS,
    socketTimeout: MANAGED_OBJECT_STORAGE_SOCKET_TIMEOUT_MS,
  };
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Health check aborted.');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(getAbortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(getAbortError(signal)));

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function checkPostgresPoolHealth(
  pool: Pool,
  context?: RuntimeHealthCheckContext,
): Promise<void> {
  if (!context) {
    await pool.query('SELECT 1');
    return;
  }

  const client = await pool.connect();
  let destroyClient = context.signal.aborted;
  const abort = () => {
    destroyClient = true;
    client.release(true);
  };

  if (destroyClient) {
    client.release(true);
    throw getAbortError(context.signal);
  }

  context.signal.addEventListener('abort', abort, { once: true });
  try {
    await raceWithAbort(client.query('SELECT 1'), context.signal);
  } finally {
    context.signal.removeEventListener('abort', abort);
    if (!destroyClient) client.release();
  }
}