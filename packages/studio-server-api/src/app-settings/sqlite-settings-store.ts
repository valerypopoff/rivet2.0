import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AppSettingsBackend, ManagedSettingsRecord, ManagedSettingsWrite } from './managed-settings-store.js';
import {
  decryptManagedSettingsValue,
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
  type ManagedSettingsEncryptionKey,
} from './managed-settings-crypto.js';

type SqliteSettingsRow = {
  setting_key: string;
  revision: number;
  schema_version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  key_id: string;
  source_hash: string | null;
};

const RIVET_LOCAL_METADATA_APPLICATION_ID = 0x52495654;
const LOCAL_METADATA_SCHEMA_VERSION = 1;
const APP_SETTINGS_TABLE_SQL = `CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  source_hash TEXT,
  updated_at TEXT NOT NULL
)`;

/**
 * Candidate local metadata backend. It is intentionally not selected by the
 * serving API until the complete local-metadata cutover can be verified.
 */
export class SqliteAppSettingsBackend implements AppSettingsBackend {
  readonly #databasePath: string;
  readonly #primaryKey: ManagedSettingsEncryptionKey;
  readonly #keys: ReadonlyMap<string, ManagedSettingsEncryptionKey>;
  readonly #listeners = new Set<(key: string) => Promise<void> | void>();
  readonly #pendingNotifications = new Map<string, number>();
  readonly #synchronizedRevisions = new Map<string, number>();
  readonly #notificationTasks = new Set<Promise<void>>();
  #db: DatabaseSync | null = null;
  #readOnly = false;
  readonly #requireExisting: boolean;
  readonly #assertWritable: () => void;

  constructor(options: {
    databasePath: string;
    encryptionSecret: string;
    previousEncryptionSecret?: string;
    requireExisting?: boolean;
    assertWritable?: () => void;
  }) {
    if (!options.encryptionSecret) throw new Error('SQLite App Settings require an encryption key.');
    this.#databasePath = options.databasePath;
    this.#requireExisting = options.requireExisting ?? false;
    this.#assertWritable = options.assertWritable ?? (() => {});
    this.#primaryKey = deriveManagedSettingsEncryptionKey(options.encryptionSecret);
    const previous = options.previousEncryptionSecret
      ? deriveManagedSettingsEncryptionKey(options.previousEncryptionSecret)
      : null;
    this.#keys = new Map(
      [this.#primaryKey, previous]
        .filter((key): key is ManagedSettingsEncryptionKey => key !== null)
        .map((key) => [key.id, key]),
    );
  }

  async initialize(options: { readOnly?: boolean } = {}): Promise<void> {
    const readOnly = options.readOnly ?? false;
    if (this.#db) {
      if (this.#readOnly !== readOnly) throw new Error('SQLite App Settings backend is already open in another mode.');
      return;
    }
    if (!readOnly) mkdirSync(path.dirname(this.#databasePath), { recursive: true, mode: 0o700 });
    try {
      const stat = lstatSync(this.#databasePath);
      if (stat.isSymbolicLink()) throw new Error('SQLite App Settings database must not be a symlink.');
      if (!stat.isFile()) throw new Error('SQLite App Settings database must be a regular file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || readOnly || this.#requireExisting) throw error;
    }

    const db = new DatabaseSync(this.#databasePath, { readOnly });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const identity = db.prepare('PRAGMA application_id').get() as { application_id: number };
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (identity.application_id !== 0 && identity.application_id !== RIVET_LOCAL_METADATA_APPLICATION_ID) {
        throw new Error('SQLite App Settings path contains a different application database.');
      }
      if (identity.application_id === 0) {
        if (readOnly) throw new Error('SQLite App Settings candidate is not initialized.');
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
        if (existing || version.user_version !== 0) {
          throw new Error('SQLite App Settings path contains an unidentified database.');
        }
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
        try {
          db.exec(APP_SETTINGS_TABLE_SQL);
          db.exec(`PRAGMA application_id = ${RIVET_LOCAL_METADATA_APPLICATION_ID}`);
          db.exec(`PRAGMA user_version = ${LOCAL_METADATA_SCHEMA_VERSION}`);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else if (version.user_version !== LOCAL_METADATA_SCHEMA_VERSION) {
        throw new Error(`SQLite App Settings schema version ${version.user_version} is unsupported.`);
      }
      if (!readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
      const storedSchema = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
        .get() as { sql: string } | undefined;
      if (storedSchema?.sql.replace(/\s+/g, ' ').trim() !== APP_SETTINGS_TABLE_SQL.replace(/\s+/g, ' ').trim()) {
        throw new Error('SQLite App Settings schema is incompatible.');
      }
      const schemaNames = db
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;
      if (schemaNames.length !== 1 || schemaNames[0]?.name !== 'app_settings') {
        throw new Error('SQLite App Settings schema contains unexpected objects.');
      }
      this.#verifyRows(db, true);
      if (!readOnly) chmodSync(this.#databasePath, 0o600);
      this.#db = db;
      this.#readOnly = readOnly;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the original initialization error.
      }
      throw error;
    }
  }

  #database(): DatabaseSync {
    if (!this.#db) throw new Error('SQLite App Settings backend is not initialized.');
    return this.#db;
  }

  listKeys(): string[] {
    return (
      this.#database().prepare('SELECT setting_key FROM app_settings ORDER BY setting_key').all() as Array<{
        setting_key: string;
      }>
    ).map((row) => row.setting_key);
  }

  async read(key: string): Promise<ManagedSettingsRecord | null> {
    const row = this.#database().prepare('SELECT * FROM app_settings WHERE setting_key = ?').get(key) as
      | SqliteSettingsRow
      | undefined;
    if (!row) return null;
    const record = this.#decodeRow(row);
    if (row.key_id !== this.#primaryKey.id && !this.#readOnly) {
      const rotated = await this.write({
        key,
        expectedRevision: record.revision,
        schemaVersion: record.schemaVersion,
        value: record.value,
        sourceHash: record.sourceHash,
      });
      return rotated ?? this.read(key);
    }
    return record;
  }

  async write(value: ManagedSettingsWrite): Promise<ManagedSettingsRecord | null> {
    this.#assertWritable();
    if (this.#readOnly) throw new Error('SQLite App Settings backend is open for verification only.');
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    let transactionOpen = true;
    let revision: number;
    try {
      const existing = db.prepare('SELECT revision FROM app_settings WHERE setting_key = ?').get(value.key) as
        | { revision: number }
        | undefined;
      if (existing && (!Number.isSafeInteger(existing.revision) || existing.revision < 1)) {
        throw new Error(`SQLite App Settings revision is invalid for ${value.key}.`);
      }
      if (existing ? value.expectedRevision !== BigInt(existing.revision) : value.expectedRevision !== null) {
        db.exec('ROLLBACK');
        transactionOpen = false;
        return null;
      }
      revision = (existing?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('SQLite App Settings revision limit reached.');
      const encrypted = encryptManagedSettingsValue(
        { key: value.key, schemaVersion: value.schemaVersion },
        value.value,
        this.#primaryKey,
      );
      db.prepare(
        `
        INSERT INTO app_settings
          (setting_key, revision, schema_version, ciphertext, iv, auth_tag, key_id, source_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(setting_key) DO UPDATE SET
          revision = excluded.revision,
          schema_version = excluded.schema_version,
          ciphertext = excluded.ciphertext,
          iv = excluded.iv,
          auth_tag = excluded.auth_tag,
          key_id = excluded.key_id,
          source_hash = excluded.source_hash,
          updated_at = excluded.updated_at
      `,
      ).run(
        value.key,
        revision,
        value.schemaVersion,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyId,
        value.sourceHash ?? null,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the write failure; a failed rollback requires reopening
          // the database and is never grounds for reporting a successful save.
        }
      }
      throw error;
    }
    const persisted: ManagedSettingsRecord = {
      key: value.key,
      revision: BigInt(revision),
      schemaVersion: value.schemaVersion,
      value: value.value,
      sourceHash: value.sourceHash ?? null,
    };
    // Refresh listeners may queue behind the repository update calling this
    // write. Awaiting them here forms a cycle: update -> write -> refresh ->
    // update. Like PostgreSQL notifications, dispatch after COMMIT without
    // making the committed writer wait for its own cache refresh. The writer
    // remembers the returned record; failed refreshes still fail health closed.
    const notification = this.#notify(value.key, revision);
    this.#notificationTasks.add(notification);
    void notification.finally(() => this.#notificationTasks.delete(notification));
    return persisted;
  }

  async #notify(key: string, revision: number): Promise<void> {
    let failed = false;
    for (const listener of this.#listeners) {
      try {
        await listener(key);
      } catch {
        failed = true;
      }
    }
    if (failed) {
      if ((this.#synchronizedRevisions.get(key) ?? 0) < revision) {
        this.#pendingNotifications.set(key, Math.max(this.#pendingNotifications.get(key) ?? 0, revision));
      }
    } else {
      this.#synchronizedRevisions.set(key, Math.max(this.#synchronizedRevisions.get(key) ?? 0, revision));
      if ((this.#pendingNotifications.get(key) ?? 0) <= revision) this.#pendingNotifications.delete(key);
    }
  }

  subscribe(listener: (key: string) => Promise<void> | void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  assertSynchronized(): void {
    if (this.#pendingNotifications.size > 0) {
      throw new Error('SQLite App Settings cache synchronization failed; retry the health check.');
    }
  }

  async checkHealth(): Promise<void> {
    await Promise.all(this.#notificationTasks);
    this.#verifyRows(this.#database());
    for (const [key, revision] of this.#pendingNotifications) {
      try {
        for (const listener of this.#listeners) await listener(key);
        this.#synchronizedRevisions.set(key, Math.max(this.#synchronizedRevisions.get(key) ?? 0, revision));
        if ((this.#pendingNotifications.get(key) ?? 0) <= revision) this.#pendingNotifications.delete(key);
      } catch {
        // Keep the key pending so reads remain fail-closed until a later retry.
      }
    }
    this.assertSynchronized();
  }

  #decodeRow(row: SqliteSettingsRow): ManagedSettingsRecord {
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error(`SQLite App Settings revision is invalid for ${row.setting_key}.`);
    }
    if (!Number.isSafeInteger(row.schema_version) || row.schema_version < 0) {
      throw new Error(`SQLite App Settings schema version is invalid for ${row.setting_key}.`);
    }
    return {
      key: row.setting_key,
      revision: BigInt(row.revision),
      schemaVersion: row.schema_version,
      value: decryptManagedSettingsValue(
        { key: row.setting_key, schemaVersion: row.schema_version },
        {
          ciphertext: Buffer.from(row.ciphertext),
          iv: Buffer.from(row.iv),
          authTag: Buffer.from(row.auth_tag),
          keyId: row.key_id,
        },
        this.#keys,
      ),
      sourceHash: row.source_hash,
    };
  }

  #verifyRows(db: DatabaseSync, fullIntegrityCheck = false): void {
    const pragma = fullIntegrityCheck ? 'integrity_check' : 'quick_check';
    const result = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, string>;
    if (result[pragma] !== 'ok') throw new Error('SQLite App Settings integrity check failed.');
    for (const row of db.prepare('SELECT * FROM app_settings').all() as SqliteSettingsRow[]) {
      this.#decodeRow(row);
    }
  }

  async dispose(): Promise<void> {
    this.#listeners.clear();
    await Promise.all(this.#notificationTasks);
    this.#pendingNotifications.clear();
    this.#synchronizedRevisions.clear();
    this.#db?.close();
    this.#db = null;
    this.#readOnly = false;
  }
}
