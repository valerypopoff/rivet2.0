import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(docsDirectory, '../..');
const yarnCli = resolve(repositoryDirectory, '.yarn/releases/yarn-4.17.1.cjs');

export function spawnWorkspaceScript(workspace, script, options = {}) {
  return spawn(process.execPath, [yarnCli, 'workspace', workspace, 'run', script], {
    cwd: repositoryDirectory,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    windowsHide: true,
  });
}

export function spawnRepositoryScript(script, options = {}) {
  return spawn(process.execPath, [yarnCli, script], {
    cwd: repositoryDirectory,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    windowsHide: true,
  });
}

export function terminateWorkspaceProcess(child) {
  if (child.exitCode != null || child.signalCode != null || child.pid == null) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  child.kill('SIGTERM');
}

export function waitForChild(child, label) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
    });
  });
}
