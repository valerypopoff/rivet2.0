import { Pool, type PoolConfig } from 'pg';

import { parsePositiveInt } from './utils/env-parsing.js';

export const DEFAULT_MANAGED_POSTGRES_POOL_MAX = 10;
export const MANAGED_POSTGRES_POOL_MAX_ENV = 'RIVET_DEPLOYMENT_DATABASE_POOL_MAX';

type ManagedPostgresPoolEntry = {
  pool: Pool;
  referenceCount: number;
  endPromise: Promise<void> | null;
};

export type ManagedPostgresPoolLease = {
  pool: Pool;
  release(): Promise<void>;
};

export type ManagedPostgresPoolMetrics = Readonly<{
  idle: number;
  pools: number;
  total: number;
  waiting: number;
}>;

function normalizeKeyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeyValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeKeyValue(nestedValue)]),
    );
  }
  if (typeof value === 'function') {
    return value.toString();
  }
  return value;
}

function getPoolKey(config: PoolConfig, max: number): string {
  const { max: _ignoredMax, ...identityConfig } = config;
  return JSON.stringify(normalizeKeyValue({ ...identityConfig, max }));
}

export function getManagedPostgresPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env[MANAGED_POSTGRES_POOL_MAX_ENV], DEFAULT_MANAGED_POSTGRES_POOL_MAX);
}

export function withManagedPostgresPoolMax(config: PoolConfig, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  return {
    ...withAuthoritativePostgresTls(config),
    // Bound ordinary reads as well as transaction-local writes. The driver's
    // slightly longer deadline also covers a server/network that stops replying.
    statement_timeout: config.statement_timeout ?? 60_000,
    query_timeout: config.query_timeout ?? 65_000,
    max: getManagedPostgresPoolMax(env),
  };
}

/** pg parses URL TLS options after the explicit SSL object. Never allow a URL
 * to silently weaken the deployment policy. sslmode is the legacy UI hint;
 * Rivet's separate policy owns it, so remove it rather than reinterpret it. */
export function withAuthoritativePostgresTls(config: PoolConfig): PoolConfig {
  if (!config.connectionString) return config;
  const url = new URL(config.connectionString);
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === 'sslmode') continue;
    if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') {
      throw new Error('PostgreSQL URL TLS overrides are not supported. Configure Rivet database SSL mode instead.');
    }
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'sslmode') url.searchParams.delete(key);
  }
  return { ...config, connectionString: url.toString(), ssl: config.ssl ?? false };
}

export class ManagedPostgresPoolRegistry {
  readonly #entries = new Map<string, ManagedPostgresPoolEntry>();
  readonly #createPool: (config: PoolConfig) => Pool;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    createPool: (config: PoolConfig) => Pool = (config) => new Pool(config),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#createPool = createPool;
    this.#env = env;
  }

  acquire(config: PoolConfig): ManagedPostgresPoolLease {
    const poolConfig = withManagedPostgresPoolMax(config, this.#env);
    const key = getPoolKey(poolConfig, poolConfig.max!);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {
        pool: this.#createPool(poolConfig),
        referenceCount: 0,
        endPromise: null,
      };
      this.#entries.set(key, entry);
    }
    entry.referenceCount += 1;

    let released = false;
    return {
      pool: entry.pool,
      release: async () => {
        if (released) return;
        released = true;
        entry!.referenceCount -= 1;
        if (entry!.referenceCount > 0) return;

        if (this.#entries.get(key) === entry) {
          this.#entries.delete(key);
        }
        entry!.endPromise ??= entry!.pool.end();
        await entry!.endPromise;
      },
    };
  }

  getMetrics(): ManagedPostgresPoolMetrics {
    let idle = 0;
    let total = 0;
    let waiting = 0;

    for (const { pool } of this.#entries.values()) {
      idle += toNonNegativeCount(pool.idleCount);
      total += toNonNegativeCount(pool.totalCount);
      waiting += toNonNegativeCount(pool.waitingCount);
    }

    return Object.freeze({
      idle,
      pools: this.#entries.size,
      total,
      waiting,
    });
  }
}

function toNonNegativeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

const managedPostgresPoolRegistry = new ManagedPostgresPoolRegistry();

export function acquireManagedPostgresPool(config: PoolConfig): ManagedPostgresPoolLease {
  return managedPostgresPoolRegistry.acquire(config);
}

/**
 * A synchronous view of process-local shared pools for the metrics endpoint.
 * It never opens a connection or queries PostgreSQL while Prometheus scrapes.
 */
export function getManagedPostgresPoolMetrics(): ManagedPostgresPoolMetrics {
  return managedPostgresPoolRegistry.getMetrics();
}
