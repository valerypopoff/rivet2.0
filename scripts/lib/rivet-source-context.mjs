import fs from 'node:fs';
import path from 'node:path';

const contextRootRelPath = path.join('.data', 'docker-contexts');
const defaultContextRelPath = path.join(contextRootRelPath, 'rivet-source');
const defaultDependencyContextRelPath = path.join(contextRootRelPath, 'rivet-dependency-metadata');

const rootFiles = [
  '.editorconfig',
  '.gitattributes',
  '.npmignore',
  '.prettierrc.yml',
  '.upstream-version',
  '.yarnrc.yml',
  'LICENSE',
  'README.md',
  'eslint.config.mjs',
  'package.json',
  'tsconfig.base.json',
  'yarn.lock',
];

const sourceOnlyDirectories = ['scripts'];

const requiredRootScripts = ['build:runtime', 'build:hosted-web-deps'];

const yarnSubdirectories = ['releases', 'patches', 'plugins'];

const excludedDirectoryNames = new Set([
  '.cache',
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'sidecars',
  'src-tauri',
]);

const excludedFileNames = new Set([
  '.pnp.cjs',
  '.pnp.loader.mjs',
  'install-state.gz',
  'stats.html',
  'tsconfig.tsbuildinfo',
]);

export function getDefaultRivetDockerContextPath(rootDir) {
  return path.join(rootDir, defaultContextRelPath);
}

export function getDefaultRivetDependencyMetadataContextPath(rootDir) {
  return path.join(rootDir, defaultDependencyContextRelPath);
}

function assertInside(parentDir, childPath, label) {
  const relative = path.relative(parentDir, childPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[rivet-context] Refusing to use ${label} outside ${parentDir}: ${childPath}`);
  }
}

function comparablePath(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertDistinctPaths(firstPath, secondPath, firstLabel, secondLabel) {
  if (comparablePath(firstPath) === comparablePath(secondPath)) {
    throw new Error(`[rivet-context] ${firstLabel} and ${secondLabel} must be different directories: ${firstPath}`);
  }
}

function copyFiltered(sourcePath, destinationPath) {
  fs.cpSync(sourcePath, destinationPath, {
    dereference: false,
    errorOnExist: false,
    filter: (candidate) => {
      const name = path.basename(candidate);
      const stats = fs.lstatSync(candidate);

      if (stats.isDirectory()) {
        return !excludedDirectoryNames.has(name);
      }

      return !excludedFileNames.has(name);
    },
    force: true,
    recursive: true,
  });
}

function copyIfExists(sourceRoot, destinationRoot, relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);

  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const destinationPath = path.join(destinationRoot, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFiltered(sourcePath, destinationPath);
  return true;
}

function readWorkspacePatterns(sourceRoot) {
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const workspaces = Array.isArray(rootPackageJson.workspaces)
    ? rootPackageJson.workspaces
    : rootPackageJson.workspaces?.packages;

  return Array.isArray(workspaces) ? workspaces.filter((pattern) => typeof pattern === 'string') : [];
}

function normalizeWorkspacePattern(pattern) {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`[rivet-context] Unsupported workspace pattern in upstream Rivet package.json: ${pattern}`);
  }

  return normalized;
}

function copyWorkspacePackageJsonFiles(sourceRoot, destinationRoot) {
  for (const pattern of readWorkspacePatterns(sourceRoot)) {
    const normalizedPattern = normalizeWorkspacePattern(pattern);
    const wildcardCount = (normalizedPattern.match(/\*/g) ?? []).length;

    if (wildcardCount === 0) {
      copyIfExists(sourceRoot, destinationRoot, path.join(normalizedPattern, 'package.json'));
      continue;
    }

    if (wildcardCount !== 1 || !normalizedPattern.endsWith('/*')) {
      throw new Error(
        `[rivet-context] Unsupported workspace pattern in upstream Rivet package.json: ${pattern}. ` +
          'Only exact workspace paths and immediate-child /* patterns are supported.',
      );
    }

    const workspaceRootRelPath = normalizedPattern.slice(0, -2);
    const workspaceRoot = path.join(sourceRoot, workspaceRootRelPath);

    if (!fs.existsSync(workspaceRoot)) {
      continue;
    }

    for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || excludedDirectoryNames.has(entry.name)) {
        continue;
      }

      copyIfExists(sourceRoot, destinationRoot, path.join(workspaceRootRelPath, entry.name, 'package.json'));
    }
  }
}

function validateRivetSource(sourceRoot) {
  const requiredPaths = [
    'package.json',
    'yarn.lock',
    '.yarnrc.yml',
    path.join('.yarn', 'releases'),
    path.join('scripts', 'build-wrapper-target.mjs'),
    path.join('packages', 'app', 'package.json'),
    path.join('packages', 'app-executor', 'package.json'),
    path.join('packages', 'core', 'package.json'),
    path.join('packages', 'node', 'package.json'),
    path.join('packages', 'trivet', 'package.json'),
  ];

  for (const relativePath of requiredPaths) {
    const candidate = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(candidate)) {
      throw new Error(`[rivet-context] Expected upstream Rivet source file or directory at ${candidate}`);
    }
  }

  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const scriptName of requiredRootScripts) {
    if (typeof rootPackageJson.scripts?.[scriptName] !== 'string') {
      throw new Error(`[rivet-context] Expected upstream Rivet package.json script "${scriptName}"`);
    }
  }
}

export function prepareRivetDockerContext(rootDir, env) {
  const sourceRoot = fs.realpathSync.native(String(env.RIVET_SOURCE_HOST_PATH ?? path.join(rootDir, 'rivet')));
  const contextRoot = path.join(rootDir, contextRootRelPath);
  const contextPath = path.resolve(String(env.RIVET_SOURCE_BUILD_CONTEXT_PATH ?? getDefaultRivetDockerContextPath(rootDir)));
  const dependencyContextPath = path.resolve(
    String(env.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH ?? getDefaultRivetDependencyMetadataContextPath(rootDir)),
  );

  assertInside(contextRoot, contextPath, 'Rivet Docker build context');
  assertInside(contextRoot, dependencyContextPath, 'Rivet dependency metadata Docker build context');
  assertDistinctPaths(contextPath, dependencyContextPath, 'Rivet Docker build context', 'Rivet dependency metadata context');
  validateRivetSource(sourceRoot);

  fs.rmSync(contextPath, { recursive: true, force: true });
  fs.mkdirSync(contextPath, { recursive: true });

  for (const relativePath of rootFiles) {
    copyIfExists(sourceRoot, contextPath, relativePath);
  }

  for (const relativePath of sourceOnlyDirectories) {
    copyIfExists(sourceRoot, contextPath, relativePath);
  }

  copyIfExists(sourceRoot, contextPath, 'packages');

  for (const subdirectory of yarnSubdirectories) {
    copyIfExists(sourceRoot, contextPath, path.join('.yarn', subdirectory));
  }

  fs.rmSync(dependencyContextPath, { recursive: true, force: true });
  fs.mkdirSync(dependencyContextPath, { recursive: true });

  for (const relativePath of rootFiles) {
    copyIfExists(sourceRoot, dependencyContextPath, relativePath);
  }

  for (const subdirectory of yarnSubdirectories) {
    copyIfExists(sourceRoot, dependencyContextPath, path.join('.yarn', subdirectory));
  }

  copyWorkspacePackageJsonFiles(sourceRoot, dependencyContextPath);

  env.RIVET_SOURCE_BUILD_CONTEXT_PATH = contextPath;
  env.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH = dependencyContextPath;

  console.log(`[rivet-context] Prepared filtered Rivet Docker context: ${contextPath}`);
  console.log(`[rivet-context] Prepared Rivet dependency metadata context: ${dependencyContextPath}`);
  console.log(`[rivet-context] Source: ${sourceRoot}`);
  console.log('[rivet-context] Excluded dependency folders, build output, VCS data, and Yarn cache artifacts.');

  return contextPath;
}
