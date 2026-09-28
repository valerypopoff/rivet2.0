import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLocalMetadataServingSelection } from './serving-selection.js';

/** Keep this leaf module independent of Settings/security/source importers:
 * those construct repositories during module evaluation. Every selected write
 * rechecks the durable revision; a deleted marker cannot revive old processes. */
export function assertLocalMetadataWritesAllowed(): void {
  const root = process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT?.trim();
  if (!root) return;
  const appData = process.env.RIVET_APP_DATA_ROOT?.trim();
  if (!path.isAbsolute(root) || !appData || !path.isAbsolute(appData))
    throw new Error('Explicit local metadata control and app-data paths are required.');
  try {
    lstatSync(path.join(appData, 'vm-migration-maintenance.json'));
    throw new Error('Local metadata writes are paused for the storage upgrade.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const file = path.join(root, 'transition.sqlite');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local metadata transition journal.');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT phase, generation_id, revision FROM transition_state').all() as Array<{
      phase: string;
      generation_id: string | null;
      revision: number;
    }>;
    const row = rows[0],
      selected = getLocalMetadataServingSelection();
    if (
      db.prepare('PRAGMA application_id').get()?.application_id !== 0x5249544a ||
      db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
      rows.length !== 1 ||
      !row ||
      row.revision !== Number(process.env.RIVET_LOCAL_METADATA_BOOT_REVISION) ||
      (selected
        ? row.phase !== 'sqlite-live' || row.generation_id !== selected.generationId
        : !['legacy', 'legacy-resumed'].includes(row.phase))
    )
      throw new Error('Local metadata selection is paused or requires a coordinated backend restart.');
  } finally {
    db.close();
  }
}
