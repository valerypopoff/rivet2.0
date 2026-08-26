import { Client, Pool, type PoolConfig, type QueryResultRow } from 'pg';

import {
  decryptManagedSettingsValue,
  deriveManagedSettingsEncryptionKey,
  encryptManagedSettingsValue,
  type ManagedSettingsEncryptionKey,
} from './managed-settings-crypto.js';

const APP_SETTINGS_CHANNEL = 'rivet_app_settings_changed';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_WRITE_RETRIES = 3;

export type ManagedSettingsRecord = {
  key: string;
  revision: bigint;
  schemaVersion: number;
  value: Record<string, unknown>;
  sourceHash: string | null;
};

export type ManagedSettingsWrite = {
  key: string;
  expectedRevision: bigint | null;
  schemaVersion: number;
  value: Record<string, unknown>;
  sourceHash?: string | null;
};

type AppSettingsRow = QueryResultRow & {
  setting_key: string;
  revision: string;
  schema_version: number;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
  source_hash: string | null;
};

type RevisionRow = QueryResultRow & {
  setting_key: string;
  revision: string;
};

type ManagedSettingsStoreOptions = {
  poolConfig: PoolConfig;
  encryptionSecret: string;
  previousEncryptionSecret?: string;
  pollIntervalMs?: number;
  logger?: Pick<Console, 'error' | 'log' | 'warn'>;
};

export interface AppSettingsBackend {
  initialize(): Promise<void>;
  read(key: string): Promise<ManagedSettingsRecord | null>;
  write(value: ManagedSettingsWrite): Promise<ManagedSettingsRecord | null>;
  subscribe(listener: (key: string) => Promise<void> | void): () => void;
  dispose(): Promise<void>;
}

type ManagedSettingsChangeListener = (key: string) => Promise<void> | void;

export async function publishManagedSettingsChange(
  query: (text: string, values: unknown[]) => Promise<unknown>,
  key: string,
  revision: bigint,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await query('SELECT pg_notify($1, $2)', [
      APP_SETTINGS_CHANNEL,
      JSON.stringify({ key, revision: revision.toString() }),
    ]);
  } catch (error) {
    onError(error);
  }
}

export async function acknowledgeManagedSettingsRevision(
  knownRevisions: Map<string, bigint>,
  key: string,
  revision: bigint,
  notify: ManagedSettingsChangeListener,
): Promise<boolean> {
  const knownRevision = knownRevisions.get(key);
  if (knownRevision != null && knownRevision >= revision) {
    return true;
  }

  try {
    await notify(key);
  } catch {
    return false;
  }

  const latestKnownRevision = knownRevisions.get(key);
  if (latestKnownRevision == null || latestKnownRevision < revision) {
    knownRevisions.set(key, revision);
  }
  return true;
}

function normalizePollInterval(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 1_000
    ? Math.floor(value as number)
    : DEFAULT_POLL_INTERVAL_MS;
}

export class PostgresAppSettingsBackend implements AppSettingsBackend {
  readonly #pool: Pool;
  readonly #poolConfig: PoolConfig;
  readonly #primaryKey: ManagedSettingsEncryptionKey;
  readonly #keys: ReadonlyMap<string, ManagedSettingsEncryptionKey>;
  readonly #pollIntervalMs: number;
  readonly #logger: Pick<Console, 'error' | 'log' | 'warn'>;
  readonly #listeners = new Set<ManagedSettingsChangeListener>();
  readonly #knownRevisions = new Map<string, bigint>();
  #listenerClient: Client | null = null;
  #listenerReconnectTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #pollInFlight: Promise<void> | undefined;
  #initialized = false;
  #disposed = false;

  constructor(options: ManagedSettingsStoreOptions) {
    this.#poolConfig = options.poolConfig;
    this.#pool = new Pool({ ...options.poolConfig, max: 5 });
    this.#primaryKey = deriveManagedSettingsEncryptionKey(options.encryptionSecret);
    const keys = [this.#primaryKey];
    if (options.previousEncryptionSecret?.trim()) {
      keys.push(deriveManagedSettingsEncryptionKey(options.previousEncryptionSecret));
    }
    this.#keys = new Map(keys.map((key) => [key.id, key]));
    this.#pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    this.#logger = options.logger ?? console;
  }

  #report(level: 'error' | 'warn', message: string, error: unknown): void {
    try {
      this.#logger[level](message, error);
    } catch {
      // Diagnostics must not change settings persistence or invalidation outcomes.
    }
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }
    if (this.#disposed) {
      throw new Error('PostgreSQL app-settings backend is disposed.');
    }

    await this.#refreshRevisionIndex(false);
    this.#initialized = true;
    await this.#connectListener();
    this.#pollTimer = setInterval(() => {
      if (this.#pollInFlight) {
        return;
      }
      this.#pollInFlight = this.#refreshRevisionIndex(true)
        .catch((error) => {
          this.#report('error', '[app-settings] PostgreSQL revision poll failed:', error);
        })
        .finally(() => {
          this.#pollInFlight = undefined;
        });
    }, this.#pollIntervalMs);
    this.#pollTimer.unref?.();
  }

  async read(key: string): Promise<ManagedSettingsRecord | null> {
    const result = await this.#pool.query<AppSettingsRow>(`
      SELECT setting_key, revision, schema_version, ciphertext, iv, auth_tag, key_id, source_hash
      FROM app_settings
      WHERE setting_key = $1
    `, [key]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const value = decryptManagedSettingsValue({
      key: row.setting_key,
      schemaVersion: row.schema_version,
    }, {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyId: row.key_id,
    }, this.#keys);
    const record = this.#toRecord(row, value);
    this.#knownRevisions.set(key, record.revision);

    if (row.key_id !== this.#primaryKey.id) {
      const rotated = await this.write({
        key,
        expectedRevision: record.revision,
        schemaVersion: record.schemaVersion,
        value,
        sourceHash: record.sourceHash,
      });
      return rotated ?? this.read(key);
    }

    return record;
  }

  async write(input: ManagedSettingsWrite): Promise<ManagedSettingsRecord | null> {
    const encrypted = encryptManagedSettingsValue({
      key: input.key,
      schemaVersion: input.schemaVersion,
    }, input.value, this.#primaryKey);
    const params = [
      input.key,
      input.schemaVersion,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      this.#primaryKey.id,
      input.sourceHash ?? null,
    ];

    const result = input.expectedRevision == null
      ? await this.#pool.query<AppSettingsRow>(`
          INSERT INTO app_settings
            (setting_key, revision, schema_version, ciphertext, iv, auth_tag, key_id, source_hash)
          VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (setting_key) DO NOTHING
          RETURNING setting_key, revision, schema_version, ciphertext, iv, auth_tag, key_id, source_hash
        `, params)
      : await this.#pool.query<AppSettingsRow>(`
          UPDATE app_settings
          SET revision = revision + 1,
              schema_version = $2,
              ciphertext = $3,
              iv = $4,
              auth_tag = $5,
              key_id = $6,
              source_hash = $7,
              updated_at = NOW()
          WHERE setting_key = $1 AND revision = $8
          RETURNING setting_key, revision, schema_version, ciphertext, iv, auth_tag, key_id, source_hash
        `, [...params, input.expectedRevision.toString()]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const record = this.#toRecord(row, input.value);
    this.#knownRevisions.set(input.key, record.revision);
    await publishManagedSettingsChange(
      (text, values) => this.#pool.query(text, values),
      input.key,
      record.revision,
      (error) => this.#report(
        'warn',
        `[app-settings] ${input.key} revision ${record.revision} was saved, but PostgreSQL notification delivery failed; polling will converge replicas:`,
        error,
      ),
    );
    return record;
  }

  subscribe(listener: ManagedSettingsChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#initialized = false;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#listenerReconnectTimer) {
      clearTimeout(this.#listenerReconnectTimer);
      this.#listenerReconnectTimer = undefined;
    }
    const listener = this.#listenerClient;
    this.#listenerClient = null;
    await this.#pollInFlight?.catch(() => undefined);
    this.#pollInFlight = undefined;
    await Promise.allSettled([
      listener?.end(),
      this.#pool.end(),
    ]);
    this.#listeners.clear();
    this.#knownRevisions.clear();
  }

  #toRecord(row: AppSettingsRow, value: Record<string, unknown>): ManagedSettingsRecord {
    return {
      key: row.setting_key,
      revision: BigInt(row.revision),
      schemaVersion: row.schema_version,
      value,
      sourceHash: row.source_hash,
    };
  }

  async #emit(key: string): Promise<void> {
    let firstError: unknown;
    for (const listener of this.#listeners) {
      try {
        await listener(key);
      } catch (error) {
        this.#report('error', `[app-settings] Change listener failed for ${key}:`, error);
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  async #refreshRevisionIndex(emitChanges: boolean): Promise<void> {
    const result = await this.#pool.query<RevisionRow>(
      'SELECT setting_key, revision FROM app_settings ORDER BY setting_key',
    );
    for (const row of result.rows) {
      const revision = BigInt(row.revision);
      if (!emitChanges) {
        this.#knownRevisions.set(row.setting_key, revision);
        continue;
      }
      await acknowledgeManagedSettingsRevision(
        this.#knownRevisions,
        row.setting_key,
        revision,
        (key) => this.#emit(key),
      );
    }
  }

  async #connectListener(): Promise<void> {
    if (this.#disposed || this.#listenerClient) {
      return;
    }
    const client = new Client(this.#poolConfig);
    try {
      await client.connect();
      await client.query(`LISTEN ${APP_SETTINGS_CHANNEL}`);
      client.on('notification', (message) => {
        if (message.channel !== APP_SETTINGS_CHANNEL || !message.payload) {
          return;
        }
        try {
          const payload = JSON.parse(message.payload) as { key?: unknown; revision?: unknown };
          if (typeof payload.key !== 'string') {
            return;
          }
          if (typeof payload.revision !== 'string') {
            return;
          }
          const revision = BigInt(payload.revision);
          void acknowledgeManagedSettingsRevision(
            this.#knownRevisions,
            payload.key,
            revision,
            (key) => this.#emit(key),
          );
        } catch (error) {
          this.#report('warn', '[app-settings] Ignoring malformed PostgreSQL change notification:', error);
        }
      });
      const reconnect = () => {
        if (this.#listenerClient === client) {
          this.#listenerClient = null;
        }
        if (!this.#disposed && !this.#listenerReconnectTimer) {
          this.#listenerReconnectTimer = setTimeout(() => {
            this.#listenerReconnectTimer = undefined;
            void this.#connectListener();
          }, 1_000);
          this.#listenerReconnectTimer.unref?.();
        }
      };
      client.once('error', reconnect);
      client.once('end', reconnect);
      this.#listenerClient = client;
    } catch (error) {
      await client.end().catch(() => undefined);
      this.#report('warn', '[app-settings] PostgreSQL LISTEN unavailable; polling remains active:', error);
      if (!this.#disposed && !this.#listenerReconnectTimer) {
        this.#listenerReconnectTimer = setTimeout(() => {
          this.#listenerReconnectTimer = undefined;
          void this.#connectListener();
        }, 1_000);
        this.#listenerReconnectTimer.unref?.();
      }
    }
  }
}

export function getManagedSettingsWriteRetryLimit(): number {
  return MAX_WRITE_RETRIES;
}

export function isPostgresAppSettingsBackendEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.RIVET_APP_SETTINGS_BACKEND?.trim().toLowerCase() === 'postgres';
}

function stripSslMode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

function buildConnectionString(env: NodeJS.ProcessEnv): string {
  const explicit = env.RIVET_APP_SETTINGS_DATABASE_URL?.trim()
    || env.RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING?.trim();
  if (explicit) {
    return stripSslMode(explicit);
  }

  const host = env.RIVET_DEPLOYMENT_DATABASE_HOST?.trim();
  const database = env.RIVET_DEPLOYMENT_DATABASE_NAME?.trim();
  const username = env.RIVET_DEPLOYMENT_DATABASE_USERNAME?.trim();
  if (!host || !database || !username) {
    throw new Error(
      'PostgreSQL app settings require RIVET_APP_SETTINGS_DATABASE_URL, ' +
      'RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING, or the deployment database host/name/username tuple.',
    );
  }

  const port = env.RIVET_DEPLOYMENT_DATABASE_PORT?.trim() || '5432';
  const password = env.RIVET_DEPLOYMENT_DATABASE_PASSWORD ?? '';
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(database)}`;
}

export function createPostgresAppSettingsBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PostgresAppSettingsBackend {
  const encryptionSecret = env.RIVET_APP_SETTINGS_ENCRYPTION_KEY?.trim()
    || env.RIVET_KEY?.trim();
  if (!encryptionSecret) {
    throw new Error(
      'PostgreSQL app settings require RIVET_APP_SETTINGS_ENCRYPTION_KEY or RIVET_KEY.',
    );
  }

  const sslMode = env.RIVET_DEPLOYMENT_DATABASE_SSL_MODE?.trim().toLowerCase() || 'require';
  const poolConfig: PoolConfig = {
    connectionString: buildConnectionString(env),
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    ...(sslMode === 'disable'
      ? {}
      : { ssl: { rejectUnauthorized: sslMode === 'verify-full' } }),
  };

  return new PostgresAppSettingsBackend({
    poolConfig,
    encryptionSecret,
    previousEncryptionSecret: env.RIVET_APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS,
    pollIntervalMs: Number.parseInt(env.RIVET_APP_SETTINGS_POLL_INTERVAL_MS ?? '', 10),
  });
}
