export const ENDPOINT_RELEASE_SCHEMA_SQL = `
CREATE TABLE workflow_endpoint_releases (
  release_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
  manifest JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE workflow_endpoint_release_projects (
  release_id TEXT NOT NULL REFERENCES workflow_endpoint_releases(release_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  project_blob_key TEXT NOT NULL,
  dataset_blob_key TEXT NULL,
  PRIMARY KEY (release_id, revision_id)
);
ALTER TABLE workflow_published_versions
  ADD COLUMN release_id TEXT NULL REFERENCES workflow_endpoint_releases(release_id) ON DELETE CASCADE,
  ADD COLUMN restored_from TEXT NULL;
CREATE INDEX workflow_endpoint_releases_owner_idx ON workflow_endpoint_releases(workflow_id);
CREATE INDEX workflow_published_versions_release_idx ON workflow_published_versions(release_id);
`;
