import { createHash } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { MANAGED_WORKFLOW_SCHEMA_SQL } from './schema.js';

export const MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE = 'managed_workflow_schema_migrations';
export const CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION = 6;
// A serving release may verify an additive schema created by its immediate
// successor only when the chart deliberately supplies that compatibility
// window. Keep this constant explicit: raising it is the release-engineering
// declaration that the current build can safely be used as a rollback target
// for a newer schema.
export const MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION = 2;

const MANAGED_WORKFLOW_SCHEMA_LOCK = {
  classId: 8_071,
  objectId: 24_002,
} as const;

const MANAGED_APP_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY CHECK (char_length(setting_key) > 0),
  revision BIGINT NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  iv BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_id TEXT NOT NULL CHECK (char_length(key_id) = 16),
  source_hash TEXT NULL CHECK (source_hash IS NULL OR char_length(source_hash) = 64),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const MIGRATION_LOCK_TIMEOUT = '30s';

const MANAGED_MAINTENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS managed_maintenance_leases (
  lease_name TEXT PRIMARY KEY CHECK (char_length(lease_name) > 0),
  holder_id TEXT NOT NULL CHECK (char_length(holder_id) > 0),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS managed_object_deletion_outbox (
  object_key TEXT PRIMARY KEY CHECK (char_length(object_key) > 0),
  domain TEXT NOT NULL CHECK (char_length(domain) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'blocked')),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_holder_id TEXT NULL,
  claim_fencing_token BIGINT NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS managed_object_deletion_outbox_pending_idx
  ON managed_object_deletion_outbox(status, next_attempt_at, enqueued_at, object_key);
`;

const MANAGED_RECONCILIATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS managed_reconciliation_state (
  domain TEXT PRIMARY KEY CHECK (domain IN ('evaluations', 'runtime_libraries', 'workflows')),
  phase TEXT NOT NULL DEFAULT 'metadata' CHECK (phase IN ('metadata', 'objects')),
  cursor TEXT NULL,
  active_generation BIGINT NOT NULL DEFAULT 1 CHECK (active_generation > 0),
  completed_generation BIGINT NOT NULL DEFAULT 0 CHECK (completed_generation >= 0),
  scan_started_at TIMESTAMPTZ NULL,
  last_completed_at TIMESTAMPTZ NULL,
  last_error_at TIMESTAMPTZ NULL,
  last_error_code TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS managed_reconciliation_findings (
  domain TEXT NOT NULL CHECK (domain IN ('evaluations', 'runtime_libraries', 'workflows')),
  kind TEXT NOT NULL CHECK (char_length(kind) > 0),
  subject_key TEXT NOT NULL CHECK (char_length(subject_key) > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_generation BIGINT NOT NULL CHECK (last_observed_generation > 0),
  last_completed_observed_generation BIGINT NULL CHECK (last_completed_observed_generation > 0),
  consecutive_complete_scans INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_complete_scans >= 0),
  resolved_at TIMESTAMPTZ NULL,
  PRIMARY KEY (domain, kind, subject_key)
);

CREATE INDEX IF NOT EXISTS managed_reconciliation_findings_open_idx
  ON managed_reconciliation_findings(domain, resolved_at, kind, first_seen_at);
`;
const MANAGED_HOSTED_EVALUATIONS_SCHEMA_SQL = `
-- Hosted Evaluation scheduling is separate from the durable user-facing run
-- projection. The snapshot is immutable; jobs are claimed with fencing tokens
-- so an accepted graph execution is never silently replayed after worker loss.
CREATE TABLE IF NOT EXISTS evaluation_hosted_runs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'canceled', 'interrupted')),
  snapshot_json JSONB NOT NULL,
  cancel_requested_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, run_id),
  FOREIGN KEY (project_id, run_id) REFERENCES evaluation_runs(project_id, run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evaluation_hosted_runs_active_idx
  ON evaluation_hosted_runs(status, created_at, project_id, run_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS evaluation_hosted_trial_jobs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_name TEXT NOT NULL,
  case_index INTEGER NOT NULL CHECK (case_index >= 0),
  trial_index INTEGER NOT NULL CHECK (trial_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'accepted', 'settled', 'interrupted', 'canceled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  worker_id TEXT NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  accepted_at TIMESTAMPTZ NULL,
  settled_at TIMESTAMPTZ NULL,
  trial_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, run_id, job_id),
  FOREIGN KEY (project_id, run_id) REFERENCES evaluation_hosted_runs(project_id, run_id) ON DELETE CASCADE,
  UNIQUE (project_id, run_id, case_id, trial_index)
);

CREATE INDEX IF NOT EXISTS evaluation_hosted_trial_jobs_claim_idx
  ON evaluation_hosted_trial_jobs(status, case_index, trial_index, project_id, run_id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS evaluation_hosted_trial_jobs_lease_idx
  ON evaluation_hosted_trial_jobs(status, lease_expires_at, project_id, run_id)
  WHERE status IN ('claimed', 'accepted');

CREATE TABLE IF NOT EXISTS evaluation_hosted_trial_attempts (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  fencing_token BIGINT NOT NULL CHECK (fencing_token >= 0),
  worker_id TEXT NULL,
  event TEXT NOT NULL CHECK (event IN ('claimed', 'accepted', 'settled', 'interrupted', 'canceled', 'requeued')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, run_id, job_id, attempt, event),
  FOREIGN KEY (project_id, run_id, job_id)
    REFERENCES evaluation_hosted_trial_jobs(project_id, run_id, job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evaluation_hosted_trial_attempts_run_idx
  ON evaluation_hosted_trial_attempts(project_id, run_id, created_at, job_id);
`;

const MANAGED_HOSTED_EVALUATION_OUTSTANDING_INDEX_SQL = `
-- Keep the installation-wide submission quota check bounded by outstanding
-- work rather than by the complete historical Evaluation job ledger.
CREATE INDEX IF NOT EXISTS evaluation_hosted_trial_jobs_outstanding_idx
  ON evaluation_hosted_trial_jobs(status)
  WHERE status IN ('queued', 'claimed', 'accepted');
`;
const MIGRATION_STATEMENT_TIMEOUT = '5min';
const VERIFY_STATEMENT_TIMEOUT = '30s';
const TRANSIENT_SCHEMA_ERROR_CODES = new Set(['40001', '40P01', '55P03']);
const TRANSIENT_SCHEMA_RETRY_ATTEMPTS = 3;

export type ManagedWorkflowSchemaMode = 'migrate' | 'verify';

export type ManagedWorkflowSchemaCompatibilityWindow = {
  minimumVersion: number;
  maximumVersion: number;
};

type ManagedWorkflowSchemaMigration = {
  version: number;
  name: string;
  sql: string;
  checksum: string;
};

type AppliedMigrationRow = QueryResultRow & {
  version: number;
  name: string;
  checksum: string;
};

type NameRow = QueryResultRow & {
  name: string;
};

type TableRow = NameRow & {
  row_security: boolean;
  forced_row_security: boolean;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
};

type IndexRow = NameRow & {
  table_name: string;
  method: string;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  key_expressions: string[];
  key_options: number[];
  predicate: string | null;
};

type ColumnRow = QueryResultRow & {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

type ConstraintRow = QueryResultRow & {
  table_name: string;
  type: string;
  definition: string;
  is_validated: boolean;
  backing_index_valid: boolean;
  backing_index_ready: boolean;
};

type FunctionRow = QueryResultRow & {
  source_checksum: string;
  language: string;
  volatility: string;
  security_definer: boolean;
  can_execute: boolean;
  result_type: string;
};

type RegclassRow = QueryResultRow & { object_name: string | null };

export type ManagedWorkflowSchemaResult = {
  currentVersion: number;
  appliedVersions: number[];
};

export class ManagedWorkflowSchemaCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedWorkflowSchemaCompatibilityError';
  }
}

function checksumSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export const MANAGED_WORKFLOW_SCHEMA_MIGRATIONS: readonly ManagedWorkflowSchemaMigration[] = [
  {
    version: 1,
    name: 'baseline-managed-workflow-schema',
    sql: MANAGED_WORKFLOW_SCHEMA_SQL,
    checksum: '692f720796964d6ae4f25bcbfc7b1f11616fcc1012e7bcf506dec9428c9ce3b6',
  },
  {
    version: 2,
    name: 'encrypted-app-settings',
    sql: MANAGED_APP_SETTINGS_SCHEMA_SQL,
    checksum: '4b531b5c4404eef0ddef0b08ed3a85f31f88a203151a5452986565536a04fe80',
  },
  {
    version: 3,
    name: 'managed-maintenance-outbox',
    sql: MANAGED_MAINTENANCE_SCHEMA_SQL,
    checksum: 'bd4cc69a896623c0e6fb56ab47ea087d1791137348afaabc3c31399ccf56bd3e',
  },
  {
    version: 4,
    name: 'managed-reconciliation-audit',
    sql: MANAGED_RECONCILIATION_SCHEMA_SQL,
    checksum: '6c6965c2d883e38d452345ab7730cb5704bc773275db41d9e7f3de00622cd330',
  },
  {
    version: 5,
    name: 'hosted-evaluation-coordinator',
    sql: MANAGED_HOSTED_EVALUATIONS_SCHEMA_SQL,
    checksum: '77cc68364a05ba7afadaa0634ea1945353d120dd3d338cd5c9ef09111f756bbf',
  },
  {
    version: 6,
    name: 'hosted-evaluation-outstanding-index',
    sql: MANAGED_HOSTED_EVALUATION_OUTSTANDING_INDEX_SQL,
    checksum: '29e225e645272fced8e1c8e8be268a8667a7f069bb3fba3ee1213759815d1e05',
  },
];

function assertMigrationDefinitions(): void {
  for (const [index, migration] of MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Managed workflow schema migration definitions must be contiguous; expected version ${expectedVersion}, received ${migration.version}.`,
      );
    }
    const computedChecksum = checksumSql(migration.sql);
    if (migration.checksum !== computedChecksum) {
      throw new Error(
        `Managed workflow schema migration ${migration.version} has changed. Expected checksum ${migration.checksum}, computed ${computedChecksum}. Released migration SQL is immutable.`,
      );
    }
  }

  const latestVersion = MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
  if (latestVersion !== CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION) {
    throw new Error(
      `Managed workflow schema version constant is ${CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION}, but the latest migration is ${latestVersion}.`,
    );
  }
}

assertMigrationDefinitions();

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES = [
  'app_settings',
  'managed_maintenance_leases',
  'managed_object_deletion_outbox',
  'managed_reconciliation_state',
  'managed_reconciliation_findings',
  'workflow_folders',
  'workflows',
  'workflow_revisions',
  'workflow_published_versions',
  'workflow_endpoints',
  'workflow_web_apps',
  'workflow_recordings',
  'web_app_action_runs',
  'web_app_action_run_events',
  'web_app_action_cancel_commands',
  'llm_profile_health',
  'evaluation_library',
  'evaluation_library_imports',
  'evaluation_runs',
  'evaluation_recordings',
  'evaluation_dataset_snapshots',
  'evaluation_hosted_runs',
  'evaluation_hosted_trial_jobs',
  'evaluation_hosted_trial_attempts',
] as const;

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS = [
  ['managed_maintenance_leases', 'lease_name', 'text', 'NO'],
  ['managed_maintenance_leases', 'holder_id', 'text', 'NO'],
  ['managed_maintenance_leases', 'fencing_token', 'int8', 'NO'],
  ['managed_maintenance_leases', 'expires_at', 'timestamptz', 'NO'],
  ['managed_maintenance_leases', 'updated_at', 'timestamptz', 'NO'],
  ['managed_object_deletion_outbox', 'object_key', 'text', 'NO'],
  ['managed_object_deletion_outbox', 'domain', 'text', 'NO'],
  ['managed_object_deletion_outbox', 'status', 'text', 'NO'],
  ['managed_object_deletion_outbox', 'enqueued_at', 'timestamptz', 'NO'],
  ['managed_object_deletion_outbox', 'next_attempt_at', 'timestamptz', 'NO'],
  ['managed_object_deletion_outbox', 'attempt_count', 'int4', 'NO'],
  ['managed_object_deletion_outbox', 'claim_holder_id', 'text', 'YES'],
  ['managed_object_deletion_outbox', 'claim_fencing_token', 'int8', 'YES'],
  ['managed_object_deletion_outbox', 'claim_expires_at', 'timestamptz', 'YES'],
  ['managed_object_deletion_outbox', 'last_error', 'text', 'YES'],
  ['managed_object_deletion_outbox', 'completed_at', 'timestamptz', 'YES'],
  ['managed_object_deletion_outbox', 'updated_at', 'timestamptz', 'NO'],
  ['managed_reconciliation_state', 'domain', 'text', 'NO'],
  ['managed_reconciliation_state', 'phase', 'text', 'NO'],
  ['managed_reconciliation_state', 'cursor', 'text', 'YES'],
  ['managed_reconciliation_state', 'active_generation', 'int8', 'NO'],
  ['managed_reconciliation_state', 'completed_generation', 'int8', 'NO'],
  ['managed_reconciliation_state', 'scan_started_at', 'timestamptz', 'YES'],
  ['managed_reconciliation_state', 'last_completed_at', 'timestamptz', 'YES'],
  ['managed_reconciliation_state', 'last_error_at', 'timestamptz', 'YES'],
  ['managed_reconciliation_state', 'last_error_code', 'text', 'YES'],
  ['managed_reconciliation_state', 'updated_at', 'timestamptz', 'NO'],
  ['managed_reconciliation_findings', 'domain', 'text', 'NO'],
  ['managed_reconciliation_findings', 'kind', 'text', 'NO'],
  ['managed_reconciliation_findings', 'subject_key', 'text', 'NO'],
  ['managed_reconciliation_findings', 'first_seen_at', 'timestamptz', 'NO'],
  ['managed_reconciliation_findings', 'last_seen_at', 'timestamptz', 'NO'],
  ['managed_reconciliation_findings', 'last_observed_generation', 'int8', 'NO'],
  ['managed_reconciliation_findings', 'last_completed_observed_generation', 'int8', 'YES'],
  ['managed_reconciliation_findings', 'consecutive_complete_scans', 'int4', 'NO'],
  ['managed_reconciliation_findings', 'resolved_at', 'timestamptz', 'YES'],
  ['app_settings', 'setting_key', 'text', 'NO'],
  ['app_settings', 'revision', 'int8', 'NO'],
  ['app_settings', 'schema_version', 'int4', 'NO'],
  ['app_settings', 'ciphertext', 'bytea', 'NO'],
  ['app_settings', 'iv', 'bytea', 'NO'],
  ['app_settings', 'auth_tag', 'bytea', 'NO'],
  ['app_settings', 'key_id', 'text', 'NO'],
  ['app_settings', 'source_hash', 'text', 'YES'],
  ['app_settings', 'updated_at', 'timestamptz', 'NO'],
  ['evaluation_dataset_snapshots', 'project_id', 'text', 'NO'],
  ['evaluation_dataset_snapshots', 'dataset_fingerprint', 'text', 'NO'],
  ['evaluation_dataset_snapshots', 'snapshot_json', 'jsonb', 'NO'],
  ['evaluation_hosted_runs', 'project_id', 'text', 'NO'],
  ['evaluation_hosted_runs', 'run_id', 'text', 'NO'],
  ['evaluation_hosted_runs', 'status', 'text', 'NO'],
  ['evaluation_hosted_runs', 'snapshot_json', 'jsonb', 'NO'],
  ['evaluation_hosted_runs', 'cancel_requested_at', 'timestamptz', 'YES'],
  ['evaluation_hosted_runs', 'created_at', 'timestamptz', 'NO'],
  ['evaluation_hosted_runs', 'updated_at', 'timestamptz', 'NO'],
  ['evaluation_hosted_trial_jobs', 'project_id', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'run_id', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'job_id', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'case_id', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'case_name', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'case_index', 'int4', 'NO'],
  ['evaluation_hosted_trial_jobs', 'trial_index', 'int4', 'NO'],
  ['evaluation_hosted_trial_jobs', 'status', 'text', 'NO'],
  ['evaluation_hosted_trial_jobs', 'attempt', 'int4', 'NO'],
  ['evaluation_hosted_trial_jobs', 'fencing_token', 'int8', 'NO'],
  ['evaluation_hosted_trial_jobs', 'worker_id', 'text', 'YES'],
  ['evaluation_hosted_trial_jobs', 'lease_expires_at', 'timestamptz', 'YES'],
  ['evaluation_hosted_trial_jobs', 'accepted_at', 'timestamptz', 'YES'],
  ['evaluation_hosted_trial_jobs', 'settled_at', 'timestamptz', 'YES'],
  ['evaluation_hosted_trial_jobs', 'trial_json', 'jsonb', 'YES'],
  ['evaluation_hosted_trial_jobs', 'created_at', 'timestamptz', 'NO'],
  ['evaluation_hosted_trial_jobs', 'updated_at', 'timestamptz', 'NO'],
  ['evaluation_hosted_trial_attempts', 'project_id', 'text', 'NO'],
  ['evaluation_hosted_trial_attempts', 'run_id', 'text', 'NO'],
  ['evaluation_hosted_trial_attempts', 'job_id', 'text', 'NO'],
  ['evaluation_hosted_trial_attempts', 'attempt', 'int4', 'NO'],
  ['evaluation_hosted_trial_attempts', 'fencing_token', 'int8', 'NO'],
  ['evaluation_hosted_trial_attempts', 'worker_id', 'text', 'YES'],
  ['evaluation_hosted_trial_attempts', 'event', 'text', 'NO'],
  ['evaluation_hosted_trial_attempts', 'created_at', 'timestamptz', 'NO'],
  ['evaluation_dataset_snapshots', 'created_at', 'timestamptz', 'NO'],
  ['evaluation_library', 'singleton_key', 'bool', 'NO'],
  ['evaluation_library', 'revision', 'int8', 'NO'],
  ['evaluation_library', 'library_json', 'jsonb', 'NO'],
  ['evaluation_library', 'updated_at', 'timestamptz', 'NO'],
  ['evaluation_library_imports', 'source_fingerprint', 'text', 'NO'],
  ['evaluation_library_imports', 'imported_at', 'timestamptz', 'NO'],
  ['evaluation_recordings', 'project_id', 'text', 'NO'],
  ['evaluation_recordings', 'recording_id', 'text', 'NO'],
  ['evaluation_recordings', 'run_id', 'text', 'NO'],
  ['evaluation_recordings', 'artifact_json', 'jsonb', 'NO'],
  ['evaluation_recordings', 'created_at', 'timestamptz', 'NO'],
  ['evaluation_runs', 'project_id', 'text', 'NO'],
  ['evaluation_runs', 'run_id', 'text', 'NO'],
  ['evaluation_runs', 'suite_id', 'text', 'NO'],
  ['evaluation_runs', 'started_at', 'timestamptz', 'NO'],
  ['evaluation_runs', 'run_json', 'jsonb', 'NO'],
  ['evaluation_runs', 'updated_at', 'timestamptz', 'NO'],
  ['llm_profile_health', 'key', 'text', 'NO'],
  ['llm_profile_health', 'project_id', 'text', 'YES'],
  ['llm_profile_health', 'entry_json', 'jsonb', 'YES'],
  ['llm_profile_health', 'updated_at', 'timestamptz', 'NO'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'version', 'int4', 'NO'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'name', 'text', 'NO'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'checksum', 'text', 'NO'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'application_version', 'text', 'YES'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'applied_at', 'timestamptz', 'NO'],
  ['web_app_action_cancel_commands', 'run_id', 'text', 'NO'],
  ['web_app_action_cancel_commands', 'host_id', 'text', 'NO'],
  ['web_app_action_cancel_commands', 'owner_scope', 'text', 'NO'],
  ['web_app_action_cancel_commands', 'requested_at', 'timestamptz', 'NO'],
  ['web_app_action_cancel_commands', 'acknowledged_at', 'timestamptz', 'YES'],
  ['web_app_action_run_events', 'run_id', 'text', 'NO'],
  ['web_app_action_run_events', 'sequence', 'int4', 'NO'],
  ['web_app_action_run_events', 'event', 'jsonb', 'NO'],
  ['web_app_action_run_events', 'created_at', 'timestamptz', 'NO'],
  ['web_app_action_runs', 'run_id', 'text', 'NO'],
  ['web_app_action_runs', 'owner_scope', 'text', 'NO'],
  ['web_app_action_runs', 'request_id', 'text', 'NO'],
  ['web_app_action_runs', 'component_id', 'text', 'NO'],
  ['web_app_action_runs', 'host_id', 'text', 'NO'],
  ['web_app_action_runs', 'lease_id', 'text', 'NO'],
  ['web_app_action_runs', 'lease_expires_at', 'timestamptz', 'NO'],
  ['web_app_action_runs', 'status', 'text', 'NO'],
  ['web_app_action_runs', 'last_sequence', 'int4', 'NO'],
  ['web_app_action_runs', 'created_at', 'timestamptz', 'NO'],
  ['web_app_action_runs', 'updated_at', 'timestamptz', 'NO'],
  ['workflow_endpoints', 'lookup_name', 'text', 'NO'],
  ['workflow_endpoints', 'workflow_id', 'text', 'NO'],
  ['workflow_endpoints', 'endpoint_name', 'text', 'NO'],
  ['workflow_endpoints', 'is_draft', 'bool', 'NO'],
  ['workflow_endpoints', 'is_published', 'bool', 'NO'],
  ['workflow_endpoints', 'updated_at', 'timestamptz', 'NO'],
  ['workflow_folders', 'relative_path', 'text', 'NO'],
  ['workflow_folders', 'name', 'text', 'NO'],
  ['workflow_folders', 'parent_relative_path', 'text', 'NO'],
  ['workflow_folders', 'updated_at', 'timestamptz', 'NO'],
  ['workflow_published_versions', 'version_id', 'text', 'NO'],
  ['workflow_published_versions', 'workflow_id', 'text', 'NO'],
  ['workflow_published_versions', 'revision_id', 'text', 'NO'],
  ['workflow_published_versions', 'endpoint_name', 'text', 'NO'],
  ['workflow_published_versions', 'published_at', 'timestamptz', 'NO'],
  ['workflow_published_versions', 'is_starred', 'bool', 'NO'],
  ['workflow_published_versions', 'comment', 'text', 'NO'],
  ['workflow_recordings', 'recording_id', 'text', 'NO'],
  ['workflow_recordings', 'workflow_id', 'text', 'NO'],
  ['workflow_recordings', 'source_project_name', 'text', 'NO'],
  ['workflow_recordings', 'source_project_relative_path', 'text', 'NO'],
  ['workflow_recordings', 'created_at', 'timestamptz', 'NO'],
  ['workflow_recordings', 'run_kind', 'text', 'NO'],
  ['workflow_recordings', 'status', 'text', 'NO'],
  ['workflow_recordings', 'duration_ms', 'int4', 'NO'],
  ['workflow_recordings', 'endpoint_name_at_execution', 'text', 'NO'],
  ['workflow_recordings', 'execution_surface', 'text', 'YES'],
  ['workflow_recordings', 'graph_id_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'graph_name_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'revision_key_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'ui_graph_id_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'ui_graph_name_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'web_app_slug_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'component_id_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'component_type_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'component_label_at_execution', 'text', 'YES'],
  ['workflow_recordings', 'error_message', 'text', 'YES'],
  ['workflow_recordings', 'recording_blob_key', 'text', 'NO'],
  ['workflow_recordings', 'replay_project_blob_key', 'text', 'NO'],
  ['workflow_recordings', 'replay_dataset_blob_key', 'text', 'YES'],
  ['workflow_recordings', 'has_replay_dataset', 'bool', 'NO'],
  ['workflow_recordings', 'recording_compressed_bytes', 'int4', 'NO'],
  ['workflow_recordings', 'recording_uncompressed_bytes', 'int4', 'NO'],
  ['workflow_recordings', 'project_compressed_bytes', 'int4', 'NO'],
  ['workflow_recordings', 'project_uncompressed_bytes', 'int4', 'NO'],
  ['workflow_recordings', 'dataset_compressed_bytes', 'int4', 'NO'],
  ['workflow_recordings', 'dataset_uncompressed_bytes', 'int4', 'NO'],
  ['workflow_revisions', 'revision_id', 'text', 'NO'],
  ['workflow_revisions', 'workflow_id', 'text', 'NO'],
  ['workflow_revisions', 'project_blob_key', 'text', 'NO'],
  ['workflow_revisions', 'dataset_blob_key', 'text', 'YES'],
  ['workflow_revisions', 'stats_graph_count', 'int4', 'YES'],
  ['workflow_revisions', 'stats_total_node_count', 'int4', 'YES'],
  ['workflow_revisions', 'stats_web_app_count', 'int4', 'YES'],
  ['workflow_revisions', 'created_at', 'timestamptz', 'NO'],
  ['workflow_web_apps', 'app_id', 'text', 'NO'],
  ['workflow_web_apps', 'workflow_id', 'text', 'NO'],
  ['workflow_web_apps', 'revision_id', 'text', 'NO'],
  ['workflow_web_apps', 'ui_graph_id', 'text', 'NO'],
  ['workflow_web_apps', 'slug', 'text', 'NO'],
  ['workflow_web_apps', 'slug_lookup_name', 'text', 'NO'],
  ['workflow_web_apps', 'allowed_emails', '_text', 'NO'],
  ['workflow_web_apps', 'published_at', 'timestamptz', 'NO'],
  ['workflows', 'workflow_id', 'text', 'NO'],
  ['workflows', 'name', 'text', 'NO'],
  ['workflows', 'file_name', 'text', 'NO'],
  ['workflows', 'relative_path', 'text', 'NO'],
  ['workflows', 'folder_relative_path', 'text', 'NO'],
  ['workflows', 'updated_at', 'timestamptz', 'NO'],
  ['workflows', 'current_draft_revision_id', 'text', 'NO'],
  ['workflows', 'published_revision_id', 'text', 'YES'],
  ['workflows', 'published_version_id', 'text', 'YES'],
  ['workflows', 'endpoint_name', 'text', 'NO'],
  ['workflows', 'published_endpoint_name', 'text', 'NO'],
  ['workflows', 'last_published_at', 'timestamptz', 'YES'],
] as const;

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS = [
  ['managed_maintenance_leases', 'updated_at', 'now()'],
  ['managed_object_deletion_outbox', 'status', "'pending'::text"],
  ['managed_object_deletion_outbox', 'enqueued_at', 'now()'],
  ['managed_object_deletion_outbox', 'next_attempt_at', 'now()'],
  ['managed_object_deletion_outbox', 'attempt_count', '0'],
  ['managed_object_deletion_outbox', 'updated_at', 'now()'],
  ['managed_reconciliation_state', 'phase', "'metadata'::text"],
  ['managed_reconciliation_state', 'active_generation', '1'],
  ['managed_reconciliation_state', 'completed_generation', '0'],
  ['managed_reconciliation_state', 'updated_at', 'now()'],
  ['managed_reconciliation_findings', 'first_seen_at', 'now()'],
  ['managed_reconciliation_findings', 'last_seen_at', 'now()'],
  ['managed_reconciliation_findings', 'consecutive_complete_scans', '0'],
  ['app_settings', 'updated_at', 'now()'],
  ['evaluation_hosted_runs', 'created_at', 'now()'],
  ['evaluation_hosted_runs', 'updated_at', 'now()'],
  ['evaluation_hosted_trial_jobs', 'attempt', '0'],
  ['evaluation_hosted_trial_jobs', 'fencing_token', '0'],
  ['evaluation_hosted_trial_jobs', 'created_at', 'now()'],
  ['evaluation_hosted_trial_jobs', 'updated_at', 'now()'],
  ['evaluation_hosted_trial_attempts', 'created_at', 'now()'],
  ['evaluation_dataset_snapshots', 'created_at', 'now()'],
  ['evaluation_library', 'singleton_key', 'true'],
  ['evaluation_library', 'updated_at', 'now()'],
  ['evaluation_library_imports', 'imported_at', 'now()'],
  ['evaluation_recordings', 'created_at', 'now()'],
  ['evaluation_runs', 'updated_at', 'now()'],
  ['llm_profile_health', 'updated_at', 'now()'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'applied_at', 'now()'],
  ['web_app_action_cancel_commands', 'requested_at', 'now()'],
  ['web_app_action_run_events', 'created_at', 'now()'],
  ['web_app_action_runs', 'last_sequence', '0'],
  ['web_app_action_runs', 'created_at', 'now()'],
  ['web_app_action_runs', 'updated_at', 'now()'],
  ['workflow_endpoints', 'is_draft', 'false'],
  ['workflow_endpoints', 'is_published', 'false'],
  ['workflow_endpoints', 'updated_at', 'now()'],
  ['workflow_folders', 'updated_at', 'now()'],
  ['workflow_published_versions', 'published_at', 'now()'],
  ['workflow_published_versions', 'is_starred', 'false'],
  ['workflow_published_versions', 'comment', `''::text`],
  ['workflow_recordings', 'created_at', 'now()'],
  ['workflow_recordings', 'has_replay_dataset', 'false'],
  ['workflow_recordings', 'recording_compressed_bytes', '0'],
  ['workflow_recordings', 'recording_uncompressed_bytes', '0'],
  ['workflow_recordings', 'project_compressed_bytes', '0'],
  ['workflow_recordings', 'project_uncompressed_bytes', '0'],
  ['workflow_recordings', 'dataset_compressed_bytes', '0'],
  ['workflow_recordings', 'dataset_uncompressed_bytes', '0'],
  ['workflow_revisions', 'created_at', 'now()'],
  ['workflow_web_apps', 'allowed_emails', `'{}'::text[]`],
  ['workflow_web_apps', 'published_at', 'now()'],
  ['workflows', 'updated_at', 'now()'],
  ['workflows', 'endpoint_name', `''::text`],
  ['workflows', 'published_endpoint_name', `''::text`],
] as const;

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES = [
  [
    'managed_object_deletion_outbox',
    'managed_object_deletion_outbox_pending_idx',
    ['status', 'next_attempt_at', 'enqueued_at', 'object_key'],
    null,
    [0, 0, 0, 0],
  ],
  [
    'managed_reconciliation_findings',
    'managed_reconciliation_findings_open_idx',
    ['domain', 'resolved_at', 'kind', 'first_seen_at'],
    null,
    [0, 0, 0, 0],
  ],
  ['workflows', 'workflows_folder_relative_path_idx', ['folder_relative_path'], null, [0]],
  ['workflows', 'workflows_published_endpoint_name_idx', ['published_endpoint_name'], null, [0]],
  ['workflow_revisions', 'workflow_revisions_workflow_id_idx', ['workflow_id'], null, [0]],
  [
    'workflow_published_versions',
    'workflow_published_versions_workflow_id_published_at_idx',
    ['workflow_id', 'published_at'],
    null,
    [0, 3],
  ],
  ['workflow_endpoints', 'workflow_endpoints_workflow_id_idx', ['workflow_id'], null, [0]],
  ['workflow_endpoints', 'workflow_endpoints_is_published_idx', ['is_published'], null, [0]],
  ['workflow_web_apps', 'workflow_web_apps_workflow_id_idx', ['workflow_id'], null, [0]],
  ['workflow_web_apps', 'workflow_web_apps_revision_id_idx', ['revision_id'], null, [0]],
  ['workflow_recordings', 'workflow_recordings_workflow_id_idx', ['workflow_id'], null, [0]],
  ['workflow_recordings', 'workflow_recordings_created_at_idx', ['created_at'], null, [3]],
  [
    'workflow_recordings',
    'workflow_recordings_endpoint_created_at_idx',
    ['workflow_id', 'lower(btrim(endpoint_name_at_execution))', 'created_at', 'recording_id'],
    null,
    [0, 0, 3, 3],
  ],
  [
    'workflow_recordings',
    'workflow_recordings_statistics_target_idx',
    [
      'execution_surface',
      'workflow_id',
      'ui_graph_id_at_execution',
      'component_id_at_execution',
      'run_kind',
      'created_at',
    ],
    null,
    [0, 0, 0, 0, 0, 3],
  ],
  ['web_app_action_runs', 'web_app_action_runs_lease_idx', ['status', 'lease_expires_at'], null, [0, 0]],
  ['web_app_action_runs', 'web_app_action_runs_host_idx', ['host_id', 'status'], null, [0, 0]],
  [
    'web_app_action_cancel_commands',
    'web_app_action_cancel_commands_pending_idx',
    ['host_id', 'requested_at'],
    'acknowledged_at IS NULL',
    [0, 0],
  ],
  ['llm_profile_health', 'llm_profile_health_project_id_idx', ['project_id'], null, [0]],
  ['llm_profile_health', 'llm_profile_health_updated_at_idx', ['updated_at'], null, [3]],
  ['evaluation_runs', 'evaluation_runs_project_started_idx', ['project_id', 'started_at'], null, [0, 3]],
  ['evaluation_runs', 'evaluation_runs_project_suite_idx', ['project_id', 'suite_id'], null, [0, 0]],
  ['evaluation_hosted_runs', 'evaluation_hosted_runs_active_idx', ['status', 'created_at', 'project_id', 'run_id'], "(status = ANY (ARRAY['queued'::text, 'running'::text]))", [0, 0, 0, 0]],
  ['evaluation_hosted_trial_jobs', 'evaluation_hosted_trial_jobs_claim_idx', ['status', 'case_index', 'trial_index', 'project_id', 'run_id'], "(status = 'queued'::text)", [0, 0, 0, 0, 0]],
  ['evaluation_hosted_trial_jobs', 'evaluation_hosted_trial_jobs_lease_idx', ['status', 'lease_expires_at', 'project_id', 'run_id'], "(status = ANY (ARRAY['claimed'::text, 'accepted'::text]))", [0, 0, 0, 0]],
  ['evaluation_hosted_trial_jobs', 'evaluation_hosted_trial_jobs_outstanding_idx', ['status'], "(status = ANY (ARRAY['queued'::text, 'claimed'::text, 'accepted'::text]))", [0]],
  ['evaluation_hosted_trial_attempts', 'evaluation_hosted_trial_attempts_run_idx', ['project_id', 'run_id', 'created_at', 'job_id'], null, [0, 0, 0, 0]],
  ['evaluation_recordings', 'evaluation_recordings_project_run_idx', ['project_id', 'run_id'], null, [0, 0]],
] as const;

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS = [
  ['managed_maintenance_leases', 'p', 'PRIMARY KEY (lease_name)'],
  ['managed_maintenance_leases', 'c', 'CHECK ((char_length(lease_name) > 0))'],
  ['managed_maintenance_leases', 'c', 'CHECK ((char_length(holder_id) > 0))'],
  ['managed_maintenance_leases', 'c', 'CHECK ((fencing_token > 0))'],
  ['managed_object_deletion_outbox', 'p', 'PRIMARY KEY (object_key)'],
  ['managed_object_deletion_outbox', 'c', 'CHECK ((char_length(object_key) > 0))'],
  ['managed_object_deletion_outbox', 'c', 'CHECK ((char_length(domain) > 0))'],
  ['managed_object_deletion_outbox', 'c', 'CHECK ((attempt_count >= 0))'],
  ['managed_reconciliation_state', 'p', 'PRIMARY KEY (domain)'],
  [
    'managed_reconciliation_state',
    'c',
    "CHECK ((domain = ANY (ARRAY['evaluations'::text, 'runtime_libraries'::text, 'workflows'::text])))",
  ],
  ['managed_reconciliation_state', 'c', "CHECK ((phase = ANY (ARRAY['metadata'::text, 'objects'::text])))"],
  ['managed_reconciliation_state', 'c', 'CHECK ((active_generation > 0))'],
  ['managed_reconciliation_state', 'c', 'CHECK ((completed_generation >= 0))'],
  ['managed_reconciliation_findings', 'p', 'PRIMARY KEY (domain, kind, subject_key)'],
  [
    'managed_reconciliation_findings',
    'c',
    "CHECK ((domain = ANY (ARRAY['evaluations'::text, 'runtime_libraries'::text, 'workflows'::text])))",
  ],
  ['managed_reconciliation_findings', 'c', 'CHECK ((char_length(kind) > 0))'],
  ['managed_reconciliation_findings', 'c', 'CHECK ((char_length(subject_key) > 0))'],
  ['managed_reconciliation_findings', 'c', 'CHECK ((last_observed_generation > 0))'],
  ['managed_reconciliation_findings', 'c', 'CHECK ((last_completed_observed_generation > 0))'],
  ['managed_reconciliation_findings', 'c', 'CHECK ((consecutive_complete_scans >= 0))'],
  [
    'managed_object_deletion_outbox',
    'c',
    "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'blocked'::text])))",
  ],
  ['app_settings', 'p', 'PRIMARY KEY (setting_key)'],
  ['app_settings', 'c', 'CHECK ((char_length(setting_key) > 0))'],
  ['app_settings', 'c', 'CHECK ((revision > 0))'],
  ['app_settings', 'c', 'CHECK ((schema_version >= 0))'],
  ['app_settings', 'c', 'CHECK ((octet_length(ciphertext) > 0))'],
  ['app_settings', 'c', 'CHECK ((octet_length(iv) = 12))'],
  ['app_settings', 'c', 'CHECK ((octet_length(auth_tag) = 16))'],
  ['app_settings', 'c', 'CHECK ((char_length(key_id) = 16))'],
  ['app_settings', 'c', 'CHECK (((source_hash IS NULL) OR (char_length(source_hash) = 64)))'],
  ['evaluation_dataset_snapshots', 'p', 'PRIMARY KEY (project_id, dataset_fingerprint)'],
  ['evaluation_hosted_runs', 'p', 'PRIMARY KEY (project_id, run_id)'],
  ['evaluation_hosted_runs', 'f', 'FOREIGN KEY (project_id, run_id) REFERENCES evaluation_runs(project_id, run_id) ON DELETE CASCADE'],
  ['evaluation_hosted_trial_jobs', 'p', 'PRIMARY KEY (project_id, run_id, job_id)'],
  ['evaluation_hosted_trial_jobs', 'u', 'UNIQUE (project_id, run_id, case_id, trial_index)'],
  ['evaluation_hosted_trial_jobs', 'f', 'FOREIGN KEY (project_id, run_id) REFERENCES evaluation_hosted_runs(project_id, run_id) ON DELETE CASCADE'],
  ['evaluation_hosted_trial_attempts', 'p', 'PRIMARY KEY (project_id, run_id, job_id, attempt, event)'],
  ['evaluation_hosted_trial_attempts', 'f', 'FOREIGN KEY (project_id, run_id, job_id) REFERENCES evaluation_hosted_trial_jobs(project_id, run_id, job_id) ON DELETE CASCADE'],
  ['evaluation_dataset_snapshots', 'f', 'FOREIGN KEY (project_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['evaluation_library', 'p', 'PRIMARY KEY (singleton_key)'],
  ['evaluation_library', 'c', 'CHECK (singleton_key)'],
  ['evaluation_library_imports', 'p', 'PRIMARY KEY (source_fingerprint)'],
  ['evaluation_recordings', 'p', 'PRIMARY KEY (project_id, recording_id)'],
  ['evaluation_recordings', 'f', 'FOREIGN KEY (project_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['evaluation_runs', 'p', 'PRIMARY KEY (project_id, run_id)'],
  ['evaluation_runs', 'f', 'FOREIGN KEY (project_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['llm_profile_health', 'p', 'PRIMARY KEY (key)'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'c', 'CHECK ((char_length(checksum) = 64))'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'p', 'PRIMARY KEY (version)'],
  [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE, 'c', 'CHECK ((version > 0))'],
  ['web_app_action_cancel_commands', 'p', 'PRIMARY KEY (run_id)'],
  [
    'web_app_action_cancel_commands',
    'f',
    'FOREIGN KEY (run_id) REFERENCES web_app_action_runs(run_id) ON DELETE CASCADE',
  ],
  ['web_app_action_run_events', 'p', 'PRIMARY KEY (run_id, sequence)'],
  ['web_app_action_run_events', 'f', 'FOREIGN KEY (run_id) REFERENCES web_app_action_runs(run_id) ON DELETE CASCADE'],
  ['web_app_action_runs', 'u', 'UNIQUE (owner_scope, request_id)'],
  ['web_app_action_runs', 'p', 'PRIMARY KEY (run_id)'],
  ['workflow_endpoints', 'p', 'PRIMARY KEY (lookup_name)'],
  ['workflow_endpoints', 'f', 'FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['workflow_folders', 'p', 'PRIMARY KEY (relative_path)'],
  ['workflow_published_versions', 'p', 'PRIMARY KEY (version_id)'],
  [
    'workflow_published_versions',
    'f',
    'FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE',
  ],
  ['workflow_published_versions', 'f', 'FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['workflow_recordings', 'p', 'PRIMARY KEY (recording_id)'],
  ['workflow_revisions', 'p', 'PRIMARY KEY (revision_id)'],
  ['workflow_revisions', 'f', 'FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['workflow_web_apps', 'p', 'PRIMARY KEY (app_id)'],
  ['workflow_web_apps', 'f', 'FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE'],
  ['workflow_web_apps', 'u', 'UNIQUE (slug_lookup_name)'],
  ['workflow_web_apps', 'f', 'FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'],
  ['workflow_web_apps', 'u', 'UNIQUE (workflow_id, ui_graph_id)'],
  ['workflows', 'p', 'PRIMARY KEY (workflow_id)'],
  ['workflows', 'u', 'UNIQUE (relative_path)'],
] as const;

export const MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION = {
  name: 'move_managed_workflow_folder',
  argumentTypes: 'text,text,text,text',
  sourceChecksum: 'c4ae0930536809309e4200c9bd833921',
  language: 'plpgsql',
  volatility: 'v',
  securityDefiner: false,
  canExecute: true,
  resultType:
    'TABLE(relative_path text, name text, parent_relative_path text, updated_at timestamp with time zone, moved_relative_paths text[])',
} as const;

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (char_length(checksum) = 64),
  application_version TEXT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const LIST_MIGRATIONS_SQL = `
SELECT version, name, checksum
FROM ${MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE}
ORDER BY version ASC;
`;

function describeMissing(values: Iterable<string>): string {
  return [...values].sort().join(', ');
}

async function assertMigrationTableExists(client: PoolClient): Promise<void> {
  const result = await client.query<RegclassRow>(
    `SELECT table_name AS object_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND table_name = $1::text`,
    [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE],
  );

  if (!result.rows[0]?.object_name) {
    throw new ManagedWorkflowSchemaCompatibilityError(
      `Managed workflow schema metadata is missing. Run "yarn studio-server:workflow-schema:migrate" before starting verify-only API workloads.`,
    );
  }
}

function validateAppliedMigrations(
  rows: AppliedMigrationRow[],
  maximumSupportedVersion = CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
): number {
  const migrationsByVersion = new Map(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.map((migration) => [migration.version, migration]),
  );

  for (const row of rows) {
    const expected = migrationsByVersion.get(row.version);
    if (!expected) {
      if (row.version > CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION && row.version <= maximumSupportedVersion) {
        // A rollback target cannot know a successor's checksum. The canonical
        // release tool reaches this branch only after the successor manifest
        // declares the migration expand-only and sets the serving upper bound.
        continue;
      }
      throw new ManagedWorkflowSchemaCompatibilityError(
        `Managed workflow schema version ${row.version} is newer than this server supports (${maximumSupportedVersion}).`,
      );
    }

    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new ManagedWorkflowSchemaCompatibilityError(
        `Managed workflow schema migration ${row.version} does not match this build. Expected ${expected.name} (${expected.checksum}), received ${row.name} (${row.checksum}).`,
      );
    }
  }

  const currentVersion = rows.at(-1)?.version ?? 0;
  for (let version = 1; version <= currentVersion; version += 1) {
    if (!rows.some((row) => row.version === version)) {
      throw new ManagedWorkflowSchemaCompatibilityError(
        `Managed workflow schema migration history has a gap at version ${version}.`,
      );
    }
  }

  return currentVersion;
}

async function validateManagedWorkflowSchemaObjects(client: PoolClient): Promise<void> {
  const tableResult = await client.query<TableRow>(
    `SELECT table_relation.relname AS name,
            table_relation.relrowsecurity AS row_security,
            table_relation.relforcerowsecurity AS forced_row_security,
            has_table_privilege(current_user, table_relation.oid, 'SELECT') AS can_select,
            has_table_privilege(current_user, table_relation.oid, 'INSERT') AS can_insert,
            has_table_privilege(current_user, table_relation.oid, 'UPDATE') AS can_update,
            has_table_privilege(current_user, table_relation.oid, 'DELETE') AS can_delete
       FROM pg_class table_relation
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
      WHERE table_namespace.nspname = current_schema()
        AND table_relation.relkind IN ('r', 'p')
        AND table_relation.relname = ANY($1::text[])`,
    [[...MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES]],
  );
  const presentTables = new Map(tableResult.rows.map((row) => [row.name, row]));
  const tableProblems = MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES.flatMap((tableName) => {
    const actual = presentTables.get(tableName);
    if (!actual) {
      return [tableName];
    }
    if (actual.row_security || actual.forced_row_security) {
      return [`${tableName} (row-level security is enabled)`];
    }
    const missingPrivileges = [
      actual.can_select ? null : 'SELECT',
      actual.can_insert ? null : 'INSERT',
      actual.can_update ? null : 'UPDATE',
      actual.can_delete ? null : 'DELETE',
    ].filter((privilege): privilege is string => privilege != null);
    return missingPrivileges.length > 0 ? [`${tableName} (current role lacks ${missingPrivileges.join('/')})`] : [];
  });

  const columnResult = await client.query<ColumnRow>(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [[...new Set(MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.map(([tableName]) => tableName))]],
  );
  const presentColumns = new Map(
    columnResult.rows.map((row) => [
      `${row.table_name}.${row.column_name}`,
      { udtName: row.udt_name, nullable: row.is_nullable, defaultValue: row.column_default },
    ]),
  );
  const missingColumns = MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.flatMap(
    ([tableName, columnName, expectedUdtName, expectedNullable]) => {
      const qualifiedName = `${tableName}.${columnName}`;
      const actual = presentColumns.get(qualifiedName);
      if (!actual) {
        return [qualifiedName];
      }
      if (actual.udtName !== expectedUdtName || actual.nullable !== expectedNullable) {
        return [
          `${qualifiedName} (expected ${expectedUdtName}/${expectedNullable}, received ${actual.udtName}/${actual.nullable})`,
        ];
      }
      return [];
    },
  );
  const invalidColumnDefaults = MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS.flatMap(
    ([tableName, columnName, expectedDefault]) => {
      const qualifiedName = `${tableName}.${columnName}`;
      const actualDefault = presentColumns.get(qualifiedName)?.defaultValue ?? null;
      return actualDefault === expectedDefault
        ? []
        : [`${qualifiedName} (expected ${expectedDefault}, received ${actualDefault ?? 'missing'})`];
    },
  );

  const indexResult = await client.query<IndexRow>(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table_name,
            access_method.amname AS method,
            pg_index.indisunique AS is_unique,
            pg_index.indisvalid AS is_valid,
            pg_index.indisready AS is_ready,
            pg_index.indoption::smallint[] AS key_options,
            ARRAY(
              SELECT pg_get_indexdef(pg_index.indexrelid, key_number, true)
                FROM generate_series(1, pg_index.indnkeyatts) AS key_number
               ORDER BY key_number
            ) AS key_expressions,
            pg_get_expr(pg_index.indpred, pg_index.indrelid, true) AS predicate
       FROM pg_index
       JOIN pg_class index_relation ON index_relation.oid = pg_index.indexrelid
       JOIN pg_class table_relation ON table_relation.oid = pg_index.indrelid
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_relation.relam
      WHERE table_namespace.nspname = current_schema()
        AND index_relation.relname = ANY($1::text[])`,
    [[...MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.map(([, indexName]) => indexName)]],
  );
  const presentIndexes = new Map(indexResult.rows.map((row) => [row.name, row]));
  const missingIndexes = MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.flatMap(
    ([expectedTableName, indexName, expectedKeys, expectedPredicate, expectedKeyOptions]) => {
      const actual = presentIndexes.get(indexName);
      if (!actual) {
        return [indexName];
      }

      const expectedSignature = JSON.stringify({
        tableName: expectedTableName,
        method: 'btree',
        isUnique: false,
        isValid: true,
        isReady: true,
        keyExpressions: expectedKeys,
        keyOptions: expectedKeyOptions,
        predicate: expectedPredicate,
      });
      const actualSignature = JSON.stringify({
        tableName: actual.table_name,
        method: actual.method,
        isUnique: actual.is_unique,
        isValid: actual.is_valid,
        isReady: actual.is_ready,
        keyExpressions: actual.key_expressions,
        keyOptions: actual.key_options,
        predicate: actual.predicate,
      });
      if (actualSignature !== expectedSignature) {
        return [`${indexName} (expected ${expectedSignature}, received ${actualSignature})`];
      }
      return [];
    },
  );

  const constraintResult = await client.query<ConstraintRow>(
    `SELECT table_relation.relname AS table_name,
            constraint_relation.contype AS type,
            pg_get_constraintdef(constraint_relation.oid, false) AS definition,
            constraint_relation.convalidated AS is_validated,
            CASE
              WHEN constraint_relation.contype IN ('p', 'u')
                THEN COALESCE(constraint_index.indisvalid, false)
              ELSE true
            END AS backing_index_valid,
            CASE
              WHEN constraint_relation.contype IN ('p', 'u')
                THEN COALESCE(constraint_index.indisready, false)
              ELSE true
            END AS backing_index_ready
       FROM pg_constraint constraint_relation
       JOIN pg_class table_relation ON table_relation.oid = constraint_relation.conrelid
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
       LEFT JOIN pg_index constraint_index
         ON constraint_index.indexrelid = constraint_relation.conindid
      WHERE table_namespace.nspname = current_schema()
        AND table_relation.relname = ANY($1::text[])`,
    [[...new Set(MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.map(([tableName]) => tableName))]],
  );
  const presentConstraints = new Map(
    constraintResult.rows.map((row) => [JSON.stringify([row.table_name, row.type, row.definition]), row]),
  );
  const missingConstraints = MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.flatMap(([tableName, type, definition]) => {
    const signature = `${tableName}/${type}/${definition}`;
    const actual = presentConstraints.get(JSON.stringify([tableName, type, definition]));
    if (!actual) {
      return [signature];
    }
    if (!actual.is_validated) {
      return [`${signature} (not validated)`];
    }
    if (!actual.backing_index_valid || !actual.backing_index_ready) {
      return [`${signature} (backing index is invalid or unready)`];
    }
    return [];
  });

  const functionResult = await client.query<FunctionRow>(
    `SELECT md5(function_relation.prosrc) AS source_checksum,
            language_relation.lanname AS language,
            function_relation.provolatile AS volatility,
            function_relation.prosecdef AS security_definer,
            has_function_privilege(current_user, function_relation.oid, 'EXECUTE') AS can_execute,
            pg_get_function_result(function_relation.oid) AS result_type
       FROM pg_proc function_relation
       JOIN pg_namespace function_namespace ON function_namespace.oid = function_relation.pronamespace
       JOIN pg_language language_relation ON language_relation.oid = function_relation.prolang
      WHERE function_namespace.nspname = current_schema()
        AND function_relation.oid = to_regprocedure(
          format('%I.%I(%s)', current_schema(), $1::text, $2::text)
        )`,
    [MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.name, MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.argumentTypes],
  );
  const actualFunction = functionResult.rows[0];
  const expectedFunctionSignature = JSON.stringify({
    sourceChecksum: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.sourceChecksum,
    language: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.language,
    volatility: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.volatility,
    securityDefiner: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.securityDefiner,
    canExecute: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.canExecute,
    resultType: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.resultType,
  });
  const actualFunctionSignature = actualFunction
    ? JSON.stringify({
        sourceChecksum: actualFunction.source_checksum,
        language: actualFunction.language,
        volatility: actualFunction.volatility,
        securityDefiner: actualFunction.security_definer,
        canExecute: actualFunction.can_execute,
        resultType: actualFunction.result_type,
      })
    : null;
  const functionProblem =
    actualFunctionSignature === expectedFunctionSignature
      ? null
      : `${MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.name}(${MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.argumentTypes}) (expected ${expectedFunctionSignature}, received ${actualFunctionSignature ?? 'missing'})`;

  const problems = [
    tableProblems.length > 0 ? `tables: ${describeMissing(tableProblems)}` : null,
    missingColumns.length > 0 ? `columns: ${describeMissing(missingColumns)}` : null,
    invalidColumnDefaults.length > 0 ? `column defaults: ${describeMissing(invalidColumnDefaults)}` : null,
    missingIndexes.length > 0 ? `indexes: ${describeMissing(missingIndexes)}` : null,
    missingConstraints.length > 0 ? `constraints: ${describeMissing(missingConstraints)}` : null,
    functionProblem ? `function: ${functionProblem}` : null,
  ].filter((problem): problem is string => problem != null);

  if (problems.length > 0) {
    throw new ManagedWorkflowSchemaCompatibilityError(
      `Managed workflow schema version ${CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION} is incomplete (${problems.join('; ')}).`,
    );
  }
}

export function getManagedWorkflowSchemaMode(env: NodeJS.ProcessEnv = process.env): ManagedWorkflowSchemaMode {
  const configured = env.RIVET_MANAGED_WORKFLOW_SCHEMA_MODE?.trim().toLowerCase();
  if (!configured || configured === 'migrate') {
    return 'migrate';
  }
  if (configured === 'verify') {
    return 'verify';
  }

  throw new Error(`Invalid RIVET_MANAGED_WORKFLOW_SCHEMA_MODE "${configured}". Expected "migrate" or "verify".`);
}

function parseCompatibilityVersion(value: string | undefined, variableName: string, fallback: number): number {
  const configured = value?.trim();
  if (!configured) {
    return fallback;
  }

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${variableName} "${configured}". Expected a positive integer schema version.`);
  }
  return parsed;
}

/**
 * Serving API pods are verify-only. The Helm release, rather than a user
 * secret, supplies this window after dotenv loading. A normal release accepts
 * only its own schema. During a documented expand-only rollback, the release
 * tool may widen the upper bound so the older image verifies the newer
 * additive schema without trying to mutate it.
 */
export function getManagedWorkflowSchemaCompatibilityWindow(
  env: NodeJS.ProcessEnv = process.env,
): ManagedWorkflowSchemaCompatibilityWindow {
  const minimumVersion = parseCompatibilityVersion(
    env.RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION,
    'RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION',
    CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  );
  const maximumVersion = parseCompatibilityVersion(
    env.RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION,
    'RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION',
    CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  );
  if (minimumVersion > maximumVersion) {
    throw new Error(
      `Invalid managed workflow schema compatibility window ${minimumVersion}-${maximumVersion}: minimum version cannot exceed maximum version.`,
    );
  }
  return { minimumVersion, maximumVersion };
}

type RunSchemaOptions = {
  applicationVersion?: string | null;
  compatibilityWindow?: ManagedWorkflowSchemaCompatibilityWindow;
  logger?: Pick<Console, 'log' | 'warn'>;
};

function safelyLog(run: () => void): void {
  try {
    run();
  } catch {
    // Logging must not change a committed or failed migration's outcome.
  }
}

async function rollbackAfterSchemaError(client: PoolClient, logger: Pick<Console, 'warn'>): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch (rollbackError) {
    safelyLog(() =>
      logger.warn('[managed-workflow-schema] Failed to roll back after a schema migration error:', rollbackError),
    );
    return true;
  }
}

async function runManagedWorkflowSchema(
  pool: Pick<Pool, 'connect'>,
  mode: ManagedWorkflowSchemaMode,
  options: RunSchemaOptions = {},
): Promise<ManagedWorkflowSchemaResult> {
  const logger = options.logger ?? console;
  const compatibilityWindow = options.compatibilityWindow ?? getManagedWorkflowSchemaCompatibilityWindow();
  if (
    mode === 'migrate' &&
    (compatibilityWindow.minimumVersion !== CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION ||
      compatibilityWindow.maximumVersion !== CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION)
  ) {
    throw new Error(
      'Managed workflow schema migrations require the exact schema version for this build. Compatibility windows are only valid for verify-only serving workloads.',
    );
  }
  const client = await pool.connect();
  const appliedVersions: number[] = [];
  const startedAt = Date.now();
  let lockWaitMs = 0;
  let observedVersion = 0;
  let discardClient = false;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(
      `SET LOCAL statement_timeout = '${mode === 'migrate' ? MIGRATION_STATEMENT_TIMEOUT : VERIFY_STATEMENT_TIMEOUT}'`,
    );
    const lockStartedAt = Date.now();
    await client.query(
      mode === 'migrate'
        ? 'SELECT pg_advisory_xact_lock($1::integer, $2::integer)'
        : 'SELECT pg_advisory_xact_lock_shared($1::integer, $2::integer)',
      [MANAGED_WORKFLOW_SCHEMA_LOCK.classId, MANAGED_WORKFLOW_SCHEMA_LOCK.objectId],
    );
    lockWaitMs = Date.now() - lockStartedAt;

    if (mode === 'migrate') {
      await client.query(CREATE_MIGRATIONS_TABLE_SQL);
    } else {
      await assertMigrationTableExists(client);
    }

    const appliedResult = await client.query<AppliedMigrationRow>(LIST_MIGRATIONS_SQL);
    let currentVersion = validateAppliedMigrations(
      appliedResult.rows,
      mode === 'verify' ? compatibilityWindow.maximumVersion : CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
    );
    observedVersion = currentVersion;

    if (
      mode === 'verify' &&
      (currentVersion < compatibilityWindow.minimumVersion || currentVersion > compatibilityWindow.maximumVersion)
    ) {
      throw new ManagedWorkflowSchemaCompatibilityError(
        `Managed workflow schema is at version ${currentVersion}; this server supports versions ${compatibilityWindow.minimumVersion}-${compatibilityWindow.maximumVersion}. Run "yarn studio-server:workflow-schema:migrate" before starting verify-only API workloads, or use the documented expand-only rollback release values.`,
      );
    }

    if (mode === 'migrate') {
      for (const migration of MANAGED_WORKFLOW_SCHEMA_MIGRATIONS) {
        if (migration.version <= currentVersion) {
          continue;
        }
        if (migration.version !== currentVersion + 1) {
          throw new ManagedWorkflowSchemaCompatibilityError(
            `Managed workflow schema migration ${migration.version} cannot follow version ${currentVersion}.`,
          );
        }

        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE}
             (version, name, checksum, application_version)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, options.applicationVersion?.trim() || null],
        );
        appliedVersions.push(migration.version);
        currentVersion = migration.version;
      }
    }

    await validateManagedWorkflowSchemaObjects(client);
    await client.query('COMMIT');

    safelyLog(() =>
      logger.log(
        `[managed-workflow-schema] ${mode === 'migrate' ? 'Migration' : 'Verification'} complete: version ${observedVersion} -> ${currentVersion}; lock wait ${lockWaitMs}ms; total ${Date.now() - startedAt}ms${appliedVersions.length > 0 ? `; applied ${appliedVersions.join(', ')}` : ''}.`,
      ),
    );

    return { currentVersion, appliedVersions };
  } catch (error) {
    discardClient = await rollbackAfterSchemaError(client, logger);
    throw error;
  } finally {
    client.release(discardClient);
  }
}

function getPostgresErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error != null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') || null
    : null;
}

async function runManagedWorkflowSchemaWithRetry(
  pool: Pick<Pool, 'connect'>,
  mode: ManagedWorkflowSchemaMode,
  options: RunSchemaOptions,
): Promise<ManagedWorkflowSchemaResult> {
  const logger = options.logger ?? console;
  for (let attempt = 1; attempt <= TRANSIENT_SCHEMA_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await runManagedWorkflowSchema(pool, mode, options);
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if (!code || !TRANSIENT_SCHEMA_ERROR_CODES.has(code) || attempt === TRANSIENT_SCHEMA_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
      safelyLog(() =>
        logger.warn(
          `[managed-workflow-schema] ${mode} failed with transient PostgreSQL error ${code}; retrying in ${delayMs}ms (${attempt}/${TRANSIENT_SCHEMA_RETRY_ATTEMPTS}).`,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Managed workflow schema retry loop completed without a result.');
}

function getApplicationVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.RIVET_BUILD_VERSION?.trim() || env.RIVET_IMAGE_TAG?.trim() || null;
}

export function migrateManagedWorkflowSchema(
  pool: Pick<Pool, 'connect'>,
  options: RunSchemaOptions = {},
): Promise<ManagedWorkflowSchemaResult> {
  return runManagedWorkflowSchemaWithRetry(pool, 'migrate', {
    applicationVersion: options.applicationVersion ?? getApplicationVersion(),
    logger: options.logger,
  });
}

export function verifyManagedWorkflowSchema(
  pool: Pick<Pool, 'connect'>,
  options: RunSchemaOptions = {},
): Promise<ManagedWorkflowSchemaResult> {
  return runManagedWorkflowSchemaWithRetry(pool, 'verify', options);
}
