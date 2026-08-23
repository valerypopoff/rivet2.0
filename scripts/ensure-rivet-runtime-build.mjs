import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getRivetYarnEnvironment } from './lib/rivet-local-dependencies.mjs';

const rootDir = process.cwd();
const rivetRootDir = process.env.RIVET_SOURCE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_SOURCE_ROOT)
  : path.join(rootDir, 'rivet');

const packages = [
  {
    label: '@valerypopoff/rivet2-core',
    sourceDir: path.join(rivetRootDir, 'packages', 'core'),
  },
  {
    label: '@valerypopoff/rivet2-node',
    sourceDir: path.join(rivetRootDir, 'packages', 'node'),
  },
  {
    label: '@valerypopoff/rivet2-evaluations',
    sourceDir: path.join(rivetRootDir, 'packages', 'evaluations'),
  },
];

const importantRootFiles = [
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  'tsconfig.base.json',
  path.join('scripts', 'build-wrapper-target.mjs'),
];

function pathExists(candidate) {
  return fs.existsSync(candidate);
}

function newestMtimeMs(paths) {
  let newest = 0;

  function visit(candidate) {
    if (!pathExists(candidate)) {
      return;
    }

    const stats = fs.statSync(candidate);
    newest = Math.max(newest, stats.mtimeMs);

    if (!stats.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }

      visit(path.join(candidate, entry.name));
    }
  }

  for (const candidate of paths) {
    visit(candidate);
  }

  return newest;
}

function oldestRequiredDistMtimeMs(pkg) {
  const requiredOutputs = [
    path.join(pkg.sourceDir, 'dist', 'esm', 'index.js'),
    path.join(pkg.sourceDir, 'dist', 'types', 'index.d.ts'),
  ];

  if (pkg.label === '@valerypopoff/rivet2-node') {
    requiredOutputs.push(path.join(pkg.sourceDir, 'dist', 'esm', 'webAppHandler.js'));
  }

  let oldest = Number.POSITIVE_INFINITY;

  for (const outputPath of requiredOutputs) {
    if (!pathExists(outputPath)) {
      return 0;
    }

    oldest = Math.min(oldest, fs.statSync(outputPath).mtimeMs);
  }

  return oldest;
}

function isPackageRuntimeBuildStale(pkg) {
  const sourceMtime = newestMtimeMs([
    path.join(pkg.sourceDir, 'src'),
    path.join(pkg.sourceDir, 'package.json'),
    path.join(pkg.sourceDir, 'tsconfig.json'),
    ...importantRootFiles.map((relativePath) => path.join(rivetRootDir, relativePath)),
  ]);
  const distMtime = oldestRequiredDistMtimeMs(pkg);

  return distMtime === 0 || sourceMtime > distMtime;
}

function getConfiguredYarnPath() {
  const yarnrcPath = path.join(rivetRootDir, '.yarnrc.yml');
  const yarnrc = fs.readFileSync(yarnrcPath, 'utf8');
  const configuredPath = /^yarnPath:\s*(\S+)\s*$/m.exec(yarnrc)?.[1];

  if (!configuredPath) {
    throw new Error(`[ensure-rivet-runtime-build] Expected yarnPath in ${yarnrcPath}`);
  }

  const yarnPath = path.resolve(rivetRootDir, configuredPath);
  const relativeYarnPath = path.relative(rivetRootDir, yarnPath);
  if (!relativeYarnPath || relativeYarnPath.startsWith('..') || path.isAbsolute(relativeYarnPath)) {
    throw new Error(`[ensure-rivet-runtime-build] yarnPath must stay inside ${rivetRootDir}`);
  }

  if (!pathExists(yarnPath)) {
    throw new Error(`[ensure-rivet-runtime-build] Configured Yarn release is missing: ${yarnPath}`);
  }

  return yarnPath;
}

function runHostedApiBuild() {
  console.log('[ensure-rivet-runtime-build] Rebuilding Rivet API packages because source is newer than dist.');
  const yarnPath = getConfiguredYarnPath();
  const env = {
    ...process.env,
    ...getRivetYarnEnvironment(rootDir, rivetRootDir),
  };

  for (const target of ['build:runtime', 'build:hosted-web-deps']) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=8192', yarnPath, target], {
      cwd: rivetRootDir,
      env,
      stdio: 'inherit',
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

for (const pkg of packages) {
  if (!pathExists(path.join(pkg.sourceDir, 'package.json'))) {
    throw new Error(`[ensure-rivet-runtime-build] Expected ${pkg.label} at ${pkg.sourceDir}`);
  }
}

if (packages.some(isPackageRuntimeBuildStale)) {
  runHostedApiBuild();
} else {
  console.log('[ensure-rivet-runtime-build] Rivet API package dist is fresh.');
}
