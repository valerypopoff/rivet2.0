import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { bindSharedReplayProjectId } from '@valerypopoff/rivet2-core/serialization';
import {
  ManagedArtifactIntegrityError,
  parseManagedArtifactDescriptor,
} from './artifact-descriptor.js';
import {
  isManagedWorkflowArtifactObjectKey,
  isMissingManagedWorkflowObject,
  isRecordingProjectSnapshotKey,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowMaintenanceLease } from './maintenance.js';

export function canShareRecordingProjectSnapshot(workflowId: string): boolean {
  return (
    workflowId === workflowId.trim() &&
    !!workflowId &&
    workflowId !== '.' &&
    workflowId !== '..' &&
    !workflowId.includes('/') &&
    !workflowId.includes('\\')
  );
}

type SnapshotRow = QueryResultRow & {
  object_key: string;
  workflow_id: string;
};

export function readRecordingProjectSnapshotDescriptor(key: string, workflowId: string) {
  if (
    !isRecordingProjectSnapshotKey(key) ||
    key.split('/', 1)[0] !== workflowId ||
    !isManagedWorkflowArtifactObjectKey(key)
  )
    throw new Error('Recording project snapshot has an invalid storage owner.');
  return parseManagedArtifactDescriptor(key)!;
}

export async function confirmRecordingProjectSnapshot(client: Pick<Pool, 'query'>, key: string): Promise<void> {
  await client.query(
    `UPDATE workflow_recording_project_snapshots SET state='verified'
     WHERE object_key=$1 AND state='pending'`,
    [key],
  );
}

export async function markRecordingProjectSnapshotUnusable(
  client: Pick<Pool, 'query'>,
  keys: readonly string[],
  integrityFailure = false,
): Promise<void> {
  if (!keys.length) return;
  // A missing pending object can still be in flight. A confirmed checksum
  // mismatch also fences a pending generation whose immutable key exists.
  await client.query(
    `UPDATE workflow_recording_project_snapshots SET state='unusable'
     WHERE object_key=ANY($1::text[]) AND
           (state='verified' OR ($2::boolean AND state='pending'))`,
    [keys, integrityFailure],
  );
}

export async function noteRecordingProjectSnapshotReadFailure(
  pool: Pick<Pool, 'query'>,
  key: string,
  error: unknown,
): Promise<void> {
  const integrityFailure = error instanceof ManagedArtifactIntegrityError;
  if (integrityFailure || isMissingManagedWorkflowObject(error))
    await markRecordingProjectSnapshotUnusable(pool, [key], integrityFailure).catch(() => undefined);
}

export async function readSharedRecordingProject(
  pool: Pick<Pool, 'query'>,
  store: ManagedWorkflowBlobStore,
  key: string,
  workflowId: string,
  recordingId: string,
): Promise<string> {
  readRecordingProjectSnapshotDescriptor(key, workflowId);
  try {
    const text = await store.getText(key);
    try {
      return bindSharedReplayProjectId(text, workflowId, recordingId);
    } catch {
      throw new ManagedArtifactIntegrityError('Shared replay project has an invalid source identity.');
    }
  } catch (error) {
    await noteRecordingProjectSnapshotReadFailure(pool, key, error);
    throw error;
  }
}

/** Keep one maintenance cursor and only lock snapshots that appear unreferenced. */
export function createRecordingProjectSnapshotRetentionTask(
  context: Pick<ManagedWorkflowContext, 'pool' | 'withTransaction' | 'maintenance'>,
) {
  let cursor: string | null = null;
  const checkReferences = async (client: Pick<Pool, 'query'>, rows: SnapshotRow[]) =>
    new Set(
      (
        await client.query<{ object_key: string }>(
          `SELECT replay_project_blob_key AS object_key FROM workflow_recordings
       WHERE workflow_id=ANY($2::text[]) AND replay_project_blob_key=ANY($1::text[])
       UNION
       SELECT manifest_json->'row'->>'replayProjectBlobKey' AS object_key FROM workflow_run_evidence
       WHERE workflow_id=ANY($2::text[]) AND availability IN ('pending','unavailable')
         AND manifest_json->'row'->>'replayProjectBlobKey'=ANY($1::text[])`,
          [rows.map((row) => row.object_key), [...new Set(rows.map((row) => row.workflow_id))]],
        )
      ).rows.map((row) => row.object_key),
    );
  return async (lease: ManagedWorkflowMaintenanceLease): Promise<void> => {
    const limit = context.maintenance.config.batchSize;
    const after = cursor ?? '';
    const page = (
      await context.pool.query<SnapshotRow>(
        'SELECT object_key,workflow_id FROM workflow_recording_project_snapshots WHERE object_key>$1 ORDER BY object_key LIMIT $2',
        [after, limit],
      )
    ).rows;
    if (page.length) {
      const referenced = await checkReferences(context.pool, page);
      const candidates = page.filter((row) => !referenced.has(row.object_key)).map((row) => row.object_key);
      if (candidates.length)
        await context.withTransaction(async (client) => {
          await lease.assertCurrent(client);
          const locked = (
            await client.query<SnapshotRow>(
              `SELECT object_key,workflow_id FROM workflow_recording_project_snapshots
           WHERE object_key=ANY($1::text[]) ORDER BY object_key FOR UPDATE SKIP LOCKED`,
              [candidates],
            )
          ).rows;
          // Fresh statement after the exclusive lock. A writer either committed
          // its pin already or cannot attach this generation after retirement.
          const live = await checkReferences(client, locked);
          const retired = locked
            .filter((row) => !live.has(row.object_key))
            .map((row) => {
              readRecordingProjectSnapshotDescriptor(row.object_key, row.workflow_id);
              return row.object_key;
            });
          if (!retired.length) return;
          await client.query('DELETE FROM workflow_recording_project_snapshots WHERE object_key=ANY($1::text[])', [
            retired,
          ]);
          await context.maintenance.enqueueObjectDeletions(client, 'workflow-recording-snapshot-retention', retired);
        });
    }
    cursor = page.length === limit ? page.at(-1)!.object_key : null;
  };
}
