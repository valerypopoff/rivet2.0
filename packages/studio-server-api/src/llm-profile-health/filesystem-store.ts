import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ProjectId,
  RivetLLMProfileHealthBeginRequest,
  RivetLLMProfileHealthBeginResult,
  RivetLLMProfileHealthFinishRequest,
  RivetLLMProfileHealthListRequest,
  RivetLLMProfileHealthRenewRequest,
  RivetLLMProfileHealthResetRequest,
  RivetLLMProfileHealthSnapshot,
} from '@valerypopoff/rivet2-node';

import { getAppDataRoot } from '../security.js';
import { beginLLMProfileHealthAttempt, createLLMProfileHealthSnapshot, finishLLMProfileHealthAttempt, renewLLMProfileHealthPermit, type StoredLLMProfileHealthEntry } from './state.js';
import type { RivetStudioLLMProfileHealthStore } from './store.js';

type StoredRow = { key: string; entryJson: string };

export function getFilesystemLLMProfileHealthDatabasePath(): string {
  return path.join(getAppDataRoot(), 'llm-profile-health.sqlite');
}

function requireProjectId(
  identity: RivetLLMProfileHealthBeginRequest['identity'],
): void {
  if (identity.projectId == null || String(identity.projectId).trim() === '') {
    throw new Error('Studio Server LLM Profile health operations require a projectId.');
  }
}

function parseEntry(row: StoredRow | undefined): StoredLLMProfileHealthEntry | null {
  if (!row) return null;
  const parsed = JSON.parse(row.entryJson) as StoredLLMProfileHealthEntry;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.failureTimestamps)) {
    throw new Error(`Invalid persisted LLM Profile health entry for ${row.key}.`);
  }
  return parsed;
}

export class FilesystemRivetLLMProfileHealthStore implements RivetStudioLLMProfileHealthStore {
  readonly #databasePath: string;
  #databasePromise: Promise<DatabaseSync> | null = null;

  constructor(databasePath = getFilesystemLLMProfileHealthDatabasePath()) {
    this.#databasePath = databasePath;
  }

  async #getDatabase(): Promise<DatabaseSync> {
    this.#databasePromise ??= (async () => {
      await fs.mkdir(path.dirname(this.#databasePath), { recursive: true });
      const database = new DatabaseSync(this.#databasePath);
      try {
        database.exec(`
          PRAGMA busy_timeout = 5000;
          PRAGMA journal_mode = DELETE;
          CREATE TABLE IF NOT EXISTS llm_profile_health (
            key TEXT PRIMARY KEY,
            project_id TEXT,
            entry_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
        `);
        const columns = database.prepare('PRAGMA table_info(llm_profile_health)').all<{ name: string }>();
        if (!columns.some((column) => column.name === 'project_id')) {
          database.exec('ALTER TABLE llm_profile_health ADD COLUMN project_id TEXT');
        }
        database.exec(`
          CREATE INDEX IF NOT EXISTS llm_profile_health_project_id_idx ON llm_profile_health(project_id);
          CREATE INDEX IF NOT EXISTS llm_profile_health_updated_at_idx ON llm_profile_health(updated_at_ms DESC);
        `);
      } catch (error) {
        database.close();
        throw error;
      }
      return database;
    })().catch((error) => {
      this.#databasePromise = null;
      throw error;
    });
    return this.#databasePromise;
  }

  #read(database: DatabaseSync, key: string): StoredLLMProfileHealthEntry | null {
    return parseEntry(database.prepare('SELECT key, entry_json AS entryJson FROM llm_profile_health WHERE key = ?').get<StoredRow>(key));
  }

  #write(database: DatabaseSync, key: string, entry: StoredLLMProfileHealthEntry): void {
    database.prepare(`
      INSERT INTO llm_profile_health (key, project_id, entry_json, updated_at_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        project_id = excluded.project_id,
        entry_json = excluded.entry_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(key, entry.identity.projectId == null ? null : String(entry.identity.projectId), JSON.stringify(entry), entry.updatedAt);
  }

  async #transaction<T>(run: (database: DatabaseSync) => T): Promise<T> {
    const database = await this.#getDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = run(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the operation error. */ }
      throw error;
    }
  }

  begin(request: RivetLLMProfileHealthBeginRequest): Promise<RivetLLMProfileHealthBeginResult> {
    requireProjectId(request.identity);
    return this.#transaction((database) => {
      const transition = beginLLMProfileHealthAttempt(this.#read(database, request.identity.key), request, Date.now());
      this.#write(database, request.identity.key, transition.entry);
      return transition.result;
    });
  }

  finish(request: RivetLLMProfileHealthFinishRequest): Promise<RivetLLMProfileHealthSnapshot> {
    requireProjectId(request.identity);
    return this.#transaction((database) => {
      const transition = finishLLMProfileHealthAttempt(this.#read(database, request.identity.key), request, Date.now());
      if (transition.entry != null) this.#write(database, request.identity.key, transition.entry);
      return transition.snapshot;
    });
  }

  renew(request: RivetLLMProfileHealthRenewRequest): Promise<RivetLLMProfileHealthSnapshot> {
    requireProjectId(request.identity);
    return this.#transaction((database) => {
      const transition = renewLLMProfileHealthPermit(this.#read(database, request.identity.key), request, Date.now());
      if (transition.entry != null) this.#write(database, request.identity.key, transition.entry);
      return transition.snapshot;
    });
  }

  async reset(request: RivetLLMProfileHealthResetRequest): Promise<void> {
    await this.#transaction((database) => {
      if (request.key != null) {
        database.prepare('DELETE FROM llm_profile_health WHERE key = ?').run(request.key);
      } else {
        database.prepare('DELETE FROM llm_profile_health WHERE project_id = ?').run(String(request.projectId));
      }
    });
  }

  async resetProjectKey(projectId: ProjectId, key: string): Promise<boolean> {
    return this.#transaction((database) => {
      const result = database.prepare(
        'DELETE FROM llm_profile_health WHERE project_id = ? AND key = ?',
      ).run(String(projectId), key);
      return result.changes > 0;
    });
  }

  async list(request: RivetLLMProfileHealthListRequest = {}): Promise<RivetLLMProfileHealthSnapshot[]> {
    const database = await this.#getDatabase();
    const rows = request.projectId == null
      ? database.prepare('SELECT key, entry_json AS entryJson FROM llm_profile_health ORDER BY updated_at_ms DESC, key ASC').all<StoredRow>()
      : database.prepare(`
          SELECT key, entry_json AS entryJson
          FROM llm_profile_health
          WHERE project_id = ?
          ORDER BY updated_at_ms DESC, key ASC
        `).all<StoredRow>(String(request.projectId));
    const now = Date.now();
    return rows.map((row) => createLLMProfileHealthSnapshot(parseEntry(row)!, now));
  }

  async dispose(): Promise<void> {
    const databasePromise = this.#databasePromise;
    this.#databasePromise = null;
    if (databasePromise) (await databasePromise).close();
  }
}
