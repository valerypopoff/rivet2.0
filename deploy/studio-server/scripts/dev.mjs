import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';
import { performance } from 'node:perf_hooks';
import { withLauncherProgress } from './lib/launcher-progress.mjs';

const rootDir = process.cwd();
const { mergedEnv } = loadDevEnv(rootDir);

console.log('[dev] Starting local development services...');
console.log('[dev] Open http://localhost:5174 once Vite is ready.');
console.log('[dev] This command stays running and watches for code changes. Press Ctrl+C to stop.');

const processes = [];
const started = performance.now();

function start(name, command) {
  const child = spawn(command, {
    cwd: rootDir,
    env: mergedEnv,
    shell: true,
    stdio: 'pipe',
  });

  const prefix = () => `[${name} +${Math.floor((performance.now() - started) / 1000)}s]`;

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`${prefix()} ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`${prefix()} ${chunk}`);
  });

  child.on('exit', (code) => {
    process.stderr.write(`${prefix()} exited with code ${code ?? 1}\n`);
    shutdown(code ?? 1);
  });

  processes.push(child);
  void withLauncherProgress(
    'dev',
    `Launching ${name} watcher`,
    () =>
      new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      }),
  ).catch((error) => {
    console.error(`[dev] ${name} watcher failed: ${error.message}`);
    shutdown(1);
  });
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const proc of processes) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('API', 'yarn workspace @valerypopoff/rivet-studio-server-api run dev');
start('WEB', 'yarn workspace @valerypopoff/rivet-studio-server-web run dev');
start('EXECUTOR', 'yarn workspace @valerypopoff/rivet-studio-server-executor run dev');
