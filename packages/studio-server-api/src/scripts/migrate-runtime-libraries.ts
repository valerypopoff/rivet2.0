import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import * as tar from 'tar';

import type { ManagedRuntimeLibrariesConfig } from '../runtime-libraries/config.js';
import { MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX } from '../runtime-libraries/config.js';
import {
  S3RuntimeLibrariesBlobStore,
  createRuntimeLibraryReleaseArtifactKey,
} from '../runtime-libraries/managed/blob-store.js';
import {
  ensureManagedRuntimeLibrariesSchema,
  getPoolConfig,
  MANAGED_RUNTIME_LIBRARIES_RELEASE_MUTATION_LOCK,
  normalizePackageMap,
} from '../runtime-libraries/managed/schema.js';
import type { RuntimeLibraryManifest } from '../runtime-libraries/manifest.js';
import type { ManagedWorkflowStorageConfig } from '../routes/workflows/storage-config.js';
import { readMigrationSourceUtf8 } from './migration-source-utf8.js';
import { chargeLocalSourceBytes } from '../local-metadata/source-budget.js';

function runtimeConfig(target: ManagedWorkflowStorageConfig): ManagedRuntimeLibrariesConfig {
  return {
    ...target,
    objectStoragePrefix: MANAGED_RUNTIME_LIBRARIES_OBJECT_STORAGE_PREFIX,
    syncPollIntervalMs: 5_000,
    runtimeProcessRole: 'api',
    runtimeReplicaTier: 'none',
    replicaStatusRetentionMs: 15 * 60_000,
    replicaStatusCleanupIntervalMs: 5 * 60_000,
    jobWorkerEnabled: false,
  };
}

function canonicalPackages(packages: RuntimeLibraryManifest['packages']): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(packages).sort(([left], [right]) => left.localeCompare(right))),
  );
}

async function sourceStatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRealSourceDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Runtime-library source must be a real directory: ${directory}`);
  }
}

export async function readSourceManifest(root: string): Promise<RuntimeLibraryManifest> {
  if (await sourceStatOrNull(root)) await assertRealSourceDirectory(root);
  const manifestPath = path.join(root, 'manifest.json');
  const legacyActiveRelease = path.join(root, 'active-release');
  if (await sourceStatOrNull(legacyActiveRelease)) {
    throw new Error(
      'Source runtime libraries still use the legacy active-release layout; start the VM once to reconcile it before taking the frozen migration copy.',
    );
  }
  let text: string;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    text = await readMigrationSourceUtf8(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (await sourceStatOrNull(path.join(root, 'current'))) {
        throw new Error('Source runtime libraries have current/ but no manifest.json');
      }
      return { packages: {}, updatedAt: '' };
    }
    throw new Error('Cannot read source runtime-library manifest', { cause: error });
  }
  const raw = JSON.parse(text) as Partial<RuntimeLibraryManifest>;
  if (
    !raw ||
    typeof raw !== 'object' ||
    !raw.packages ||
    typeof raw.packages !== 'object' ||
    Array.isArray(raw.packages)
  ) {
    throw new Error('Source runtime-library manifest is invalid');
  }
  const packages = normalizePackageMap(raw.packages);
  if (Object.keys(packages).length !== Object.keys(raw.packages).length) {
    throw new Error('Source runtime-library manifest has invalid package entries');
  }
  if (Object.keys(packages).length === 0 && (await sourceStatOrNull(path.join(root, 'current')))) {
    throw new Error('Source runtime libraries have current/ but no packages in the manifest');
  }
  if (raw.activeReleaseId !== undefined && (typeof raw.activeReleaseId !== 'string' || !raw.activeReleaseId.trim())) {
    throw new Error('Source runtime-library manifest has an invalid active release ID');
  }
  return {
    packages,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    ...(raw.activeReleaseId ? { activeReleaseId: raw.activeReleaseId.trim() } : {}),
  };
}

export async function createSourceArchive(root: string): Promise<Buffer> {
  await assertRealSourceDirectory(root);
  return createRuntimeLibraryDirectoryArchive(path.join(root, 'current'));
}

export async function createRuntimeLibraryDirectoryArchive(current: string): Promise<Buffer> {
  await assertRealSourceDirectory(current);
  const archiveRoot = await fs.realpath(current);
  async function validateEntry(filePath: string): Promise<void> {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(filePath);
      const relativeTarget = path.relative(archiveRoot, await fs.realpath(filePath));
      if (
        path.isAbsolute(link) ||
        relativeTarget === '..' ||
        relativeTarget.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeTarget)
      ) {
        throw new Error(`Runtime-library symlink escapes the archived release: ${path.relative(current, filePath)}`);
      }
    } else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(filePath)).sort()) await validateEntry(path.join(filePath, name));
    } else if (!stat.isFile()) {
      throw new Error(`Runtime-library archive contains a non-regular entry: ${path.relative(current, filePath)}`);
    }
  }
  await validateEntry(current);
  if (
    !(await fs.stat(path.join(current, 'package.json'))).isFile() ||
    !(await fs.stat(path.join(current, 'node_modules'))).isDirectory()
  ) {
    throw new Error('Runtime-library release needs a package.json file and node_modules directory');
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-runtime-migration-'));
  try {
    const archivePath = path.join(temporaryRoot, 'release.tar');
    await tar.c({ cwd: current, file: archivePath, portable: true, noMtime: true, strict: true }, ['.']);
    chargeLocalSourceBytes((await fs.stat(archivePath)).size);
    return await fs.readFile(archivePath);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Copies an installed release as immutable bytes; the target must run a compatible Linux/Node image. */
export async function migrateRuntimeLibraries(options: {
  sourceRoot: string;
  target: ManagedWorkflowStorageConfig;
  verifyOnly?: boolean;
}): Promise<number> {
  const manifest = await readSourceManifest(options.sourceRoot);
  const hasPackages = Object.keys(manifest.packages).length > 0;
  if (hasPackages && process.env.RIVET_MIGRATION_RUNTIME_PLATFORM_ACK !== '1') {
    throw new Error(
      'Runtime libraries may contain native binaries. Confirm matching source/target image, OS, architecture and Node ABI with RIVET_MIGRATION_RUNTIME_PLATFORM_ACK=1.',
    );
  }
  const archive = hasPackages ? await createSourceArchive(options.sourceRoot) : null;
  const archiveSha = archive ? createHash('sha256').update(archive).digest('hex') : null;
  const releaseId = archiveSha ? `vm-migration-${archiveSha.slice(0, 32)}` : null;
  const artifactKey = releaseId ? createRuntimeLibraryReleaseArtifactKey(releaseId) : null;
  const config = runtimeConfig(options.target);
  const pool = new Pool(getPoolConfig(config));
  const blobStore = new S3RuntimeLibrariesBlobStore(config);
  try {
    if (options.verifyOnly) {
      await blobStore.checkHealth();
    } else {
      await ensureManagedRuntimeLibrariesSchema(pool);
      await blobStore.initialize();
    }
    const preflight = await pool.query<{ active_release_id: string | null }>(
      `SELECT active_release_id FROM runtime_library_activation WHERE slot = 'default'`,
    );
    if (preflight.rows[0]?.active_release_id && preflight.rows[0]?.active_release_id !== releaseId) {
      throw new Error('Managed runtime libraries already have a different active release');
    }
    if (archive && artifactKey && !options.verifyOnly) {
      // Immutable deterministic key makes a retry safe after an upload succeeds but DB commit fails.
      await blobStore.putBuffer(artifactKey, archive, 'application/x-tar');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MANAGED_RUNTIME_LIBRARIES_RELEASE_MUTATION_LOCK.classId,
        MANAGED_RUNTIME_LIBRARIES_RELEASE_MUTATION_LOCK.objectId,
      ]);
      const active = await client.query<{
        active_release_id: string | null;
        packages_json: RuntimeLibraryManifest['packages'] | null;
        artifact_blob_key: string | null;
        artifact_sha256: string | null;
      }>(`SELECT a.active_release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256
          FROM runtime_library_activation a LEFT JOIN runtime_library_releases r
          ON r.release_id = a.active_release_id WHERE a.slot = 'default' FOR UPDATE OF a`);
      const row = active.rows[0];
      if (!row) throw new Error('Managed runtime-library activation row is missing');
      if (!options.verifyOnly && releaseId && !row.active_release_id) {
        await client.query(
          `INSERT INTO runtime_library_releases
           (release_id, packages_json, artifact_blob_key, artifact_sha256)
           VALUES ($1, $2::jsonb, $3, $4) ON CONFLICT (release_id) DO NOTHING`,
          [releaseId, JSON.stringify(manifest.packages), artifactKey, archiveSha],
        );
        await client.query(
          `UPDATE runtime_library_activation SET active_release_id = $1, updated_at = NOW()
           WHERE slot = 'default' AND active_release_id IS NULL`,
          [releaseId],
        );
      }
      const verified = await client.query<{
        active_release_id: string | null;
        packages_json: RuntimeLibraryManifest['packages'] | null;
        artifact_blob_key: string | null;
        artifact_sha256: string | null;
      }>(`SELECT a.active_release_id, r.packages_json, r.artifact_blob_key, r.artifact_sha256
          FROM runtime_library_activation a LEFT JOIN runtime_library_releases r
          ON r.release_id = a.active_release_id WHERE a.slot = 'default'`);
      const current = verified.rows[0];
      if (
        !current ||
        current.active_release_id !== releaseId ||
        current.artifact_blob_key !== artifactKey ||
        current.artifact_sha256 !== archiveSha ||
        canonicalPackages(normalizePackageMap(current.packages_json)) !== canonicalPackages(manifest.packages)
      ) {
        throw new Error('Managed runtime-library release differs from the source');
      }
      if (artifactKey && archiveSha) {
        const storedArchive = await blobStore.getBuffer(artifactKey);
        if (createHash('sha256').update(storedArchive).digest('hex') !== archiveSha) {
          throw new Error('Managed runtime-library artifact differs from the source');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return Object.keys(manifest.packages).length;
  } finally {
    await pool.end();
    blobStore.dispose();
  }
}
