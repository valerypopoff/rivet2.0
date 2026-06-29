import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportTiming, startTimer } from '../../../scripts/ci-timing.mjs';
import { getChildProcessEnvWithoutMissingPnpPreload } from './pnp-env.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const repoRoot = resolve(appDir, '..', '..');
const yarnPath = resolve(repoRoot, '.yarn', 'releases', 'yarn-4.6.0.cjs');
const syncDesktopVersionScript = resolve(repoRoot, 'scripts', 'sync-desktop-version.mjs');
const childProcessEnv = getChildProcessEnvWithoutMissingPnpPreload(repoRoot);

const syncStartedAt = startTimer();
const syncResult = spawnSync(process.execPath, [syncDesktopVersionScript], {
  cwd: repoRoot,
  env: childProcessEnv,
  stdio: 'inherit',
});
await reportTiming('prepare-tauri: sync desktop version metadata', syncStartedAt);

if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

const executorStartedAt = startTimer();
const result = spawnSync(
  process.execPath,
  ['--max-old-space-size=8192', yarnPath, 'workspace', '@valerypopoff/rivet-app-executor', 'run', 'build'],
  {
    cwd: repoRoot,
    env: childProcessEnv,
    stdio: 'inherit',
  },
);
await reportTiming('prepare-tauri: app-executor sidecar build', executorStartedAt);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
