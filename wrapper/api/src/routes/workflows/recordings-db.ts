import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getAppDataRoot } from '../../security.js';
import type {
  WorkflowRecordingBlobEncoding,
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingFilterStatus,
  WorkflowRecordingRunKind,
  WorkflowRecordingStatus,
  WorkflowRunStatisticsTarget,
} from '../../../../shared/workflow-recording-types.js';

export type WorkflowRecordingWorkflowRow = {
  workflowId: string;
  sourceProjectMetadataId: string;
  sourceProjectPath: string;
  sourceProjectRelativePath: string;
  sourceProjectName: string;
  updatedAt: string;
};

export type WorkflowRecordingRunRow = {
  id: string;
  workflowId: string;
  createdAt: string;
  runKind: WorkflowRecordingRunKind;
  status: WorkflowRecordingStatus;
  durationMs: number;
  endpointNameAtExecution: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  errorMessage?: string;
  bundlePath: string;
  encoding: WorkflowRecordingBlobEncoding;
  hasReplayDataset: boolean;
  recordingCompressedBytes: number;
  recordingUncompressedBytes: number;
  projectCompressedBytes: number;
  projectUncompressedBytes: number;
  datasetCompressedBytes: number;
  datasetUncompressedBytes: number;
};

export type WorkflowRecordingWorkflowStatsRow = WorkflowRecordingWorkflowRow & {
  latestRunAt?: string;
  totalRuns: number;
  failedRuns: number;
  suspiciousRuns: number;
};

export type WorkflowRecordingStatisticsRow = WorkflowRecordingRunRow & {
  sourceProjectName: string;
};

const RECORDING_RUN_COLUMNS = `
  id AS id,
  workflow_id AS workflowId,
  created_at AS createdAt,
  run_kind AS runKind,
  status AS status,
  duration_ms AS durationMs,
  endpoint_name_at_execution AS endpointNameAtExecution,
  execution_surface AS executionSurface,
  graph_id_at_execution AS graphIdAtExecution,
  graph_name_at_execution AS graphNameAtExecution,
  revision_key_at_execution AS revisionKeyAtExecution,
  ui_graph_id_at_execution AS uiGraphIdAtExecution,
  ui_graph_name_at_execution AS uiGraphNameAtExecution,
  web_app_slug_at_execution AS webAppSlugAtExecution,
  component_id_at_execution AS componentIdAtExecution,
  component_type_at_execution AS componentTypeAtExecution,
  component_label_at_execution AS componentLabelAtExecution,
  error_message AS errorMessage,
  bundle_path AS bundlePath,
  encoding AS encoding,
  has_replay_dataset AS hasReplayDataset,
  recording_compressed_bytes AS recordingCompressedBytes,
  recording_uncompressed_bytes AS recordingUncompressedBytes,
  project_compressed_bytes AS projectCompressedBytes,
  project_uncompressed_bytes AS projectUncompressedBytes,
  dataset_compressed_bytes AS datasetCompressedBytes,
  dataset_uncompressed_bytes AS datasetUncompressedBytes
`;

const UPSERT_RECORDING_WORKFLOW_SQL = `
  INSERT INTO recording_workflows (
    workflow_id,
    source_project_metadata_id,
    source_project_path,
    source_project_relative_path,
    source_project_name,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(workflow_id) DO UPDATE SET
    source_project_metadata_id = excluded.source_project_metadata_id,
    source_project_path = excluded.source_project_path,
    source_project_relative_path = excluded.source_project_relative_path,
    source_project_name = excluded.source_project_name,
    updated_at = excluded.updated_at
`;

const UPSERT_RECORDING_RUN_SQL = `
  INSERT INTO recording_runs (
    id,
    workflow_id,
    created_at,
    run_kind,
    status,
    duration_ms,
    endpoint_name_at_execution,
    execution_surface,
    graph_id_at_execution,
    graph_name_at_execution,
    revision_key_at_execution,
    ui_graph_id_at_execution,
    ui_graph_name_at_execution,
    web_app_slug_at_execution,
    component_id_at_execution,
    component_type_at_execution,
    component_label_at_execution,
    error_message,
    bundle_path,
    encoding,
    has_replay_dataset,
    recording_compressed_bytes,
    recording_uncompressed_bytes,
    project_compressed_bytes,
    project_uncompressed_bytes,
    dataset_compressed_bytes,
    dataset_uncompressed_bytes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    workflow_id = excluded.workflow_id,
    created_at = excluded.created_at,
    run_kind = excluded.run_kind,
    status = excluded.status,
    duration_ms = excluded.duration_ms,
    endpoint_name_at_execution = excluded.endpoint_name_at_execution,
    execution_surface = excluded.execution_surface,
    graph_id_at_execution = excluded.graph_id_at_execution,
    graph_name_at_execution = excluded.graph_name_at_execution,
    revision_key_at_execution = excluded.revision_key_at_execution,
    ui_graph_id_at_execution = excluded.ui_graph_id_at_execution,
    ui_graph_name_at_execution = excluded.ui_graph_name_at_execution,
    web_app_slug_at_execution = excluded.web_app_slug_at_execution,
    component_id_at_execution = excluded.component_id_at_execution,
    component_type_at_execution = excluded.component_type_at_execution,
    component_label_at_execution = excluded.component_label_at_execution,
    error_message = excluded.error_message,
    bundle_path = excluded.bundle_path,
    encoding = excluded.encoding,
    has_replay_dataset = excluded.has_replay_dataset,
    recording_compressed_bytes = excluded.recording_compressed_bytes,
    recording_uncompressed_bytes = excluded.recording_uncompressed_bytes,
    project_compressed_bytes = excluded.project_compressed_bytes,
    project_uncompressed_bytes = excluded.project_uncompressed_bytes,
    dataset_compressed_bytes = excluded.dataset_compressed_bytes,
    dataset_uncompressed_bytes = excluded.dataset_uncompressed_bytes
`;

type RecordingStatement = ReturnType<DatabaseSync['prepare']>;

function writeWorkflowRecordingWorkflow(
  statement: RecordingStatement,
  row: WorkflowRecordingWorkflowRow,
): void {
  statement.run(
    row.workflowId,
    row.sourceProjectMetadataId,
    row.sourceProjectPath,
    row.sourceProjectRelativePath,
    row.sourceProjectName,
    row.updatedAt,
  );
}

function writeWorkflowRecordingRun(statement: RecordingStatement, row: WorkflowRecordingRunRow): void {
  const identity = row.executionIdentity;
  statement.run(
    row.id,
    row.workflowId,
    row.createdAt,
    row.runKind,
    row.status,
    row.durationMs,
    row.endpointNameAtExecution,
    identity?.surface ?? null,
    identity?.graphId ?? null,
    identity?.graphName ?? null,
    identity?.revisionKey ?? null,
    identity?.uiGraphId ?? null,
    identity?.uiGraphName ?? null,
    identity?.webAppSlug ?? null,
    identity?.componentId ?? null,
    identity?.componentType ?? null,
    identity?.componentLabel ?? null,
    row.errorMessage ?? null,
    row.bundlePath,
    row.encoding,
    row.hasReplayDataset ? 1 : 0,
    row.recordingCompressedBytes,
    row.recordingUncompressedBytes,
    row.projectCompressedBytes,
    row.projectUncompressedBytes,
    row.datasetCompressedBytes,
    row.datasetUncompressedBytes,
  );
}

let databasePromise: Promise<DatabaseSync> | null = null;
let recordingIndexRevision = 0;

export function getWorkflowRecordingIndexRevision(): number {
  return recordingIndexRevision;
}

function markWorkflowRecordingIndexChanged(): void {
  recordingIndexRevision += 1;
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function getDatabasePath(): string {
  return path.join(getAppDataRoot(), 'recordings.sqlite');
}

async function openDatabase(): Promise<DatabaseSync> {
  await fs.mkdir(path.dirname(getDatabasePath()), { recursive: true });

  let db: DatabaseSync | null = null;

  try {
    db = new DatabaseSync(getDatabasePath());
    db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    -- The index is rebuildable from recording bundles. DELETE journaling avoids
    -- WAL shared-memory files, which are unreliable on some Docker volumes/PVCs.
    PRAGMA journal_mode = DELETE;

    CREATE TABLE IF NOT EXISTS recording_workflows (
      workflow_id TEXT PRIMARY KEY,
      source_project_metadata_id TEXT NOT NULL,
      source_project_path TEXT NOT NULL,
      source_project_relative_path TEXT NOT NULL,
      source_project_name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recording_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES recording_workflows(workflow_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      endpoint_name_at_execution TEXT NOT NULL,
      execution_surface TEXT,
      graph_id_at_execution TEXT,
      graph_name_at_execution TEXT,
      revision_key_at_execution TEXT,
      ui_graph_id_at_execution TEXT,
      ui_graph_name_at_execution TEXT,
      web_app_slug_at_execution TEXT,
      component_id_at_execution TEXT,
      component_type_at_execution TEXT,
      component_label_at_execution TEXT,
      error_message TEXT,
      bundle_path TEXT NOT NULL,
      encoding TEXT NOT NULL,
      has_replay_dataset INTEGER NOT NULL,
      recording_compressed_bytes INTEGER NOT NULL,
      recording_uncompressed_bytes INTEGER NOT NULL,
      project_compressed_bytes INTEGER NOT NULL,
      project_uncompressed_bytes INTEGER NOT NULL,
      dataset_compressed_bytes INTEGER NOT NULL,
      dataset_uncompressed_bytes INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recording_runs_workflow_created_at
      ON recording_runs(workflow_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recording_runs_status_created_at
      ON recording_runs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recording_runs_created_at
      ON recording_runs(created_at DESC);
    CREATE TABLE IF NOT EXISTS recording_storage_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `);
    ensureRecordingRunIdentityColumns(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recording_runs_statistics_target
        ON recording_runs(
          execution_surface,
          workflow_id,
          ui_graph_id_at_execution,
          component_id_at_execution,
          run_kind,
          created_at DESC
        );
    `);

    return db;
  } catch (error) {
    db?.close();
    throw error;
  }
}

function ensureRecordingRunIdentityColumns(db: DatabaseSync): void {
  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(recording_runs)').all<{ name: string }>().map((row) => row.name),
  );
  const columns = [
    ['execution_surface', 'TEXT'],
    ['graph_id_at_execution', 'TEXT'],
    ['graph_name_at_execution', 'TEXT'],
    ['revision_key_at_execution', 'TEXT'],
    ['ui_graph_id_at_execution', 'TEXT'],
    ['ui_graph_name_at_execution', 'TEXT'],
    ['web_app_slug_at_execution', 'TEXT'],
    ['component_id_at_execution', 'TEXT'],
    ['component_type_at_execution', 'TEXT'],
    ['component_label_at_execution', 'TEXT'],
  ] as const;

  for (const [name, type] of columns) {
    if (!existingColumns.has(name)) {
      db.exec(`ALTER TABLE recording_runs ADD COLUMN ${name} ${type}`);
    }
  }
}

async function getDatabase(): Promise<DatabaseSync> {
  databasePromise ??= openDatabase();
  return databasePromise;
}

export async function getWorkflowRecordingStorageState(key: string): Promise<string | null> {
  const db = await getDatabase();
  const row = db.prepare('SELECT value AS value FROM recording_storage_state WHERE key = ?').get<{ value: string }>(key);
  return row?.value ?? null;
}

export async function setWorkflowRecordingStorageState(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  db.prepare(`
    INSERT INTO recording_storage_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export async function clearWorkflowRecordingIndex(): Promise<void> {
  const db = await getDatabase();
  db.exec(`
    DELETE FROM recording_runs;
    DELETE FROM recording_workflows;
  `);
  markWorkflowRecordingIndexChanged();
}

export async function upsertWorkflowRecordingWorkflow(row: WorkflowRecordingWorkflowRow): Promise<void> {
  const db = await getDatabase();
  writeWorkflowRecordingWorkflow(db.prepare(UPSERT_RECORDING_WORKFLOW_SQL), row);
  markWorkflowRecordingIndexChanged();
}

export async function upsertWorkflowRecordingRun(row: WorkflowRecordingRunRow): Promise<void> {
  const db = await getDatabase();
  writeWorkflowRecordingRun(db.prepare(UPSERT_RECORDING_RUN_SQL), row);
  markWorkflowRecordingIndexChanged();
}

export async function upsertWorkflowRecordingBundle(
  workflow: WorkflowRecordingWorkflowRow,
  run: WorkflowRecordingRunRow,
): Promise<void> {
  const db = await getDatabase();
  const workflowStatement = db.prepare(UPSERT_RECORDING_WORKFLOW_SQL);
  const runStatement = db.prepare(UPSERT_RECORDING_RUN_SQL);

  db.exec('BEGIN IMMEDIATE');
  try {
    writeWorkflowRecordingWorkflow(workflowStatement, workflow);
    writeWorkflowRecordingRun(runStatement, run);
    db.exec('COMMIT');
    markWorkflowRecordingIndexChanged();
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original bundle-index failure.
    }
    throw error;
  }
}

export async function replaceWorkflowRecordingIndex(
  workflows: readonly WorkflowRecordingWorkflowRow[],
  runs: readonly WorkflowRecordingRunRow[],
  options: { expectedRevision?: number } = {},
): Promise<boolean> {
  const db = await getDatabase();
  if (options.expectedRevision != null && options.expectedRevision !== recordingIndexRevision) {
    return false;
  }

  const workflowStatement = db.prepare(UPSERT_RECORDING_WORKFLOW_SQL);
  const runStatement = db.prepare(UPSERT_RECORDING_RUN_SQL);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM recording_runs; DELETE FROM recording_workflows;');
    for (const workflow of workflows) {
      writeWorkflowRecordingWorkflow(workflowStatement, workflow);
    }
    for (const run of runs) {
      writeWorkflowRecordingRun(runStatement, run);
    }
    db.exec('COMMIT');
    markWorkflowRecordingIndexChanged();
    return true;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original replacement failure.
    }
    throw error;
  }
}

export async function listWorkflowRecordingWorkflowStatsRows(): Promise<WorkflowRecordingWorkflowStatsRow[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT
      w.workflow_id AS workflowId,
      w.source_project_metadata_id AS sourceProjectMetadataId,
      w.source_project_path AS sourceProjectPath,
      w.source_project_relative_path AS sourceProjectRelativePath,
      w.source_project_name AS sourceProjectName,
      w.updated_at AS updatedAt,
      MAX(r.created_at) AS latestRunAt,
      COUNT(r.id) AS totalRuns,
      COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failedRuns,
      COALESCE(SUM(CASE WHEN r.status = 'suspicious' THEN 1 ELSE 0 END), 0) AS suspiciousRuns
    FROM recording_workflows w
    LEFT JOIN recording_runs r ON r.workflow_id = w.workflow_id
    GROUP BY
      w.workflow_id,
      w.source_project_metadata_id,
      w.source_project_path,
      w.source_project_relative_path,
      w.source_project_name,
      w.updated_at
    ORDER BY latestRunAt DESC, w.source_project_name ASC
  `).all<Record<string, unknown>>();

  return rows.map((row) => ({
    workflowId: String(row.workflowId ?? ''),
    sourceProjectMetadataId: String(row.sourceProjectMetadataId ?? ''),
    sourceProjectPath: String(row.sourceProjectPath ?? ''),
    sourceProjectRelativePath: String(row.sourceProjectRelativePath ?? ''),
    sourceProjectName: String(row.sourceProjectName ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    latestRunAt: toOptionalString(row.latestRunAt),
    totalRuns: toNumber(row.totalRuns),
    failedRuns: toNumber(row.failedRuns),
    suspiciousRuns: toNumber(row.suspiciousRuns),
  }));
}

export async function listWorkflowRecordingRunRowsByWorkflowId(
  workflowId: string,
  options: { page: number; pageSize: number; statusFilter: WorkflowRecordingFilterStatus },
): Promise<WorkflowRecordingRunRow[]> {
  const db = await getDatabase();
  const whereClause = buildRunFilterClause(options.statusFilter);
  const rows = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all<Record<string, unknown>>(workflowId, options.pageSize, (options.page - 1) * options.pageSize);

  return rows.map(normalizeWorkflowRecordingRunRow);
}

export async function countWorkflowRecordingRuns(
  workflowId: string,
  statusFilter: WorkflowRecordingFilterStatus,
): Promise<number> {
  const db = await getDatabase();
  const whereClause = buildRunFilterClause(statusFilter);
  const row = db.prepare(`SELECT COUNT(id) AS count FROM recording_runs ${whereClause}`)
    .get<{ count: number | bigint }>(workflowId);

  return toNumber(row?.count ?? 0);
}

export async function getWorkflowRecordingRunRow(recordingId: string): Promise<WorkflowRecordingRunRow | null> {
  const db = await getDatabase();
  const row = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    WHERE id = ?
  `).get<Record<string, unknown>>(recordingId);

  return row ? normalizeWorkflowRecordingRunRow(row) : null;
}

export async function listWorkflowRecordingRunRowsForWorkflow(workflowId: string): Promise<WorkflowRecordingRunRow[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    WHERE workflow_id = ?
    ORDER BY created_at DESC, id DESC
  `).all<Record<string, unknown>>(workflowId);

  return rows.map(normalizeWorkflowRecordingRunRow);
}

export async function listWorkflowRecordingRunsOlderThan(createdBefore: string): Promise<WorkflowRecordingRunRow[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    WHERE created_at < ?
    ORDER BY created_at ASC, id ASC
  `).all<Record<string, unknown>>(createdBefore);

  return rows.map(normalizeWorkflowRecordingRunRow);
}

export async function listWorkflowRecordingRunsOldestFirst(): Promise<WorkflowRecordingRunRow[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    ORDER BY created_at ASC, id ASC
  `).all<Record<string, unknown>>();

  return rows.map(normalizeWorkflowRecordingRunRow);
}

export async function listWorkflowRecordingStatisticsRows(
  from: string,
  to: string,
  target?: WorkflowRunStatisticsTarget,
): Promise<WorkflowRecordingStatisticsRow[]> {
  const db = await getDatabase();
  const { clause, parameters } = buildStatisticsTargetClause(target);
  const rows = db.prepare(`
    SELECT
      ${RECORDING_RUN_COLUMNS}
    FROM recording_runs
    WHERE created_at >= ? AND created_at < ?
    ${clause}
    ORDER BY created_at ASC, id ASC
  `).all<Record<string, unknown>>(from, to, ...parameters);
  const workflowNames = new Map(
    (await listWorkflowRecordingWorkflowStatsRows()).map((workflow) => [workflow.workflowId, workflow.sourceProjectName]),
  );

  return rows.map((row) => {
    const run = normalizeWorkflowRecordingRunRow(row);
    return { ...run, sourceProjectName: workflowNames.get(run.workflowId) ?? run.workflowId };
  });
}

export async function listWorkflowRecordingStatisticsCatalogRows(): Promise<WorkflowRecordingStatisticsRow[]> {
  const runs = await listWorkflowRecordingRunsOldestFirst();
  const workflowNames = new Map(
    (await listWorkflowRecordingWorkflowStatsRows()).map((workflow) => [workflow.workflowId, workflow.sourceProjectName]),
  );

  return runs.map((run) => ({
    ...run,
    sourceProjectName: workflowNames.get(run.workflowId) ?? run.workflowId,
  }));
}

export async function listWorkflowRecordingBundlePaths(): Promise<string[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT bundle_path AS bundlePath
    FROM recording_runs
    ORDER BY bundle_path ASC
  `).all<{ bundlePath: string }>();

  return rows.map((row) => String(row.bundlePath ?? ''));
}

export async function getWorkflowRecordingWorkflowRowsBySourceProjectPath(
  sourceProjectPath: string,
  sourceProjectRelativePath: string,
): Promise<WorkflowRecordingWorkflowRow[]> {
  const db = await getDatabase();
  const rows = db.prepare(`
    SELECT
      workflow_id AS workflowId,
      source_project_metadata_id AS sourceProjectMetadataId,
      source_project_path AS sourceProjectPath,
      source_project_relative_path AS sourceProjectRelativePath,
      source_project_name AS sourceProjectName,
      updated_at AS updatedAt
    FROM recording_workflows
    WHERE source_project_path = ? OR source_project_relative_path = ?
  `).all<Record<string, unknown>>(sourceProjectPath, sourceProjectRelativePath);

  return rows.map((row) => ({
    workflowId: String(row.workflowId ?? ''),
    sourceProjectMetadataId: String(row.sourceProjectMetadataId ?? ''),
    sourceProjectPath: String(row.sourceProjectPath ?? ''),
    sourceProjectRelativePath: String(row.sourceProjectRelativePath ?? ''),
    sourceProjectName: String(row.sourceProjectName ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
  }));
}

export async function deleteWorkflowRecordingRunRow(recordingId: string): Promise<void> {
  const db = await getDatabase();
  db.prepare('DELETE FROM recording_runs WHERE id = ?').run(recordingId);
  markWorkflowRecordingIndexChanged();
}

export async function deleteWorkflowRecordingWorkflowRow(workflowId: string): Promise<void> {
  const db = await getDatabase();
  db.prepare('DELETE FROM recording_workflows WHERE workflow_id = ?').run(workflowId);
  markWorkflowRecordingIndexChanged();
}

export async function deleteEmptyWorkflowRecordingWorkflows(): Promise<void> {
  const db = await getDatabase();
  db.prepare(`
    DELETE FROM recording_workflows
    WHERE workflow_id NOT IN (SELECT DISTINCT workflow_id FROM recording_runs)
  `).run();
  markWorkflowRecordingIndexChanged();
}

export async function getWorkflowRecordingTotalCompressedBytes(): Promise<number> {
  const db = await getDatabase();
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      recording_compressed_bytes +
      project_compressed_bytes +
      dataset_compressed_bytes
    ), 0) AS total
    FROM recording_runs
  `).get<{ total: number | bigint }>();

  return toNumber(row?.total ?? 0);
}

export async function resetWorkflowRecordingDatabaseForTests(): Promise<void> {
  if (!databasePromise) {
    recordingIndexRevision = 0;
    return;
  }

  const db = await databasePromise;
  db.close();
  databasePromise = null;
  recordingIndexRevision = 0;
}

function normalizeWorkflowRecordingRunRow(row: Record<string, unknown>): WorkflowRecordingRunRow {
  let status: WorkflowRecordingStatus = 'succeeded';
  if (row.status === 'failed') {
    status = 'failed';
  } else if (row.status === 'suspicious') {
    status = 'suspicious';
  }

  return {
    id: String(row.id ?? ''),
    workflowId: String(row.workflowId ?? ''),
    createdAt: String(row.createdAt ?? ''),
    runKind: row.runKind === 'published' ? 'published' : 'latest',
    status,
    durationMs: toNumber(row.durationMs),
    endpointNameAtExecution: String(row.endpointNameAtExecution ?? ''),
    executionIdentity: getExecutionIdentity(row),
    errorMessage: toOptionalString(row.errorMessage),
    bundlePath: String(row.bundlePath ?? ''),
    encoding: row.encoding === 'identity' ? 'identity' : 'gzip',
    hasReplayDataset: toNumber(row.hasReplayDataset) > 0,
    recordingCompressedBytes: toNumber(row.recordingCompressedBytes),
    recordingUncompressedBytes: toNumber(row.recordingUncompressedBytes),
    projectCompressedBytes: toNumber(row.projectCompressedBytes),
    projectUncompressedBytes: toNumber(row.projectUncompressedBytes),
    datasetCompressedBytes: toNumber(row.datasetCompressedBytes),
    datasetUncompressedBytes: toNumber(row.datasetUncompressedBytes),
  };
}

function getExecutionIdentity(row: Record<string, unknown>): WorkflowRecordingExecutionIdentity | undefined {
  const surface = row.executionSurface;
  if (surface !== 'workflow_endpoint' && surface !== 'web_app_action') {
    return undefined;
  }

  const componentType = row.componentTypeAtExecution;
  return {
    surface,
    graphId: toOptionalString(row.graphIdAtExecution),
    graphName: toOptionalString(row.graphNameAtExecution),
    revisionKey: toOptionalString(row.revisionKeyAtExecution),
    uiGraphId: toOptionalString(row.uiGraphIdAtExecution),
    uiGraphName: toOptionalString(row.uiGraphNameAtExecution),
    webAppSlug: toOptionalString(row.webAppSlugAtExecution),
    componentId: toOptionalString(row.componentIdAtExecution),
    componentType: componentType === 'button' || componentType === 'chat' ? componentType : undefined,
    componentLabel: toOptionalString(row.componentLabelAtExecution),
  };
}

function buildRunFilterClause(statusFilter: WorkflowRecordingFilterStatus): string {
  return statusFilter === 'failed'
    ? `WHERE workflow_id = ? AND status IN ('failed', 'suspicious')`
    : 'WHERE workflow_id = ?';
}

function buildStatisticsTargetClause(target: WorkflowRunStatisticsTarget | undefined): {
  clause: string;
  parameters: string[];
} {
  if (!target) {
    return { clause: '', parameters: [] };
  }

  if (target.surface === 'endpoint') {
    return {
      clause: `AND workflow_id = ?
        AND (execution_surface = 'workflow_endpoint'
          OR (execution_surface IS NULL AND endpoint_name_at_execution NOT LIKE '/%'))`,
      parameters: [target.workflowId],
    };
  }

  if ('legacyEndpointName' in target) {
    return {
      clause: `AND workflow_id = ?
        AND (
          execution_surface IS NULL
          OR (
            execution_surface = 'web_app_action'
            AND (ui_graph_id_at_execution IS NULL OR component_id_at_execution IS NULL)
          )
        )
        AND endpoint_name_at_execution = ?`,
      parameters: [target.workflowId, target.legacyEndpointName],
    };
  }

  return {
    clause: `AND workflow_id = ?
      AND execution_surface = 'web_app_action'
      AND ui_graph_id_at_execution = ?
      AND component_id_at_execution = ?`,
    parameters: [target.workflowId, target.uiGraphId, target.componentId],
  };
}
