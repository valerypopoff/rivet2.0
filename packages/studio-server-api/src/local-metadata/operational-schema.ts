import type { DatabaseSync } from 'node:sqlite';

const schemas = {
  evaluations: {
    evaluation_library: ['singleton_key', 'revision', 'library_json', 'updated_at_ms'],
    evaluation_library_imports: ['source_fingerprint', 'imported_at_ms'],
    evaluation_runs: ['project_id', 'run_id', 'suite_id', 'started_at', 'run_json', 'updated_at_ms'],
    evaluation_recordings: ['project_id', 'recording_id', 'run_id', 'artifact_json', 'created_at_ms'],
    evaluation_dataset_snapshots: ['project_id', 'dataset_fingerprint', 'snapshot_json', 'created_at_ms'],
    evaluation_deleted_projects: ['project_id', 'deleted_at_ms'],
  },
  health: { llm_profile_health: ['key', 'project_id', 'entry_json', 'updated_at_ms'] },
} as const;

/** Selected databases are authorities, not rebuildable indexes. Check before
 * any CREATE IF NOT EXISTS/legacy migration can disguise missing metadata. */
export function assertLocalOperationalSchema(database: DatabaseSync, domain: keyof typeof schemas): void {
  const integrity = database.prepare('PRAGMA quick_check').all<{ quick_check: string }>();
  if (
    integrity.length !== 1 ||
    integrity[0]?.quick_check !== 'ok' ||
    database.prepare('PRAGMA foreign_key_check').get()
  )
    throw new Error('Selected operational database failed integrity checks.');
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  if (tables.length !== Object.keys(schemas[domain]).length)
    throw new Error('Selected operational database has unexpected or missing tables.');
  for (const [table, required] of Object.entries(schemas[domain])) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (required.some((column: string) => !columns.some((actual) => actual.name === column)))
      throw new Error('Selected operational database has an incomplete schema; restore its coordinated backup.');
  }
}

export function assertEmptyLocalOperationalDatabase(database: DatabaseSync, domain: keyof typeof schemas): void {
  assertLocalOperationalSchema(database, domain);
  for (const table of Object.keys(schemas[domain]))
    if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      throw new Error('An absent source domain has unexpected candidate records.');
}
