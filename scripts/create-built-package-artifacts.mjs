import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutDir = path.join(repoRoot, '.rivet-built-packages');

const artifacts = {
  core: {
    kind: 'package',
    name: '@valerypopoff/rivet2-core',
    sourceDir: path.join(repoRoot, 'packages/core'),
    artifactDir: 'rivet2-core',
  },
  node: {
    kind: 'package',
    name: '@valerypopoff/rivet2-node',
    sourceDir: path.join(repoRoot, 'packages/node'),
    artifactDir: 'rivet2-node',
    requiresArtifacts: ['core'],
    rewriteDependencies: {
      '@valerypopoff/rivet2-core': 'file:../rivet2-core',
    },
  },
  evaluations: {
    kind: 'package',
    name: '@valerypopoff/rivet2-evaluations',
    sourceDir: path.join(repoRoot, 'packages/evaluations'),
    artifactDir: 'rivet2-evaluations',
    requiresArtifacts: ['core'],
    rewriteDependencies: {
      '@valerypopoff/rivet2-core': 'file:../rivet2-core',
    },
  },
  'app-executor': {
    kind: 'app-executor',
    name: '@valerypopoff/rivet-app-executor',
    sourceDir: path.join(repoRoot, 'packages/app-executor'),
    artifactDir: 'app-executor',
  },
};

const artifactTargets = {
  runtime: ['core', 'node'],
  'hosted-web-deps': ['core', 'evaluations'],
  'executor-runtime': ['core', 'node', 'app-executor'],
  wrapper: ['core', 'node', 'evaluations', 'app-executor'],
};
const artifactOrder = Object.keys(artifacts);

function readOption(name) {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) {
    const value = process.argv[exactIndex + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }

    return value;
  }

  const prefix = `${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (arg) {
    const value = arg.slice(prefix.length);
    if (!value) {
      throw new Error(`${name} requires a value.`);
    }

    return value;
  }

  return undefined;
}

const outDirArg = readOption('--out-dir');
const outDir = outDirArg ? path.resolve(outDirArg) : defaultOutDir;
const includeArg = readOption('--include');
const targetName = readOption('--target') ?? 'runtime';
const requestedKeys = includeArg
  ? includeArg
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  : artifactTargets[targetName];

if (!includeArg && !artifactTargets[targetName]) {
  throw new Error(
    `Unknown artifact target "${targetName}". Expected one of: ${Object.keys(artifactTargets).join(', ')}`,
  );
}

function expandArtifactKeys(keys) {
  const expandedKeys = new Set();

  function addKey(key) {
    const artifact = artifacts[key];
    if (!artifact) {
      throw new Error(`Unknown artifact "${key}". Expected one of: ${Object.keys(artifacts).join(', ')}`);
    }

    for (const dependencyKey of artifact.requiresArtifacts ?? []) {
      addKey(dependencyKey);
    }

    expandedKeys.add(key);
  }

  for (const key of keys ?? []) {
    addKey(key);
  }

  return artifactOrder.filter((key) => expandedKeys.has(key));
}

const selectedKeys = expandArtifactKeys(requestedKeys);

if (selectedKeys.length === 0) {
  throw new Error('At least one artifact must be selected.');
}

const selectedArtifacts = selectedKeys.map((key) => {
  return { key, artifact: artifacts[key] };
});

function isSameOrInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeOutDir(targetDir) {
  const resolvedTargetDir = path.resolve(targetDir);
  const root = path.parse(resolvedTargetDir).root;

  if (resolvedTargetDir === root) {
    throw new Error(`Refusing to recreate filesystem root as an output directory: ${resolvedTargetDir}`);
  }

  if (isSameOrInside(resolvedTargetDir, repoRoot)) {
    throw new Error(
      `Refusing to recreate the repository root or one of its parents as an output directory: ${resolvedTargetDir}`,
    );
  }

  if (isSameOrInside(repoRoot, resolvedTargetDir) && !isSameOrInside(defaultOutDir, resolvedTargetDir)) {
    throw new Error(
      `Output directories inside this repository must live under ${path.relative(repoRoot, defaultOutDir)}: ${resolvedTargetDir}`,
    );
  }

  for (const artifact of Object.values(artifacts)) {
    if (
      isSameOrInside(artifact.sourceDir, resolvedTargetDir) ||
      isSameOrInside(resolvedTargetDir, artifact.sourceDir)
    ) {
      throw new Error(
        `Output directory must not overlap ${artifact.name}'s source directory (${path.relative(repoRoot, artifact.sourceDir)}): ${resolvedTargetDir}`,
      );
    }
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertBuiltPackage(artifact) {
  const requiredFiles = ['dist/esm/index.js', 'dist/cjs/bundle.cjs', 'dist/types/index.d.ts'];
  const missingFiles = [];

  for (const file of requiredFiles) {
    if (!(await pathExists(path.join(artifact.sourceDir, file)))) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `${artifact.name} has not been built. Missing ${missingFiles.join(', ')}. Run its workspace build first.`,
    );
  }
}

async function assertBuiltAppExecutor(artifact) {
  const bundlePath = path.join(artifact.sourceDir, 'bin/executor-bundle.cjs');
  const distDir = path.join(artifact.sourceDir, 'dist');
  const missingFiles = [];

  if (!(await pathExists(bundlePath))) {
    missingFiles.push('bin/executor-bundle.cjs');
  }

  if (!(await pathExists(distDir))) {
    missingFiles.push('dist/*');
  } else {
    const distFiles = await readdir(distDir);
    if (!distFiles.some((file) => file === 'rivet-app-executor' || file.startsWith('app-executor-'))) {
      missingFiles.push('dist/app-executor-*');
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `${artifact.name} has not been built. Missing ${missingFiles.join(', ')}. Run its workspace build first.`,
    );
  }
}

function sanitizePackageJson(artifact, packageJson) {
  const nextPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    repository: packageJson.repository,
    type: packageJson.type,
    main: packageJson.main,
    module: packageJson.module,
    types: packageJson.types,
    bin: packageJson.bin,
    exports: packageJson.exports,
    dependencies: {
      ...(packageJson.dependencies ?? {}),
      ...(artifact.rewriteDependencies ?? {}),
    },
  };

  return `${JSON.stringify(removeUndefinedProperties(nextPackageJson), null, 2)}\n`;
}

function removeUndefinedProperties(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

async function copyIfPresent(from, to) {
  if (await pathExists(from)) {
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
}

async function preparePackageArtifact(key, artifact, targetDir) {
  await assertBuiltPackage(artifact);

  const packageJson = JSON.parse(await readFile(path.join(artifact.sourceDir, 'package.json'), 'utf8'));
  await writeFile(path.join(targetDir, 'package.json'), sanitizePackageJson(artifact, packageJson));
  await cp(path.join(artifact.sourceDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  await copyIfPresent(path.join(artifact.sourceDir, 'README.md'), path.join(targetDir, 'README.md'));
  await copyIfPresent(path.join(artifact.sourceDir, 'LICENSE'), path.join(targetDir, 'LICENSE'));

  return {
    key,
    kind: artifact.kind,
    name: artifact.name,
    version: packageJson.version,
    path: path.relative(outDir, targetDir),
  };
}

async function prepareAppExecutorArtifact(key, artifact, targetDir) {
  await assertBuiltAppExecutor(artifact);

  const packageJson = JSON.parse(await readFile(path.join(artifact.sourceDir, 'package.json'), 'utf8'));
  await writeFile(path.join(targetDir, 'package.json'), sanitizePackageJson(artifact, packageJson));
  await copyIfPresent(
    path.join(artifact.sourceDir, 'bin/executor-bundle.cjs'),
    path.join(targetDir, 'bin/executor-bundle.cjs'),
  );
  await copyAppExecutorDistArtifacts(artifact, targetDir);
  await copyIfPresent(path.join(artifact.sourceDir, 'README.md'), path.join(targetDir, 'README.md'));
  await copyIfPresent(path.join(artifact.sourceDir, 'LICENSE'), path.join(targetDir, 'LICENSE'));

  return {
    key,
    kind: artifact.kind,
    name: artifact.name,
    version: packageJson.version,
    path: path.relative(outDir, targetDir),
  };
}

async function copyAppExecutorDistArtifacts(artifact, targetDir) {
  const distDir = path.join(artifact.sourceDir, 'dist');
  const targetDistDir = path.join(targetDir, 'dist');
  const distFiles = await readdir(distDir);

  await mkdir(targetDistDir, { recursive: true });

  for (const file of distFiles) {
    if (file === 'rivet-app-executor' || file === 'rivet-app-executor.exe' || file.startsWith('app-executor-')) {
      await cp(path.join(distDir, file), path.join(targetDistDir, file));
    }
  }
}

async function resolveRevision() {
  const revisionArg = readOption('--revision') ?? process.env.RIVET_SOURCE_REVISION;
  if (revisionArg) {
    return revisionArg;
  }

  const upstreamVersionPath = path.join(repoRoot, '.upstream-version');
  if (await pathExists(upstreamVersionPath)) {
    const upstreamVersion = (await readFile(upstreamVersionPath, 'utf8')).trim();
    const shaMatch = /[0-9a-f]{40}/i.exec(upstreamVersion);
    return shaMatch?.[0] ?? upstreamVersion;
  }

  const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  return gitResult.status === 0 ? gitResult.stdout.trim() : 'unknown';
}

assertSafeOutDir(outDir);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const preparedArtifacts = [];

for (const { key, artifact } of selectedArtifacts) {
  const targetDir = path.join(outDir, artifact.artifactDir);
  await mkdir(targetDir, { recursive: true });

  const preparedArtifact =
    artifact.kind === 'app-executor'
      ? await prepareAppExecutorArtifact(key, artifact, targetDir)
      : await preparePackageArtifact(key, artifact, targetDir);

  preparedArtifacts.push(preparedArtifact);
  console.log(`Prepared ${artifact.name} at ${path.relative(repoRoot, targetDir)}`);
}

const revision = await resolveRevision();
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: includeArg ? 'custom' : targetName,
  revision,
  sourceRef: process.env.RIVET_SOURCE_REF ?? process.env.RIVET_REPO_REF ?? null,
  artifacts: preparedArtifacts,
};

await writeFile(path.join(outDir, 'rivet-build-artifacts.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built artifacts are ready at ${path.relative(repoRoot, outDir)}`);
console.log(`Artifact manifest revision: ${revision}`);
