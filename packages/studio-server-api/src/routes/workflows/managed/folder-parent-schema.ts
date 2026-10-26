/** Migration 17. Keep historical migrations immutable. */
export const MANAGED_FOLDER_MOVE_SQL = String.raw`
CREATE OR REPLACE FUNCTION move_managed_workflow_folder(
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
  source_prefix_pattern TEXT := replace(replace(replace(source_relative_path, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  temporary_prefix_pattern TEXT := replace(replace(replace(temporary_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  moved_paths TEXT[] := ARRAY[]::TEXT[];
BEGIN
  PERFORM pg_advisory_xact_lock(8071, 24016);
  PERFORM 1 FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM workflow_folders AS folder
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\'
  FOR UPDATE;
  IF target_parent_relative_path <> '' THEN
    PERFORM 1 FROM workflow_folders AS folder
    WHERE folder.relative_path = target_parent_relative_path FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM workflow_folders AS folder WHERE folder.relative_path = target_relative_path) THEN
    RAISE EXCEPTION 'Folder already exists: %', folder_name USING ERRCODE = '23505';
  END IF;
  WITH locked_workflows AS (
    SELECT workflow.relative_path FROM workflows AS workflow
    WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\'
    ORDER BY workflow.relative_path ASC FOR UPDATE
  )
  SELECT COALESCE(array_agg(locked_workflows.relative_path ORDER BY locked_workflows.relative_path ASC), ARRAY[]::TEXT[])
  INTO moved_paths FROM locked_workflows;

  UPDATE workflow_folders AS folder
  SET relative_path = CASE WHEN folder.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(folder.relative_path from char_length(source_relative_path) + 1) END,
      parent_relative_path = CASE
        WHEN folder.parent_relative_path = source_relative_path THEN temporary_prefix
        WHEN folder.parent_relative_path LIKE source_prefix_pattern ESCAPE '\' THEN temporary_prefix || substring(folder.parent_relative_path from char_length(source_relative_path) + 1)
        ELSE folder.parent_relative_path END,
      updated_at = NOW()
  WHERE folder.relative_path = source_relative_path OR folder.relative_path LIKE source_prefix_pattern ESCAPE '\';

  UPDATE workflows AS workflow
  SET relative_path = CASE WHEN workflow.relative_path = source_relative_path THEN temporary_prefix
        ELSE temporary_prefix || substring(workflow.relative_path from char_length(source_relative_path) + 1) END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = source_relative_path THEN temporary_prefix
        WHEN workflow.folder_relative_path LIKE source_prefix_pattern ESCAPE '\' THEN temporary_prefix || substring(workflow.folder_relative_path from char_length(source_relative_path) + 1)
        ELSE workflow.folder_relative_path END,
      updated_at = NOW()
  WHERE workflow.relative_path = source_relative_path OR workflow.relative_path LIKE source_prefix_pattern ESCAPE '\';

  UPDATE workflow_folders AS folder
  SET relative_path = CASE WHEN folder.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(folder.relative_path from char_length(temporary_prefix) + 1) END,
      name = CASE WHEN folder.relative_path = temporary_prefix THEN folder_name ELSE folder.name END,
      parent_relative_path = CASE
        WHEN folder.relative_path = temporary_prefix THEN target_parent_relative_path
        WHEN folder.parent_relative_path = temporary_prefix THEN target_relative_path
        WHEN folder.parent_relative_path LIKE temporary_prefix_pattern ESCAPE '\' THEN target_relative_path || substring(folder.parent_relative_path from char_length(temporary_prefix) + 1)
        ELSE folder.parent_relative_path END,
      updated_at = NOW()
  WHERE folder.relative_path = temporary_prefix OR folder.relative_path LIKE temporary_prefix_pattern ESCAPE '\';

  UPDATE workflows AS workflow
  SET relative_path = CASE WHEN workflow.relative_path = temporary_prefix THEN target_relative_path
        ELSE target_relative_path || substring(workflow.relative_path from char_length(temporary_prefix) + 1) END,
      folder_relative_path = CASE
        WHEN workflow.folder_relative_path = temporary_prefix THEN target_relative_path
        WHEN workflow.folder_relative_path LIKE temporary_prefix_pattern ESCAPE '\' THEN target_relative_path || substring(workflow.folder_relative_path from char_length(temporary_prefix) + 1)
        ELSE workflow.folder_relative_path END,
      updated_at = NOW()
  WHERE workflow.relative_path = temporary_prefix OR workflow.relative_path LIKE temporary_prefix_pattern ESCAPE '\';

  RETURN QUERY SELECT folder.relative_path, folder.name, folder.parent_relative_path, folder.updated_at, moved_paths
    FROM workflow_folders AS folder WHERE folder.relative_path = target_relative_path;
END;
$$;
`;

export const MANAGED_FOLDER_PARENT_MIGRATION_SQL =
  String.raw`
-- Same lease as folder/project writers and migration 16's topology triggers.
SELECT pg_advisory_xact_lock(8071, 24016);
DO $$
BEGIN
  IF EXISTS (
    WITH paths AS (
      SELECT relative_path, CASE WHEN position('/' in relative_path) = 0 THEN ''
        ELSE regexp_replace(relative_path, '/[^/]+$', '') END AS expected_parent
      FROM workflow_folders
    )
    SELECT 1 FROM paths LEFT JOIN workflow_folders parent ON parent.relative_path = paths.expected_parent
    WHERE paths.relative_path = '' OR paths.relative_path ~ '(^/|/$|//|(^|/)[.]{1,2}(/|$)|[[:cntrl:]])'
      OR strpos(paths.relative_path, E'\\') > 0
      OR (paths.expected_parent <> '' AND parent.relative_path IS NULL)
  ) THEN
    RAISE EXCEPTION 'Folder topology requires review: noncanonical paths or missing destination parents'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
-- Paths were already moved successfully. Correct only parent metadata, never
-- recreate folders, change bundle/workflow identities or rewrite saved blobs.
WITH paths AS (
  SELECT relative_path, CASE WHEN position('/' in relative_path) = 0 THEN ''
    ELSE regexp_replace(relative_path, '/[^/]+$', '') END AS expected_parent
  FROM workflow_folders
)
UPDATE workflow_folders folder SET parent_relative_path = paths.expected_parent, updated_at = NOW()
FROM paths WHERE folder.relative_path = paths.relative_path
  AND folder.parent_relative_path IS DISTINCT FROM paths.expected_parent;
` + MANAGED_FOLDER_MOVE_SQL;
