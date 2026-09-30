import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { collectSourceAppSettings } from './migrate-app-settings.js';

/**
 * Copy only App Settings into an inactive candidate SQLite database. This is
 * not a backend selector or a safe local-storage cutover by itself.
 */
export async function migrateLocalAppSettings(options: {
  sourceRoot: string;
  databasePath: string;
  encryptionKey: string;
  verifyOnly?: boolean;
}): Promise<number> {
  const expected = await collectSourceAppSettings(options.sourceRoot);
  if (options.verifyOnly) {
    const stat = await fs.stat(options.databasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error('Candidate local metadata database does not exist.');
      throw error;
    });
    if (!stat.isFile()) throw new Error('Candidate local metadata database is not a regular file.');
  }
  const backend = new SqliteAppSettingsBackend({
    databasePath: options.databasePath,
    encryptionSecret: options.encryptionKey,
  });
  try {
    await backend.initialize({ readOnly: options.verifyOnly });
    const expectedKeys = new Set(expected.map((row) => row.key));
    for (const key of backend.listKeys()) {
      if (!expectedKeys.has(key)) throw new Error(`Unexpected candidate App Settings domain: ${key}`);
    }
    for (const row of expected) {
      let stored = await backend.read(row.key);
      if (!stored && !options.verifyOnly) {
        stored = await backend.write({
          key: row.key,
          expectedRevision: null,
          schemaVersion: row.schemaVersion,
          value: row.value,
          sourceHash: row.sourceHash,
        });
        stored ??= await backend.read(row.key);
      }
      if (
        !stored ||
        stored.revision !== 1n ||
        stored.schemaVersion !== row.schemaVersion ||
        stored.sourceHash !== row.sourceHash ||
        !isDeepStrictEqual(stored.value, row.value)
      ) {
        throw new Error(`Candidate App Settings domain differs from the source: ${row.key}`);
      }
    }
    const after = await collectSourceAppSettings(options.sourceRoot);
    if (!isDeepStrictEqual(after, expected)) {
      throw new Error('Source App Settings changed during the candidate copy; retry from a frozen source.');
    }
    return expected.length;
  } finally {
    await backend.dispose();
  }
}
