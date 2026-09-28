import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import { syncDirectory, syncFileDescriptor } from '../routes/workflows/filesystem-transaction-primitives.js';

export type LocalSqliteSnapshotProof = {
  logicalHash: string;
  tables: Array<{ name: string; rows: number }>;
};

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// This package's older Node typings predate these APIs. The production runtime
// must provide Node >=22.16; capability checks fail before creating a backup.
type SnapshotStatement = ReturnType<DatabaseSync['prepare']> & {
  setReadBigInts(enabled: boolean): void;
  iterate(): Iterable<Record<string, unknown>>;
};
const sqliteBackup = (
  sqlite as unknown as {
    backup?: (source: DatabaseSync, destination: string, options: { rate: number }) => Promise<number>;
  }
).backup;

function encode(value: unknown): string {
  if (typeof value === 'bigint') return `integer:${value}`;
  // JSON turns both infinities into null. They are valid SQLite REAL values
  // and must not produce the same logical proof as each other.
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'real:NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'real:+Infinity' : 'real:-Infinity';
    return `real:${Object.is(value, -0) ? '-0' : value}`;
  }
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('hex')}`;
  if (value === null) return 'null';
  return `${typeof value}:${JSON.stringify(value)}`;
}

function inspect(db: DatabaseSync): LocalSqliteSnapshotProof {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
    throw new Error('Local SQLite snapshot failed integrity checks.');
  const hash = createHash('sha256');
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  for (const pragma of ['application_id', 'user_version', 'encoding'])
    add(JSON.stringify(db.prepare(`PRAGMA ${pragma}`).get()));
  const schema = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  for (const entry of schema) add(JSON.stringify(entry));
  const tables: LocalSqliteSnapshotProof['tables'] = [];
  const names = schema.filter((entry) => entry.type === 'table').map((entry) => entry.name);
  // AUTOINCREMENT sequence state affects the next write and is not disposable.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) names.push('sqlite_sequence');
  for (const name of names.sort()) {
    const columns = (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    if (!columns.length) throw new Error('Local SQLite snapshot contains an unsupported table.');
    add(name);
    add(JSON.stringify(columns));
    const order = columns.flatMap((column) => [
      `typeof(${quote(column)}) COLLATE BINARY`,
      `${quote(column)} COLLATE BINARY`,
    ]);
    const statement = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order.join(', ')}`) as SnapshotStatement;
    if (typeof statement.setReadBigInts !== 'function' || typeof statement.iterate !== 'function')
      throw new Error('Local SQLite snapshots require Node 22.16 or newer.');
    statement.setReadBigInts(true);
    let rows = 0;
    for (const row of statement.iterate()) {
      for (const column of columns) add(encode(row[column]));
      rows++;
    }
    tables.push({ name, rows });
  }
  return { logicalHash: hash.digest('hex'), tables };
}

async function regularPath(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Local SQLite snapshot requires a regular database file.');
  // A symlinked parent is not an owned persistent path, even if its leaf is real.
  await realDirectory(path.dirname(path.resolve(filePath)));
}

async function realDirectory(directory: string): Promise<void> {
  let cursor = path.resolve(directory);
  while (true) {
    const parent = await fs.lstat(cursor);
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error('Local SQLite snapshot path has an unsafe parent.');
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

/** Logical proof, not a hash of a live main file that can omit committed WAL data. */
export async function inspectLocalSqliteSnapshot(databasePath: string): Promise<LocalSqliteSnapshotProof> {
  databasePath = path.resolve(databasePath);
  await regularPath(databasePath);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN');
    return inspect(db);
  } finally {
    db.close();
  }
}

/**
 * Create an immutable, readback-verified SQLite backup using SQLite's backup
 * API. The owner must establish and enforce a drained maintenance fence. This
 * is one member of a coordinated backup, not a whole-installation certificate.
 * No source file, journal, schema or permissions are changed deliberately.
 */
export async function createVerifiedLocalSqliteSnapshot(options: {
  sourcePath: string;
  destinationPath: string;
  assertFrozen: () => Promise<void>;
}): Promise<LocalSqliteSnapshotProof> {
  const { assertFrozen } = options;
  if (typeof sqliteBackup !== 'function') throw new Error('Local SQLite backups require Node 22.16 or newer.');
  const sourcePath = path.resolve(options.sourcePath);
  const destinationPath = path.resolve(options.destinationPath);
  if (sourcePath === destinationPath) throw new Error('SQLite backup must not replace its source.');
  await assertFrozen();
  await regularPath(sourcePath);
  // The owner provisions and syncs the destination directory before snapshotting.
  const parent = path.dirname(destinationPath);
  await realDirectory(parent);
  const temporaryPath = path.join(parent, `.sqlite-backup-${randomUUID()}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN');
    const expected = inspect(source);
    await assertFrozen();
    // Never overwrite a previous backup. Existing data is accepted only after
    // complete schema/row comparison, including BLOBs and 64-bit integers.
    try {
      const existing = await inspectLocalSqliteSnapshot(destinationPath);
      if (existing.logicalHash !== expected.logicalHash) throw new Error('Existing SQLite backup differs from source.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const reserved = await fs.open(temporaryPath, 'wx', 0o600);
      await reserved.close();
      await sqliteBackup(source, temporaryPath, { rate: 100 });
      const actual = await inspectLocalSqliteSnapshot(temporaryPath);
      if (actual.logicalHash !== expected.logicalHash) throw new Error('SQLite backup readback differs from source.');
      const handle = await fs.open(temporaryPath, 'r+');
      try {
        await syncFileDescriptor(handle.fd);
      } finally {
        await handle.close();
      }
      await assertFrozen();
      await fs.link(temporaryPath, destinationPath);
      await syncDirectory(parent);
    }
    source.exec('ROLLBACK');
    await assertFrozen();
    const fresh = await inspectLocalSqliteSnapshot(sourcePath);
    if (fresh.logicalHash !== expected.logicalHash) throw new Error('SQLite source changed during backup.');
    const final = await inspectLocalSqliteSnapshot(destinationPath);
    if (final.logicalHash !== expected.logicalHash) throw new Error('SQLite backup changed after publication.');
    // Sync retries too: another writer's pending directory sync is not evidence.
    await syncDirectory(parent);
    return final;
  } finally {
    source.close();
    await fs.rm(temporaryPath, { force: true });
  }
}
