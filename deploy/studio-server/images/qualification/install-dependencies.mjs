import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyActorSource } from './verify-source.mjs';

/** Only for the actor's private clean build checkout. Yarn's node-modules
 * linker removes tracked PnP loaders; retain their exact bytes and permissions so
 * the runtime can still verify the complete source, without a dirty-file waiver. */
export async function installActorDependencies(source, sourceSha, { env = process.env } = {}) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim();
  await verifyActorSource(source, sourceSha);
  const loaders = [];
  for (const name of ['.pnp.cjs', '.pnp.loader.mjs']) {
    git('ls-files', '--error-unmatch', '--', name);
    const file = path.join(source, name);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile());
    loaders.push({ file, bytes: await fs.readFile(file), mode: stat.mode & 0o777 });
  }
  // A Windows-published cache need not contain Alpine's optional musl archives.
  // Install them outside the checkout; never ignore new source/cache files to
  // make source admission pass. Seed verified committed archives to avoid
  // fetching the entire dependency graph again.
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-cache-'));
  try {
    const committedCache = path.join(source, '.yarn/cache');
    for (const name of await fs.readdir(committedCache).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const file = path.join(committedCache, name);
      assert.ok((await fs.lstat(file)).isFile(), 'Unexpected dependency cache entry');
      await fs.copyFile(file, path.join(cache, name));
    }
    execFileSync(process.execPath, [path.join(source, '.yarn/releases/yarn-4.17.1.cjs'), 'install', '--immutable'], {
      cwd: source,
      env: {
        ...env,
        YARN_NODE_LINKER: 'node-modules',
        YARN_ENABLE_GLOBAL_CACHE: 'false',
        YARN_CACHE_FOLDER: cache,
        YARN_GLOBAL_FOLDER: path.join(cache, 'global'),
      },
      stdio: 'pipe',
      timeout: 600000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await fs.rm(cache, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const { file, bytes, mode } of loaders) {
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      const handle = await fs.open(file, 'wx', mode);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(mode); // Preserve executable bits even under a restrictive umask.
      } finally {
        await handle.close();
      }
    } else {
      assert.ok(stat.isFile(), 'Actor install replaced a loader with an unexpected file type');
      assert.deepEqual(await fs.readFile(file), bytes, 'Actor install unexpectedly rewrote a tracked loader');
      assert.equal(stat.mode & 0o777, mode, 'Actor install unexpectedly changed tracked loader permissions');
    }
  }
  await verifyActorSource(source, sourceSha);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await installActorDependencies(process.cwd(), process.argv[2]);
