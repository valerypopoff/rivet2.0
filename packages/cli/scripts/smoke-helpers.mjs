import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(packageDir, '../..');
export const yarnPath = join(repoRoot, '.yarn/releases/yarn-4.6.0.cjs');

export function buildWorkspace(workspaceName) {
  run('node', [yarnPath, 'workspace', workspaceName, 'run', 'build'], repoRoot);
}

export async function packBuiltWorkspace(workspacePath, packagePath, tempDir) {
  const workspaceDir = join(repoRoot, workspacePath);
  const packageJson = JSON.parse(await readFile(join(workspaceDir, 'package.json'), 'utf8'));
  const stageDir = join(tempDir, `stage-${packageJson.name.replace(/[^a-z0-9]+/gi, '-')}`);

  await rm(stageDir, { force: true, recursive: true });
  await mkdir(stageDir, { recursive: true });
  await copyPackageFiles(workspaceDir, stageDir, packageJson.files ?? []);
  await copyPackageMetadataFile('LICENSE', workspaceDir, stageDir);
  await copyPackageMetadataFile('README.md', workspaceDir, stageDir);
  await writeFile(join(stageDir, 'package.json'), `${JSON.stringify(rewriteWorkspaceRanges(packageJson), null, 2)}\n`);

  const output = runNpm(['pack', '--ignore-scripts', '--pack-destination', tempDir], stageDir);
  const packedFileName = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1);

  if (!packedFileName) {
    throw new Error(`npm pack did not report an output file for ${packageJson.name}.`);
  }

  await rm(packagePath, { force: true });
  await rename(join(tempDir, packedFileName), packagePath);
}

export function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(env).filter(([, value]) => value != null)),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runNpm(args, cwd, env = cleanPackageRuntimeEnv()) {
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

  return existsSync(npmCli) ? run(process.execPath, [npmCli, ...args], cwd, env) : run('npm', args, cwd, env);
}

export function cleanPackageRuntimeEnv() {
  return process.env.NODE_OPTIONS?.includes('.pnp.') ? { NODE_OPTIONS: '' } : {};
}

export async function readTgzEntries(packagePath) {
  const archive = gunzipSync(await readFile(packagePath));
  const entries = [];
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8);
    entries.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

async function copyPackageFiles(workspaceDir, stageDir, files) {
  for (const filePattern of files) {
    const relativePath = filePattern.replace(/[/\\]?\*\*.*$/, '').replace(/[/\\]?\*.*$/, '');
    await cp(join(workspaceDir, relativePath), join(stageDir, relativePath), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
}

async function copyPackageMetadataFile(fileName, workspaceDir, stageDir) {
  const workspaceFile = join(workspaceDir, fileName);
  await cp(existsSync(workspaceFile) ? workspaceFile : join(repoRoot, fileName), join(stageDir, fileName));
}

function rewriteWorkspaceRanges(packageJson) {
  const rewritten = structuredClone(packageJson);

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!rewritten[field]) {
      continue;
    }

    for (const [dependency, range] of Object.entries(rewritten[field])) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        rewritten[field][dependency] = `^${rewritten.version}`;
      }
    }
  }

  return rewritten;
}

function readTarString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
}
