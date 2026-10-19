/** Additive: existing project and portable archive formats are unchanged. */
export const MANAGED_BUNDLE_SCHEMA_SQL = `
ALTER TABLE workflow_folders ADD COLUMN bundle_id UUID NULL;
ALTER TABLE workflow_folders ADD CONSTRAINT workflow_folders_bundle_id_key UNIQUE(bundle_id);

-- Old API replicas also pass through these guards. Check the final topology,
-- not the temporary paths used by the existing folder move function.
CREATE FUNCTION lock_workflow_bundle_topology() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(8071, 24016);
  IF TG_LEVEL = 'ROW' THEN RETURN NEW; END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER workflow_bundle_topology_lock BEFORE INSERT OR UPDATE OR DELETE ON workflow_folders
FOR EACH STATEMENT EXECUTE FUNCTION lock_workflow_bundle_topology();
CREATE TRIGGER workflow_project_topology_lock BEFORE INSERT OR DELETE ON workflows
FOR EACH STATEMENT EXECUTE FUNCTION lock_workflow_bundle_topology();
CREATE TRIGGER workflow_project_move_topology_lock BEFORE UPDATE OF relative_path, folder_relative_path ON workflows
FOR EACH ROW WHEN (OLD.relative_path IS DISTINCT FROM NEW.relative_path OR OLD.folder_relative_path IS DISTINCT FROM NEW.folder_relative_path)
EXECUTE FUNCTION lock_workflow_bundle_topology();
CREATE FUNCTION check_workflow_bundle_topology() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bundle_id IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM workflow_folders child JOIN workflow_folders ancestor
    ON child.relative_path <> ancestor.relative_path
    AND left(child.relative_path, length(ancestor.relative_path) + 1) = ancestor.relative_path || '/'
    WHERE child.bundle_id IS NOT NULL AND ancestor.bundle_id IS NOT NULL
      AND (child.bundle_id = NEW.bundle_id OR ancestor.bundle_id = NEW.bundle_id)
  ) THEN
    RAISE EXCEPTION 'Bundles cannot contain other bundles' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER workflow_bundle_topology_check AFTER INSERT OR UPDATE ON workflow_folders
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_bundle_topology();
`;
