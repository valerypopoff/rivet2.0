/** Additive schema; no FK to the mutable project catalog: history outlives projects. */
export const RECORDING_EVIDENCE_SCHEMA_SQL = `
CREATE TABLE workflow_run_evidence (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ NOT NULL,
  upload_until TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','running','succeeded','failed','suspicious','unknown')),
  availability TEXT NOT NULL CHECK (availability IN ('pending','available','unavailable','deleted')),
  reason TEXT NULL CHECK (reason IN ('capacity','capture_incomplete','serialization_failed','upload_incomplete','persistence_failed')),
  input_json JSONB NOT NULL CHECK (octet_length(input_json::text) <= 32768),
  outcome_json JSONB NULL CHECK (octet_length(outcome_json::text) <= 4096),
  child_coverage TEXT NOT NULL DEFAULT 'unknown' CHECK (child_coverage IN ('unknown','complete','incomplete')),
  manifest_json JSONB NULL CHECK (octet_length(manifest_json::text) <= 65536),
  fingerprint TEXT NULL,
  handoff_ready BOOLEAN NOT NULL DEFAULT FALSE,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  pending_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_bytes >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX workflow_run_evidence_history_idx ON workflow_run_evidence(workflow_id, created_at DESC, run_id DESC);
CREATE INDEX workflow_run_evidence_pending_idx ON workflow_run_evidence(next_attempt_at, run_id) WHERE availability = 'pending';
CREATE INDEX workflow_run_evidence_notification_idx ON workflow_run_evidence(next_attempt_at, run_id) WHERE availability = 'available' AND NOT notified;
CREATE INDEX workflow_run_evidence_global_history_idx ON workflow_run_evidence(created_at DESC, run_id DESC);
CREATE INDEX workflow_run_evidence_root_idx ON workflow_run_evidence((input_json->>'rootId'));
CREATE INDEX workflow_run_evidence_lease_idx ON workflow_run_evidence(lease_until) WHERE state IN ('accepted','running');
CREATE FUNCTION rivet_recording_evidence_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workflow_run_evidence SET availability='deleted', manifest_json=NULL, pending_bytes=0,
    updated_at=NOW() WHERE run_id=OLD.recording_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER workflow_recording_evidence_deleted AFTER DELETE ON workflow_recordings
FOR EACH ROW EXECUTE FUNCTION rivet_recording_evidence_deleted();
`;

/** Exact source-owned trigger; a restore must still reject modified or custom triggers. */
export const RECORDING_EVIDENCE_RESTORE_GUARDS = [
  {
    name: 'workflow_recording_evidence_deleted',
    table_name: 'workflow_recordings',
    function_name: 'rivet_recording_evidence_deleted',
    definition:
      'CREATE TRIGGER workflow_recording_evidence_deleted AFTER DELETE ON workflow_recordings FOR EACH ROW EXECUTE FUNCTION rivet_recording_evidence_deleted()',
    source: RECORDING_EVIDENCE_SCHEMA_SQL.match(
      /CREATE FUNCTION rivet_recording_evidence_deleted\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )![1]!,
  },
];
