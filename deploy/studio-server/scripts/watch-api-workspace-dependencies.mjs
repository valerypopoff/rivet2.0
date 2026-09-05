import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), '../../..');
const apiWorkspaceName = '@valerypopoff/rivet-studio-server-api';
const workspaceDependencyEntrypoints = [
  'packages/core/dist/esm/index.js',
  'packages/node/dist/esm/index.js',
  'packages/evaluations/dist/esm/index.js',
];
const dependencyPollIntervalMs = 100;

export function missingWorkspaceDependencyEntrypoints(workspaceRoot, fileExists = existsSync) {
  return workspaceDependencyEntrypoints
    .map((entrypoint) => join(workspaceRoot, entrypoint))
    .filter((entrypoint) => !fileExists(entrypoint));
}

function findYarnRelease(workspaceRoot) {
  const releasesDir = join(workspaceRoot, '.yarn', 'releases');
  const releases = readdirSync(releasesDir).filter((file) => /^yarn-.*\.cjs$/.test(file));

  if (releases.length !== 1) {
    throw new Error(`Expected exactly one checked-in Yarn release in ${releasesDir}, found ${releases.length}.`);
  }

  return join(releasesDir, releases[0]);
}

function waitForWorkspaceDependencyEntrypoints(shouldStop) {
  return new Promise((resolveReady) => {
    let waiting = false;

    const check = () => {
      if (shouldStop()) {
        clearInterval(interval);
        resolveReady(false);
        return;
      }

      const missing = missingWorkspaceDependencyEntrypoints(rootDir);
      if (missing.length === 0) {
        clearInterval(interval);
        resolveReady(true);
        return;
      }

      if (!waiting) {
        waiting = true;
        console.warn(
          `[studio-server-api:dev] Waiting for workspace dependency outputs: ${missing
            .map((entrypoint) => relative(rootDir, entrypoint))
            .join(', ')}.`,
        );
      }
    };

    const interval = setInterval(check, dependencyPollIntervalMs);
    check();
  });
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function main() {
  const yarnRelease = findYarnRelease(rootDir);
  let activeChild;
  let stopping = false;

  const stop = (signal) => {
    stopping = true;
    activeChild?.kill(signal);
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    const dependenciesReady = await waitForWorkspaceDependencyEntrypoints(() => stopping);
    if (!dependenciesReady) break;

    let dependencyGapObserved = false;
    let restartRequested = false;
    const dependencyWatcher = setInterval(() => {
      const missing = missingWorkspaceDependencyEntrypoints(rootDir);
      if (missing.length > 0) {
        dependencyGapObserved = true;
        return;
      }

      if (dependencyGapObserved && !restartRequested && activeChild) {
        restartRequested = true;
        console.warn('[studio-server-api:dev] Workspace dependency outputs are ready; restarting the API watcher.');
        activeChild.kill('SIGTERM');
      }
    }, dependencyPollIntervalMs);

    activeChild = spawn(process.execPath, [yarnRelease, 'workspace', apiWorkspaceName, 'run', 'dev:tsx'], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });

    const { code, signal } = await waitForExit(activeChild);
    activeChild = undefined;
    clearInterval(dependencyWatcher);

    if (stopping) break;

    if (dependencyGapObserved) {
      if (!restartRequested) {
        console.warn(
          '[studio-server-api:dev] API watcher stopped while workspace outputs were rebuilding; restarting it now.',
        );
      }
      continue;
    }

    process.exitCode = signal ? 1 : code ?? 1;
    return;
  }
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === scriptPath;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
