import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { acquireManagedPostgresPool, type ManagedPostgresPoolLease } from '../../managed-postgres-pool.js';
import { getManagedRuntimeLibrariesConfig } from '../config.js';
import { ensureDirectories } from '../manifest.js';
import { S3RuntimeLibrariesBlobStore, type RuntimeLibrariesBlobStore } from './blob-store.js';
import { ManagedRuntimeLibrariesLocalCache } from './local-cache.js';
import type { RuntimeLibrarySnapshot } from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import { getPoolConfig } from './schema.js';

export type ManagedRuntimeLibrariesContext = {
  config: ReturnType<typeof getManagedRuntimeLibrariesConfig>;
  pool: Pool;
  poolLease: ManagedPostgresPoolLease;
  blobStore: RuntimeLibrariesBlobStore;
  localCache: ManagedRuntimeLibrariesLocalCache;
  instanceId: string;
  ensureLocalFilesystemReady(): void;
  getProcessManagedSync(): ((force?: boolean) => Promise<RuntimeLibrarySnapshot | undefined>) | undefined;
  syncForLocalUse(force: boolean): Promise<RuntimeLibrarySnapshot>;
};

export function createManagedRuntimeLibrariesContext(
  blobStore?: RuntimeLibrariesBlobStore,
): ManagedRuntimeLibrariesContext {
  const config = getManagedRuntimeLibrariesConfig();
  const poolLease = acquireManagedPostgresPool(getPoolConfig(config));
  const { pool } = poolLease;
  const resolvedBlobStore = blobStore ?? new S3RuntimeLibrariesBlobStore(config);
  const localCache = new ManagedRuntimeLibrariesLocalCache(pool, resolvedBlobStore, config);
  const instanceId = `${os.hostname()}-${process.pid}-${randomUUID()}`;

  const getProcessManagedSync = () =>
    (
      globalThis as {
        __RIVET_PREPARE_RUNTIME_LIBRARIES__?: (force?: boolean) => Promise<RuntimeLibrarySnapshot | undefined>;
      }
    ).__RIVET_PREPARE_RUNTIME_LIBRARIES__;

  const syncForLocalUse = async (force: boolean): Promise<RuntimeLibrarySnapshot> => {
    const globalPrepare = getProcessManagedSync();

    if (globalPrepare) {
      const snapshot = await globalPrepare(force);
      if (!snapshot || snapshot.version !== 1 || !snapshot.requireAnchorPath)
        throw new Error('Managed runtime-library preparation did not return a verified snapshot.');
      return snapshot;
    }

    return localCache.sync(force);
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
