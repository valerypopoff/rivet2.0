import type { Pool, PoolClient } from 'pg';
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

import { beginLLMProfileHealthAttempt, createLLMProfileHealthSnapshot, finishLLMProfileHealthAttempt, renewLLMProfileHealthPermit, type StoredLLMProfileHealthEntry } from './state.js';
import type { RivetStudioLLMProfileHealthStore } from './store.js';

type ManagedRow = { key: string; entry_json: StoredLLMProfileHealthEntry | string | null };
type ManagedClockRow = { now_ms: string | number };

// A dedicated advisory-lock namespace prevents unrelated Studio data from
// contending with LLM Profile health operations. Hash collisions only cause
// conservative serialization; they cannot mix project state.
const LLM_PROFILE_HEALTH_PROJECT_LOCK_NAMESPACE = 1_815_101_512;

function parseEntry(row: ManagedRow | undefined): StoredLLMProfileHealthEntry | null {
  if (!row?.entry_json) return null;
  const parsed = typeof row.entry_json === 'string' ? JSON.parse(row.entry_json) as StoredLLMProfileHealthEntry : row.entry_json;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.failureTimestamps)) {
    throw new Error(`Invalid persisted LLM Profile health entry for ${row.key}.`);
  }
  return parsed;
}

function requireProjectId(
  identity: RivetLLMProfileHealthBeginRequest['identity'],
): ProjectId {
  if (identity.projectId == null || String(identity.projectId).trim() === '') {
    throw new Error('Studio Server LLM Profile health operations require a projectId.');
  }
  return identity.projectId;
}

export class PostgresRivetLLMProfileHealthStore implements RivetStudioLLMProfileHealthStore {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }

  async #transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the operation error. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async #readForBegin(client: PoolClient, key: string): Promise<StoredLLMProfileHealthEntry | null> {
    await client.query('INSERT INTO llm_profile_health (key, entry_json, updated_at) VALUES ($1, NULL, NOW()) ON CONFLICT (key) DO NOTHING', [key]);
    return this.#readForUpdate(client, key);
  }

  async #readForUpdate(client: PoolClient, key: string): Promise<StoredLLMProfileHealthEntry | null> {
    const result = await client.query<ManagedRow>('SELECT key, entry_json FROM llm_profile_health WHERE key = $1 FOR UPDATE', [key]);
    return parseEntry(result.rows[0]);
  }

  async #lockProject(client: PoolClient, projectId: ProjectId): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [LLM_PROFILE_HEALTH_PROJECT_LOCK_NAMESPACE, String(projectId)],
    );
  }

  async #now(client: PoolClient): Promise<number> {
    const result = await client.query<ManagedClockRow>(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms',
    );
    const now = Number(result.rows[0]?.now_ms);
    if (!Number.isFinite(now)) throw new Error('Postgres did not return a valid health-store clock.');
    return now;
  }

  async #write(client: PoolClient, key: string, entry: StoredLLMProfileHealthEntry): Promise<void> {
    await client.query(`
      UPDATE llm_profile_health
      SET project_id = $2, entry_json = $3::jsonb, updated_at = to_timestamp($4 / 1000.0)
      WHERE key = $1
    `, [key, entry.identity.projectId == null ? null : String(entry.identity.projectId), JSON.stringify(entry), entry.updatedAt]);
  }

  begin(request: RivetLLMProfileHealthBeginRequest): Promise<RivetLLMProfileHealthBeginResult> {
    return this.#transaction(async (client) => {
      await this.#lockProject(client, requireProjectId(request.identity));
      const transition = beginLLMProfileHealthAttempt(
        await this.#readForBegin(client, request.identity.key),
        request,
        await this.#now(client),
      );
      await this.#write(client, request.identity.key, transition.entry);
      return transition.result;
    });
  }

  finish(request: RivetLLMProfileHealthFinishRequest): Promise<RivetLLMProfileHealthSnapshot> {
    return this.#transaction(async (client) => {
      await this.#lockProject(client, requireProjectId(request.identity));
      const transition = finishLLMProfileHealthAttempt(
        await this.#readForUpdate(client, request.identity.key),
        request,
        await this.#now(client),
      );
      if (transition.entry != null) await this.#write(client, request.identity.key, transition.entry);
      return transition.snapshot;
    });
  }

  renew(request: RivetLLMProfileHealthRenewRequest): Promise<RivetLLMProfileHealthSnapshot> {
    return this.#transaction(async (client) => {
      await this.#lockProject(client, requireProjectId(request.identity));
      const transition = renewLLMProfileHealthPermit(
        await this.#readForUpdate(client, request.identity.key),
        request,
        await this.#now(client),
      );
      if (transition.entry != null) await this.#write(client, request.identity.key, transition.entry);
      return transition.snapshot;
    });
  }

  async reset(request: RivetLLMProfileHealthResetRequest): Promise<void> {
    if (request.key != null) {
      await this.#pool.query('DELETE FROM llm_profile_health WHERE key = $1', [request.key]);
    } else {
      await this.#transaction(async (client) => {
        await this.#lockProject(client, request.projectId);
        await client.query(
          'DELETE FROM llm_profile_health WHERE project_id = $1',
          [String(request.projectId)],
        );
      });
    }
  }

  async resetProjectKey(projectId: ProjectId, key: string): Promise<boolean> {
    return this.#transaction(async (client) => {
      await this.#lockProject(client, projectId);
      const result = await client.query(
        'DELETE FROM llm_profile_health WHERE project_id = $1 AND key = $2',
        [String(projectId), key],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async list(request: RivetLLMProfileHealthListRequest = {}): Promise<RivetLLMProfileHealthSnapshot[]> {
    const result = request.projectId == null
      ? await this.#pool.query<ManagedRow>('SELECT key, entry_json FROM llm_profile_health WHERE entry_json IS NOT NULL ORDER BY updated_at DESC, key ASC')
      : await this.#pool.query<ManagedRow>(`
          SELECT key, entry_json
          FROM llm_profile_health
          WHERE entry_json IS NOT NULL AND project_id = $1
          ORDER BY updated_at DESC, key ASC
        `, [String(request.projectId)]);
    const clockResult = await this.#pool.query<ManagedClockRow>(
      'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms',
    );
    const now = Number(clockResult.rows[0]?.now_ms);
    if (!Number.isFinite(now)) throw new Error('Postgres did not return a valid health-store clock.');
    return result.rows.map((row) => createLLMProfileHealthSnapshot(parseEntry(row)!, now));
  }
}
