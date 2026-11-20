import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  bindSharedReplayProjectId,
  deserializeProject,
  serializeSharedReplayProject,
} from '@valerypopoff/rivet2-core/serialization';
import {
  MAX_MANAGED_ARTIFACT_BYTES,
  ManagedArtifactIntegrityError,
  parseManagedArtifactDescriptor,
  prepareManagedTextArtifact,
} from './artifact-descriptor.js';
import {
  createRecordingBlobKey,
  createRecordingProjectSnapshotKey,
  isManagedWorkflowArtifactObjectKey,
  isMissingManagedWorkflowObject,
} from './blob-store.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowMaintenanceLease } from './maintenance.js';
import {
  canShareRecordingProjectSnapshot,
  noteRecordingProjectSnapshotReadFailure,
  readRecordingProjectSnapshotDescriptor,
} from './recording-project-snapshots.js';

type Candidate = { recording_id: string; workflow_id: string; replay_project_blob_key: string };

const snapshotCleanupReason = 'workflow-recording-snapshot-retention';
const automaticBatchLimit = 100;
const automaticBatchTimeMs = 5000;

const replayCanBeReplaced = `NOT EXISTS (
  SELECT 1 FROM workflow_run_evidence e WHERE e.run_id=r.recording_id
    AND (e.availability<>'available' OR e.upload_until>NOW())
)`;

function isBrokenArtifact(error: unknown): boolean {
  return error instanceof ManagedArtifactIntegrityError || isMissingManagedWorkflowObject(error);
}

/**
 * The recording row and outbox commit together. Shared artifacts are immutable.
 */
export async function compactRecordingProjectSnapshots(
  context: Pick<ManagedWorkflowContext, 'pool' | 'blobStore' | 'withTransaction' | 'maintenance'>,
  {
    limit,
    after,
    workflowId,
    signal,
    lease,
  }: {
    limit: number;
    after?: string;
    workflowId?: string;
    signal: AbortSignal;
    lease?: ManagedWorkflowMaintenanceLease;
  },
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Use a batch size from 1 to 1000.');
  const { pool, blobStore, withTransaction, maintenance } = context;
  const putArtifact = blobStore.putArtifact?.bind(blobStore);
  if (!putArtifact) throw new Error('Recording compaction requires immutable object storage writes.');
  const compact = async ({ recording_id: id, workflow_id: workflowId, replay_project_blob_key: oldKey }: Candidate) => {
    if (!canShareRecordingProjectSnapshot(workflowId) || !isManagedWorkflowArtifactObjectKey(oldKey)) return;
    const expectedKey = createRecordingBlobKey(workflowId, id, 'replay-project');
    if (oldKey !== expectedKey && !oldKey.startsWith(expectedKey + '.artifact-v1.')) return;

    const contents = await blobStore.getText(oldKey, { signal }).catch((error) => {
      signal.throwIfAborted();
      if (isBrokenArtifact(error)) return undefined;
      throw error;
    });
    if (contents === undefined) return;
    let snapshot: string;
    const oldBytes = parseManagedArtifactDescriptor(oldKey)?.storedBytes ?? Buffer.byteLength(contents);
    try {
      const original = deserializeProject(contents, null, { logErrors: false });
      const [project, attachedData] = original;
      snapshot = serializeSharedReplayProject(
        { ...project, metadata: { ...project.metadata, id: workflowId as typeof project.metadata.id } },
        attachedData,
      );
      if (Buffer.byteLength(snapshot) > MAX_MANAGED_ARTIFACT_BYTES) return;
      // Use the actual replay reader and ignore only its intentional identity
      // binding. A legacy format that cannot round trip keeps its old file.
      const replay = deserializeProject(bindSharedReplayProjectId(snapshot, workflowId, project.metadata.id), null, {
        logErrors: false,
      });
      if (!isDeepStrictEqual(original, replay)) return;
    } catch {
      return;
    }

    const digest = createHash('sha256').update(snapshot).digest('hex');
    const hit = (
      await pool.query<{ object_key: string; state: string }>(
        'SELECT object_key,state FROM workflow_recording_project_snapshots WHERE workflow_id=$1 AND digest=$2',
        [workflowId, digest],
      )
    ).rows[0];
    if (hit && hit.state !== 'verified') return;
    let fresh: Awaited<ReturnType<typeof prepareManagedTextArtifact>> | undefined;
    let key: string;
    if (hit) {
      key = hit.object_key;
      readRecordingProjectSnapshotDescriptor(key, workflowId);
    } else {
      fresh = await prepareManagedTextArtifact(createRecordingProjectSnapshotKey(workflowId), snapshot, true);
      // A single replacement must also save space or break even. Later copies
      // of the same snapshot reuse this generation.
      if (fresh.descriptor.storedBytes > oldBytes) return;
      key = fresh.descriptor.key;
    }
    try {
      signal.throwIfAborted();
      if (fresh) {
        // Record cleanup before uploading. The delay exceeds the command's maximum
        // batch time and gives an interrupted PUT time to settle.
        await pool.query(
          `INSERT INTO managed_object_deletion_outbox (object_key,domain,next_attempt_at)
           VALUES ($1,$2,clock_timestamp()+INTERVAL '5 minutes')`,
          [key, snapshotCleanupReason],
        );
        signal.throwIfAborted();
        await putArtifact(fresh.descriptor, fresh.bytes, undefined, { signal });
      }
      // Before retiring the original, prove that the replacement is readable.
      if ((await blobStore.getText(key, { signal })) !== snapshot)
        throw new ManagedArtifactIntegrityError('Replay snapshot differs.');
    } catch (error) {
      if (!fresh) await noteRecordingProjectSnapshotReadFailure(pool, key, error);
      signal.throwIfAborted();
      if (isBrokenArtifact(error)) return;
      throw error;
    }

    const changed = await withTransaction(async (client) => {
      await lease?.assertCurrent(client);
      if (fresh) {
        // Lock the unclaimed cleanup entry through publication. Once cleanup can
        // claim it, this generation cannot become a replay pointer.
        const upload = await client.query(
          `SELECT 1 FROM managed_object_deletion_outbox
           WHERE object_key=$1 AND domain=$2 AND status='pending'
             AND claim_holder_id IS NULL AND attempt_count=0 AND next_attempt_at>clock_timestamp()
           FOR UPDATE`,
          [key, snapshotCleanupReason],
        );
        if (!upload.rowCount) return false;
        const saved = await client.query(
          `INSERT INTO workflow_recording_project_snapshots (workflow_id,digest,object_key,state)
           VALUES ($1,$2,$3,'verified') ON CONFLICT (workflow_id,digest) DO NOTHING`,
          [workflowId, digest, key],
        );
        if (!saved.rowCount) return false;
      } else {
        const selected = await client.query(
          `SELECT 1 FROM workflow_recording_project_snapshots
           WHERE workflow_id=$1 AND digest=$2 AND object_key=$3 AND state='verified' FOR SHARE`,
          [workflowId, digest, key],
        );
        if (!selected.rowCount) return false;
      }

      signal.throwIfAborted();
      const updated = await client.query(
        `UPDATE workflow_recordings r SET replay_project_blob_key=$4
         WHERE r.recording_id=$1 AND r.workflow_id=$2 AND r.replay_project_blob_key=$3
           AND ${replayCanBeReplaced}`,
        [id, workflowId, oldKey, key],
      );
      if (!updated.rowCount) {
        if (fresh) await client.query('DELETE FROM workflow_recording_project_snapshots WHERE object_key=$1', [key]);
        return false;
      }
      if (fresh) await client.query('DELETE FROM managed_object_deletion_outbox WHERE object_key=$1', [key]);
      await maintenance.enqueueObjectDeletions(client, 'workflow-recording-retention', [oldKey]);
      signal.throwIfAborted();
      return true;
    });
    if (changed) return { oldBytes, newBytes: fresh?.descriptor.storedBytes ?? 0 };
  };

  signal.throwIfAborted();
  const page = await pool.query<Candidate>(
    `SELECT r.recording_id,r.workflow_id,r.replay_project_blob_key FROM workflow_recordings r
     WHERE r.recording_id>$1 AND split_part(r.replay_project_blob_key,'/',2)='recordings'
       AND ($3::text IS NULL OR r.workflow_id=$3) AND ${replayCanBeReplaced}
     ORDER BY r.recording_id LIMIT $2`,
    [after ?? '', limit + 1, workflowId ?? null],
  );
  const result = { scanned: 0, compacted: 0, bytesQueuedForDeletion: 0, newSnapshotBytes: 0 };
  let cursor = after ?? null;
  for (const row of page.rows.slice(0, limit)) {
    if (signal.aborted) break;
    const saved = await compact(row).catch((error) => {
      if (signal.aborted && error === signal.reason) return undefined;
      throw error;
    });
    if (saved) {
      result.compacted++;
      result.bytesQueuedForDeletion += saved.oldBytes;
      result.newSnapshotBytes += saved.newBytes;
    }
    if (signal.aborted && !saved) break;
    result.scanned++;
    cursor = row.recording_id;
  }
  return {
    ...result,
    interrupted: signal.aborted,
    nextAfter: signal.aborted || page.rows.length > limit ? cursor : null,
  };
}

/** Run only on the periodic maintenance owner. Once at the end, give held or
 * newly imported recordings time to settle before scanning again. */
export function createRecordingProjectCompactionTask(
  context: Pick<ManagedWorkflowContext, 'pool' | 'blobStore' | 'withTransaction' | 'maintenance'>,
) {
  return async (lease: ManagedWorkflowMaintenanceLease): Promise<void> => {
    const checkpoint = (
      await context.pool.query<{ next_after: string | null; due: boolean }>(
        `SELECT next_after,resume_at<=clock_timestamp() AS due
         FROM workflow_recording_project_compaction WHERE singleton=TRUE`,
      )
    ).rows[0];
    if (checkpoint && !checkpoint.due) return;

    const result = await compactRecordingProjectSnapshots(context, {
      after: checkpoint?.next_after ?? undefined,
      limit: Math.min(context.maintenance.config.batchSize, automaticBatchLimit),
      signal: AbortSignal.timeout(automaticBatchTimeMs),
      lease,
    });
    if (result.interrupted && result.scanned === 0) return;
    await context.withTransaction(async (client) => {
      await lease.assertCurrent(client);
      await client.query(
        `INSERT INTO workflow_recording_project_compaction (singleton,next_after,resume_at)
         VALUES (TRUE,$1,clock_timestamp()+CASE WHEN $1::text IS NULL THEN INTERVAL '1 day' ELSE INTERVAL '0' END)
         ON CONFLICT (singleton) DO UPDATE SET next_after=EXCLUDED.next_after,resume_at=EXCLUDED.resume_at`,
        [result.nextAfter],
      );
    });
  };
}
