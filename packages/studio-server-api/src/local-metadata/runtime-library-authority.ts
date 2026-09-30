import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as tar from 'tar';
import { LocalWorkflowCatalog, type LocalRuntimeLibraryState } from './workflow-catalog.js';
import type { LocalMetadataServingSelection } from './serving-selection.js';
import { configureLocalRuntimeLibraryAuthority } from '../runtime-libraries/manifest.js';
import { createRuntimeLibraryDirectoryArchive } from '../scripts/migrate-runtime-libraries.js';

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
  let cacheRepair: Promise<void> | null = null;
  const repair = async () => {
    if (cacheReady) return;
    cacheRepair ??= materializeLocalRuntimeLibraries(selection.runtimeCacheRoot, state!)
      .then(() => {
        cacheReady = true;
      })
      .finally(() => {
        cacheRepair = null;
      });
    await cacheRepair;
  };
  try {
    state = await catalog.readRuntimeLibraryState();
    if (!state) throw new Error('Selected generation has no runtime-library activation state.');
    // Supervised startup has no admitted executions. Only this boundary can
    // prune inactive physical caches safely; live Code may lazy-require from
    // an earlier release after its workflow awaited other nodes.
    await materializeLocalRuntimeLibraries(selection.runtimeCacheRoot, state, { pruneInactive: true });
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
  { pruneInactive = false }: { pruneInactive?: boolean } = {},
): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `extract-${randomUUID()}`);
  const extracted = path.join(temporary, 'current');
  const current = path.join(root, 'current');
  const previous = path.join(root, `previous-${randomUUID()}`);
  // Each extracted release has a unique physical path. Node also caches package
  // entry-point/exports resolution, which deleting require.cache cannot reset.
  const releaseName = `cache-${randomUUID()}`;
  const release = path.join(root, releaseName);
  const nextLink = path.join(root, `link-${randomUUID()}`);
  await fs.mkdir(extracted, { recursive: true, mode: 0o700 });
  let moved = false;
  let promoted = false;
  let replaceLink = false;
  try {
    if (state.archive) {
      const archive = path.join(temporary, 'release.tar');
      await fs.writeFile(archive, state.archive, { mode: 0o600, flag: 'wx' });
      await tar.x({
        file: archive,
        cwd: extracted,
        strict: true,
        preservePaths: false,
        filter: (entryPath, entry) => {
          const parts = entryPath.replaceAll('\\', '/').split('/');
          const link = ('linkpath' in entry ? entry.linkpath : '')?.replaceAll('\\', '/') ?? '';
          const target = path.posix.normalize(
            path.posix.join(path.posix.dirname(entryPath.replaceAll('\\', '/')), link),
          );
          if (
            path.isAbsolute(entryPath) ||
            path.win32.isAbsolute(entryPath) ||
            parts.includes('..') ||
            path.isAbsolute(link) ||
            path.win32.isAbsolute(link) ||
            (link && (target === '..' || target.startsWith('../')))
          )
            throw new Error('Runtime-library archive contains an unsafe path.');
          return true;
        },
      });
      // Validate symlink targets and release structure with the same archive
      // writer used by conversion. Resolving packages does not execute them.
      await createRuntimeLibraryDirectoryArchive(extracted);
      const require = createRequire(path.join(extracted, 'package.json'));
      for (const name of Object.keys(state.manifest.packages)) require.resolve(name);
    } else {
      if (Object.keys(state.manifest.packages).length) throw new Error('Runtime-library packages have no archive.');
      await fs.mkdir(path.join(extracted, 'node_modules'));
      await fs.writeFile(path.join(extracted, 'package.json'), '{"private":true}');
    }
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
    await fs.rename(extracted, release);
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
      // POSIX rename replaces an existing symlink atomically. Readers in the
      // co-located executor must never observe current missing between renames.
      // Retain the directory/junction compatibility path for older caches.
      await fs.rename(nextLink, current);
      promoted = true;
    } catch (error) {
      if (moved) await fs.rename(previous, current);
      throw error;
    }
  } finally {
    // All paths are unique children of the known disposable cache root.
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.rm(nextLink, { force: true });
    // If restoration itself failed, leave the previous cache for diagnosis.
    if (promoted || !moved || (await fs.lstat(current).catch(() => null)))
      await fs.rm(previous, { recursive: true, force: true });
    if (!promoted) await fs.rm(release, { recursive: true, force: true });
    if (promoted && pruneInactive) {
      for (const name of await fs.readdir(root)) {
        if (name !== releaseName && /^cache-[a-f0-9-]{36}$/.test(name))
          await fs.rm(path.join(root, name), { recursive: true, force: true });
      }
    }
  }
}
