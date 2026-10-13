import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';
import { withLauncherProgress } from './lib/launcher-progress.mjs';

const rootDir = process.cwd();

const command = process.argv.slice(2).join(' ').trim();
if (!command) {
  console.error('Usage: node deploy/studio-server/scripts/run-with-env.mjs "<command>"');
  process.exit(1);
}

const { mergedEnv } = loadDevEnv(rootDir);

const child = spawn(command, {
  cwd: rootDir,
  env: mergedEnv,
  shell: true,
  stdio: 'inherit',
});

void withLauncherProgress(
  'dev',
  'Launching the development watcher',
  () =>
    new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }),
).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
