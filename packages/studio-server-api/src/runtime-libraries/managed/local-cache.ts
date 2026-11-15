import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createRuntimeLibrarySync,
  extractRuntimeLibraryArchive,
  publishRuntimeLibraryCandidate,
  readRuntimeCacheManifest,
  selectRuntimeLibrarySource,
  publishEmptyRuntimeRelease,
  type RuntimeLibrarySnapshot,
  type RuntimeCacheManifest,
  runtimePackagesKey,
} from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import { getRootPath } from '../manifest.js';
import type { ManagedRuntimeLibrariesConfig } from '../config.js';
import type { RuntimeLibrariesBlobStore } from './blob-store.js';
import { normalizePackageMap, toIsoString } from './schema.js';
import { getManagedActiveRelease } from './state.js';

export class ManagedRuntimeLibrariesLocalCache {
  readonly #pool: Pool;
  readonly #blobStore: RuntimeLibrariesBlobStore;

  readonly #synchronizer: ReturnType<typeof createRuntimeLibrarySync<RuntimeLibrarySnapshot>>;

  constructor(pool: Pool, blobStore: RuntimeLibrariesBlobStore, config: ManagedRuntimeLibrariesConfig) {
    this.#pool = pool;
    this.#blobStore = blobStore;
    this.#synchronizer = createRuntimeLibrarySync(() => this.#syncCurrentRelease(), config.syncPollIntervalMs);
  }

  reset(): void {
    this.#synchronizer.reset();
  }

  drain(): Promise<void> {
    return this.#synchronizer.drain();
  }

  jobsRoot(): string {
    return path.join(getRootPath(), 'jobs');
  }

  sync(force: boolean): Promise<RuntimeLibrarySnapshot> {
    return this.#synchronizer.sync(force);
  }

  async #syncCurrentRelease(): Promise<RuntimeLibrarySnapshot> {
    const root = getRootPath();
    const activeRelease = await getManagedActiveRelease(this.#pool);
    let manifest: RuntimeCacheManifest | undefined;
    let snapshot: RuntimeLibrarySnapshot | null | undefined;
    try {
      manifest = readRuntimeCacheManifest(root);
      if (manifest.runtimeCache) snapshot = selectRuntimeLibrarySource(root, manifest).snapshot;
    } catch {
      manifest = undefined;
      // This is a rebuildable hint. Only the durable release below may replace it.
      console.warn('[runtime-libraries] Rebuilding invalid local cache from the active release.');
    }
    const cachedReleaseId = manifest?.activeReleaseId ?? null;
    const nextReleaseId = activeRelease?.release_id ?? null;
    runtimePackagesKey(activeRelease?.packages_json ?? {});
    const nextPackages = normalizePackageMap(activeRelease?.packages_json);

    if (
      snapshot &&
      manifest &&
      cachedReleaseId === nextReleaseId &&
      runtimePackagesKey(manifest.packages) === runtimePackagesKey(nextPackages) &&
      (!activeRelease?.artifact_sha256 || snapshot.integrity === activeRelease.artifact_sha256)
    ) {
      return snapshot;
    }
    const nextManifest: RuntimeCacheManifest = {
      packages: nextPackages,
      updatedAt: toIsoString(activeRelease?.updated_at ?? activeRelease?.created_at) ?? new Date().toISOString(),
      ...(nextReleaseId ? { activeReleaseId: nextReleaseId } : {}),
    };
    if (!Object.keys(nextPackages).length) {
      return (await publishEmptyRuntimeRelease(root, nextManifest)).snapshot;
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

    const extracted = await extractRuntimeLibraryArchive(root, archiveBuffer);
    try {
      return await this.promoteCurrentRelease(extracted.candidate, nextManifest, archiveSha256);
    } finally {
      await extracted.dispose();
    }
  }

  async promoteCurrentRelease(
    candidateDir: string,
    manifest = readRuntimeCacheManifest(getRootPath()),
    integrity?: string,
  ): Promise<RuntimeLibrarySnapshot> {
    return (await publishRuntimeLibraryCandidate(getRootPath(), candidateDir, manifest, { integrity })).snapshot;
  }
}
