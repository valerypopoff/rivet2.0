import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';

const rootDir = process.cwd();

const command = process.argv.slice(2).join(' ').trim();
if (!command) {
  console.error('Usage: node scripts/run-with-env.mjs "<command>"');
  process.exit(1);
}

const { mergedEnv } = loadDevEnv(rootDir);

const child = spawn(command, {
  cwd: rootDir,
  env: mergedEnv,
  shell: true,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
