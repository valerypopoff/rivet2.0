import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalWorkflowCatalog, type LocalRuntimeLibraryState } from './workflow-catalog.js';
import type { LocalMetadataServingSelection } from './serving-selection.js';
import { configureLocalRuntimeLibraryAuthority } from '../runtime-libraries/manifest.js';
import { createRuntimeLibraryDirectoryArchive } from '../scripts/migrate-runtime-libraries.js';
import {
  extractRuntimeLibraryArchive,
  publishRuntimeLibraryCandidate,
  publishEmptyRuntimeRelease,
  readRuntimeSnapshotLink,
  type RuntimeLibrarySnapshot,
} from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';

/** Only a rebuildable package cache is extracted. The catalog's archive pointer
 * is authoritative; manifest.json is never read, rewritten or recreated here. */
export async function initializeLocalRuntimeLibraryAuthority(
  selection: LocalMetadataServingSelection,
  assertWritable: () => void,
): Promise<() => void> {
  const catalog = new LocalWorkflowCatalog({
    databasePath: selection.catalogDatabasePath,
    artifactRoot: selection.artifactRoot,
  });
  catalog.initialize({ requireExisting: true });
  let state: LocalRuntimeLibraryState | null = null;
  let cacheReady = false;
  let cacheRepair: Promise<RuntimeLibrarySnapshot> | null = null;
  let snapshot: RuntimeLibrarySnapshot | undefined;
  const repair = async () => {
    if (cacheReady && snapshot) return snapshot;
    cacheRepair ??= materializeLocalRuntimeLibraries(selection.runtimeCacheRoot, state!)
      .then((prepared) => {
        snapshot = prepared;
        cacheReady = true;
        return prepared;
      })
      .finally(() => {
        cacheRepair = null;
      });
    return cacheRepair;
  };
  try {
    state = await catalog.readRuntimeLibraryState();
    if (!state) throw new Error('Selected generation has no runtime-library activation state.');
    // An API-only restart may leave the separate executor using an older cache.
    // Materialization must preserve every previously published directory.
    snapshot = await materializeLocalRuntimeLibraries(selection.runtimeCacheRoot, state);
    cacheReady = true;
    configureLocalRuntimeLibraryAuthority({
      read: () => {
        if (!cacheReady) throw new Error('Runtime-library cache needs repair from the selected SQL archive.');
        return state!.manifest;
      },
      prepare: repair,
      activate: async (staging, manifest) => {
        await repair();
        assertWritable();
        const archive = Object.keys(manifest.packages).length
          ? await createRuntimeLibraryDirectoryArchive(staging)
          : null;
        assertWritable();
        const next = {
          manifest: {
            ...manifest,
            activeReleaseId: archive ? `local-${createHash('sha256').update(archive).digest('hex')}` : undefined,
          },
          archive,
        };
        // Commit the durable immutable package archive before changing caches.
        // If cache promotion fails, startup/execution preparation must repair
        // from SQL; never undo the committed pointer or report stale libraries.
        await catalog.replaceRuntimeLibraryState(state!, next);
        state = next;
        cacheReady = false;
        await repair();
      },
    });
    return () => {
      configureLocalRuntimeLibraryAuthority(null);
      catalog.close();
    };
  } catch (error) {
    catalog.close();
    throw error;
  }
}

export async function materializeLocalRuntimeLibraries(
  root: string,
  state: LocalRuntimeLibraryState,
): Promise<RuntimeLibrarySnapshot> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const integrity = state.archive ? createHash('sha256').update(state.archive).digest('hex') : undefined;
  try {
    const current = readRuntimeSnapshotLink(root, state.manifest);
    if (!integrity || current.integrity === integrity) return current;
  } catch {
    // A missing/damaged disk cache is rebuilt from the catalog's archive.
    // Never fall back to an unverified cache or remove a previous reader's files.
  }
  const prepared = state.archive
    ? await (async () => {
        const extracted = await extractRuntimeLibraryArchive(root, state.archive!);
        try {
          return await publishRuntimeLibraryCandidate(root, extracted.candidate, state.manifest, {
            publishManifest: false,
            integrity,
          });
        } finally {
          await extracted.dispose();
        }
      })()
    : await publishEmptyRuntimeRelease(root, state.manifest, { publishManifest: false });
  const release = prepared.snapshot.directory;
  const releaseName = path.basename(release);
  const current = path.join(root, 'current');
  const previous = path.join(root, `previous-${randomUUID()}`);
  const nextLink = path.join(root, `link-${randomUUID()}`);
  let moved = false,
    promoted = false,
    replaceLink = false;
  try {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(current);
        const target = path.resolve(root, link);
        if (
          !/^cache-[a-f0-9-]{36}$/.test(path.basename(target)) ||
          path.dirname(target) !== path.resolve(root) ||
          (process.platform !== 'win32' && path.isAbsolute(link))
        )
          throw new Error('Runtime-library cache has an unexpected activation link.');
        replaceLink = process.platform !== 'win32';
      } else if (!stat.isDirectory()) throw new Error('Runtime-library cache has an invalid activation entry.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.symlink(releaseName, nextLink, process.platform === 'win32' ? 'junction' : 'dir');
    if (!replaceLink) {
      try {
        await fs.rename(current, previous);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await fs.rename(nextLink, current);
      promoted = true;
    } catch (error) {
      if (moved) await fs.rename(previous, current);
      throw error;
    }
    return prepared.snapshot;
  } finally {
    await fs.rm(nextLink, { force: true });
    if (promoted || !moved || (await fs.lstat(current).catch(() => null)))
      await fs.rm(previous, { recursive: true, force: true });
    if (!promoted) await fs.rm(release, { recursive: true, force: true });
  }
}
