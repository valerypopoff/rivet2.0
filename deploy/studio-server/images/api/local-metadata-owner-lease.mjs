import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x52494f4c;
const SCHEMA = 'CREATE TABLE owner_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))';
const normalized = (value) => value.replace(/\s+/g, ' ').trim();

function realDirectory(directory) {
  let cursor = path.resolve(directory);
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Local metadata control needs a real persistent directory.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

/** SQLite releases this process-independent lock on process death. No stale
 * PID file may be deleted to bypass a still-running serving owner/converter.
 * Offline recovery still requires stopping the whole container: a killed
 * supervisor can leave child processes alive outside this advisory lease. */
export function acquireLocalMetadataOwnerLease(controlRoot, { requireExisting = false } = {}) {
  if (!path.isAbsolute(controlRoot)) throw new Error('Local metadata control root must be absolute.');
  realDirectory(controlRoot);
  const file = path.join(controlRoot, 'owner-lock.sqlite');
  let created = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local metadata owner lock.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (requireExisting)
      throw new Error(
        'Recovery requires a previously provisioned serving-owner lock; start the supported backend before conversion.',
      );
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    created = true;
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    if (created) {
      db.exec(SCHEMA);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; COMMIT`);
      const fd = fs.openSync(controlRoot, 'r');
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code))
          throw error;
      } finally {
        fs.closeSync(fd);
      }
      db.exec('BEGIN IMMEDIATE');
    }
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (
      db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
      db.prepare('PRAGMA user_version').get().user_version !== 1 ||
      objects.length !== 1 ||
      normalized(objects[0].sql) !== normalized(SCHEMA) ||
      db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
    )
      throw new Error('Local metadata owner lock is damaged or incompatible.');
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        db.close();
      },
    };
  } catch (error) {
    db.close();
    if (error.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message))
      throw new Error('Another backend, converter or recovery process owns local metadata. Stop it before recovery.');
    throw error;
  }
}

/** Only an explicitly aware combined supervisor may select SQLite. Old startup
 * callers remain fail-closed rather than falling back to retained files. */
export function assertLegacyLocalMetadataStartup(controlRoot, appDataRoot, { allowSqlite = false } = {}) {
  const journalPath = path.join(controlRoot, 'transition.sqlite');
  try {
    const stat = fs.lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local metadata transition journal.');
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('Local metadata transition journal is missing; refusing a legacy fallback.');
    throw error;
  }
  const db = new DatabaseSync(journalPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT phase, generation_id, revision FROM transition_state').all();
    if (
      db.prepare('PRAGMA application_id').get().application_id !== 0x5249544a ||
      db.prepare('PRAGMA user_version').get().user_version !== 1 ||
      rows.length !== 1 ||
      !['legacy', 'verified', 'sqlite-validation', 'sqlite-live', 'legacy-validation', 'legacy-resumed'].includes(
        rows[0].phase,
      ) ||
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    )
      throw new Error('Invalid local metadata transition selection.');
    const phase = rows[0].phase;
    if (phase.startsWith('sqlite-') && !allowSqlite)
      throw new Error(
        'This image cannot yet serve an activated local SQLite generation. Return to legacy while paused; do not bypass the selection.',
      );
    if (phase === 'verified' || phase === 'legacy-validation' || phase === 'sqlite-validation') {
      const marker = path.join(appDataRoot, 'vm-migration-maintenance.json');
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Paused local metadata selection requires its maintenance fence.');
      const fence = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (fence.version !== 1 || typeof fence.enteredAt !== 'string' || !Number.isFinite(Date.parse(fence.enteredAt)))
        throw new Error('Paused local metadata selection has an invalid maintenance fence.');
    }
    if (phase.startsWith('sqlite-') && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(rows[0].generation_id ?? ''))
      throw new Error('Invalid selected local generation.');
    if (!Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1)
      throw new Error('Invalid local startup revision.');
    return {
      phase,
      revision: rows[0].revision,
      generationId: phase.startsWith('sqlite-') ? rows[0].generation_id : '',
    };
  } finally {
    db.close();
  }
}
