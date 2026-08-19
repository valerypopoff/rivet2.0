export const MANAGED_WORKFLOW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_folders (
  relative_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_relative_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  folder_relative_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_draft_revision_id TEXT NOT NULL,
  published_revision_id TEXT NULL,
  published_version_id TEXT NULL,
  endpoint_name TEXT NOT NULL DEFAULT '',
  published_endpoint_name TEXT NOT NULL DEFAULT '',
  last_published_at TIMESTAMPTZ NULL
);

ALTER TABLE workflows ADD COLUMN IF NOT EXISTS published_version_id TEXT NULL;

CREATE INDEX IF NOT EXISTS workflows_folder_relative_path_idx ON workflows(folder_relative_path);
CREATE INDEX IF NOT EXISTS workflows_published_endpoint_name_idx ON workflows(published_endpoint_name);

CREATE TABLE IF NOT EXISTS workflow_revisions (
  revision_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_blob_key TEXT NOT NULL,
  dataset_blob_key TEXT NULL,
  stats_graph_count INTEGER NULL,
  stats_total_node_count INTEGER NULL,
  stats_web_app_count INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_graph_count INTEGER NULL;
ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_total_node_count INTEGER NULL;
ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_web_app_count INTEGER NULL;

CREATE INDEX IF NOT EXISTS workflow_revisions_workflow_id_idx ON workflow_revisions(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_published_versions (
  version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
  comment TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE
);

ALTER TABLE workflow_published_versions ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workflow_published_versions ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS workflow_published_versions_workflow_id_published_at_idx
  ON workflow_published_versions(workflow_id, published_at DESC);

CREATE TABLE IF NOT EXISTS workflow_endpoints (
  lookup_name TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  is_draft BOOLEAN NOT NULL DEFAULT FALSE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_endpoints_workflow_id_idx ON workflow_endpoints(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_endpoints_is_published_idx ON workflow_endpoints(is_published);

CREATE TABLE IF NOT EXISTS workflow_web_apps (
  app_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  ui_graph_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_lookup_name TEXT NOT NULL UNIQUE,
  allowed_emails TEXT[] NOT NULL DEFAULT '{}',
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE,
  UNIQUE (workflow_id, ui_graph_id)
);

ALTER TABLE workflow_web_apps ADD COLUMN IF NOT EXISTS allowed_emails TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS workflow_web_apps_workflow_id_idx ON workflow_web_apps(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_web_apps_revision_id_idx ON workflow_web_apps(revision_id);

DROP FUNCTION IF EXISTS move_managed_workflow_folder(TEXT, TEXT, TEXT, TEXT);

CREATE FUNCTION move_managed_workflow_folder(
  source_relative_path TEXT,
  temporary_prefix TEXT,
  target_relative_path TEXT,
  folder_name TEXT
) RETURNS TABLE (
  relative_path TEXT,
  name TEXT,
  parent_relative_path TEXT,
  updated_at TIMESTAMPTZ,
  moved_relative_paths TEXT[]
) LANGUAGE plpgsql AS $$
DECLARE
  target_parent_relative_path TEXT := CASE
    WHEN position('/' in target_relative_path) = 0 THEN ''
    ELSE regexp_replace(target_relative_path, '/[^/]+$', '')
  END;
  source_prefix_pattern TEXT := replace(replace(replace(source_relative_path, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%';
  temporary_prefix_pattern TEXT := replace(replace(replace(temporary_prefix, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%';
  moved_paths TEXT[] := ARRAY[]::TEXT[];
BEGIN
  PERFORM 1
  FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\\'
  FOR UPDATE;

  IF target_parent_relative_path <> '' THEN
    PERFORM 1
    FROM workflow_folders AS folder
    WHERE folder.relative_path = target_parent_relative_path
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_folders AS folder
    WHERE folder.relative_path = target_relative_path
  ) THEN
    RAISE EXCEPTION 'Folder already exists: %', folder_name USING ERRCODE = '23505';
  END IF;

  WITH locked_workflows AS (
    SELECT workflow.relative_path
    FROM workflows AS workflow
    WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\\'
    ORDER BY workflow.relative_path ASC
    FOR UPDATE
  )
  SELECT COALESCE(array_agg(locked_workflows.relative_path ORDER BY locked_workflows.relative_path ASC), ARRAY[]::TEXT[])
  INTO moved_paths
  FROM locked_workflows;

  UPDATE workflow_folders AS folder
  SET relative_path = CASE
        WHEN folder.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(folder.relative_path from char_length(source_relative_path) + 1)
      END,
      parent_relative_path = CASE
        WHEN folder.parent_relative_path = source_relative_path THEN temporary_prefix
        WHEN folder.parent_relative_path LIKE source_prefix_pattern ESCAPE '\\' THEN temporary_prefix || substring(folder.parent_relative_path from char_length(source_relative_path) + 1)
        ELSE folder.parent_relative_path
      END,
      updated_at = NOW()
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\\';

  UPDATE workflows AS workflow
  SET relative_path = CASE
        WHEN workflow.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(workflow.relative_path from char_length(source_relative_path) + 1)
      END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = source_relative_path THEN temporary_prefix
        WHEN workflow.folder_relative_path LIKE source_prefix_pattern ESCAPE '\\' THEN temporary_prefix || substring(workflow.folder_relative_path from char_length(source_relative_path) + 1)
        ELSE workflow.folder_relative_path
      END,
      updated_at = NOW()
  WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\\';

  UPDATE workflow_folders AS folder
  SET relative_path = CASE
        WHEN folder.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(folder.relative_path from char_length(temporary_prefix) + 1)
      END,
      name = CASE
        WHEN folder.relative_path = temporary_prefix THEN folder_name
        ELSE folder.name
      END,
      parent_relative_path = CASE
        WHEN folder.parent_relative_path = temporary_prefix THEN target_relative_path
        WHEN folder.parent_relative_path LIKE temporary_prefix_pattern ESCAPE '\\' THEN target_relative_path || substring(folder.parent_relative_path from char_length(temporary_prefix) + 1)
        ELSE folder.parent_relative_path
      END,
      updated_at = NOW()
  WHERE folder.relative_path = temporary_prefix OR folder.relative_path LIKE temporary_prefix_pattern ESCAPE '\\';

  UPDATE workflows AS workflow
  SET relative_path = CASE
        WHEN workflow.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(workflow.relative_path from char_length(temporary_prefix) + 1)
      END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = temporary_prefix THEN target_relative_path
        WHEN workflow.folder_relative_path LIKE temporary_prefix_pattern ESCAPE '\\' THEN target_relative_path || substring(workflow.folder_relative_path from char_length(temporary_prefix) + 1)
        ELSE workflow.folder_relative_path
      END,
      updated_at = NOW()
  WHERE workflow.relative_path = temporary_prefix OR workflow.relative_path LIKE temporary_prefix_pattern ESCAPE '\\';

  RETURN QUERY
    SELECT workflow_folders.relative_path, workflow_folders.name, workflow_folders.parent_relative_path, workflow_folders.updated_at, moved_paths
    FROM workflow_folders
    WHERE workflow_folders.relative_path = target_relative_path;
END;
$$;

CREATE TABLE IF NOT EXISTS workflow_recordings (
  recording_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  source_project_name TEXT NOT NULL,
  source_project_relative_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  endpoint_name_at_execution TEXT NOT NULL,
  execution_surface TEXT NULL,
  graph_id_at_execution TEXT NULL,
  graph_name_at_execution TEXT NULL,
  revision_key_at_execution TEXT NULL,
  ui_graph_id_at_execution TEXT NULL,
  ui_graph_name_at_execution TEXT NULL,
  web_app_slug_at_execution TEXT NULL,
  component_id_at_execution TEXT NULL,
  component_type_at_execution TEXT NULL,
  component_label_at_execution TEXT NULL,
  error_message TEXT NULL,
  recording_blob_key TEXT NOT NULL,
  replay_project_blob_key TEXT NOT NULL,
  replay_dataset_blob_key TEXT NULL,
  has_replay_dataset BOOLEAN NOT NULL DEFAULT FALSE,
  recording_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  recording_uncompressed_bytes INTEGER NOT NULL DEFAULT 0,
  project_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  project_uncompressed_bytes INTEGER NOT NULL DEFAULT 0,
  dataset_compressed_bytes INTEGER NOT NULL DEFAULT 0,
  dataset_uncompressed_bytes INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS execution_surface TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS graph_id_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS graph_name_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS revision_key_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS ui_graph_id_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS ui_graph_name_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS web_app_slug_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS component_id_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS component_type_at_execution TEXT NULL;
ALTER TABLE workflow_recordings ADD COLUMN IF NOT EXISTS component_label_at_execution TEXT NULL;

CREATE INDEX IF NOT EXISTS workflow_recordings_workflow_id_idx ON workflow_recordings(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_recordings_created_at_idx ON workflow_recordings(created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_recordings_endpoint_created_at_idx
  ON workflow_recordings(workflow_id, (LOWER(BTRIM(endpoint_name_at_execution))), created_at DESC, recording_id DESC);
CREATE INDEX IF NOT EXISTS workflow_recordings_statistics_target_idx
  ON workflow_recordings(
    execution_surface,
    workflow_id,
    ui_graph_id_at_execution,
    component_id_at_execution,
    run_kind,
    created_at DESC
  );

-- The web-app WebSocket transport keeps a compact, short-lived durable ledger.
-- This is intentionally separate from workflow_recordings: it exists for action
-- reconnect/replay and cancellation routing, while recordings remain the long-term
-- editor replay artifact.
CREATE TABLE IF NOT EXISTS web_app_action_runs (
  run_id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  request_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_scope, request_id)
);

CREATE INDEX IF NOT EXISTS web_app_action_runs_lease_idx
  ON web_app_action_runs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS web_app_action_runs_host_idx
  ON web_app_action_runs(host_id, status);

CREATE TABLE IF NOT EXISTS web_app_action_run_events (
  run_id TEXT NOT NULL REFERENCES web_app_action_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS web_app_action_cancel_commands (
  run_id TEXT PRIMARY KEY REFERENCES web_app_action_runs(run_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS web_app_action_cancel_commands_pending_idx
  ON web_app_action_cancel_commands(host_id, requested_at)
  WHERE acknowledged_at IS NULL;

-- Operational LLM Profile circuit state is deliberately separate from project
-- revisions and user Stored Values. JSONB keeps the host store forward-compatible
-- with the public Rivet health-store contract while row locks make transitions
-- atomic across execution pods.
CREATE TABLE IF NOT EXISTS llm_profile_health (
  key TEXT PRIMARY KEY,
  project_id TEXT NULL,
  entry_json JSONB NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE llm_profile_health
  ADD COLUMN IF NOT EXISTS project_id TEXT NULL;

CREATE INDEX IF NOT EXISTS llm_profile_health_project_id_idx
  ON llm_profile_health(project_id);

CREATE INDEX IF NOT EXISTS llm_profile_health_updated_at_idx
  ON llm_profile_health(updated_at DESC);

-- Evaluation definitions stay in project revisions; complete run summaries are
-- durable operational data. Project deletion cascades these rows alongside
-- existing recordings and never leaks historical results into project YAML.
CREATE TABLE IF NOT EXISTS evaluation_runs (
  project_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  suite_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  run_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, run_id)
);

CREATE INDEX IF NOT EXISTS evaluation_runs_project_started_idx
  ON evaluation_runs(project_id, started_at DESC);

CREATE INDEX IF NOT EXISTS evaluation_runs_project_suite_idx
  ON evaluation_runs(project_id, suite_id);

-- Replayable artifacts stay outside compact EvaluationRun summaries. They are
-- project-scoped and cascade with the project, so a project deletion cannot
-- leave raw model outputs or recordings behind.
CREATE TABLE IF NOT EXISTS evaluation_recordings (
  project_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, recording_id)
);

CREATE INDEX IF NOT EXISTS evaluation_recordings_project_run_idx
  ON evaluation_recordings(project_id, run_id);

-- Raw cases are retained only as immutable, content-addressed snapshots for
-- historical Evaluation runs. Project baselines remain compact metrics.
CREATE TABLE IF NOT EXISTS evaluation_dataset_snapshots (
  project_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  dataset_fingerprint TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, dataset_fingerprint)
);
`;
