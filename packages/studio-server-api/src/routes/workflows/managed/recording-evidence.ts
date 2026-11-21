import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig, QueryResultRow } from 'pg';
import { serializeDatasets, serializeProject } from '@valerypopoff/rivet2-node';
import { serializeSharedReplayProject } from '@valerypopoff/rivet2-core/serialization';
import type {
  RunEvidenceHandle,
  RunEvidenceInput,
  RunEvidenceOutcome,
  RunEvidenceRepository,
  RunEvidenceSummary,
  RecordingUnavailableReason,
} from '@valerypopoff/rivet-studio-server-shared/workflow-run-evidence.js';
import type { ManagedWorkflowContext } from './context.js';
import type { PersistWorkflowExecutionRecordingOptions } from '../data-backend.js';
import type { RecordingInsertRowData } from './types.js';
import {
  ManagedArtifactIntegrityError,
  MAX_MANAGED_ARTIFACT_BYTES,
  prepareManagedTextArtifact,
  decodeManagedArtifactBytes,
  verifyManagedArtifactBytes,
  type ManagedArtifactDescriptor,
} from './artifact-descriptor.js';
import {
  createRecordingBlobKey,
  createRecordingProjectSnapshotKey,
  isRecordingProjectSnapshotKey,
  isMissingManagedWorkflowObject,
} from './blob-store.js';
import {
  confirmRecordingProjectSnapshot,
  noteRecordingProjectSnapshotReadFailure,
  canShareRecordingProjectSnapshot,
  readRecordingProjectSnapshotDescriptor,
} from './recording-project-snapshots.js';
import { getWorkflowRecordingRuntimeConfig, readWorkflowRecordingLimitSettings } from '../recordings-config.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresRivetLLMProfileHealthStore } from '../../../llm-profile-health/managed-store.js';
import { reportRecordingFailure } from '../recording-diagnostics.js';
import { recordStudioMetrics } from '../../../metrics.js';

export const EVIDENCE_LEASE_MS = 180_000;
export const EVIDENCE_UPLOAD_MS = 60 * 60_000;
export const EVIDENCE_RETRY_MS = 24 * 60 * 60_000;
const MAX_PENDING_BYTES = 1024 * 1024 * 1024;
const MAX_ACTIVE_BYTES = 256 * 1024 * 1024;
const MAX_ATTEMPTS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class RecordingIntegrityError extends Error {}
export function retryableRecordingStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = value.$metadata?.httpStatusCode;
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(String(value.code)) ||
    ['AbortError', 'TimeoutError'].includes(String(value.name))
  );
}

export function recordingDurabilityEnabled(): boolean {
  const value = process.env.RIVET_RECORDING_DURABILITY_ENABLED?.trim();
  if (!value || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('RIVET_RECORDING_DURABILITY_ENABLED must be true or false.');
}

type Manifest = {
  artifacts: ManagedArtifactDescriptor[];
  row: RecordingInsertRowData;
  compression: boolean;
  gzipLevel: number;
  replayProjectDigest?: string;
};
type PreparedArtifact = Awaited<ReturnType<typeof prepareManagedTextArtifact>>;
type ReplayProjectSelection = Awaited<ReturnType<typeof selectRecordingProjectSnapshot>>;
type StagedRecording = { manifest: Manifest; projectUpload?: PreparedArtifact; available: boolean };
export type EvidenceRow = QueryResultRow & {
  has_sub_runs?: boolean;
  run_id: string;
  workflow_id: string;
  token: string;
  created_at: Date | string;
  lease_until: Date | string;
  upload_until: Date | string;
  updated_at: Date | string;
  state: RunEvidenceSummary['state'];
  availability: RunEvidenceSummary['availability'];
  reason: RecordingUnavailableReason | null;
  input_json: RunEvidenceInput;
  outcome_json: RunEvidenceOutcome | null;
  child_coverage: RunEvidenceSummary['childCoverage'];
  manifest_json: Manifest | null;
  fingerprint: string | null;
  attempts: number;
  handoff_ready: boolean;
  notified: boolean;
};
export function evidenceSummary(row: EvidenceRow): RunEvidenceSummary {
  return {
    ...row.input_json,
    id: row.run_id,
    createdAt: new Date(row.created_at).toISOString(),
    state:
      ['accepted', 'running'].includes(row.state) && Date.parse(String(row.lease_until)) < Date.now()
        ? 'unknown'
        : row.state,
    availability: row.availability,
    reason: row.reason ?? undefined,
    durationMs: row.outcome_json?.durationMs,
    cost: row.outcome_json?.cost,
    childCoverage: row.child_coverage,
    handoffReady: row.handoff_ready && (row.availability === 'pending' || row.availability === 'available'),
  };
}
type SnapshotSelectionRow = { object_key: string; state: 'pending' | 'verified' | 'unusable' };

/** Bind only while the caller holds the transaction that will pin the manifest. */
async function selectRecordingProjectSnapshot(
  client: PoolClient,
  workflowId: string,
  digest: string,
  prepared?: PreparedArtifact,
  boundKey?: string,
  alreadyAvailable = false,
): Promise<
  | {
      descriptor: PreparedArtifact['descriptor'];
      upload?: PreparedArtifact;
    }
  | 'prepare'
  | 'dedicated'
> {
  const lookup = async () =>
    (
      await client.query<SnapshotSelectionRow>(
        `SELECT object_key,state FROM workflow_recording_project_snapshots
       WHERE workflow_id=$1 AND digest=$2 FOR KEY SHARE ${boundKey ? '' : 'NOWAIT'}`,
        [workflowId, digest],
      )
    ).rows[0];
  let row = await lookup();
  if (boundKey && row?.object_key !== boundKey) throw conflict('Recording project snapshot differs from its manifest.');
  if (!row && prepared) {
    row =
      (
        await client.query<SnapshotSelectionRow>(
          `INSERT INTO workflow_recording_project_snapshots (workflow_id,digest,object_key,state)
       VALUES ($1,$2,$3,'pending') ON CONFLICT (workflow_id,digest) DO NOTHING RETURNING object_key,state`,
          [workflowId, digest, prepared.descriptor.key],
        )
      ).rows[0] ?? (await lookup());
  }
  if (!row) return prepared ? 'dedicated' : 'prepare';
  const descriptor = readRecordingProjectSnapshotDescriptor(row.object_key, workflowId);
  if (row.state === 'verified' || alreadyAvailable) return { descriptor };
  if (row.state === 'pending') {
    if (!prepared) return 'prepare';
    const local = prepared.descriptor;
    if (
      descriptor.hash === local.hash &&
      descriptor.encoding === local.encoding &&
      descriptor.storedBytes === local.storedBytes &&
      descriptor.decodedBytes === local.decodedBytes
    )
      return { descriptor, upload: { descriptor, bytes: prepared.bytes } };
  }
  if (boundKey) throw conflict('Recording project snapshot could not be verified.');
  return 'dedicated';
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');
}
export function validEvidenceHandle(handle: RunEvidenceHandle): boolean {
  return UUID.test(handle.id) && UUID.test(handle.token);
}

/** Metadata and replay publication only. This class never invokes a processor. */
export class ManagedRecordingEvidence implements RunEvidenceRepository {
  #active = new Map<string, RunEvidenceHandle>();
  #timer?: ReturnType<typeof setInterval>;
  #heartbeatWork?: Promise<unknown>;
  #activeBytes = 0;
  #safetyCheck?: Promise<void>;
  constructor(readonly context: ManagedWorkflowContext) {}

  canShareReplayProject(workflowId: string): boolean {
    return canShareRecordingProjectSnapshot(workflowId);
  }

  async #query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    await this.context.initialize();
    return this.context.pool.query<T>({ text, values, query_timeout: 15_000 } as QueryConfig & {
      query_timeout: number;
    });
  }
  async #get(handle: RunEvidenceHandle, client?: PoolClient): Promise<EvidenceRow> {
    if (!validEvidenceHandle(handle)) throw conflict('Invalid run evidence handle.');
    const sql = 'SELECT * FROM workflow_run_evidence WHERE run_id=$1 AND token=$2';
    const result = client
      ? await client.query<EvidenceRow>(sql + ' FOR UPDATE', [handle.id, handle.token])
      : await this.#query<EvidenceRow>(sql, [handle.id, handle.token]);
    if (!result.rows[0]) throw conflict('Run evidence is unavailable or belongs to another attempt.');
    return result.rows[0];
  }
  async begin(input: RunEvidenceInput, requested?: RunEvidenceHandle): Promise<RunEvidenceHandle> {
    this.#safetyCheck ??= this.#query<{ safe: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgname='workflow_recording_evidence_deleted' AND tgrelid='workflow_recordings'::regclass
      AND tgenabled IN ('O','A') AND NOT tgisinternal) AS safe`,
    )
      .then((result) => {
        if (!result.rows[0]?.safe) throw new Error('Recording durability deletion protection is not installed.');
      })
      .catch((error) => {
        this.#safetyCheck = undefined;
        throw error;
      });
    await this.#safetyCheck;
    const handle = requested ?? { id: randomUUID(), token: randomUUID() };
    if (!validEvidenceHandle(handle)) throw conflict('Invalid run evidence handle.');
    const previous =
      requested && !input.createdAt
        ? (
            await this.#query<EvidenceRow>('SELECT * FROM workflow_run_evidence WHERE run_id=$1 AND token=$2', [
              handle.id,
              handle.token,
            ])
          ).rows[0]
        : undefined;
    const createdAt = input.createdAt ?? previous?.input_json.createdAt ?? new Date().toISOString();
    const normalized = { ...input, createdAt };
    if (
      !input.projectId ||
      Buffer.byteLength(JSON.stringify(normalized)) > 24 * 1024 ||
      !Number.isFinite(Date.parse(createdAt))
    )
      throw conflict('Invalid run evidence metadata.');
    if (
      !previous &&
      ((!input.rootId && Date.parse(createdAt) < Date.now() - EVIDENCE_UPLOAD_MS) ||
        Date.parse(createdAt) > Date.now() + 300_000)
    )
      throw conflict('The recording registration timestamp is outside its acceptance window.');
    try {
      const inserted = await this.#query(
        `INSERT INTO workflow_run_evidence
        (run_id,workflow_id,token,created_at,lease_until,upload_until,state,availability,input_json)
        VALUES ($1,$2,$3,$4,NOW()+($5::bigint*INTERVAL '1 millisecond'),
          NOW()+($6::bigint*INTERVAL '1 millisecond'),'accepted','pending',$7::jsonb)
        ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
        [
          handle.id,
          input.projectId,
          handle.token,
          createdAt,
          EVIDENCE_LEASE_MS,
          EVIDENCE_UPLOAD_MS,
          JSON.stringify(normalized),
        ],
      );
      if (inserted.rowCount === 1) return handle;
    } catch {
      // Registration is idempotent and never executes anything. Confirm an uncertain INSERT.
      const row = await this.#get(handle);
      if (fingerprint(row.input_json) !== fingerprint(normalized) || row.availability === 'deleted')
        throw conflict('Run evidence metadata differs or has been deleted.');
      return handle;
    }
    const row = await this.#get(handle);
    if (fingerprint(row.input_json) !== fingerprint(normalized) || row.availability === 'deleted')
      throw conflict('Run evidence metadata differs or has been deleted.');
    return handle;
  }
  /** Only actual server/executor owners use this. Browser clients heartbeat explicitly. */
  track(handle: RunEvidenceHandle): void {
    this.#active.set(handle.id, handle);
    this.#timer ??= setInterval(() => {
      if (this.#heartbeatWork || !this.#active.size) return;
      const active = [...this.#active.values()];
      this.#heartbeatWork = this.#query(
        `UPDATE workflow_run_evidence e SET state='running',
        lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),upload_until=NOW()+INTERVAL '1 hour'
        FROM UNNEST($1::text[],$2::text[]) live(id,token)
        WHERE e.run_id=live.id AND e.token=live.token AND e.state IN ('accepted','running','unknown')
          AND e.availability<>'deleted' AND e.upload_until>NOW()`,
        [active.map((h) => h.id), active.map((h) => h.token), EVIDENCE_LEASE_MS],
      )
        .catch((error) => reportRecordingFailure(error, { phase: 'persistence' }))
        .finally(() => {
          this.#heartbeatWork = undefined;
        });
    }, 30_000);
    this.#timer.unref();
  }
  release(handle: RunEvidenceHandle): void {
    this.#active.delete(handle.id);
    if (!this.#active.size) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
  async dispose(): Promise<void> {
    clearInterval(this.#timer);
    this.#active.clear();
    await this.#heartbeatWork;
  }
  async heartbeat(handle: RunEvidenceHandle): Promise<void> {
    await this.#query(
      `UPDATE workflow_run_evidence SET state=CASE WHEN state IN ('accepted','unknown') THEN 'running' ELSE state END,
      lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),upload_until=NOW()+INTERVAL '1 hour' WHERE run_id=$1 AND token=$2
      AND state IN ('accepted','running','unknown') AND availability<>'deleted' AND upload_until>NOW()`,
      [handle.id, handle.token, EVIDENCE_LEASE_MS],
    );
  }
  async outcome(handle: RunEvidenceHandle, outcome: RunEvidenceOutcome, incompleteChildren = false): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(outcome)) > 4096) throw conflict('Run outcome is too large.');
    await this.#query(
      `UPDATE workflow_run_evidence SET state=$3,outcome_json=$4::jsonb,updated_at=NOW(),upload_until=NOW()+INTERVAL '1 hour',
      child_coverage=CASE WHEN $5 OR child_coverage='incomplete' THEN 'incomplete' WHEN $3='unknown' THEN 'unknown' ELSE 'complete' END
      WHERE run_id=$1 AND token=$2 AND availability<>'deleted' AND upload_until>NOW()
      AND (state IN ('accepted','running','unknown') OR state=$3)`,
      [handle.id, handle.token, outcome.state, JSON.stringify(outcome), incompleteChildren],
    );
    this.release(handle);
  }
  async unavailable(handle: RunEvidenceHandle, reason: RecordingUnavailableReason): Promise<void> {
    await this.#query(
      `UPDATE workflow_run_evidence SET availability='unavailable',reason=$3,updated_at=NOW()
      WHERE run_id=$1 AND token=$2 AND availability NOT IN ('available','deleted') AND manifest_json IS NULL`,
      [handle.id, handle.token, reason],
    );
  }
  async childIncomplete(handle: RunEvidenceHandle): Promise<void> {
    await this.#query(
      "UPDATE workflow_run_evidence SET child_coverage='incomplete' WHERE run_id=$1 AND token=$2 AND availability<>'deleted'",
      [handle.id, handle.token],
    );
  }
  async read(handle: RunEvidenceHandle): Promise<RunEvidenceSummary> {
    return evidenceSummary(await this.#get(handle));
  }
  async adoptExecutor(
    projectId: string,
    graphId: string,
    correlationId: string,
    requestId: string,
  ): Promise<RunEvidenceHandle | undefined> {
    const result = await this.#query<EvidenceRow>(
      `UPDATE workflow_run_evidence SET
      input_json=jsonb_set(input_json,'{sourceRunId}',to_jsonb($4::text))
      WHERE workflow_id=$1 AND input_json->'executionIdentity'->>'graphId'=$2
        AND input_json->'executionIdentity'->>'correlationId'=$3
        AND input_json->'executionIdentity'->>'surface'='editor_local'
        AND input_json->>'rootId' IS NULL AND availability<>'deleted' AND upload_until>NOW()
        AND (input_json->>'sourceRunId' IS NULL OR input_json->>'sourceRunId'=$4)
      RETURNING *`,
      [projectId, graphId, correlationId, 'editor-node:' + requestId],
    );
    if (result.rows.length !== 1) return undefined;
    return { id: result.rows[0]!.run_id, token: result.rows[0]!.token };
  }

  async #verify(manifest: Manifest, deadline = Date.now() + 30_000): Promise<void> {
    if (!this.context.blobStore.getBytes) throw new Error('Durable recording storage requires verified bytes.');
    for (const descriptor of manifest.artifacts) {
      if (Date.now() >= deadline) throw new Error('Recording verification deadline exceeded.');
      if (this.#activeBytes + descriptor.storedBytes > MAX_ACTIVE_BYTES)
        throw new Error('Recording verification capacity exhausted.');
      this.#activeBytes += descriptor.storedBytes;
      try {
        const bytes = await this.context.blobStore.getBytes(descriptor.key, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
        });
        verifyManagedArtifactBytes(bytes, descriptor);
        if (isRecordingProjectSnapshotKey(descriptor.key))
          await confirmRecordingProjectSnapshot(this.context.pool, descriptor.key);
      } catch (error) {
        if (isRecordingProjectSnapshotKey(descriptor.key))
          await noteRecordingProjectSnapshotReadFailure(this.context.pool, descriptor.key, error);
        if (error instanceof ManagedArtifactIntegrityError)
          throw new RecordingIntegrityError('The staged recording failed verification.');
        throw error;
      } finally {
        this.#activeBytes -= descriptor.storedBytes;
      }
    }
  }
  async #finalize(handle: RunEvidenceHandle, manifest: Manifest): Promise<string> {
    try {
      await this.context.withTransaction(async (client) => {
        const current = await this.#get(handle, client);
        if (
          current.availability === 'deleted' ||
          !current.manifest_json ||
          current.fingerprint !== fingerprint(manifest)
        )
          throw conflict('Recording publication was deleted or its content differs.');
        if (current.availability === 'available') return;
        if (!['succeeded', 'failed', 'suspicious'].includes(current.state) || current.state !== manifest.row.status)
          throw createHttpError(409, 'Recording publication is awaiting its confirmed execution outcome.', {
            code: 'recording_outcome_pending',
          });
        if (manifest.replayProjectDigest) {
          const snapshot = await client.query(
            `SELECT 1 FROM workflow_recording_project_snapshots
             WHERE workflow_id=$1 AND digest=$2 AND object_key=$3 AND state='verified' FOR SHARE`,
            [current.workflow_id, manifest.replayProjectDigest, manifest.row.replayProjectBlobKey],
          );
          if (!snapshot.rows.length) throw new RecordingIntegrityError('The shared replay project is unavailable.');
        }
        await this.context.revisions.insertRecordingRow(client, manifest.row, {
          timestampMode: 'provided',
          createdAt: new Date(current.created_at).toISOString(),
          onConflict: 'fail',
          cleanupContext: 'durable recording publication',
        });
        await client.query(
          "UPDATE workflow_run_evidence SET availability='available',handoff_ready=TRUE,pending_bytes=0,updated_at=NOW() WHERE run_id=$1",
          [handle.id],
        );
      });
    } catch (error) {
      const current = await this.#get(handle);
      if (current.availability !== 'available' || current.fingerprint !== fingerprint(manifest)) throw error;
    }
    return handle.id;
  }
  async #stageManifest(
    handle: RunEvidenceHandle,
    selectProject: (client: PoolClient, current: EvidenceRow) => Promise<ReplayProjectSelection>,
    buildManifest: (descriptor: ManagedArtifactDescriptor) => Manifest,
    sharing = false,
  ): Promise<StagedRecording | 'prepare' | 'dedicated'> {
    let proposed: StagedRecording | 'prepare' | 'dedicated' | undefined;
    let sharingContended = false;
    try {
      return await this.context.withTransaction(async (client) => {
        const row = await this.#get(handle, client);
        if (row.availability === 'deleted' || Date.parse(String(row.upload_until)) <= Date.now())
          throw conflict('Recording upload window has closed.');
        let selected: ReplayProjectSelection;
        try {
          selected = await selectProject(client, row);
        } catch (error) {
          sharingContended = sharing && !row.manifest_json && (error as { code?: string })?.code === '55P03';
          throw error;
        }
        if (typeof selected === 'string') {
          proposed = selected;
          return selected;
        }
        const manifest = buildManifest(selected.descriptor);
        const hash = fingerprint(manifest);
        if (row.fingerprint && row.fingerprint !== hash) throw conflict('Recording content differs.');
        const staged = { manifest, projectUpload: selected.upload, available: row.availability === 'available' };
        if (row.manifest_json) {
          proposed = staged;
          return staged;
        }
        await client.query("SELECT pg_advisory_xact_lock(hashtext('rivet-recording-pending-bytes'))");
        const budget = await client.query<{ bytes: string }>(
          "SELECT COALESCE(SUM(pending_bytes),0)::text AS bytes FROM workflow_run_evidence WHERE availability='pending'",
        );
        const bytes = manifest.artifacts.reduce((n, descriptor) => n + descriptor.storedBytes, 0);
        if (Number(budget.rows[0]?.bytes) + bytes > MAX_PENDING_BYTES)
          throw createHttpError(503, 'Pending recording capacity is exhausted.');
        proposed = staged;
        await client.query(
          `UPDATE workflow_run_evidence SET availability='pending',reason=NULL,manifest_json=$3::jsonb,
           fingerprint=$4,pending_bytes=$5,updated_at=NOW() WHERE run_id=$1 AND token=$2`,
          [handle.id, handle.token, JSON.stringify(manifest), hash, bytes],
        );
        return staged;
      });
    } catch (error) {
      // Selection failed before a manifest was proposed. A timed-out
      // optimization may use the same durable, per-recording format.
      if (sharingContended) return 'dedicated';
      if (!proposed) throw error;
      if (typeof proposed === 'string') return proposed;
      const confirmed = await this.#get(handle);
      if (
        confirmed.fingerprint !== fingerprint(proposed.manifest) ||
        !confirmed.manifest_json ||
        confirmed.availability === 'deleted'
      )
        throw error;
      return { ...proposed, available: confirmed.availability === 'available' };
    }
  }

  async persist(options: PersistWorkflowExecutionRecordingOptions, handle: RunEvidenceHandle): Promise<string> {
    const current = await this.#get(handle);
    const workflowId = current.workflow_id;
    if (workflowId !== options.sourceProject.metadata.id) throw conflict('Recording project differs from its run.');
    if (
      current.input_json.runKind !== options.runKind ||
      (['surface', 'graphId', 'correlationId'] as const).some(
        (key) => current.input_json.executionIdentity?.[key] !== options.executionIdentity?.[key],
      )
    )
      throw conflict('Recording invocation differs from its accepted run.');
    if (['succeeded', 'failed', 'suspicious'].includes(current.state) && current.state !== options.status)
      throw conflict('Recording outcome differs from its execution owner.');
    if (current.availability === 'deleted' || Date.parse(String(current.upload_until)) <= Date.now())
      throw conflict('Recording upload window has closed.');

    const policy = getWorkflowRecordingRuntimeConfig();
    const compression = current.manifest_json?.compression ?? policy.compression === 'gzip';
    const gzipLevel = current.manifest_json?.gzipLevel ?? policy.gzipLevel;
    const prepare = (key: string, value: string | Buffer) =>
      prepareManagedTextArtifact(key, value, compression, gzipLevel);
    const prepareDedicatedProject = (text: string) =>
      prepare(createRecordingBlobKey(workflowId, handle.id, 'replay-project'), text);
    const dedicatedProjectText = () =>
      serializeProject(
        {
          ...options.executedProject,
          metadata: {
            ...options.executedProject.metadata,
            id: handle.id as typeof options.executedProject.metadata.id,
          },
        },
        options.executedAttachedData,
      ) as string;
    const boundShared = current.manifest_json?.replayProjectDigest;
    let snapshot =
      boundShared || (!current.manifest_json && this.canShareReplayProject(workflowId))
        ? Buffer.from(
            serializeSharedReplayProject(
              {
                ...options.executedProject,
                metadata: { ...options.executedProject.metadata, id: options.sourceProject.metadata.id },
              },
              options.executedAttachedData,
            ),
          )
        : undefined;
    if (snapshot && !boundShared && snapshot.byteLength > MAX_MANAGED_ARTIFACT_BYTES) snapshot = undefined;
    const projectText = snapshot ? undefined : dedicatedProjectText();
    const datasetText = options.executedDatasets.length ? serializeDatasets(options.executedDatasets) : null;
    const projectBytes = snapshot?.byteLength ?? Buffer.byteLength(projectText!);
    let estimate = 0;
    const reserveBytes = (amount: number) => {
      if (this.#activeBytes + amount > MAX_ACTIVE_BYTES)
        throw createHttpError(503, 'Recording upload capacity is temporarily exhausted.');
      this.#activeBytes += amount;
      estimate += amount;
    };
    try {
      try {
        reserveBytes(
          projectBytes + Buffer.byteLength(options.recordingSerialized) + Buffer.byteLength(datasetText ?? ''),
        );
      } catch (error) {
        await this.unavailable(handle, 'capacity');
        throw error;
      }
      const preparations = [
        this.#prepareTrace(
          current,
          options.recordingSerialized,
          policy.managedTraceEncoding ?? policy.compression,
          gzipLevel,
        ),
        datasetText === null
          ? null
          : prepare(createRecordingBlobKey(workflowId, handle.id, 'replay-dataset'), datasetText),
        projectText === undefined ? undefined : prepareDedicatedProject(projectText),
      ] as const;
      const [recording, dataset, dedicated] = await Promise.all(preparations).catch(async (error: unknown) => {
        // Native compression keeps its input alive until its callback settles.
        // Keep ownership of sibling work even when another preparation fails.
        await Promise.allSettled(preparations);
        throw error;
      });
      const buildManifest = (project: ManagedArtifactDescriptor, replayProjectDigest?: string): Manifest => ({
        compression,
        gzipLevel,
        ...(replayProjectDigest ? { replayProjectDigest } : {}),
        artifacts: dataset ? [recording.descriptor, project, dataset.descriptor] : [recording.descriptor, project],
        row: {
          recordingId: handle.id,
          workflowId,
          sourceProjectName: current.input_json.sourceProjectName,
          sourceProjectRelativePath: current.input_json.sourceProjectRelativePath,
          runKind: options.runKind,
          status: options.status,
          durationMs: Math.max(0, Math.round(options.durationMs)),
          cost: options.cost,
          endpointNameAtExecution: options.endpointName,
          executionIdentity: options.executionIdentity,
          // Full node/provider diagnostics belong in the private replay payload.
          errorMessage: options.errorMessage ? 'Execution reported an error. Inspect its recording for details.' : null,
          recordingBlobKey: recording.descriptor.key,
          replayProjectBlobKey: project.key,
          replayDatasetBlobKey: dataset?.descriptor.key ?? null,
          hasReplayDataset: !!dataset,
          recordingCompressedBytes: recording.descriptor.storedBytes,
          recordingUncompressedBytes: recording.descriptor.decodedBytes,
          projectCompressedBytes: project.storedBytes,
          projectUncompressedBytes: project.decodedBytes,
          datasetCompressedBytes: dataset?.descriptor.storedBytes ?? 0,
          datasetUncompressedBytes: dataset?.descriptor.decodedBytes ?? 0,
        },
      });

      let staged: StagedRecording | 'prepare' | 'dedicated' = 'dedicated';
      if (snapshot) {
        const digest = createHash('sha256').update(snapshot).digest('hex');
        const trySharing = (prepared?: PreparedArtifact) =>
          this.#stageManifest(
            handle,
            async (client, row) => {
              const manifest = row.manifest_json;
              if (manifest && !manifest.replayProjectDigest) return 'dedicated';
              if (manifest && manifest.replayProjectDigest !== digest)
                throw conflict('Recording project snapshot differs from its manifest.');
              return selectRecordingProjectSnapshot(
                client,
                workflowId,
                digest,
                prepared,
                manifest?.row.replayProjectBlobKey,
                row.availability === 'available',
              );
            },
            (descriptor) => buildManifest(descriptor, digest),
            true,
          );
        staged = await trySharing();
        if (staged === 'prepare')
          staged = await trySharing(await prepare(createRecordingProjectSnapshotKey(workflowId), snapshot));
        snapshot = undefined;
      }
      if (staged === 'dedicated') {
        let projectUpload = dedicated;
        if (!projectUpload) {
          const text = dedicatedProjectText();
          reserveBytes(Math.max(0, Buffer.byteLength(text) - projectBytes));
          projectUpload = await prepareDedicatedProject(text);
        }
        staged = await this.#stageManifest(
          handle,
          async () => ({ descriptor: projectUpload.descriptor, upload: projectUpload }),
          buildManifest,
        );
      }
      if (typeof staged === 'string') throw new Error('Recording project snapshot could not be prepared.');
      if (staged.available) return handle.id;
      const { manifest, projectUpload } = staged;
      const artifacts = [recording, projectUpload, dataset];
      if (!this.context.blobStore.putArtifact) throw new Error('Durable recording storage requires immutable writes.');
      const uploadDeadline = Date.now() + 300_000,
        uploadSignal = AbortSignal.timeout(300_000);
      for (let attempt = 0; attempt < 3; attempt++) {
        uploadSignal.throwIfAborted();
        const uploads = await Promise.allSettled(
          artifacts.flatMap((artifact) =>
            artifact
              ? [
                  (async () => {
                    const key = artifact.descriptor.key;
                    const shared = isRecordingProjectSnapshotKey(key);
                    try {
                      await this.context.blobStore.putArtifact!(artifact.descriptor, artifact.bytes, undefined, {
                        signal: uploadSignal,
                      });
                      if (shared) await confirmRecordingProjectSnapshot(this.context.pool, key);
                    } catch (error) {
                      if (shared) await noteRecordingProjectSnapshotReadFailure(this.context.pool, key, error);
                      throw error;
                    }
                  })(),
                ]
              : [],
          ),
        );
        const failed = uploads.find((r) => r.status === 'rejected');
        if (!failed) break;
        try {
          await this.#verify(manifest, uploadDeadline);
          break;
        } catch {
          if (attempt === 2 || !retryableRecordingStorageError(failed.reason)) throw failed.reason;
        }
        await delay(100 * 2 ** attempt + Math.floor(Math.random() * 50));
      }
      await this.#query(
        "UPDATE workflow_run_evidence SET handoff_ready=TRUE WHERE run_id=$1 AND token=$2 AND availability='pending'",
        [handle.id, handle.token],
      );
      const id = await this.#finalize(handle, manifest);
      // Keep the recovery queue for stranded work, rather than adding every
      // healthy recording to a five-minute notification backlog.
      await this.#notifyAvailable(current).catch(() => undefined);
      return id;
    } finally {
      this.#activeBytes -= estimate;
    }
  }

  async #prepareTrace(
    current: EvidenceRow,
    text: string,
    encoding: ManagedArtifactDescriptor['encoding'],
    gzipLevel: number,
  ): Promise<PreparedArtifact> {
    const manifest = current.manifest_json;
    const bound = manifest?.artifacts.find((item) => item.key === manifest.row.recordingBlobKey);
    if (!bound) {
      if (manifest) throw new RecordingIntegrityError('The recording manifest has no trace artifact.');
      return prepareManagedTextArtifact(
        createRecordingBlobKey(current.workflow_id, current.run_id, 'recording'),
        text,
        encoding,
        gzipLevel,
      );
    }
    if (Buffer.byteLength(text) !== bound.decodedBytes) throw conflict('Recording content differs from its manifest.');
    if (!this.context.blobStore.getBytes) throw new Error('Durable recording storage requires verified bytes.');
    try {
      const bytes = await this.context.blobStore.getBytes(bound.key);
      const decoded = await decodeManagedArtifactBytes(bytes, bound);
      if (!Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).equals(Buffer.from(text)))
        throw conflict('Recording content differs from its manifest.');
      return { descriptor: bound, bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } catch (error) {
      if (!isMissingManagedWorkflowObject(error)) throw error;
    }
    // Only a missing upload may be reproduced. Never replace the manifest with
    // a different compressor result after a process or configuration change.
    const rebuilt = await prepareManagedTextArtifact(
      createRecordingBlobKey(current.workflow_id, current.run_id, 'recording'),
      text,
      bound.encoding,
      gzipLevel,
    );
    verifyManagedArtifactBytes(rebuilt.bytes, bound);
    return { ...rebuilt, descriptor: bound };
  }

  async recover(): Promise<void> {
    const passDeadline = Date.now() + 20_000;
    // Metadata expiry never proves execution failure and never schedules execution.
    await this.#query(`UPDATE workflow_run_evidence SET state='unknown',
      child_coverage=CASE WHEN child_coverage='incomplete' THEN 'incomplete' ELSE 'unknown' END
      WHERE run_id IN (SELECT run_id FROM workflow_run_evidence WHERE state IN ('accepted','running')
        AND lease_until<NOW() ORDER BY lease_until LIMIT 1000)`);
    const rows = await this.#query<EvidenceRow>(`SELECT * FROM workflow_run_evidence
      WHERE ((availability='pending' AND manifest_json IS NOT NULL) OR (availability='available' AND NOT notified)) AND next_attempt_at<=NOW()
      ORDER BY CASE WHEN availability='pending' THEN 0 ELSE 1 END,next_attempt_at,run_id LIMIT 10`);
    for (const row of rows.rows) {
      if (Date.now() >= passDeadline) break;
      const handle = { id: row.run_id, token: row.token };
      try {
        if (row.availability !== 'available') {
          await this.#verify(row.manifest_json!, passDeadline);
          await this.#finalize(handle, row.manifest_json!);
        }
        await this.#notifyAvailable(row);
      } catch (error) {
        if (row.availability === 'available') {
          await this.#query(
            `UPDATE workflow_run_evidence SET attempts=attempts+1,
            next_attempt_at=NOW()+($2::bigint*INTERVAL '1 millisecond') WHERE run_id=$1 AND availability='available'`,
            [row.run_id, Math.min(60_000 * 2 ** Math.min(row.attempts, 6), 3600_000)],
          );
          continue;
        }
        const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
        const permanent =
          error instanceof RecordingIntegrityError ||
          (typeof status === 'number' && status >= 400 && status < 500 && ![404, 408, 429].includes(status));
        const expired =
          permanent ||
          Date.now() - Date.parse(String(row.updated_at)) > EVIDENCE_RETRY_MS ||
          row.attempts + 1 >= MAX_ATTEMPTS;
        await this.#query(
          `UPDATE workflow_run_evidence SET attempts=attempts+1,
          next_attempt_at=NOW()+($2::bigint*INTERVAL '1 millisecond'),
          availability=CASE WHEN $3 THEN 'unavailable' ELSE availability END,
          reason=CASE WHEN $3 THEN 'upload_incomplete' ELSE reason END
          WHERE run_id=$1 AND availability='pending'`,
          [row.run_id, Math.min(60_000 * 2 ** row.attempts, 3600_000), expired],
        );
        if (expired) await this.#closeArtifacts(row.run_id, permanent ? 'persistence_failed' : 'upload_incomplete');
      }
    }
    await this.#query(`UPDATE workflow_run_evidence SET availability='unavailable',reason='capture_incomplete'
      WHERE run_id IN (SELECT run_id FROM workflow_run_evidence WHERE availability='pending'
        AND manifest_json IS NULL AND upload_until<NOW() ORDER BY upload_until LIMIT 1000)`);
    // Replay retention remains authoritative; available metadata can be rebuilt from its row.
    await this.#query(`DELETE FROM workflow_run_evidence WHERE run_id IN (SELECT run_id FROM workflow_run_evidence
      WHERE availability IN ('available','deleted') AND upload_until<NOW()-INTERVAL '2 days'
      AND updated_at<NOW()-INTERVAL '2 days' ORDER BY upload_until LIMIT 1000)`);
    const limits = readWorkflowRecordingLimitSettings();
    if (limits.retentionDays > 0)
      await this.#query(
        `DELETE FROM workflow_run_evidence WHERE run_id IN (SELECT run_id FROM workflow_run_evidence WHERE availability='unavailable'
      AND manifest_json IS NULL AND created_at<NOW()-($1::integer*INTERVAL '1 day')
      AND upload_until<NOW()-INTERVAL '2 days' ORDER BY created_at LIMIT 1000)`,
        [limits.retentionDays],
      );
    if (limits.maxRunsPerEndpoint > 0)
      await this.#query(
        `DELETE FROM workflow_run_evidence WHERE run_id IN (
      SELECT run_id FROM (SELECT run_id,ROW_NUMBER() OVER (PARTITION BY workflow_id,input_json->>'endpointName'
        ORDER BY created_at DESC,run_id DESC) AS rank FROM workflow_run_evidence WHERE availability='unavailable'
        AND manifest_json IS NULL AND upload_until<NOW()-INTERVAL '2 days') ranked WHERE rank>$1 LIMIT 1000)`,
        [limits.maxRunsPerEndpoint],
      );
    const metrics = (
      await this.#query<{ pending: number; unavailable: number; unknown: number; bytes: string; oldest: number }>(`
      SELECT COUNT(*) FILTER(WHERE availability='pending')::int AS pending,
        COUNT(*) FILTER(WHERE availability='unavailable')::int AS unavailable,
        COUNT(*) FILTER(WHERE state='unknown' AND availability<>'deleted')::int AS unknown,
        COALESCE(SUM(pending_bytes) FILTER(WHERE availability='pending'),0)::text AS bytes,
        COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at) FILTER(WHERE availability='pending')),0)::float8 AS oldest
      FROM workflow_run_evidence`)
    ).rows[0];
    if (metrics)
      recordStudioMetrics((registry) =>
        registry.setWorkflowRecordingEvidence({
          ...metrics,
          pendingBytes: Number(metrics.bytes),
          oldestSeconds: Math.max(0, metrics.oldest),
        }),
      );
  }
  async #notifyAvailable(row: EvidenceRow): Promise<void> {
    const identity = row.input_json.executionIdentity;
    try {
      if (identity?.correlationId && identity.surface !== 'subgraph_project')
        await new PostgresRivetLLMProfileHealthStore(this.context.pool).recordRecordingOutcome({
          correlationId: identity.correlationId,
          availability: 'available',
          recordingId: row.run_id,
        });
      await this.#query("UPDATE workflow_run_evidence SET notified=TRUE WHERE run_id=$1 AND availability='available'", [
        row.run_id,
      ]);
    } catch (error) {
      reportRecordingFailure(error, { projectId: row.workflow_id, recordingId: row.run_id, phase: 'notification' });
      throw error;
    }
  }
  async #closeArtifacts(id: string, reason: RecordingUnavailableReason | 'deleted'): Promise<boolean> {
    return this.context.withTransaction(async (client) => {
      const result = await client.query<EvidenceRow>('SELECT * FROM workflow_run_evidence WHERE run_id=$1 FOR UPDATE', [
        id,
      ]);
      const row = result.rows[0];
      if (!row || row.availability === 'available') return false;
      await client.query(
        `UPDATE workflow_run_evidence SET availability=$2,reason=$3,manifest_json=NULL,
        pending_bytes=0,handoff_ready=FALSE,updated_at=NOW() WHERE run_id=$1`,
        [id, reason === 'deleted' ? 'deleted' : 'unavailable', reason === 'deleted' ? null : reason],
      );
      await this.context.maintenance.enqueueObjectDeletions(
        client,
        'workflow-recording-retention',
        row.manifest_json?.artifacts.map((d) => d.key) ?? [],
      );
      return true;
    });
  }
  async deletePending(id: string): Promise<boolean> {
    const result = await this.#query<EvidenceRow>('SELECT * FROM workflow_run_evidence WHERE run_id=$1', [id]);
    if (!result.rows[0]) return false;
    return this.#closeArtifacts(id, 'deleted');
  }
}
