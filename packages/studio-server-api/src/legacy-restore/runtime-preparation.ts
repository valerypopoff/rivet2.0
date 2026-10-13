import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { npmInstall, validateCandidate } from '../runtime-libraries/managed/release-builder.js';
import {
  readSourceManifest,
  validateRuntimeLibraryDirectory,
  assertRuntimeLibraryArchiveSpace,
} from '../scripts/migrate-runtime-libraries.js';
import { readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { terminateChildProcess } from '../utils/exec.js';
import { assertPortableRuntimeTree } from './native-runtime.js';

export async function runtimeNeedsReinstallation(current: string): Promise<boolean> {
  try {
    await assertPortableRuntimeTree(current);
    return false;
  } catch (error) {
    if (error instanceof Error && error.message === 'Native runtime libraries require a platform-certified migration.')
      return true;
    throw error;
  }
}

export function restoreRuntimePlatform(): string {
  // An attestation for derived bytes, stored only in the encrypted operation payload.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return `${process.platform}/${process.arch}/${process.version}/${process.versions.modules}/${report?.header?.glibcVersionRuntime ?? 'non-glibc'}`;
}

/** Validate the npm lock without ever copying executable backup scripts or npm configuration. */
export function validateRestoreRuntimeLock(raw: unknown, dependencies: Record<string, string>) {
  for (const name of Object.keys(dependencies)) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214)
      throw new Error('Runtime package lock contains unsupported sources.');
  }
  const lock = raw as { lockfileVersion?: number; packages?: Record<string, Record<string, unknown>> };
  if (!lock || ![2, 3].includes(lock.lockfileVersion!) || !lock.packages || typeof lock.packages !== 'object')
    throw new Error('Runtime package reinstallation requires a valid npm lockfile.');
  const root = lock.packages[''];
  if (
    !root ||
    JSON.stringify(Object.entries((root.dependencies ?? {}) as object).sort()) !==
      JSON.stringify(Object.entries(dependencies).sort())
  )
    throw new Error('Runtime package lock does not match the backup manifest.');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.link ||
      name.includes('..') ||
      name.includes('\\') ||
      (name && !name.startsWith('node_modules/'))
    )
      throw new Error('Runtime package lock contains unsupported sources.');
    if (name) {
      if (typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string' || !entry.integrity)
        throw new Error('Runtime package lock contains unsupported sources.');
      let url: URL;
      try {
        url = new URL(entry.resolved);
      } catch {
        throw new Error('Runtime package lock contains unsupported sources.');
      }
      if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'registry.npmjs.org')
        throw new Error('Runtime package lock contains unsupported sources.');
    }
  }
  return lock;
}

/** destination is a fresh child of the operation scratch, never a live runtime path.
 * Pin the original dependency graph, install target-platform optional binaries, and retain derived bytes for retries. */
export async function prepareRestoreRuntime(source: string, destination: string): Promise<void> {
  const manifest = await readSourceManifest(source);
  const dependencies = Object.fromEntries(Object.values(manifest.packages).map((entry) => [entry.name, entry.version]));
  if (!Object.keys(dependencies).length) throw new Error('Runtime package reinstallation has no packages.');
  const current = path.join(source, 'current');
  await validateRuntimeLibraryDirectory(current);
  const allowance = await assertRuntimeLibraryArchiveSpace(current, path.dirname(destination));
  const space = await fs.statfs(path.dirname(destination), { bigint: true });
  // The original tree already occupies disk; reserve a candidate, npm cache and artifact margin.
  if (space.bavail * space.bsize < 4n * allowance + 64n * 1024n ** 2n)
    throw new Error('Insufficient restore scratch space for the runtime-library artifact.');
  const lockPath = path.join(current, 'package-lock.json');
  const lockStat = await fs.lstat(lockPath).catch(() => null);
  if (!lockStat?.isFile() || lockStat.isSymbolicLink())
    throw new Error('Runtime package reinstallation requires a valid npm lockfile.');
  const lock = validateRestoreRuntimeLock(JSON.parse(await readMigrationSourceUtf8(lockPath)), dependencies);
  // Detect a manifest/lock/tree mismatch before downloading anything.
  for (const name of Object.keys(dependencies)) {
    const installed = JSON.parse(
      await readMigrationSourceUtf8(path.join(current, 'node_modules', name, 'package.json')),
    );
    if (installed.version !== lock.packages![`node_modules/${name}`]?.version)
      throw new Error('Runtime package lock does not match the installed backup packages.');
  }
  await fs.mkdir(destination); // Exclusive creation; archive content cannot pre-create an attestation.
  const candidate = path.join(destination, 'current');
  await fs.mkdir(candidate);
  const cache = path.join(destination, '.npm-cache');
  let child: ChildProcess | null = null;
  try {
    await fs.writeFile(
      path.join(candidate, 'package.json'),
      JSON.stringify({
        name: 'rivet-runtime-libraries',
        version: '1.0.0',
        private: true,
        dependencies,
      }),
    );
    await fs.writeFile(path.join(candidate, 'package-lock.json'), JSON.stringify(lock));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      npm_config_cache: cache,
      npm_config_userconfig: path.join(destination, 'empty.npmrc'),
      npm_config_globalconfig: path.join(destination, 'empty-global.npmrc'),
      npm_config_registry: 'https://registry.npmjs.org/',
      TMPDIR: destination,
      TEMP: destination,
      TMP: destination,
    };
    const code = await npmInstall(
      'restore',
      candidate,
      async () => {},
      (_id, process) => {
        child = process;
      },
      () => {
        if (child) terminateChildProcess(child, 'SIGTERM');
      },
      async () => false,
      { locked: true, ignoreScripts: true, env },
    );
    if (code !== 0) throw new Error('Runtime package reinstallation failed.');
    if (validateCandidate(candidate, manifest.packages).length)
      throw new Error('Runtime package reinstallation failed.');
    await validateRuntimeLibraryDirectory(candidate);
    for (const name of Object.keys(dependencies)) {
      const installed = JSON.parse(
        await readMigrationSourceUtf8(path.join(candidate, 'node_modules', name, 'package.json')),
      );
      if (installed.version !== lock.packages![`node_modules/${name}`]?.version)
        throw new Error('Runtime package reinstallation failed.');
    }
    await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
  } catch (error) {
    if (child) terminateChildProcess(child, 'SIGKILL');
    throw error;
  } finally {
    await fs.rm(cache, { recursive: true, force: true });
  }
}
