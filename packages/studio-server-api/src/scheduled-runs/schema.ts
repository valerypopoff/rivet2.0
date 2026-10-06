// Shared SQL deliberately uses portable scalar columns, not a settings blob.
export const SCHEDULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rivet_schedules (
  id TEXT PRIMARY KEY, revision BIGINT NOT NULL, enabled INTEGER NOT NULL,
  next_at BIGINT NULL, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rivet_schedules_due_idx ON rivet_schedules(enabled, next_at);
CREATE TABLE IF NOT EXISTS rivet_schedule_runs (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, status TEXT NOT NULL,
  owner TEXT NULL, lease_until BIGINT NULL, scheduled_at BIGINT NOT NULL,
  json TEXT NOT NULL, draft_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rivet_schedule_runs_active_idx ON rivet_schedule_runs(status, lease_until);
CREATE INDEX IF NOT EXISTS rivet_schedule_runs_history_idx ON rivet_schedule_runs(schedule_id, scheduled_at);
CREATE TABLE IF NOT EXISTS rivet_schedule_installation (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rivet_schedule_requests (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at BIGINT NOT NULL,
  resource_id TEXT NOT NULL, json TEXT NOT NULL
);
`;
