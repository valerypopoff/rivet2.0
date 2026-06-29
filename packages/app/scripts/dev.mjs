import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChildProcessEnvWithoutMissingPnpPreload } from './pnp-env.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const repoRoot = resolve(appDir, '..', '..');
const yarnPath = resolve(repoRoot, '.yarn', 'releases', 'yarn-4.6.0.cjs');
const childProcessEnv = getChildProcessEnvWithoutMissingPnpPreload(repoRoot);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: appDir,
    env: childProcessEnv,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function killWindowsProcessByExecutablePath(executablePath) {
  const escapedPath = executablePath.replace(/'/g, "''");
  const script = [
    `$target = '${escapedPath}'`,
    '$processes = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target }',
    'foreach ($process in $processes) {',
    '  Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop',
    '}',
  ].join('; ');

  run('powershell.exe', ['-NoProfile', '-Command', script]);
}

function cleanupStaleSidecars() {
  if (process.platform !== 'win32') {
    return;
  }

  const targetExecutables = [
    resolve(appDir, 'src-tauri', 'target', 'debug', 'app-executor.exe'),
    resolve(appDir, 'src-tauri', 'target', 'release', 'app-executor.exe'),
  ];

  for (const executablePath of targetExecutables) {
    killWindowsProcessByExecutablePath(executablePath);
  }
}

cleanupStaleSidecars();

if (process.argv.includes('--cleanup-only')) {
  process.exit(0);
}

run(process.execPath, [yarnPath, 'tauri', 'dev'], { cwd: appDir });
