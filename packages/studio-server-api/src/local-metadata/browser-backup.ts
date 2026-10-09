import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { z } from 'zod';
import type { LocalMetadataSourceRoots } from './source-identity.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import {
  syncDirectory,
  syncFileDescriptor,
  writeDurableExclusive,
} from '../routes/workflows/filesystem-transaction-primitives.js';

const domains = ['workflows', 'recordings', 'appData', 'runtimeLibraries'] as const;
const backupSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    pausedAt: z.string(),
    phase: z.enum(['creating', 'ready', 'failed']),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    archiveHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    bytes: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict()
  .refine(
    (state) =>
      state.phase === 'ready'
        ? state.archiveHash !== null && state.bytes > 0
        : state.archiveHash === null && state.bytes === 0,
    'Backup phase and archive evidence do not match.',
  );
export type BrowserBackup = z.infer<typeof backupSchema>;
const stateFile = (control: string) => path.join(control, 'browser-backup.json');
export const browserBackupDirectory = (control: string, id: string) => {
  z.string().uuid().parse(id);
  return path.join(control, 'browser-backups', id);
};

async function realDirectory(directory: string): Promise<void> {
  let cursor = path.resolve(directory);
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe backup directory.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

export async function readBrowserBackup(control: string): Promise<BrowserBackup | null> {
  try {
    const stat = await fs.lstat(stateFile(control));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid backup status.');
    return backupSchema.parse(JSON.parse(await fs.readFile(stateFile(control), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveBrowserBackup(control: string, state: BrowserBackup): Promise<void> {
  const temp = path.join(control, `browser-backup-${randomUUID()}.tmp`);
  await writeDurableExclusive(temp, JSON.stringify(backupSchema.parse(state)), 0o600);
  await fs.rename(temp, stateFile(control));
  await syncDirectory(control);
}

/** Remove obsolete certification from admission without parsing it. A corrupt
 * optional status must not block a separately verified project-ID repair.
 * Preserve both the status bytes and all archives for operator recovery. */
export async function invalidateBrowserBackup(control: string): Promise<void> {
  await realDirectory(control);
  try {
    const stat = await fs.lstat(stateFile(control));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid backup status entry.');
    await fs.rename(stateFile(control), path.join(control, `browser-backup-invalidated-${randomUUID()}.json`));
    await syncDirectory(control);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** All bytes, modes, directories and confined links, not just migration-owned
 * metadata. Streams each file so recordings do not occupy aggregate RAM. */
async function scanRoots(roots: LocalMetadataSourceRoots) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const domain of domains) {
    const root = roots[domain];
    await realDirectory(root);
    hash.update(`${domain}\0`);
    const visit = async (relative: string): Promise<void> => {
      const file = path.join(root, relative);
      const before = await fs.lstat(file);
      if (before.mode & 0o6000) throw new Error('Set-ID backup entries are unsupported.');
      hash.update(`${relative.replaceAll('\\', '/')}\0${before.mode & 0o1777}\0`);
      if (before.isSymbolicLink()) {
        if (domain !== 'runtimeLibraries') throw new Error('Unexpected backup link.');
        const link = await fs.readlink(file);
        const target = path.relative(root, await fs.realpath(file));
        if (path.isAbsolute(link) || target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target))
          throw new Error('Backup link escapes source.');
        hash.update(`link\0${link}\0`);
      } else if (before.isDirectory()) {
        hash.update('directory\0');
        for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      } else {
        if (!before.isFile()) throw new Error('Unsupported backup entry.');
        bytes += before.size;
        if (!Number.isSafeInteger(bytes)) throw new Error('Backup size is unsupported.');
        hash.update(`file\0${before.size}\0`);
        for await (const chunk of createReadStream(file)) hash.update(chunk);
      }
      const after = await fs.lstat(file);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error('Source changed during backup.');
    };
    await visit('');
  }
  return { hash: hash.digest('hex'), bytes };
}

const rootsAt = (directory: string): LocalMetadataSourceRoots =>
  Object.fromEntries(domains.map((domain) => [domain, path.join(directory, domain)])) as LocalMetadataSourceRoots;

export async function hashBackupArchive(file: string): Promise<string> {
  await realDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid backup archive.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Restore only into fresh owned scratch. Apply the archive's own permissions
 * after extraction: tar's parent creation and the process umask can otherwise
 * change directory/file modes while processing subsequent entries. */
export async function restoreBrowserBackupArchive(archive: string, destination: string): Promise<void> {
  await realDirectory(destination);
  if ((await fs.readdir(destination)).length) throw new Error('Backup restore requires empty scratch storage.');
  const modes: Array<{ file: string; mode: number; directory: boolean }> = [];
  let unsafe = false;
  await tar.x({
    cwd: destination,
    file: archive,
    strict: true,
    preservePaths: false,
    onReadEntry: (entry) => {
      if (!['File', 'Directory'].includes(entry.type)) return;
      const file = path.resolve(destination, entry.path);
      const relative = path.relative(destination, file);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        entry.mode === undefined ||
        entry.mode & 0o6000
      ) {
        unsafe = true;
        return;
      }
      modes.push({ file, mode: entry.mode & 0o1777, directory: entry.type === 'Directory' });
    },
  });
  if (unsafe) throw new Error('Unsafe backup restore entry.');
  // Children first keeps traversal available until all file modes are restored.
  modes.sort((a, b) => b.file.length - a.file.length);
  for (const entry of modes) {
    await realDirectory(path.dirname(entry.file));
    const stat = await fs.lstat(entry.file);
    if (stat.isSymbolicLink() || (entry.directory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('Unsafe restored backup entry.');
    await fs.chmod(entry.file, entry.mode);
  }
}

async function removeVerifiedScratch(ownedDirectory: string, name: 'staging' | 'restored'): Promise<void> {
  await realDirectory(ownedDirectory);
  const root = path.resolve(ownedDirectory, name);
  if (path.dirname(root) !== path.resolve(ownedDirectory)) throw new Error('Invalid backup scratch path.');
  const makeRemovable = async (directory: string): Promise<void> => {
    const relative = path.relative(root, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('Backup scratch cleanup escapes its owned root.');
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid backup scratch directory.');
    // Exact copies may contain 0555 package directories. A non-root process
    // needs owner write/traversal for disposal, but only AFTER verification.
    await fs.chmod(directory, (stat.mode & 0o1777) | 0o700);
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await makeRemovable(path.join(directory, entry.name));
  };
  await makeRemovable(root);
  await fs.rm(root, { recursive: true });
  await syncDirectory(ownedDirectory);
}

/** A server-side restore proves the actual downloadable archive, not merely
 * the directory fed to tar. This is not proof of off-host download/storage. */
export async function createBrowserBackupArchive(options: {
  control: string;
  source: LocalMetadataSourceRoots;
  state: BrowserBackup;
  assertFrozen: () => Promise<void>;
}): Promise<BrowserBackup> {
  const { control, source, state, assertFrozen } = options;
  await assertFrozen();
  await realDirectory(control);
  const authorityRoots = [control, ...Object.values(source)];
  const identities = await Promise.all(
    authorityRoots.map(async (root) => {
      await realDirectory(root);
      const ancestors = new Set<string>();
      let cursor = root;
      const stat = await fs.stat(root, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}`;
      for (;;) {
        const parentStat = await fs.stat(cursor, { bigint: true });
        ancestors.add(`${parentStat.dev}:${parentStat.ino}`);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return { identity, ancestors };
    }),
  );
  for (let i = 0; i < identities.length; i++)
    for (let j = i + 1; j < identities.length; j++) {
      if (
        identities[i]!.ancestors.has(identities[j]!.identity) ||
        identities[j]!.ancestors.has(identities[i]!.identity)
      )
        throw new Error('Backup authority roots overlap.');
    }
  const parent = path.join(control, 'browser-backups');
  await fs.mkdir(parent, { mode: 0o700, recursive: true });
  await realDirectory(parent);
  const directory = browserBackupDirectory(control, state.id);
  // Fresh owned directory only; never reuse/overwrite a source or earlier backup.
  await fs.mkdir(directory, { mode: 0o700 });
  // Sync the UUID entry too, not just files inside it. Ready status must not
  // survive a power loss while its archive directory disappears.
  await syncDirectory(parent);
  const original = await scanRoots(source);
  const disk = await fs.statfs(control);
  if (disk.bavail * disk.bsize < original.bytes * 3 + 64 * 1048576) throw new Error('Insufficient backup disk space.');
  if ((await fingerprintVmMigrationSource(source)) !== state.sourceFingerprint)
    throw new Error('Frozen source changed.');
  const staging = path.join(directory, 'staging');
  await fs.mkdir(staging, { mode: 0o700 });
  for (const domain of domains) {
    await assertFrozen();
    await fs.cp(source[domain], path.join(staging, domain), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
  }
  if ((await scanRoots(rootsAt(staging))).hash !== original.hash) throw new Error('Backup copy differs.');
  await writeDurableExclusive(
    path.join(staging, 'backup.json'),
    JSON.stringify({
      version: 1,
      kind: 'rivet-browser-legacy-backup',
      createdAt: state.createdAt,
      sourceFingerprint: state.sourceFingerprint,
      contentHash: original.hash,
      roots: domains,
      encryptionKeyIncluded: false,
    }),
    0o600,
  );
  const archive = path.join(directory, 'backup.tar.gz');
  // tar's portable mode normalizes away group/other write bits, so it cannot
  // certify an exact filesystem restore (for example a sticky 01777 directory).
  await tar.c({ cwd: staging, file: archive, gzip: true, strict: true }, [...domains, 'backup.json']);
  await fs.chmod(archive, 0o600);
  const restored = path.join(directory, 'restored');
  await fs.mkdir(restored, { mode: 0o700 });
  await restoreBrowserBackupArchive(archive, restored);
  const restoredRoots = rootsAt(restored);
  if (
    (await scanRoots(restoredRoots)).hash !== original.hash ||
    (await fingerprintVmMigrationSource(restoredRoots)) !== state.sourceFingerprint
  )
    throw new Error('Restored archive differs.');
  await assertFrozen();
  if (
    (await scanRoots(source)).hash !== original.hash ||
    (await fingerprintVmMigrationSource(source)) !== state.sourceFingerprint
  )
    throw new Error('Source changed after backup.');
  const handle = await fs.open(archive, 'r+');
  try {
    await syncFileDescriptor(handle.fd);
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  const ready: BrowserBackup = {
    ...state,
    phase: 'ready',
    archiveHash: await hashBackupArchive(archive),
    bytes: (await fs.stat(archive)).size,
  };
  // Only scratch under this newly created, verified owned directory is removed.
  await removeVerifiedScratch(directory, 'staging');
  await removeVerifiedScratch(directory, 'restored');
  return ready;
}
