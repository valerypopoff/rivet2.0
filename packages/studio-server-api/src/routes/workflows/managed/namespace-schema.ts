/** Unreleased migration 17: namespace identity and bounded recovery receipts. */
export const MANAGED_NAMESPACE_SCHEMA_SQL = `
ALTER TABLE workflow_folders ADD COLUMN namespace_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE workflow_folders ADD CONSTRAINT workflow_folders_namespace_id_key UNIQUE(namespace_id);
CREATE TABLE workflow_namespace_receipts (
  operation_id UUID PRIMARY KEY,
  request_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX workflow_namespace_receipts_expires_at_idx ON workflow_namespace_receipts(expires_at);
`;
