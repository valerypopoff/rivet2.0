import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceDirectories = ['packages/core', 'packages/node', 'packages/evaluations'];
const executorBundlePath = path.join(rootDir, 'packages', 'app-executor', 'bin', 'executor-bundle.cjs');
const require = createRequire(import.meta.url);

function collectExportTargets(value, targets) {
  if (typeof value === 'string') {
    targets.add(value);
    return;
  }

  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      collectExportTargets(child, targets);
    }
  }
}

async function assertCompiledFile(packageName, workspaceDirectory, target) {
  const fullPath = path.resolve(workspaceDirectory, target);
  const relativePath = path.relative(workspaceDirectory, fullPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${packageName} declares an export outside its workspace: ${target}`);
  }

  try {
    const fileStats = await stat(fullPath);
    if (!fileStats.isFile() || fileStats.size === 0) {
      throw new Error('not a non-empty file');
    }
  } catch {
    throw new Error(
      `${packageName} is missing its compiled export ${target}. Rebuild the compiled workspace artifact.`,
    );
  }

  return fullPath;
}

async function verifyWorkspaceExports(workspaceRelativeDirectory) {
  const workspaceDirectory = path.join(rootDir, workspaceRelativeDirectory);
  const packageJson = JSON.parse(await readFile(path.join(workspaceDirectory, 'package.json'), 'utf8'));
  const targets = new Set([packageJson.main, packageJson.module, packageJson.types].filter(Boolean));
  collectExportTargets(packageJson.exports, targets);

  for (const target of targets) {
    const fullPath = await assertCompiledFile(packageJson.name, workspaceDirectory, target);
    if (target.endsWith('.cjs')) {
      try {
        require(fullPath);
      } catch (error) {
        throw new Error(`${packageJson.name} cannot load compiled export ${target}: ${formatError(error)}`);
      }
    } else if (/\.[cm]?js$/.test(target)) {
      try {
        await import(pathToFileURL(fullPath).href);
      } catch (error) {
        throw new Error(`${packageJson.name} cannot load compiled export ${target}: ${formatError(error)}`);
      }
    }
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function verifyExecutorBundle() {
  await assertCompiledFile('@valerypopoff/rivet-app-executor', rootDir, path.relative(rootDir, executorBundlePath));
  const syntaxCheck = spawnSync(process.execPath, ['--check', executorBundlePath], { encoding: 'utf8' });
  if (syntaxCheck.status !== 0) {
    const diagnostics = [syntaxCheck.error?.message, syntaxCheck.stderr]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n');
    throw new Error(
      `@valerypopoff/rivet-app-executor has an invalid compiled executor bundle${diagnostics ? `: ${diagnostics}` : '.'}`,
    );
  }
}

for (const workspaceDirectory of workspaceDirectories) {
  await verifyWorkspaceExports(workspaceDirectory);
}
await verifyExecutorBundle();

console.log(
  'Compiled workspace exports are complete and loadable; executor bundle is present and syntactically valid.',
);
