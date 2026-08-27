import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loaderPaths = ['.pnp.cjs', '.pnp.loader.mjs'];
const requireFreshLoaders = process.argv.includes('--fresh');

function runGit(...args) {
  return execFileSync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasWorkingTreeFile(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);

  try {
    const stats = statSync(absolutePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function hasGitPath(command, relativePath) {
  return command.some((line) => line.trim() === relativePath);
}

const headPaths = runGit('ls-tree', '-r', '--name-only', 'HEAD', '--', ...loaderPaths)
  .split(/\r?\n/)
  .filter(Boolean);
const indexPaths = runGit('ls-files', '--stage', '--', ...loaderPaths)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.slice(line.indexOf('\t') + 1));

const problems = [];

for (const loaderPath of loaderPaths) {
  if (!hasWorkingTreeFile(loaderPath)) {
    problems.push(`${loaderPath} is missing or empty in the working tree`);
  }

  if (!hasGitPath(indexPaths, loaderPath)) {
    problems.push(`${loaderPath} is missing from the Git index`);
  }

  if (!hasGitPath(headPaths, loaderPath)) {
    problems.push(`${loaderPath} is missing from HEAD`);
  }
}

if (requireFreshLoaders) {
  const changedLoaderPaths = runGit('diff', '--no-ext-diff', '--name-only', '--', ...loaderPaths)
    .split(/\r?\n/)
    .filter(Boolean);

  for (const loaderPath of changedLoaderPaths) {
    problems.push(`${loaderPath} changed after dependency installation`);
  }
}

if (problems.length > 0) {
  console.error(
    requireFreshLoaders ? 'Yarn PnP install state is incomplete or stale.' : 'Yarn PnP install state is incomplete.',
  );
  for (const problem of problems) console.error(`- ${problem}`);
  console.error('');
  console.error('The root PnP loaders are tracked zero-install files and must remain present and current.');
  if (requireFreshLoaders) {
    console.error('They must also match the dependency manifests and lockfile after a fresh immutable install.');
  }
  console.error('Restore them with:');
  console.error('  node .yarn/releases/yarn-4.17.1.cjs install --immutable');
  console.error('  git add .pnp.cjs .pnp.loader.mjs');
  process.exitCode = 1;
} else {
  console.log(
    requireFreshLoaders ? 'Yarn PnP install state is complete and fresh.' : 'Yarn PnP install state is complete.',
  );
}
