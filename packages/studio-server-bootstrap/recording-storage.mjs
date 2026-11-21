/** Source-owned storage contract. Reader-only releases set this to 'gzip'. */
export const DEFAULT_MANAGED_RECORDING_ENCODING = 'br';
export const RECORDING_STORAGE_COORDINATION_PROTOCOL = 1;
export const RECORDING_STORAGE_LOCK = Object.freeze([8072, 24006]);

export function recordingStorageCapabilities() {
  return {
    readableEncodings: ['identity', 'gzip', 'br'],
    writableEncodings: DEFAULT_MANAGED_RECORDING_ENCODING === 'br' ? ['identity', 'gzip', 'br'] : ['identity', 'gzip'],
    coordinationProtocol: RECORDING_STORAGE_COORDINATION_PROTOCOL,
  };
}

/** Only maintenance operations use this lock, never ordinary serving requests. */
export async function acquireRecordingStorageLock(client, mode) {
  if (mode !== 'shared' && mode !== 'exclusive') throw new Error('Invalid recording storage lock mode.');
  const suffix = mode === 'shared' ? '_shared' : '';
  const result = await client.query(`SELECT pg_try_advisory_lock${suffix}($1,$2) AS acquired`, RECORDING_STORAGE_LOCK);
  if (!result.rows[0]?.acquired) {
    const error = new Error('Another recording storage operation is active.');
    error.code = 'recording_storage_busy';
    throw error;
  }
  let released;
  return () =>
    (released ??= (async () => {
      const result = await client.query(
        `SELECT pg_advisory_unlock${suffix}($1,$2) AS released`,
        RECORDING_STORAGE_LOCK,
      );
      if (!result.rows[0]?.released) throw new Error('Recording storage coordination ownership was lost.');
    })());
}

/** Call inside the short publication transaction, closing a lost-session race. */
export async function assertRecordingPublicationLock(client) {
  return assertRecordingTransactionLock(client, 'exclusive');
}

export async function assertRecordingTransactionLock(client, mode) {
  if (mode !== 'shared' && mode !== 'exclusive') throw new Error('Invalid recording storage lock mode.');
  const suffix = mode === 'shared' ? '_shared' : '';
  const result = await client.query(
    `SELECT pg_try_advisory_xact_lock${suffix}($1,$2) AS acquired`,
    RECORDING_STORAGE_LOCK,
  );
  if (!result.rows[0]?.acquired) {
    const error = new Error('A storage transition prevented recording publication.');
    error.code = 'recording_storage_busy';
    throw error;
  }
}
