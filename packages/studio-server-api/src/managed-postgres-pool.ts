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

export function getManagedPostgresPoolMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveInt(
    env[MANAGED_POSTGRES_POOL_MAX_ENV],
    DEFAULT_MANAGED_POSTGRES_POOL_MAX,
  );
}

export function withManagedPostgresPoolMax(
  config: PoolConfig,
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  return {
    ...config,
    max: getManagedPostgresPoolMax(env),
  };
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
}

const managedPostgresPoolRegistry = new ManagedPostgresPoolRegistry();

export function acquireManagedPostgresPool(config: PoolConfig): ManagedPostgresPoolLease {
  return managedPostgresPoolRegistry.acquire(config);
}
