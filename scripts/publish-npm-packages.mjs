#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const publishPackages = [
  {
    name: '@valerypopoff/rivet2-core',
    workspaceDir: 'packages/core',
    copyEntries: ['dist/cjs', 'dist/esm', 'dist/types'],
    requiredFiles: ['dist/cjs/bundle.cjs', 'dist/esm/index.js', 'dist/types/index.d.ts'],
  },
  {
    name: '@valerypopoff/rivet2-node',
    workspaceDir: 'packages/node',
    copyEntries: ['dist/cjs', 'dist/esm', 'dist/types'],
    requiredFiles: ['dist/cjs/bundle.cjs', 'dist/esm/index.js', 'dist/types/index.d.ts'],
  },
  {
    name: '@valerypopoff/rivet2-evaluations',
    workspaceDir: 'packages/evaluations',
    copyEntries: ['dist/cjs', 'dist/esm', 'dist/types'],
    requiredFiles: ['dist/cjs/bundle.cjs', 'dist/esm/index.js', 'dist/types/index.d.ts'],
  },
  {
    name: '@valerypopoff/rivet2-cli',
    workspaceDir: 'packages/cli',
    copyEntries: ['bin', 'dist'],
    requiredFiles: ['bin/cli.js', 'dist/types/cli.d.ts'],
  },
];

const publishPackageNames = new Set(publishPackages.map((pkg) => pkg.name));
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const stageOnly = args.has('--stage-only');
const keepStage = args.has('--keep-stage');
const skipCleanCheck = args.has('--skip-clean-check');
const skipRegistryCheck = dryRun || args.has('--skip-registry-check');
const npmDistTag = process.env.NPM_DIST_TAG;
const npmCommand = 'npm';
const npmRunOptions = process.platform === 'win32' ? { shell: true } : {};

main();

function main() {
  loadDotEnv();

  if (!skipCleanCheck) {
    ensureCleanWorkingTree();
  }

  const packageJsons = publishPackages.map((pkg) => ({
    ...pkg,
    packageJson: readJson(path.join(repoRoot, pkg.workspaceDir, 'package.json')),
  }));

  const version = validatePackageVersions(packageJsons);
  const distTag = npmDistTag ?? (version.includes('-') ? 'next' : 'latest');
  const stagingRoot = mkdtempSync(path.join(tmpdir(), 'rivet-npm-publish-'));
  const npmAuthConfigPath = writeNpmAuthConfig(stagingRoot);

  try {
    for (const pkg of packageJsons) {
      validatePackage(pkg, version);
      const stagingDir = stagePackage(pkg, version, stagingRoot);

      if (stageOnly) {
        console.log(`Validated staged package for ${pkg.name}@${version}${keepStage ? ` in ${stagingDir}` : ''}.`);
        continue;
      }

      if (!skipRegistryCheck && packageVersionExists(pkg.name, version, npmAuthConfigPath)) {
        console.log(`${pkg.name}@${version} is already published; skipping.`);
        continue;
      }

      publishPackage(pkg.name, stagingDir, distTag, npmAuthConfigPath);
    }
  } finally {
    if (npmAuthConfigPath) {
      rmSync(npmAuthConfigPath, { force: true });
    }

    if (!keepStage) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

function loadDotEnv() {
  const dotEnvPath = path.join(repoRoot, '.env');
  if (!existsSync(dotEnvPath)) {
    return;
  }

  const lines = readFileSync(dotEnvPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const envLine = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separatorIndex = envLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = envLine.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(envLine.slice(separatorIndex + 1).trim());
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  if (!process.env.NODE_AUTH_TOKEN && process.env.NPM_TOKEN) {
    process.env.NODE_AUTH_TOKEN = process.env.NPM_TOKEN;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function writeNpmAuthConfig(stagingRoot) {
  const token = process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN;
  if (!token) {
    return undefined;
  }

  const npmAuthConfigPath = path.join(stagingRoot, '.npmrc');
  writeFileSync(
    npmAuthConfigPath,
    `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${token}\n`,
  );
  return npmAuthConfigPath;
}

function ensureCleanWorkingTree() {
  const result = run('git', ['status', '--porcelain'], { stdio: 'pipe' });
  if (result.stdout.trim()) {
    fail('Git working tree is not clean. Commit or stash changes before publishing, or pass --skip-clean-check.');
  }
}

function validatePackageVersions(packageJsons) {
  const versions = new Set(packageJsons.map((pkg) => pkg.packageJson.version));
  if (versions.size !== 1) {
    fail(`Published packages must use one lockstep version. Found: ${[...versions].join(', ')}`);
  }

  const [version] = versions;
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    fail(`Version ${version} is not valid semver.`);
  }

  if (match[1] !== '2') {
    fail(`Version ${version} is not allowed. Rivet 2 npm releases must stay on major version 2.`);
  }

  return version;
}

function validatePackage(pkg) {
  if (pkg.packageJson.name !== pkg.name) {
    fail(`${pkg.workspaceDir}/package.json is named ${pkg.packageJson.name}, expected ${pkg.name}.`);
  }

  for (const requiredFile of pkg.requiredFiles) {
    const fullPath = path.join(repoRoot, pkg.workspaceDir, requiredFile);
    if (!existsSync(fullPath)) {
      fail(`${pkg.name} is missing built output ${requiredFile}. Run the package build first.`);
    }
  }
}

function stagePackage(pkg, version, stagingRoot) {
  const packageRoot = path.join(repoRoot, pkg.workspaceDir);
  const stagingDir = path.join(stagingRoot, npmPathSegment(pkg.name));

  for (const entry of pkg.copyEntries) {
    const from = path.join(packageRoot, entry);
    const to = path.join(stagingDir, entry);

    if (!existsSync(from)) {
      fail(`${pkg.name} cannot be staged because ${entry} does not exist.`);
    }

    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }

  const packageReadme = path.join(packageRoot, 'README.md');
  const repoReadme = path.join(repoRoot, 'README.md');
  if (existsSync(packageReadme)) {
    mkdirSync(stagingDir, { recursive: true });
    cpSync(packageReadme, path.join(stagingDir, 'README.md'));
  } else if (existsSync(repoReadme)) {
    mkdirSync(stagingDir, { recursive: true });
    cpSync(repoReadme, path.join(stagingDir, 'README.md'));
  }

  const licensePath = path.join(repoRoot, 'LICENSE');
  if (existsSync(licensePath)) {
    mkdirSync(stagingDir, { recursive: true });
    cpSync(licensePath, path.join(stagingDir, 'LICENSE'));
  }

  writeJson(path.join(stagingDir, 'package.json'), toPublishPackageJson(pkg.packageJson, version));
  return stagingDir;
}

function toPublishPackageJson(packageJson, version) {
  const published = pick(packageJson, [
    'name',
    'version',
    'description',
    'keywords',
    'license',
    'main',
    'module',
    'types',
    'type',
    'exports',
    'bin',
    'files',
    'engines',
  ]);

  published.version = version;
  published.repository = {
    type: 'git',
    url: 'git+https://github.com/valerypopoff/rivet2.0.git',
  };
  published.publishConfig = {
    access: 'public',
  };

  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (packageJson[key]) {
      published[key] = rewriteWorkspaceDependencies(packageJson[key], version);
    }
  }

  return published;
}

function rewriteWorkspaceDependencies(dependencies, version) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        if (!publishPackageNames.has(name)) {
          fail(`Cannot publish workspace dependency ${name}; it is not in the npm publish package set.`);
        }

        return [name, `^${version}`];
      }

      return [name, range];
    }),
  );
}

function packageVersionExists(name, version, npmAuthConfigPath) {
  const result = run(npmCommand, ['view', `${name}@${version}`, 'version', '--json', '--registry', 'https://registry.npmjs.org/'], {
    stdio: 'pipe',
    allowFailure: true,
    env: npmAuthConfigPath ? { NPM_CONFIG_USERCONFIG: npmAuthConfigPath } : undefined,
    ...npmRunOptions,
  });

  if (result.status === 0) {
    return true;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes('E404') || output.includes('404 Not Found') || output.includes('No match found')) {
    return false;
  }

  fail(`Could not check npm state for ${name}@${version}.\n${output.trim()}`);
}

function publishPackage(name, stagingDir, distTag, npmAuthConfigPath) {
  const publishArgs = ['publish', stagingDir, '--access', 'public', '--tag', distTag, '--registry', 'https://registry.npmjs.org/'];
  if (dryRun) {
    publishArgs.push('--dry-run');
  }

  console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${name} with npm dist-tag "${distTag}"...`);
  run(npmCommand, publishArgs, {
    stdio: 'inherit',
    env: npmAuthConfigPath ? { NPM_CONFIG_USERCONFIG: npmAuthConfigPath } : undefined,
    ...npmRunOptions,
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.stdio ?? 'inherit',
    shell: options.shell ?? false,
  });

  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }

  if (!options.allowFailure && result.status !== 0) {
    fail(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}.`);
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function npmPathSegment(packageName) {
  return packageName.replace('@', '').replace('/', '-');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
