import { createRequire } from 'node:module';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Loaded conditionally: desktop executors on older Node releases do not need
 * node:sqlite. A supervised VM executor checks the same durable boot revision
 * as the API, so removing maintenance cannot revive an old process. */
export function assertLocalMetadataExecutorAdmission(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.RIVET_LOCAL_METADATA_CONTROL_ROOT || env.RIVET_RUNTIME_PROCESS_ROLE !== 'executor') return;
  const file = join(env.RIVET_LOCAL_METADATA_CONTROL_ROOT, 'transition.sqlite');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local metadata selection.');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT phase, generation_id, revision FROM transition_state WHERE singleton = 1').get();
    const generation = env.RIVET_LOCAL_METADATA_BOOT_GENERATION || '';
    if (
      db.prepare('PRAGMA application_id').get()?.application_id !== 0x5249544a ||
      !row ||
      row.revision !== Number(env.RIVET_LOCAL_METADATA_BOOT_REVISION) ||
      (generation
        ? row.phase !== 'sqlite-live' || row.generation_id !== generation
        : !['legacy', 'legacy-resumed'].includes(row.phase))
    )
      throw new Error('Local metadata selection is paused or requires a coordinated restart.');
  } finally {
    db.close();
  }
}
