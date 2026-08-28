import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rootDependencyFiles = new Set(['.pnp.cjs', '.pnp.loader.mjs', '.yarnrc.yml', 'package.json', 'yarn.lock']);

const studioRuntimePrefixes = [
  '.github/actions/setup-yarn/',
  '.github/workflows/studio-server-',
  'deploy/studio-server/',
  'packages/app/',
  'packages/app-executor/',
  'packages/core/',
  'packages/evaluations/',
  'packages/node/',
  'packages/studio-server-',
  'scripts/build-wrapper-target.mjs',
  'scripts/ci/',
  'scripts/checks/check-pnp-install-state.mjs',
];

const desktopPrefixes = [
  '.github/actions/',
  '.github/scripts/',
  '.github/workflows/developer-windows-release.yml',
  '.github/workflows/official-windows-release.yml',
  'packages/app/',
  'packages/app-executor/',
  'packages/core/',
  'packages/docs/',
  'packages/evaluations/',
  'packages/node/',
  'scripts/build-wrapper-target.mjs',
  'scripts/checks/check-graph-builder',
  'scripts/sync-desktop-version.mjs',
];

const npmPrefixes = [
  '.github/actions/setup-yarn/',
  '.github/workflows/publish-npm-packages.yml',
  'packages/cli/',
  'packages/core/',
  'packages/evaluations/',
  'packages/node/',
  'scripts/build-wrapper-target.mjs',
  'scripts/create-built-package-artifacts.mjs',
  'scripts/publish-npm-packages.mjs',
];

const fullKubernetesPrefixes = [
  '.github/workflows/studio-server-images.yml',
  'deploy/studio-server/compose/',
  'deploy/studio-server/helm/',
  'deploy/studio-server/images/',
  'deploy/studio-server/scripts/candidate-image-smoke',
  'deploy/studio-server/scripts/dev-kubernetes',
  'deploy/studio-server/scripts/ensure-k8s-tools',
  'deploy/studio-server/scripts/kind-',
  'deploy/studio-server/scripts/kubernetes-',
  'deploy/studio-server/scripts/lib/kubernetes-',
  'deploy/studio-server/scripts/prod-docker',
  'deploy/studio-server/scripts/verify-kubernetes',
  'packages/studio-server-api/src/tests/kubernetes-',
];

function matches(pathName, prefixes) {
  return rootDependencyFiles.has(pathName) || prefixes.some((prefix) => pathName.startsWith(prefix));
}

export function classifyChangedPaths(changedPaths) {
  const normalized = [...new Set(changedPaths.map((value) => value.replaceAll('\\', '/').replace(/^\.\//, '')))].sort();
  return {
    studioServer: normalized.some((pathName) => matches(pathName, studioRuntimePrefixes)),
    studioImages: normalized.some((pathName) => matches(pathName, studioRuntimePrefixes)),
    desktop: normalized.some((pathName) => matches(pathName, desktopPrefixes)),
    npm: normalized.some((pathName) => matches(pathName, npmPrefixes)),
    fullKubernetes: normalized.some((pathName) => matches(pathName, fullKubernetesPrefixes)),
  };
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  return eventPath && fs.existsSync(eventPath) ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
}

function resolveDiffRange(eventName, event) {
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    return event.pull_request?.base?.sha && event.pull_request?.head?.sha
      ? [event.pull_request.base.sha, event.pull_request.head.sha]
      : null;
  }
  if (eventName === 'push') {
    const before = event.before;
    const after = event.after ?? process.env.GITHUB_SHA;
    if (!before || /^0+$/.test(before) || !after) {
      return null;
    }
    return [before, after];
  }
  return null;
}

export function listChangedPaths(base, head) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, head], {
    cwd: rootDir,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function appendOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || process.env.RIVET_CI_FORCE === 'true';
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const event = readEvent();
  const range = resolveDiffRange(eventName, event);
  const runEverything = force || eventName === 'workflow_dispatch' || eventName === 'schedule' || !range;
  const changedPaths = runEverything ? [] : listChangedPaths(range[0], range[1]);
  const classification = runEverything
    ? { studioServer: true, studioImages: true, desktop: true, npm: true, fullKubernetes: true }
    : classifyChangedPaths(changedPaths);

  for (const [name, value] of Object.entries(classification)) {
    appendOutput(
      name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      String(value),
    );
  }
  appendOutput('changed_count', String(changedPaths.length));
  console.log(
    `[ci-change-policy] ${runEverything ? 'Full verification requested.' : `Classified ${changedPaths.length} changed paths.`}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
