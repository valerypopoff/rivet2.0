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
  // A forced sync may arrive while a previous poll is still downloading an
  // older release. Keep one serialized queue so no caller can observe that
  // older sync as complete after a newer release has been requested. At most
  // one follow-up pass is queued for each active pass, so parallel execution
  // requests do not turn into one database check per caller.
  #runningSyncRound = 0;
  #requestedSyncRound = 0;

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
  }

  jobsRoot(): string {
    return path.join(path.dirname(currentDir()), 'jobs');
  }

  async sync(force: boolean): Promise<void> {
    const pollExpired = Date.now() - this.#lastSyncCheckAt >= this.#config.syncPollIntervalMs;
    if (this.#syncPromise) {
      if (force) {
        this.#queueSyncAfterCurrentRound();
      }
      return this.#syncPromise;
    }

    const hasQueuedSync = this.#requestedSyncRound > this.#runningSyncRound;
    if (!force && !hasQueuedSync && !pollExpired) {
      return;
    }
    if (!hasQueuedSync) {
      this.#requestedSyncRound = this.#runningSyncRound + 1;
    }

    let syncPromise: Promise<void>;
    syncPromise = this.#drainSyncRounds().finally(() => {
      if (this.#syncPromise === syncPromise) {
        this.#syncPromise = null;
      }
    });
    this.#syncPromise = syncPromise;
    return syncPromise;
  }

  #queueSyncAfterCurrentRound(): void {
    if (this.#syncPromise) {
      this.#requestedSyncRound = Math.max(this.#requestedSyncRound, this.#runningSyncRound + 1);
    }
  }

  async #drainSyncRounds(): Promise<void> {
    while (this.#runningSyncRound < this.#requestedSyncRound) {
      this.#runningSyncRound += 1;
      await this.#syncCurrentRelease();
    }
  }

  async #syncCurrentRelease(): Promise<void> {
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

    fs.mkdirSync(this.jobsRoot(), { recursive: true });
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
