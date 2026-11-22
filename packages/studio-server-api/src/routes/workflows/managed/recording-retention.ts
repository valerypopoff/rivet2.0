import {
  getLLMProfileHealthHeldRecordingIds,
  normalizeStoredLLMProfileHealthEntry,
  type StoredLLMProfileHealthEntry,
} from '../../../llm-profile-health/state.js';
import { getWorkflowRecordingConfig, type WorkflowRecordingConfig } from '../recordings-config.js';
import { getManagedRecordingInputCacheKey, workflowRecordingInputCache } from '../recording-input-cache.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowMaintenanceTask } from './maintenance.js';
import type { RecordingRow } from './types.js';

type ManagedHealthEntryRow = {
  entry_json: StoredLLMProfileHealthEntry | string | null;
};

function getManagedLLMProfileHealthHeldRecordingIds(rows: readonly ManagedHealthEntryRow[]): readonly string[] {
  const heldRecordingIds = new Set<string>();
  for (const row of rows) {
    if (row.entry_json == null) continue;
    const parsed =
      typeof row.entry_json === 'string' ? (JSON.parse(row.entry_json) as StoredLLMProfileHealthEntry) : row.entry_json;
    for (const recordingId of getLLMProfileHealthHeldRecordingIds(normalizeStoredLLMProfileHealthEntry(parsed))) {
      heldRecordingIds.add(recordingId);
    }
  }
  return [...heldRecordingIds];
}
type ManagedRecordingRetentionConfig = Pick<
  WorkflowRecordingConfig,
  'retentionDays' | 'maxRunsPerEndpoint' | 'maxTotalBytes'
>;

const DAY_MS = 24 * 60 * 60 * 1000;
function getEndpointRetentionKey(row: RecordingRow): string {
  return `${row.workflow_id}\0${row.endpoint_name_at_execution.trim().toLowerCase()}`;
}

function getCompressedBundleSize(row: RecordingRow): number {
  return row.recording_compressed_bytes + row.project_compressed_bytes + row.dataset_compressed_bytes;
}

function getCreatedAtMs(row: RecordingRow): number {
  const timestamp = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function selectManagedRecordingRowsForCleanup(
  rows: RecordingRow[],
  config: ManagedRecordingRetentionConfig,
  now = Date.now(),
  heldRecordingIds: ReadonlySet<string> = new Set(),
): RecordingRow[] {
  const oldestRows = rows
    .filter((row) => !heldRecordingIds.has(row.recording_id))
    .sort((left, right) => {
      const createdAtDifference = getCreatedAtMs(left) - getCreatedAtMs(right);
      return createdAtDifference || left.recording_id.localeCompare(right.recording_id);
    });
  const rowsToDelete = new Map<string, RecordingRow>();

  if (config.retentionDays > 0) {
    const cutoff = now - config.retentionDays * DAY_MS;
    for (const row of oldestRows) {
      if (getCreatedAtMs(row) < cutoff) {
        rowsToDelete.set(row.recording_id, row);
      }
    }
  }

  if (config.maxRunsPerEndpoint > 0) {
    const rowsByEndpoint = new Map<string, RecordingRow[]>();
    for (const row of oldestRows) {
      if (rowsToDelete.has(row.recording_id)) {
        continue;
      }

      const endpointKey = getEndpointRetentionKey(row);
      const endpointRows = rowsByEndpoint.get(endpointKey) ?? [];
      endpointRows.push(row);
      rowsByEndpoint.set(endpointKey, endpointRows);
    }

    for (const endpointRows of rowsByEndpoint.values()) {
      const excessCount = endpointRows.length - config.maxRunsPerEndpoint;
      for (const row of endpointRows.slice(0, Math.max(0, excessCount))) {
        rowsToDelete.set(row.recording_id, row);
      }
    }
  }

  if (config.maxTotalBytes > 0) {
    let retainedBytes = oldestRows.reduce((total, row) => total + getCompressedBundleSize(row), 0);
    for (const row of rowsToDelete.values()) {
      retainedBytes -= getCompressedBundleSize(row);
    }

    for (const row of oldestRows) {
      if (retainedBytes <= config.maxTotalBytes) {
        break;
      }
      if (rowsToDelete.has(row.recording_id)) {
        continue;
      }

      rowsToDelete.set(row.recording_id, row);
      retainedBytes -= getCompressedBundleSize(row);
    }
  }

  return [...rowsToDelete.values()];
}

export function createManagedRecordingRetentionTask(options: {
  context: ManagedWorkflowContext;
  getRecordingConfig?: () => WorkflowRecordingConfig;
}): ManagedWorkflowMaintenanceTask {
  const deps = {
    withTransaction: options.context.withTransaction,
    queryRows: options.context.db.queryRows,
    maintenance: options.context.maintenance,
    blobStore: options.context.blobStore,
    recordingColumns: options.context.mappers.RECORDING_COLUMNS,
  };
  return async (lease) => {
    const config = options.getRecordingConfig?.() ?? getWorkflowRecordingConfig();
    if (config.retentionDays <= 0 && config.maxRunsPerEndpoint <= 0 && config.maxTotalBytes <= 0) {
      return;
    }

    // Keep retention selection in PostgreSQL. Loading a long-lived endpoint's
    // full recording history into the control-plane process would defeat the
    // batch limit and can outlive its fencing lease. The window functions use
    // the same precedence as selectManagedRecordingRowsForCleanup(): discard
    // age-expired rows first, then apply per-endpoint and total-byte limits to
    // the remaining history.
    const retentionParameters: number[] = [Math.max(0, config.retentionDays)];
    const retentionConditions = ['age_expired'];
    let endpointRetentionSql: string;
    if (config.maxRunsPerEndpoint > 0) {
      retentionParameters.push(config.maxRunsPerEndpoint);
      const endpointLimitParameter = retentionParameters.length;
      retentionConditions.push('endpoint_excess');
      endpointRetentionSql = `
        endpoint_ranked AS (
          SELECT classified.*,
                 COUNT(*) FILTER (WHERE NOT age_expired) OVER (
                   PARTITION BY workflow_id, LOWER(BTRIM(endpoint_name_at_execution))
                   ORDER BY created_at DESC, recording_id DESC
                 ) AS retained_endpoint_rank
          FROM classified
        ), endpoint_classified AS (
          SELECT endpoint_ranked.*,
                 (NOT age_expired AND retained_endpoint_rank > $${endpointLimitParameter}) AS endpoint_excess
          FROM endpoint_ranked
        )`;
    } else {
      endpointRetentionSql = `
        endpoint_classified AS (
          SELECT classified.*, false AS endpoint_excess
          FROM classified
        )`;
    }

    let totalBytesRetentionSql: string;
    if (config.maxTotalBytes > 0) {
      retentionParameters.push(config.maxTotalBytes);
      const totalBytesLimitParameter = retentionParameters.length;
      retentionConditions.push(
        `(NOT age_expired AND NOT endpoint_excess AND retained_newer_bytes > $${totalBytesLimitParameter})`,
      );
      totalBytesRetentionSql = `
        ranked AS (
          SELECT endpoint_classified.*,
                 SUM(
                   recording_compressed_bytes + project_compressed_bytes + dataset_compressed_bytes
                 ) FILTER (WHERE NOT age_expired AND NOT endpoint_excess) OVER (
                   ORDER BY created_at DESC, recording_id DESC
                 ) AS retained_newer_bytes
          FROM endpoint_classified
        )`;
    } else {
      totalBytesRetentionSql = `
        ranked AS (
          SELECT endpoint_classified.*
          FROM endpoint_classified
        )`;
    }
    await deps.withTransaction(async (client) => {
      // The fence is held before candidate selection. The row lock prevents a
      // successor from taking the lease while this bounded selection and its
      // metadata/outbox mutation commit together.
      await lease.assertCurrent(client);
      // A corruption/read failure intentionally aborts this cleanup pass rather
      // than risking deletion of the replay evidence for an active suspension.
      const healthRows = await deps.queryRows<ManagedHealthEntryRow>(
        client,
        'SELECT entry_json FROM llm_profile_health WHERE entry_json IS NOT NULL',
      );
      const heldRecordingIds = [...getManagedLLMProfileHealthHeldRecordingIds(healthRows)];
      const queryParameters: Array<number | string[]> = [
        ...retentionParameters,
        heldRecordingIds,
        deps.maintenance.config.batchSize,
      ];
      const heldRecordingIdsParameter = retentionParameters.length + 1;
      const batchSizeParameter = queryParameters.length;
      const rowsToDelete = await deps.queryRows<RecordingRow>(
        client,
        `
          WITH eligible_recordings AS (
            SELECT *
            FROM workflow_recordings
            WHERE recording_id <> ALL($${heldRecordingIdsParameter}::text[])
          ), classified AS (
            SELECT ${deps.recordingColumns},
                   CASE
                     WHEN $1::int > 0
                       THEN created_at < NOW() - ($1::bigint * INTERVAL '1 day')
                     ELSE false
                   END AS age_expired
            FROM eligible_recordings
          ), ${endpointRetentionSql}, ${totalBytesRetentionSql}
          SELECT ${deps.recordingColumns}
          FROM ranked
          WHERE ${retentionConditions.join('\n             OR ')}
          ORDER BY created_at ASC, recording_id ASC
          LIMIT $${batchSizeParameter}
        `,
        queryParameters,
      );
      if (rowsToDelete.length === 0) {
        return;
      }

      const deletedRows = await deps.queryRows<RecordingRow>(
        client,
        `
          DELETE FROM workflow_recordings
          WHERE recording_id = ANY($1::text[])
          RETURNING ${deps.recordingColumns}
        `,
        [rowsToDelete.map((row) => row.recording_id)],
      );
      if (deletedRows.length > 0) {
        await deps.maintenance.enqueueObjectDeletions(
          client,
          'workflow-recording-retention',
          deletedRows.flatMap((row) => [
            row.recording_blob_key,
            row.replay_project_blob_key,
            row.replay_dataset_blob_key,
          ]),
        );
        for (const row of deletedRows) {
          workflowRecordingInputCache.invalidate(
            getManagedRecordingInputCacheKey(deps.blobStore, row.recording_blob_key),
          );
        }
      }
    });
  };
}
