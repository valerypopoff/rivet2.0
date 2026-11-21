import type { PoolClient } from 'pg';
import { assertRecordingPublicationLock } from '@valerypopoff/rivet-studio-server-bootstrap/recording-storage.mjs';
import {
  decodeManagedArtifactBytes,
  ManagedArtifactIntegrityError,
  ManagedArtifactSizeError,
  MAX_MANAGED_ARTIFACT_BYTES,
  parseManagedArtifactDescriptor,
  prepareManagedTextArtifact,
} from '../src/routes/workflows/managed/artifact-descriptor.js';
import {
  createRecordingBlobKey,
  createRecordingTraceGenerationKey,
  isManagedWorkflowArtifactObjectKey,
  isMissingManagedWorkflowObject,
} from '../src/routes/workflows/managed/blob-store.js';
import type { ManagedWorkflowContext } from '../src/routes/workflows/managed/context.js';

type Context = Pick<ManagedWorkflowContext, 'pool' | 'blobStore' | 'withTransaction' | 'maintenance'>;
export type RecordingRecompressionCursor = { createdAt: string; recordingId: string };
type Candidate = {
  recording_id: string;
  workflow_id: string;
  recording_blob_key: string;
  created_at: string;
};
const reason = 'workflow-recording-recompression';
const eligible = `r.status IN ('succeeded','failed','suspicious')
  AND NOT EXISTS (SELECT 1 FROM workflow_run_evidence e WHERE e.run_id=r.recording_id)`;
const timestamp = `TO_CHAR(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readRecordingRestoreIdentity(client: Pick<PoolClient, 'query'>): Promise<string> {
  const result = await client.query<{ deployment: string; epoch: string | null }>(
    'SELECT deployment,epoch::text FROM rivet_restore_control.installation WHERE singleton=TRUE',
  );
  if (result.rows.length !== 1) throw new Error('Restore installation identity is unavailable.');
  return JSON.stringify(result.rows[0]);
}

export async function inventoryRecordingEncodings(context: Pick<Context, 'pool'>, workflowId?: string) {
  return (
    await context.pool.query<{ encoding: string; eligible: string; held: string; stored_bytes: string }>(
      `SELECT CASE WHEN r.recording_blob_key ~ '[.]artifact-v1[.][a-f0-9]{64}[.][0-9]+[.][0-9]+[.]br$'
        THEN 'br' WHEN r.recording_blob_key ~ '[.]artifact-v1[.][a-f0-9]{64}[.][0-9]+[.][0-9]+[.]gzip$'
        THEN 'gzip' ELSE 'identity-or-legacy' END AS encoding,
      count(*) FILTER (WHERE ${eligible})::text AS eligible,
      count(*) FILTER (WHERE NOT (${eligible}))::text AS held,
      COALESCE(sum(r.recording_compressed_bytes),0)::text AS stored_bytes
    FROM workflow_recordings r WHERE ($1::text IS NULL OR r.workflow_id=$1) GROUP BY 1 ORDER BY 1`,
      [workflowId ?? null],
    )
  ).rows;
}

/** Source-only operator. Caller holds the bounded exclusive storage/shared restore lease. */
export async function recompressRecordingBatch(
  context: Context,
  options: {
    cutoff: string;
    restoreIdentity: string;
    assertReaders(): Promise<void>;
    signal: AbortSignal;
    limit?: number;
    after?: RecordingRecompressionCursor;
    workflowId?: string;
    maxDecodedBytes?: number;
    maxBatchDecodedBytes?: number;
    deadline?: number;
  },
) {
  const limit = options.limit ?? 100;
  const maxDecoded = options.maxDecodedBytes ?? 32 * 1024 * 1024;
  const maxBatch = options.maxBatchDecodedBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Use --limit 1..1000.');
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new Error('Invalid scheduling deadline.');
  if (
    ![maxDecoded, maxBatch].every((n) => Number.isSafeInteger(n) && n > 0) ||
    maxDecoded > MAX_MANAGED_ARTIFACT_BYTES ||
    maxBatch > 128 * 1024 * 1024 ||
    maxBatch < maxDecoded
  )
    throw new Error('Invalid decoded byte budget.');
  if (
    typeof options.cutoff !== 'string' ||
    !Number.isFinite(Date.parse(options.cutoff)) ||
    (options.after !== undefined &&
      (!options.after ||
        typeof options.after.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(options.after.createdAt)) ||
        typeof options.after.recordingId !== 'string' ||
        !options.after.recordingId.trim()))
  )
    throw new Error('Invalid recompression cursor.');
  const { pool, blobStore, withTransaction, maintenance } = context;
  const getBytes = blobStore.getBytes?.bind(blobStore),
    put = blobStore.putArtifact?.bind(blobStore);
  if (!getBytes || !put) throw new Error('Recompression requires immutable byte storage.');
  const { signal } = options;
  const ioSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  signal.throwIfAborted();
  await options.assertReaders();
  if ((await readRecordingRestoreIdentity(pool)) !== options.restoreIdentity)
    throw new Error('Restore identity changed.');
  const page = await pool.query<Candidate>(
    `SELECT r.recording_id,r.workflow_id,r.recording_blob_key,${timestamp} AS created_at
     FROM workflow_recordings r WHERE ${eligible} AND r.created_at<=$1::timestamptz
       AND ($2::timestamptz IS NULL OR (r.created_at,r.recording_id)>($2::timestamptz,$3::text))
       AND ($4::text IS NULL OR r.workflow_id=$4) AND r.recording_blob_key NOT LIKE '%.br'
     ORDER BY r.created_at,r.recording_id LIMIT $5`,
    [
      options.cutoff,
      options.after?.createdAt ?? null,
      options.after?.recordingId ?? '',
      options.workflowId ?? null,
      limit + 1,
    ],
  );
  const result = {
    scanned: 0,
    converted: 0,
    notSmaller: 0,
    oversized: 0,
    corruptOrMissing: 0,
    skippedOrCompeting: 0,
    decodedBytes: 0,
    budgetBytes: 0,
    uploadedBytes: 0,
    bytesQueuedForDeletion: 0,
  };
  let after = options.after;
  let exhausted = page.rows.length <= limit;
  let budgetExhausted = false;
  for (const row of page.rows.slice(0, limit)) {
    if (signal.aborted || (options.deadline !== undefined && Date.now() >= options.deadline)) {
      exhausted = false;
      budgetExhausted = !signal.aborted;
      break;
    }
    const oldKey = row.recording_blob_key;
    const canonical = createRecordingBlobKey(row.workflow_id, row.recording_id, 'recording');
    const ownerPrefix = `${row.workflow_id}/recordings/${row.recording_id}/`;
    const owned = oldKey.startsWith(ownerPrefix) && isManagedWorkflowArtifactObjectKey(oldKey);
    const descriptor = owned ? parseManagedArtifactDescriptor(oldKey) : null;
    if (!owned || (!descriptor && oldKey !== canonical)) {
      result.skippedOrCompeting++;
    } else if (descriptor && descriptor.decodedBytes > maxDecoded) {
      result.oversized++;
    } else {
      // Charge attempted decompression even when integrity checks fail. Legacy
      // keys have no declared size, so admit their worst-case bounded read.
      const admittedBytes = descriptor
        ? Math.max(descriptor.storedBytes, descriptor.decodedBytes)
        : MAX_MANAGED_ARTIFACT_BYTES;
      if (result.budgetBytes + admittedBytes > maxBatch) {
        exhausted = false;
        budgetExhausted = true;
        break;
      }
      result.budgetBytes += admittedBytes;
      let decoded: Buffer;
      try {
        const bytes = await decodeManagedArtifactBytes(await getBytes(oldKey, { signal: ioSignal() }), descriptor);
        decoded = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ManagedArtifactIntegrityError) && !isMissingManagedWorkflowObject(error)) throw error;
        result.corruptOrMissing++;
        result.scanned++;
        after = { createdAt: row.created_at, recordingId: row.recording_id };
        continue;
      }
      if (!descriptor) result.budgetBytes += decoded.length - admittedBytes;
      if (decoded.length > maxDecoded) result.oversized++;
      else {
        result.decodedBytes += decoded.length;
        const fresh = await prepareManagedTextArtifact(
          createRecordingTraceGenerationKey(row.workflow_id, row.recording_id),
          decoded,
          'br',
        ).catch((error: unknown) => {
          // Input already satisfies the decoded bound. Incompressible content
          // at the ceiling can produce an oversized encoding; retain its original.
          if (error instanceof ManagedArtifactSizeError) return null;
          throw error;
        });
        signal.throwIfAborted();
        const oldBytes = descriptor?.storedBytes ?? decoded.length;
        if (!fresh || fresh.bytes.length >= oldBytes) result.notSmaller++;
        else {
          const key = fresh.descriptor.key;
          // The generation is unique to this attempt. No later retry may reuse it.
          await pool.query(
            `INSERT INTO managed_object_deletion_outbox (object_key,domain,next_attempt_at)
            VALUES ($1,$2,clock_timestamp()+INTERVAL '5 minutes')`,
            [key, reason],
          );
          signal.throwIfAborted();
          await put(fresh.descriptor, fresh.bytes, undefined, { signal: ioSignal() });
          result.uploadedBytes += fresh.bytes.length;
          const restored = await decodeManagedArtifactBytes(
            await getBytes(key, { signal: ioSignal() }),
            fresh.descriptor,
          );
          if (!decoded.equals(restored)) throw new ManagedArtifactIntegrityError('Recompressed trace differs.');
          signal.throwIfAborted();
          let attemptedCommit = false;
          let changed: boolean;
          try {
            changed = await withTransaction(async (client, hooks) => {
              await assertRecordingPublicationLock(client);
              if ((await readRecordingRestoreIdentity(client)) !== options.restoreIdentity)
                throw new Error('Restore identity changed before publication.');
              const upload = await client.query(
                `SELECT 1 FROM managed_object_deletion_outbox
                WHERE object_key=$1 AND domain=$2 AND status='pending' AND claim_holder_id IS NULL
                  AND attempt_count=0 AND next_attempt_at>clock_timestamp() FOR UPDATE`,
                [key, reason],
              );
              if (!upload.rowCount) return false;
              signal.throwIfAborted();
              const updated = await client.query(
                `UPDATE workflow_recordings r
                SET recording_blob_key=$4, recording_compressed_bytes=$5
                WHERE r.recording_id=$1 AND r.workflow_id=$2 AND r.recording_blob_key=$3
                  AND r.created_at=$6::timestamptz AND ${eligible}`,
                [row.recording_id, row.workflow_id, oldKey, key, fresh.bytes.length, row.created_at],
              );
              if (!updated.rowCount) return false;
              await client.query('DELETE FROM managed_object_deletion_outbox WHERE object_key=$1', [key]);
              await maintenance.enqueueObjectDeletions(client, reason, [oldKey]);
              signal.throwIfAborted();
              hooks.onSettled?.((outcome) => {
                attemptedCommit = outcome === 'unknown';
              });
              return true;
            });
          } catch (error) {
            if (!attemptedCommit) throw error;
            // A row lock waits out a COMMIT whose acknowledgement was lost.
            // If that read also fails, don't advance the receipt.
            changed = await withTransaction(async (client) => {
              await assertRecordingPublicationLock(client);
              if ((await readRecordingRestoreIdentity(client)) !== options.restoreIdentity) throw error;
              const settled = await client.query<{ recording_blob_key: string }>(
                'SELECT recording_blob_key FROM workflow_recordings WHERE recording_id=$1 AND workflow_id=$2 FOR UPDATE',
                [row.recording_id, row.workflow_id],
              );
              const currentKey = settled.rows[0]?.recording_blob_key;
              // Publication did not happen. Keep this row resumable and surface
              // the original failure instead of advancing past it as a loser.
              if (currentKey === oldKey) throw error;
              return currentKey === key;
            });
          }
          if (changed) {
            result.converted++;
            result.bytesQueuedForDeletion += oldBytes;
          } else result.skippedOrCompeting++;
        }
      }
    }
    result.scanned++;
    after = { createdAt: row.created_at, recordingId: row.recording_id };
  }
  return { ...result, after, exhausted, budgetExhausted, interrupted: signal.aborted };
}
