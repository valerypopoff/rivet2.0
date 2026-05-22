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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_revisions_workflow_id_idx ON workflow_revisions(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_published_versions (
  version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  endpoint_name TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE
);

ALTER TABLE workflow_published_versions ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;

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

CREATE INDEX IF NOT EXISTS workflow_recordings_workflow_id_idx ON workflow_recordings(workflow_id);
CREATE INDEX IF NOT EXISTS workflow_recordings_created_at_idx ON workflow_recordings(created_at DESC);
`;
