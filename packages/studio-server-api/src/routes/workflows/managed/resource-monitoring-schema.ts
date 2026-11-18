export const RESOURCE_MONITORING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_monitoring_instances (
  installation TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  allocation JSONB NOT NULL,
  first_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  latest JSONB NOT NULL,
  dropped_samples BIGINT NOT NULL,
  PRIMARY KEY (installation, incarnation)
);
CREATE INDEX IF NOT EXISTS resource_monitoring_instances_recent_idx
  ON resource_monitoring_instances(installation, last_at DESC);
CREATE TABLE IF NOT EXISTS resource_monitoring_minutes (
  installation TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  bucket_at BIGINT NOT NULL,
  revision BIGINT NOT NULL,
  samples JSONB NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (installation, incarnation, bucket_at)
);
CREATE INDEX IF NOT EXISTS resource_monitoring_minutes_time_idx
  ON resource_monitoring_minutes(installation, bucket_at);
`;
