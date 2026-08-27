import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import * as tar from 'tar';
import type { Pool } from 'pg';

import { currentDir, currentNodeModulesPath, emptyManifest, ensureDirectories, readManifest, writeManifest } from '../manifest.js';
import type { ManagedRuntimeLibrariesConfig } from '../config.js';
import type { RuntimeLibrariesBlobStore } from './blob-store.js';
import { normalizePackageMap, toIsoString } from './schema.js';
import { getManagedActiveRelease } from './state.js';

export class ManagedRuntimeLibrariesLocalCache {
  readonly #pool: Pool;
  readonly #blobStore: RuntimeLibrariesBlobStore;
  readonly #config: ManagedRuntimeLibrariesConfig;

  #lastSyncCheckAt = 0;
  #syncPromise: Promise<void> | null = null;

  constructor(
    pool: Pool,
    blobStore: RuntimeLibrariesBlobStore,
    config: ManagedRuntimeLibrariesConfig,
  ) {
    this.#pool = pool;
    this.#blobStore = blobStore;
    this.#config = config;
  }

  reset(): void {
    this.#lastSyncCheckAt = 0;
    this.#syncPromise = null;
  }

  jobsRoot(): string {
    return path.join(path.dirname(currentDir()), 'jobs');
  }

  async sync(force: boolean): Promise<void> {
    if (this.#syncPromise) {
      if (!force) {
        return this.#syncPromise;
      }

      await this.#syncPromise;
    }

    if (!force && Date.now() - this.#lastSyncCheckAt < this.#config.syncPollIntervalMs) {
      return;
    }

    const syncPromise = (async () => {
      ensureDirectories();
      const activeRelease = await getManagedActiveRelease(this.#pool);
      const manifest = readManifest();
      const cachedReleaseId = manifest.activeReleaseId ?? null;
      const nextReleaseId = activeRelease?.release_id ?? null;
      const nextPackages = normalizePackageMap(activeRelease?.packages_json);

      if (!nextReleaseId) {
        if (cachedReleaseId || currentNodeModulesPath()) {
          this.removeCurrentRelease();
          writeManifest(emptyManifest());
        }

        this.#lastSyncCheckAt = Date.now();
        return;
      }

      if (Object.keys(nextPackages).length === 0) {
        this.removeCurrentRelease();
        writeManifest({
          packages: {},
          updatedAt: toIsoString(activeRelease?.updated_at ?? activeRelease?.created_at) ?? new Date().toISOString(),
          activeReleaseId: nextReleaseId,
        });
        this.#lastSyncCheckAt = Date.now();
        return;
      }

      if (
        cachedReleaseId === nextReleaseId &&
        currentNodeModulesPath() &&
        fs.existsSync(path.join(currentDir(), 'package.json'))
      ) {
        this.#lastSyncCheckAt = Date.now();
        return;
      }

      const artifactBlobKey = activeRelease?.artifact_blob_key;
      if (!artifactBlobKey) {
        throw new Error(`Active runtime-library release ${nextReleaseId} is missing its artifact pointer`);
      }

      const archiveBuffer = await this.#blobStore.getBuffer(artifactBlobKey);
      const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');
      if (activeRelease?.artifact_sha256 && archiveSha256 !== activeRelease.artifact_sha256) {
        throw new Error(`Runtime-library artifact checksum mismatch for release ${nextReleaseId}`);
      }

      const tempRoot = fs.mkdtempSync(path.join(this.jobsRoot(), `sync-${nextReleaseId}-`));
      const archivePath = path.join(tempRoot, 'release.tar');
      const extractedDir = path.join(tempRoot, 'candidate');

      try {
        fs.mkdirSync(extractedDir, { recursive: true });
        fs.writeFileSync(archivePath, archiveBuffer);
        await tar.x({
          file: archivePath,
          cwd: extractedDir,
        });

        this.promoteCurrentRelease(extractedDir);
        writeManifest({
          packages: nextPackages,
          updatedAt: toIsoString(activeRelease.updated_at) ?? new Date().toISOString(),
          activeReleaseId: nextReleaseId,
        });
        this.#lastSyncCheckAt = Date.now();
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    })();

    this.#syncPromise = syncPromise.finally(() => {
      this.#syncPromise = null;
    });

    return this.#syncPromise;
  }

  removeCurrentRelease(): void {
    fs.rmSync(currentDir(), { recursive: true, force: true });
  }

  promoteCurrentRelease(candidateDir: string): void {
    const current = currentDir();
    const backup = `${current}.previous`;

    fs.rmSync(backup, { recursive: true, force: true });

    try {
      if (fs.existsSync(current)) {
        fs.renameSync(current, backup);
      }

      fs.renameSync(candidateDir, current);
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(current) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, current);
        } catch {
          // ignore restoration failure and surface the original error
        }
      }

      throw error;
    }
  }
}
