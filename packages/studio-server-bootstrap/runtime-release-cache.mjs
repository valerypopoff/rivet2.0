import fs from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as tar from 'tar';

const markerName = '.rivet-runtime-release.json';
const cacheName = /^cache-[a-f0-9-]{36}$/;
const preparations = new Map();
export function runtimePackagesKey(packages) {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages))
    throw new Error('Invalid runtime-library package map.');
  return JSON.stringify(
    Object.entries(packages)
      .map(([name, entry]) => {
        if (!name || !entry || typeof entry.version !== 'string' || !entry.version.trim())
          throw new Error('Invalid runtime-library package entry.');
        return [name, entry.version.trim(), entry.installedAt ?? null];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
const packagesKey = (manifest) => runtimePackagesKey(manifest.packages);
const missing = (error) => error?.code === 'ENOENT';

function readJson(file) {
  if (!lstatSync(file).isFile()) throw new Error('Runtime-library metadata must be a regular file.');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Strict execution/operational reader. A damaged manifest is never an empty release. */
export function readRuntimeCacheManifest(root) {
  try {
    const manifest = readJson(path.join(root, 'manifest.json'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !manifest.packages ||
      Array.isArray(manifest.packages) ||
      typeof manifest.packages !== 'object'
    )
      throw new Error('Invalid runtime-library manifest.');
    for (const [name, entry] of Object.entries(manifest.packages))
      if (!name || !entry || typeof entry.version !== 'string' || !entry.version.trim())
        throw new Error('Invalid runtime-library package entry.');
    if (
      manifest.activeReleaseId != null &&
      (typeof manifest.activeReleaseId !== 'string' || !manifest.activeReleaseId.trim())
    )
      throw new Error('Invalid runtime-library release identity.');
    return manifest;
  } catch (error) {
    if (!missing(error)) throw error;
    let entries;
    try {
      entries = readdirSync(root);
    } catch (rootError) {
      if (!missing(rootError)) throw rootError;
      entries = [];
    }
    if (
      entries.some(
        (name) => name === 'current' || name === 'active-release' || name === 'releases' || cacheName.test(name),
      )
    )
      throw new Error('Runtime-library state has no manifest.');
    return { packages: {}, updatedAt: '' };
  }
}

function physicalDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Runtime-library release must be a real directory.');
  return realpathSync.native(directory);
}

function readSnapshot(root, manifest, directory) {
  const physical = physicalDirectory(directory);
  if (path.dirname(physical) !== realpathSync.native(root) || !cacheName.test(path.basename(physical)))
    throw new Error('Runtime-library cache path is outside its owned root.');
  const marker = readJson(path.join(physical, markerName));
  if (
    marker.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(marker.integrity) ||
    marker.packagesKey !== runtimePackagesKey(marker.packages) ||
    marker.packagesKey !== packagesKey(manifest) ||
    marker.releaseId !== (manifest.activeReleaseId ?? null)
  )
    throw new Error('Runtime-library cache identity differs from its manifest.');
  physicalDirectory(path.join(physical, 'node_modules'));
  if (!lstatSync(path.join(physical, 'package.json')).isFile())
    throw new Error('Runtime-library cache has no package.json.');
  assertStableRuntimeResolution(root);
  return Object.freeze({
    version: 1,
    root: realpathSync.native(root),
    directory: physical,
    releaseId: marker.releaseId,
    integrity: marker.integrity,
    requireAnchorPath: path.join(physical, 'node_modules', '__rivet_runtime__.cjs'),
  });
}

function assertStableRuntimeResolution(root) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const owned = normalize(root);
  const globalPaths = createRequire(import.meta.url)('node:module').globalPaths;
  for (const directory of [...globalPaths, ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)]) {
    const targets = [normalize(directory)];
    try {
      targets.push(normalize(realpathSync.native(directory)));
    } catch (error) {
      if (!missing(error) && error?.code !== 'ENOTDIR') throw error;
    }
    if (targets.some((target) => target === owned || target.startsWith(owned + path.sep)))
      throw new Error(
        'NODE_PATH must not point into the mutable runtime-library cache. Remove that override before using managed snapshots.',
      );
  }
}

/** Resolve a single manifest/path pair without following an arbitrary current symlink. */
export function selectRuntimeLibrarySource(root, manifest = readRuntimeCacheManifest(root)) {
  if (manifest.runtimeCache !== undefined) {
    const ref = manifest.runtimeCache;
    if (!ref || ref.version !== 1 || typeof ref.directory !== 'string' || !cacheName.test(ref.directory))
      throw new Error('Invalid runtime-library cache reference.');
    const snapshot = readSnapshot(root, manifest, path.join(root, ref.directory));
    if (ref.integrity !== snapshot.integrity) throw new Error('Runtime-library cache checksum reference differs.');
    return { manifest, directory: snapshot.directory, snapshot };
  }
  const directory = path.join(root, 'current');
  try {
    physicalDirectory(directory);
  } catch (error) {
    if (!missing(error)) throw error;
    if (Object.keys(manifest.packages).length) throw new Error('Runtime-library packages have no release directory.');
    return { manifest, directory: null, snapshot: null };
  }
  if (!Object.keys(manifest.packages).length) {
    const entries = readdirSync(path.join(directory, 'node_modules')).filter((name) => name !== '.package-lock.json');
    if (entries.length) throw new Error('Empty runtime-library manifest has installed packages.');
  }
  return { manifest, directory, snapshot: undefined };
}

/** SQLite uses its catalog, not manifest.json. Its confined link points to a complete cache. */
export function readRuntimeSnapshotLink(root, manifest) {
  const current = path.join(root, 'current');
  if (!lstatSync(current).isSymbolicLink()) throw new Error('SQLite runtime-library activation link is invalid.');
  const directory = realpathSync.native(current);
  if (path.dirname(directory) !== realpathSync.native(root) || !cacheName.test(path.basename(directory)))
    throw new Error('Runtime-library activation link escapes its cache root.');
  if (!manifest) {
    const marker = readJson(path.join(directory, markerName));
    manifest = { packages: marker.packages, activeReleaseId: marker.releaseId ?? undefined };
  }
  return readSnapshot(root, manifest, directory);
}

/** Validate only filesystem shape/links; never execute authored package code. */
export async function inspectRuntimeLibraryDirectory(directory) {
  const root = physicalDirectory(directory);
  const hash = createHash('sha256');
  let bytes = 0n;
  const walk = async (file) => {
    const stat = await fs.lstat(file);
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (relative === markerName) return;
    hash.update(`${relative}\0`);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(file);
      const resolved = path.relative(root, await fs.realpath(file));
      if (
        path.isAbsolute(target) ||
        path.win32.isAbsolute(target) ||
        resolved === '..' ||
        resolved.startsWith(`..${path.sep}`) ||
        path.isAbsolute(resolved)
      )
        throw new Error('Runtime-library symlink escapes its release.');
      hash.update(`link\0${target}\0`);
    } else if (stat.isDirectory()) {
      hash.update('directory\0');
      for (const entry of (await fs.readdir(file)).sort()) await walk(path.join(file, entry));
    } else if (stat.isFile()) {
      bytes += BigInt(stat.size);
      hash.update(`file\0${stat.size}\0`);
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    } else throw new Error('Runtime-library release has an unsupported entry.');
  };
  await walk(root);
  if (!(await fs.lstat(path.join(root, 'package.json'))).isFile())
    throw new Error('Runtime-library release needs package.json.');
  physicalDirectory(path.join(root, 'node_modules'));
  return { integrity: hash.digest('hex'), bytes };
}

async function assertSpace(root, bytes) {
  const available = await fs.statfs(root, { bigint: true });
  if (available.bavail * available.bsize < bytes + 64n * 1024n ** 2n)
    throw new Error('Insufficient runtime-library cache space; existing releases were preserved.');
}

export async function writeRuntimeCacheManifest(root, manifest) {
  const temporary = path.join(root, `manifest-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(root, 'manifest.json'));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Candidate ownership transfers here; no existing cache or legacy current is moved/deleted. */
export async function publishRuntimeLibraryCandidate(
  root,
  candidate,
  manifest,
  { integrity, publishManifest = true } = {},
) {
  await fs.mkdir(root, { recursive: true });
  root = await fs.realpath(root);
  candidate = physicalDirectory(candidate);
  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    cacheName.test(relative) ||
    relative.split(path.sep)[0] === 'current'
  )
    throw new Error('Runtime-library candidate is not an owned staging directory.');
  const inspected = await inspectRuntimeLibraryDirectory(candidate);
  assertStableRuntimeResolution(root);
  const require = createRequire(path.join(candidate, 'node_modules', '__validate.cjs'));
  for (const name of Object.keys(manifest.packages)) {
    const resolved = require.resolve(name);
    const local = path.relative(candidate, resolved);
    if (!path.isAbsolute(resolved) || local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local))
      throw new Error('Declared runtime package resolves outside its prepared release.');
  }
  integrity ??= inspected.integrity;
  if (!/^[a-f0-9]{64}$/.test(integrity)) throw new Error('Invalid runtime-library artifact checksum.');
  const cleanManifest = {
    packages: structuredClone(manifest.packages),
    updatedAt: manifest.updatedAt ?? new Date().toISOString(),
    ...(manifest.activeReleaseId ? { activeReleaseId: manifest.activeReleaseId } : {}),
  };
  if (
    !Object.keys(cleanManifest.packages).length &&
    (await fs.readdir(path.join(candidate, 'node_modules'))).some((name) => name !== '.package-lock.json')
  )
    throw new Error('Empty runtime-library release contains packages.');
  const name = `cache-${randomUUID()}`;
  const marker = {
    version: 1,
    integrity,
    releaseId: cleanManifest.activeReleaseId ?? null,
    packagesKey: packagesKey(cleanManifest),
    packages: cleanManifest.packages,
  };
  const markerPath = path.join(candidate, markerName);
  // An extracted marker may be linked to a package file. Replace the entry,
  // rather than truncating its target while writing host-owned metadata.
  await fs.rm(markerPath, { force: true });
  await fs.writeFile(markerPath, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  await fs.rename(candidate, path.join(root, name));
  const nextManifest = { ...cleanManifest, runtimeCache: { version: 1, directory: name, integrity } };
  // A failed manifest write leaves only an unreferenced complete cache. Never
  // remove it here: the acknowledgement may have been lost after publication.
  if (publishManifest) await writeRuntimeCacheManifest(root, nextManifest);
  return { manifest: nextManifest, snapshot: readSnapshot(root, nextManifest, path.join(root, name)) };
}

export async function extractRuntimeLibraryArchive(root, archive) {
  await fs.mkdir(path.join(root, 'jobs'), { recursive: true });
  await assertSpace(root, BigInt(archive.length) * 2n);
  const temporary = await fs.mkdtemp(path.join(root, 'jobs', 'extract-'));
  const candidate = path.join(temporary, 'candidate');
  try {
    await fs.mkdir(candidate);
    const file = path.join(temporary, 'release.tar');
    await fs.writeFile(file, archive);
    const space = await fs.statfs(root, { bigint: true });
    const available = space.bavail * space.bsize - 64n * 1024n ** 2n;
    let extractedBytes = 0n;
    let validationError;
    const reject = (message) => {
      validationError ??= new Error(message);
      return false;
    };
    await tar.x({
      file,
      cwd: candidate,
      strict: true,
      preservePaths: false,
      filter(entry, header) {
        if (validationError) return false;
        if (!Number.isSafeInteger(header.size) || header.size < 0)
          return reject('Invalid runtime-library archive entry size.');
        extractedBytes += BigInt(header.size) + 4096n;
        if (extractedBytes > available) return reject('Runtime-library archive exceeds available cache space.');
        const name = entry.replaceAll('\\', '/');
        const link = (header.linkpath ?? '').replaceAll('\\', '/');
        // Tar hard links are archive-root-relative; symbolic links are relative
        // to their entry's parent directory.
        const target = path.posix.normalize(
          path.posix.join(header.type === 'Link' ? '' : path.posix.dirname(name), link),
        );
        if (
          path.isAbsolute(name) ||
          path.win32.isAbsolute(name) ||
          /^[a-z]:/i.test(name) ||
          name.split('/').includes('..') ||
          path.isAbsolute(link) ||
          path.win32.isAbsolute(link) ||
          /^[a-z]:/i.test(link) ||
          target === '..' ||
          target.startsWith('../')
        )
          return reject('Runtime-library archive contains an unsafe path.');
        return true;
      },
    });
    // tar invokes filters from its stream callback. Throwing there can escape
    // the extraction Promise; report a normal failed preparation after closing it.
    if (validationError) throw validationError;
    return { candidate, dispose: () => fs.rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function publishEmptyRuntimeRelease(root, manifest, options) {
  await fs.mkdir(path.join(root, 'jobs'), { recursive: true });
  const parent = await fs.mkdtemp(path.join(root, 'jobs', 'empty-'));
  const candidate = path.join(parent, 'candidate');
  try {
    await fs.mkdir(path.join(candidate, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(candidate, 'package.json'), '{"private":true}');
    return await publishRuntimeLibraryCandidate(root, candidate, manifest, options);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

export async function prepareFilesystemRuntimeSnapshot(root, { allowAbsent = false } = {}) {
  root = path.resolve(root);
  const existing = preparations.get(root);
  if (existing) return existing;
  const task = (async () => {
    try {
      physicalDirectory(root);
    } catch (error) {
      if (!missing(error)) throw error;
      if (allowAbsent) return null;
      await fs.mkdir(root, { recursive: true });
    }
    const source = selectRuntimeLibrarySource(root);
    if (source.snapshot) return source.snapshot;
    const parent = await fs.mkdtemp(path.join(root, 'prepare-'));
    const candidate = path.join(parent, 'candidate');
    try {
      if (source.directory) {
        const inspected = await inspectRuntimeLibraryDirectory(source.directory);
        await assertSpace(root, inspected.bytes);
        await fs.cp(source.directory, candidate, { recursive: true, verbatimSymlinks: true });
      } else {
        await fs.mkdir(path.join(candidate, 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(candidate, 'package.json'), '{"private":true}');
      }
      return (await publishRuntimeLibraryCandidate(root, candidate, source.manifest)).snapshot;
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  })();
  preparations.set(root, task);
  try {
    return await task;
  } finally {
    if (preparations.get(root) === task) preparations.delete(root);
  }
}

/** Shared API/bootstrap coalescing. Forced waiters require a subsequent round,
 * not independent concurrent writers after awaiting the current promise. */
export function createRuntimeLibrarySync(run, intervalMs) {
  let promise,
    result,
    checkedAt = 0,
    running = 0,
    completed = 0,
    requested = 0;
  const startPending = () => {
    if (promise || completed >= requested) return;
    const task = (async () => {
      while (completed < requested) {
        running = completed + 1;
        result = await run();
        completed = running;
        checkedAt = Date.now();
      }
    })();
    promise = task
      .catch((error) => {
        requested = completed;
        running = completed;
        throw error;
      })
      .finally(() => {
        promise = undefined;
      });
  };
  return {
    reset() {
      checkedAt = 0;
    },
    async drain() {
      while (promise || completed < requested) {
        startPending();
        await promise;
      }
    },
    async sync(force = false) {
      if (!promise && !force && checkedAt && completed === requested && Date.now() - checkedAt < intervalMs)
        return result;
      const target = promise && !force ? requested : running + 1;
      requested = Math.max(requested, target);
      while (completed < target) {
        startPending();
        await promise;
      }
      return result;
    },
  };
}
