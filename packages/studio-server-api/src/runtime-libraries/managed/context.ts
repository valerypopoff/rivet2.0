import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  acquireManagedPostgresPool,
  type ManagedPostgresPoolLease,
} from '../../managed-postgres-pool.js';
import { getManagedRuntimeLibrariesConfig } from '../config.js';
import { ensureDirectories } from '../manifest.js';
import {
  S3RuntimeLibrariesBlobStore,
  type RuntimeLibrariesBlobStore,
} from './blob-store.js';
import { ManagedRuntimeLibrariesLocalCache } from './local-cache.js';
import { getPoolConfig } from './schema.js';

export type ManagedRuntimeLibrariesContext = {
  config: ReturnType<typeof getManagedRuntimeLibrariesConfig>;
  pool: Pool;
  poolLease: ManagedPostgresPoolLease;
  blobStore: RuntimeLibrariesBlobStore;
  localCache: ManagedRuntimeLibrariesLocalCache;
  instanceId: string;
  ensureLocalFilesystemReady(): void;
  getProcessManagedSync(): ((force?: boolean) => Promise<void>) | undefined;
  syncForLocalUse(force: boolean): Promise<void>;
};

export function createManagedRuntimeLibrariesContext(blobStore?: RuntimeLibrariesBlobStore): ManagedRuntimeLibrariesContext {
  const config = getManagedRuntimeLibrariesConfig();
  const poolLease = acquireManagedPostgresPool(getPoolConfig(config));
  const { pool } = poolLease;
  const resolvedBlobStore = blobStore ?? new S3RuntimeLibrariesBlobStore(config);
  const localCache = new ManagedRuntimeLibrariesLocalCache(pool, resolvedBlobStore, config);
  const instanceId = `${os.hostname()}-${process.pid}-${randomUUID()}`;

  const getProcessManagedSync = () => (globalThis as {
    __RIVET_PREPARE_RUNTIME_LIBRARIES__?: (force?: boolean) => Promise<void>;
  }).__RIVET_PREPARE_RUNTIME_LIBRARIES__;

  const syncForLocalUse = async (force: boolean): Promise<void> => {
    const globalPrepare = getProcessManagedSync();

    if (globalPrepare) {
      await globalPrepare(force);
      return;
    }

    await localCache.sync(force);
  };

  return {
    config,
    pool,
    poolLease,
    blobStore: resolvedBlobStore,
    localCache,
    instanceId,
    ensureLocalFilesystemReady() {
      ensureDirectories();
      fs.mkdirSync(localCache.jobsRoot(), { recursive: true });
    },
    getProcessManagedSync,
    syncForLocalUse,
  };
}
