import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_STATS_SUFFIX } from '../routes/workflows/fs-helpers.js';
import { inspectLocalSqliteSnapshot } from '../local-metadata/sqlite-snapshot.js';

async function hashTree(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative = '',
  ignore?: (relativePath: string) => boolean,
  allowInternalSymlinks = false,
): Promise<void> {
  if (ignore?.(relative)) return;
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update(`missing\0${relative}\0`);
    return;
  }
  const name = relative.replaceAll('\\', '/');
  if (stat.isSymbolicLink()) {
    if (!allowInternalSymlinks || relative === '')
      throw new Error(`Migration source contains a symlink: ${name || root}`);
    const link = await fs.readlink(absolute);
    const target = await fs.realpath(absolute);
    const relativeTarget = path.relative(await fs.realpath(root), target);
    if (
      path.isAbsolute(link) ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(`Runtime-library symlink escapes its root: ${name}`);
    }
    hash.update(`symlink\0${name}\0${link}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory\0${name}\0`);
    if (allowInternalSymlinks) hash.update(`mode\0${stat.mode & 0o7777}\0`);
    for (const entry of (await fs.readdir(absolute)).sort()) {
      await hashTree(hash, root, path.join(relative, entry), ignore, allowInternalSymlinks);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`Migration source contains a non-regular file: ${name}`);
  hash.update(`file\0${name}\0${stat.size}\0`);
  if (allowInternalSymlinks) hash.update(`mode\0${stat.mode & 0o7777}\0`);
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  const after = await fs.lstat(absolute);
  if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
    throw new Error(`Migration source changed while its manifest was read: ${name}`);
  }
}

type SourceRoots = {
  workflows: string;
  recordings: string;
  appData: string;
  runtimeLibraries: string;
};

/** Hash only owned source state, excluding migration status and derived recording indexes. */
export async function readVmMigrationSourceParts(roots: SourceRoots): Promise<Record<string, string>> {
  const parts: Record<string, string> = {};
  for (const [label, root] of [
    ['workflows', roots.workflows],
    ['recordings', roots.recordings],
    ['runtime-libraries', roots.runtimeLibraries],
  ] as const) {
    const hash = createHash('sha256');
    await hashTree(
      hash,
      root,
      '',
      label === 'workflows' ? (name) => name.endsWith(PROJECT_STATS_SUFFIX) : undefined,
      label === 'runtime-libraries',
    );
    parts[label] = hash.digest('hex');
  }
  const settings = createHash('sha256');
  await hashTree(settings, roots.appData, 'settings');
  parts.settings = settings.digest('hex');
  for (const database of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite', 'scheduled-runs.sqlite']) {
    if (database === 'scheduled-runs.sqlite') {
      try {
        // The scheduler retains a WAL connection while paused. Shutdown may
        // checkpoint it and remove WAL/SHM without changing any committed data.
        // Protect schema and rows, including committed WAL, not journal layout.
        parts[database] = (await inspectLocalSqliteSnapshot(path.join(roots.appData, database))).logicalHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      continue;
    }
    const hash = createHash('sha256');
    for (const suffix of ['', '-wal', '-shm']) {
      await hashTree(hash, roots.appData, `${database}${suffix}`);
    }
    parts[database] = hash.digest('hex');
  }
  return parts;
}

export function fingerprintVmMigrationSourceParts(parts: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function fingerprintVmMigrationSource(roots: SourceRoots): Promise<string> {
  return fingerprintVmMigrationSourceParts(await readVmMigrationSourceParts(roots));
}
