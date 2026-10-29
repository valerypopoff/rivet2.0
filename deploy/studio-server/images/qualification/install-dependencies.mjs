import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Only for the actor's private clean build checkout. Yarn's node-modules
 * linker removes tracked PnP loaders; retain their exact committed bytes so
 * the runtime can still verify the complete source, without a dirty-file waiver. */
export async function installActorDependencies(source, sourceSha, { env = process.env } = {}) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceSha);
  assert.equal(git('status', '--porcelain'), '', 'Actor dependency install requires an exact clean source');
  const loaders = [];
  for (const name of ['.pnp.cjs', '.pnp.loader.mjs']) {
    git('ls-files', '--error-unmatch', '--', name);
    const file = path.join(source, name);
    assert.ok((await fs.lstat(file)).isFile());
    loaders.push({ file, bytes: await fs.readFile(file) });
  }
  execFileSync(process.execPath, [path.join(source, '.yarn/releases/yarn-4.17.1.cjs'), 'install', '--immutable'], {
    cwd: source,
    env: { ...env, YARN_NODE_LINKER: 'node-modules' },
    stdio: 'pipe',
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const { file, bytes } of loaders) {
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o644 });
    else {
      assert.ok(stat.isFile(), 'Actor install replaced a loader with an unexpected file type');
      assert.deepEqual(await fs.readFile(file), bytes, 'Actor install unexpectedly rewrote a tracked loader');
    }
  }
  assert.equal(git('rev-parse', 'HEAD'), sourceSha, 'Actor dependency installation changed source identity');
  assert.equal(git('status', '--porcelain'), '', 'Actor dependency installation changed tracked source');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await installActorDependencies(process.cwd(), process.argv[2]);
