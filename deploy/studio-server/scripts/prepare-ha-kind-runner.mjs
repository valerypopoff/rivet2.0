import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertHaWorkspaceSpace } from './lib/ha-workspace.mjs';

export const UNUSED_HA_RUNNER_SDKS = Object.freeze(['/usr/local/lib/android', '/usr/share/dotnet', '/opt/ghc']);

/** Only the disposable hosted Kind runner may remove these unused SDKs.
 * Keep Docker images, its data root, tool caches, the checkout and local hosts. */
export async function prepareHaKindRunner({
  env = process.env,
  platform = process.platform,
  workspace = fileURLToPath(new URL('../../../', import.meta.url)),
  statfs = fs.statfs,
  remove = (paths) => execFileSync('sudo', ['-n', 'rm', '-rf', '--', ...paths], { stdio: 'inherit', timeout: 120_000 }),
  log = console.log,
} = {}) {
  assert.ok(
    platform === 'linux' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_OS === 'Linux' &&
      env.RIVET_HA_RUNNER_ENVIRONMENT === 'github-hosted',
    'SDK cleanup is restricted to a GitHub-hosted Linux runner.',
  );
  const before = await statfs(workspace);
  log(`[ha-runner] Workspace free before SDK cleanup: ${((before.bavail * before.bsize) / 1024 ** 3).toFixed(1)} GiB`);
  await remove(UNUSED_HA_RUNNER_SDKS);
  const available = await assertHaWorkspaceSpace(workspace, { statfs });
  log(`[ha-runner] Workspace free after SDK cleanup: ${(available / 1024 ** 3).toFixed(1)} GiB`);
  return available;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareHaKindRunner();
