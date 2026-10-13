import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import path from 'node:path';
import * as tar from 'tar';
import { restoreBrowserBackupArchive, verifyLegacyBackupDirectory } from '../local-metadata/browser-backup.js';

export const LEGACY_RESTORE_LIMITS = {
  archiveBytes: 10 * 1024 ** 3,
  expandedBytes: 30 * 1024 ** 3,
  entries: 1_000_000,
  depth: 128,
};
const roots = new Set(['workflows', 'recordings', 'appData', 'runtimeLibraries']);

/** A crash may leave partial extraction. Rebuild only the journal's UUID-owned source directory. */
export async function resetRestoreScratch(
  archive: string,
  destination: string,
  id: string,
  storageRoot: string,
  digest: string,
) {
  const owner = path.dirname(archive);
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    path.basename(owner) !== id ||
    path.dirname(owner) !== path.resolve(storageRoot) ||
    archive !== path.join(owner, 'archive.tar.gz') ||
    destination !== path.join(owner, 'source')
  )
    throw new Error('Invalid restore scratch ownership.');
  for (const directory of [storageRoot, owner]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== path.resolve(directory))
      throw new Error('Unsafe restore scratch.');
  }
  const scratch = await fs.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (
    scratch &&
    (!scratch.isDirectory() ||
      scratch.isSymbolicLink() ||
      (await fs.realpath(destination)) !== path.resolve(destination))
  )
    throw new Error('Unsafe restore scratch.');
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LEGACY_RESTORE_LIMITS.archiveBytes)
    throw new Error('Invalid uploaded archive.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('Uploaded archive changed.');
  const writable = async (directory: string): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    await fs.chmod(directory, stat.mode | 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(path.join(directory, entry.name));
  };
  if (scratch) {
    await writable(destination);
    await fs.rm(destination, { recursive: true });
  }
  await fs.mkdir(destination, { mode: 0o700 });
}

export function validateLegacyArchivePath(raw: string): string {
  if (
    !raw ||
    raw.includes('\\') ||
    raw.includes('\0') ||
    raw.length > 4096 ||
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw)
  )
    throw new Error('Unsafe backup path.');
  const value = raw.replace(/^\.\//, '').replace(/\/$/, '');
  const parts = value.split('/');
  if (
    parts.length > LEGACY_RESTORE_LIMITS.depth ||
    parts.some((p) => !p || p === '.' || p === '..') ||
    !(roots.has(parts[0]!) || value === 'backup.json')
  )
    throw new Error('Unsafe backup path.');
  return value;
}

/** Two passes: inspect every entry before extraction, then verify actual restored bytes/modes. */
export async function prepareLegacyArchive(
  archive: string,
  destination: string,
  options: { allowModifiedBackup?: boolean } = {},
) {
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LEGACY_RESTORE_LIMITS.archiveBytes)
    throw new Error('Backup archive exceeds its limit or is not a regular file.');
  const entries = new Map<string, string>();
  const links = new Set<string>();
  let expandedBytes = 0;
  const parser = new tar.Parser({
    strict: true,
    maxMetaEntrySize: 64 * 1024,
    onReadEntry: (entry) => {
      try {
        const name = validateLegacyArchivePath(entry.path);
        if (entries.has(name) || entries.size >= LEGACY_RESTORE_LIMITS.entries)
          throw new Error('Duplicate backup entry or entry limit exceeded.');
        if (
          !['File', 'Directory', 'SymbolicLink'].includes(entry.type) ||
          entry.mode === undefined ||
          entry.mode & 0o6000
        )
          throw new Error('Unsupported backup entry.');
        expandedBytes += entry.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > LEGACY_RESTORE_LIMITS.expandedBytes)
          throw new Error('Expanded backup exceeds its limit.');
        if (entry.type === 'SymbolicLink') {
          const target = entry.linkpath;
          if (
            !name.startsWith('runtimeLibraries/') ||
            !target ||
            target.includes('\\') ||
            target.includes('\0') ||
            path.posix.isAbsolute(target) ||
            /^[A-Za-z]:/.test(target)
          )
            throw new Error('Unsafe backup link.');
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
          if (!resolved.startsWith('runtimeLibraries/')) throw new Error('Backup link escapes runtime libraries.');
          links.add(name);
        }
        entries.set(name, entry.type);
        entry.resume();
      } catch (error) {
        parser.abort(error as Error);
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(archive);
    const unzip = createGunzip();
    let bytes = 0;
    const bound = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        // Count real decompressed bytes too, including headers/padding; declared file sizes cannot hide a gzip bomb.
        done(
          bytes > LEGACY_RESTORE_LIMITS.expandedBytes + LEGACY_RESTORE_LIMITS.entries * 1024
            ? new Error('Expanded backup exceeds its limit.')
            : null,
          chunk,
        );
      },
    });
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      stream.destroy();
      unzip.destroy();
      bound.destroy();
      parser.abort(error);
      reject(error);
    };
    parser.once('end', resolve);
    stream.once('error', fail);
    unzip.once('error', fail);
    bound.once('error', fail);
    parser.once('error', fail);
    stream.pipe(unzip).pipe(bound).pipe(parser);
  });
  for (const name of entries.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (links.has(parent) || (entries.has(parent) && entries.get(parent) !== 'Directory'))
        throw new Error('Backup entry traverses a non-directory.');
      parent = path.posix.dirname(parent);
    }
  }
  const missingRecordings = !entries.has('recordings');
  if (
    entries.get('backup.json') !== 'File' ||
    [...roots].some(
      (root) =>
        entries.get(root) !== 'Directory' &&
        !(root === 'recordings' && missingRecordings && options.allowModifiedBackup),
    )
  )
    throw new Error('Backup roots or manifest are missing.');
  const space = await fs.statfs(destination);
  if (space.bavail * space.bsize < expandedBytes + 64 * 1024 ** 2)
    throw new Error('Insufficient restore scratch space.');
  await restoreBrowserBackupArchive(archive, destination);
  // The operator may have intentionally removed the whole recordings domain.
  // Only that optional domain can be reconstructed; other roots remain mandatory.
  if (missingRecordings && options.allowModifiedBackup)
    await fs.mkdir(path.join(destination, 'recordings'), { recursive: true, mode: 0o700 });
  return verifyLegacyBackupDirectory(destination, options);
}
