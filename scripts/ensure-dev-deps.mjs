import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  clearEmbeddedRivetPnpLoaders,
  clearPnpLoaders,
  ensureEmbeddedRivetNodeModulesConfig,
  ensureWorkspaceNodeModulesConfig,
  getRivetYarnEnvironment,
  getRivetYarnInvocation,
  hasRivetPnpInstall,
  isExternalRivetWorkspace,
  stripPnpNodeOptions,
} from './lib/rivet-local-dependencies.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const rivetDir = path.join(rootDir, 'rivet');
const rivetRepoUrl = process.env.RIVET_REPO_URL || 'https://github.com/valerypopoff/rivet2.0.git';
const rivetRepoRef = process.env.RIVET_REPO_REF || process.env.RIVET_BRANCH || 'main';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gitCmd = process.platform === 'win32' ? 'git.exe' : 'git';

function quoteArg(arg) {
  if (/\s|"/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function run(command, args, cwd = rootDir, extraEnv = {}) {
  const commandLine = [command, ...args.map(quoteArg)].join(' ');
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);

  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: stripPnpNodeOptions(process.env.NODE_OPTIONS),
      ...extraEnv,
    },
    stdio: 'inherit',
    shell: useShell,
  });

  if (result.error) {
    console.error(`[predev] Failed to run command: ${commandLine}`);
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function exists(relPath) {
  return fs.existsSync(path.join(rootDir, relPath));
}

function isLinkedTo(relPath, targetRelPath) {
  const fullPath = path.join(rootDir, relPath);
  const targetPath = path.join(rootDir, targetRelPath);

  if (!fs.existsSync(fullPath) || !fs.existsSync(targetPath)) {
    return false;
  }

  try {
    return fs.realpathSync(fullPath) === fs.realpathSync(targetPath);
  } catch {
    return false;
  }
}

function hasExpectedApiRivetLink(packageName, sourcePackageRelPath, packageAliases) {
  const overlayRelPath = `wrapper/api/node_modules/.rivet-package-links/${packageName}`;
  const sourceDistRelPath = path.join(sourcePackageRelPath, 'dist');

  return (
    packageAliases.every((packageAlias) => isLinkedTo(`wrapper/api/node_modules/${packageAlias}`, overlayRelPath)) &&
    isLinkedTo(path.join(overlayRelPath, 'dist'), sourceDistRelPath) &&
    exists(path.join(overlayRelPath, 'node_modules', '.rivet-dependency-overlay'))
  );
}

function hasRetiredApiRivetLinks() {
  const retiredScope = ['@', 'iron', 'clad'].join('');

  return [
    `wrapper/api/node_modules/${retiredScope}/rivet-core`,
    `wrapper/api/node_modules/${retiredScope}/rivet-node`,
  ].some(exists);
}

function hasExpectedRivetWorkspace() {
  const requiredEntries = [
    'rivet/package.json',
    'rivet/.yarnrc.yml',
    'rivet/packages/core/package.json',
    'rivet/packages/node/package.json',
    'rivet/packages/evaluations/package.json',
  ];

  return requiredEntries.every((relPath) => exists(relPath));
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relPath), 'utf8'));
}

function packageNameToNodeModulesRelPath(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(scope, name);
  }

  return packageName;
}

function collectRivetDependencyNames() {
  const packageJsonRelPaths = [
    'rivet/packages/core/package.json',
    'rivet/packages/node/package.json',
    'rivet/packages/evaluations/package.json',
  ];
  const dependencyNames = new Set([
    'esbuild',
    'tsx',
    'typescript',
  ]);

  for (const relPath of packageJsonRelPaths) {
    const packageJson = readJson(relPath);

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }

    for (const dependencyName of Object.keys(packageJson.devDependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  return [...dependencyNames];
}

function hasExpectedRivetDependencyInstall() {
  if (isExternalRivetWorkspace(rootDir, rivetDir) && hasRivetPnpInstall(rivetDir)) {
    return true;
  }

  // Vite resolves imports in vendored Rivet source from rivet/node_modules.
  // Wrapper package installs cannot satisfy those source imports reliably.
  return collectRivetDependencyNames().every((dependencyName) =>
    exists(path.join('rivet/node_modules', packageNameToNodeModulesRelPath(dependencyName))),
  );
}

function ensureRivetRepo() {
  if (fs.existsSync(path.join(rivetDir, '.git'))) {
    return;
  }

  if (fs.existsSync(rivetDir)) {
    const contents = fs.readdirSync(rivetDir);

    if (contents.length > 0) {
      if (hasExpectedRivetWorkspace()) {
        console.log('[predev] Using existing rivet/ snapshot.');
        return;
      }

      console.error('[predev] Expected rivet/ to be absent, a Git checkout, or a valid upstream snapshot.');
      console.error('[predev] The existing rivet/ directory is populated but does not match the expected upstream workspace layout.');
      console.error('[predev] Remove or rename it, then run the command again.');
      process.exit(1);
    }
  }

  console.log(`[predev] Cloning rivet from ${rivetRepoUrl} (${rivetRepoRef})`);
  run(gitCmd, ['clone', '--branch', rivetRepoRef, rivetRepoUrl, 'rivet']);
}

if (ensureWorkspaceNodeModulesConfig(rootDir)) {
  console.log('[predev] Configured the wrapper workspace for node-modules dependencies.');
}

if (clearPnpLoaders(rootDir)) {
  console.log('[predev] Cleared stale PnP loader files from the wrapper workspace.');
}

ensureRivetRepo();

if (ensureEmbeddedRivetNodeModulesConfig(rootDir, rivetDir)) {
  console.log('[predev] Configured the embedded Rivet snapshot for node-modules dependencies.');
}

if (clearEmbeddedRivetPnpLoaders(rootDir, rivetDir)) {
  console.log('[predev] Cleared stale PnP loader files from the embedded Rivet snapshot.');
}

const rivetYarnEnvironment = getRivetYarnEnvironment(rootDir, rivetDir);
const rivetYarnInvocation = getRivetYarnInvocation(rivetDir);

const needsApiDeps = !exists('wrapper/api/node_modules/.bin/tsx');
const needsWebDeps =
  !exists('wrapper/web/node_modules/.bin/vite') ||
  !exists('wrapper/web/node_modules/.bin/playwright');
const needsRivetDeps = !hasExpectedRivetDependencyInstall();
const needsRivetCoreBuild = !exists('rivet/packages/core/dist/esm/index.js');
const needsRivetNodeBuild = !exists('rivet/packages/node/dist/esm/index.js');
const needsRivetEvaluationsBuild = !exists('rivet/packages/evaluations/dist/esm/index.js');
const needsApiRivetLinks =
  !hasExpectedApiRivetLink('rivet-core', 'rivet/packages/core', [
    '@rivet2/rivet-core',
    '@valerypopoff/rivet2-core',
  ]) ||
  !hasExpectedApiRivetLink('rivet-node', 'rivet/packages/node', [
    '@rivet2/rivet-node',
    '@valerypopoff/rivet2-node',
  ]) ||
  !hasExpectedApiRivetLink('rivet-evaluations', 'rivet/packages/evaluations', [
    '@valerypopoff/rivet2-evaluations',
  ]) ||
  hasRetiredApiRivetLinks();

if (
  !needsApiDeps &&
  !needsWebDeps &&
  !needsRivetDeps &&
  !needsRivetCoreBuild &&
  !needsRivetNodeBuild &&
  !needsRivetEvaluationsBuild &&
  !needsApiRivetLinks
) {
  process.exit(0);
}

console.log('[predev] Installing missing dependencies...');

if (needsApiDeps) {
  console.log('[predev] Installing wrapper/api dependencies');
  run(npmCmd, ['--prefix', 'wrapper/api', 'ci']);
}

if (needsWebDeps) {
  console.log('[predev] Installing wrapper/web dependencies');
  run(npmCmd, ['--prefix', 'wrapper/web', 'ci', '--legacy-peer-deps']);
}

if (needsRivetDeps) {
  console.log("[predev] Installing rivet dependencies with Rivet's configured Yarn release");
  run(rivetYarnInvocation.command, [...rivetYarnInvocation.args, 'install', '--immutable'], rivetDir, {
    ...rivetYarnEnvironment,
    YARN_CHECKSUM_BEHAVIOR: 'ignore',
  });

  if (clearEmbeddedRivetPnpLoaders(rootDir, rivetDir)) {
    console.log('[predev] Cleared PnP loader files left behind after the embedded Rivet install.');
  }

  if (!hasExpectedRivetDependencyInstall()) {
    throw new Error(
      '[predev] The embedded Rivet install did not produce its required node_modules layout. Refusing to build against a PnP loader.',
    );
  }
}

if (needsRivetCoreBuild) {
  console.log('[predev] Building @valerypopoff/rivet2-core');
  run(rivetYarnInvocation.command, [...rivetYarnInvocation.args, 'workspace', '@valerypopoff/rivet2-core', 'run', 'build'], rivetDir, rivetYarnEnvironment);
}

if (needsRivetNodeBuild) {
  console.log('[predev] Building @valerypopoff/rivet2-node');
  run(rivetYarnInvocation.command, [...rivetYarnInvocation.args, 'workspace', '@valerypopoff/rivet2-node', 'run', 'build'], rivetDir, rivetYarnEnvironment);
}

if (needsRivetEvaluationsBuild) {
  console.log('[predev] Building @valerypopoff/rivet2-evaluations');
  run(rivetYarnInvocation.command, [...rivetYarnInvocation.args, 'workspace', '@valerypopoff/rivet2-evaluations', 'run', 'build'], rivetDir, rivetYarnEnvironment);
}

if (needsApiRivetLinks || needsApiDeps || needsRivetCoreBuild || needsRivetNodeBuild || needsRivetEvaluationsBuild) {
  console.log('[predev] Linking wrapper/api to local Rivet packages');
  run(process.execPath, ['scripts/link-rivet-node-package.mjs']);
}

console.log('[predev] Dependencies are ready.');
