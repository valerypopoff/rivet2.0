import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const rivetRootDir = process.env.RIVET_SOURCE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_SOURCE_ROOT)
  : path.join(rootDir, 'rivet');
const apiPackageDir = process.env.RIVET_API_PACKAGE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_API_PACKAGE_ROOT)
  : path.join(rootDir, 'wrapper', 'api');
const webPackageDir = process.env.RIVET_WEB_PACKAGE_ROOT
  ? path.resolve(rootDir, process.env.RIVET_WEB_PACKAGE_ROOT)
  : path.join(rootDir, 'wrapper', 'web');
const apiNodeModulesDir = path.join(apiPackageDir, 'node_modules');
const webNodeModulesDir = path.join(webPackageDir, 'node_modules');
const packageLinksDir = path.join(apiNodeModulesDir, '.rivet-package-links');
const rivetNodeModulesDir = path.join(rivetRootDir, 'node_modules');
const dependencyNodeModulesRoots = [
  rivetNodeModulesDir,
  apiNodeModulesDir,
  webNodeModulesDir,
];
const dependencyOverlayMarkerFile = '.rivet-dependency-overlay';
const retiredScope = ['@', 'iron', 'clad'].join('');
const retiredPackageAliases = [
  { scope: retiredScope, name: 'rivet-core' },
  { scope: retiredScope, name: 'rivet-node' },
];

const packages = [
  {
    linkName: 'rivet-core',
    source: path.join(rivetRootDir, 'packages', 'core'),
    aliases: [
      { scope: '@rivet2', name: 'rivet-core' },
    ],
  },
  {
    linkName: 'rivet-node',
    source: path.join(rivetRootDir, 'packages', 'node'),
    aliases: [
      { scope: '@rivet2', name: 'rivet-node' },
    ],
  },
  {
    linkName: 'rivet-evaluations',
    source: path.join(rivetRootDir, 'packages', 'evaluations'),
    aliases: [],
  },
];
let localRivetPackageNames;

function readPackageJson(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function parsePackageName(packageName) {
  const match = /^(@[^/]+)\/(.+)$/.exec(packageName);

  if (!match) {
    throw new Error(`Expected scoped Rivet package name, got ${packageName}`);
  }

  return { scope: match[1], name: match[2] };
}

function uniqueAliases(aliases) {
  const seen = new Set();
  return aliases.filter((alias) => {
    const key = `${alias.scope}/${alias.name}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function packageNameToNodeModulesPath(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    return path.join(scope, name);
  }

  return packageName;
}

function dependencyExistsInAnyRoot(dependencyName) {
  const dependencyPath = packageNameToNodeModulesPath(dependencyName);
  return dependencyNodeModulesRoots.some((nodeModulesRoot) =>
    fs.existsSync(path.join(nodeModulesRoot, dependencyPath)),
  );
}

function collectRuntimeDependencyNames() {
  const dependencyNames = new Set();

  for (const pkg of packages) {
    const packageJson = readPackageJson(pkg);

    for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
      dependencyNames.add(dependencyName);
    }
  }

  return [...dependencyNames];
}

function getLocalRivetPackageNames() {
  if (localRivetPackageNames) {
    return localRivetPackageNames;
  }

  const packageNames = new Set();

  for (const pkg of packages) {
    const packageJson = readPackageJson(pkg);
    packageNames.add(packageJson.name);

    for (const alias of pkg.aliases) {
      packageNames.add(`${alias.scope}/${alias.name}`);
    }
  }

  localRivetPackageNames = packageNames;
  return localRivetPackageNames;
}

function isLocalRivetPackageName(packageName) {
  return getLocalRivetPackageNames().has(packageName);
}

function ensurePackageReady(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const distIndexPath = path.join(pkg.source, 'dist', 'esm', 'index.js');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Expected ${pkg.linkName} package at ${pkg.source}`);
  }

  if (!fs.existsSync(distIndexPath)) {
    throw new Error(`Expected built ${pkg.linkName} ESM output at ${distIndexPath}`);
  }

}

function ensureRuntimeDependenciesReady() {
  const missingDependencies = collectRuntimeDependencyNames().filter((dependencyName) => {
    if (isLocalRivetPackageName(dependencyName)) {
      return false;
    }

    return !dependencyExistsInAnyRoot(dependencyName);
  });

  if (missingDependencies.length > 0) {
    throw new Error(
      [
        'Expected Rivet runtime dependencies in at least one installed node_modules root.',
        `Missing: ${missingDependencies.slice(0, 8).join(', ')}${missingDependencies.length > 8 ? ', ...' : ''}.`,
        `Checked: ${dependencyNodeModulesRoots.join(', ')}.`,
        'Run npm run setup so wrapper and Rivet dependencies are installed.',
      ].join(' '),
    );
  }
}

function linkDirectory(source, destination) {
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.rmSync(destination, { recursive: true, force: true });
  fs.symlinkSync(source, destination, symlinkType);
}

function linkDependencyEntriesFromRoot(sourceNodeModulesDir, destinationNodeModulesDir, skippedPackageNames) {
  if (!fs.existsSync(sourceNodeModulesDir)) {
    return;
  }

  for (const entry of fs.readdirSync(sourceNodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.cache' || entry.name === '.package-lock.json' || entry.name === '.rivet-package-links') {
      continue;
    }

    const sourceEntry = path.join(sourceNodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const destinationScopeDir = path.join(destinationNodeModulesDir, entry.name);
      fs.mkdirSync(destinationScopeDir, { recursive: true });

      for (const scopedEntry of fs.readdirSync(sourceEntry, { withFileTypes: true })) {
        const packageName = `${entry.name}/${scopedEntry.name}`;
        if (skippedPackageNames.has(packageName)) {
          continue;
        }

        const destination = path.join(destinationScopeDir, scopedEntry.name);
        if (!fs.existsSync(destination)) {
          linkDirectory(path.join(sourceEntry, scopedEntry.name), destination);
        }
      }

      continue;
    }

    if (skippedPackageNames.has(entry.name)) {
      continue;
    }

    const destination = path.join(destinationNodeModulesDir, entry.name);
    if (!fs.existsSync(destination)) {
      linkDirectory(sourceEntry, destination);
    }
  }
}

function createDependencyOverlay(pkg, packageLinkDir) {
  const destinationNodeModulesDir = path.join(packageLinkDir, 'node_modules');
  const skippedPackageNames = getLocalRivetPackageNames();

  fs.rmSync(destinationNodeModulesDir, { recursive: true, force: true });
  fs.mkdirSync(destinationNodeModulesDir, { recursive: true });

  for (const dependencyRoot of dependencyNodeModulesRoots) {
    linkDependencyEntriesFromRoot(dependencyRoot, destinationNodeModulesDir, skippedPackageNames);
  }

  fs.writeFileSync(
    path.join(destinationNodeModulesDir, dependencyOverlayMarkerFile),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      roots: dependencyNodeModulesRoots.filter((dependencyRoot) => fs.existsSync(dependencyRoot)),
    }, null, 2),
  );
}

function removeRetiredPackageAliases() {
  const touchedScopes = new Set();

  for (const alias of retiredPackageAliases) {
    const scopeDir = path.join(apiNodeModulesDir, alias.scope);
    fs.rmSync(path.join(scopeDir, alias.name), { recursive: true, force: true });
    touchedScopes.add(scopeDir);
  }

  for (const scopeDir of touchedScopes) {
    try {
      if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } catch {
      // Best effort cleanup only; package linking below is the required step.
    }
  }
}

function createPackageLinkTarget(pkg) {
  const packageJsonPath = path.join(pkg.source, 'package.json');
  const packageLinkDir = path.join(packageLinksDir, pkg.linkName);

  fs.rmSync(packageLinkDir, { recursive: true, force: true });
  fs.mkdirSync(packageLinkDir, { recursive: true });
  fs.copyFileSync(packageJsonPath, path.join(packageLinkDir, 'package.json'));
  linkDirectory(path.join(pkg.source, 'dist'), path.join(packageLinkDir, 'dist'));

  return packageLinkDir;
}

function linkPackage(pkg) {
  ensurePackageReady(pkg);

  const packageJson = readPackageJson(pkg);
  const packageLinkDir = createPackageLinkTarget(pkg);
  const aliases = uniqueAliases([...pkg.aliases, parsePackageName(packageJson.name)]);

  for (const alias of aliases) {
    const scopeDir = path.join(apiNodeModulesDir, alias.scope);
    const destination = path.join(scopeDir, alias.name);

    fs.mkdirSync(scopeDir, { recursive: true });
    linkDirectory(packageLinkDir, destination);
    console.log(`[link-rivet-node-package] ${alias.scope}/${alias.name} -> ${packageLinkDir} (dist from ${pkg.source})`);
  }

  return packageLinkDir;
}

removeRetiredPackageAliases();
ensureRuntimeDependenciesReady();

const linkedPackages = [];
for (const pkg of packages) {
  linkedPackages.push({
    pkg,
    packageLinkDir: linkPackage(pkg),
  });
}

for (const linkedPackage of linkedPackages) {
  createDependencyOverlay(linkedPackage.pkg, linkedPackage.packageLinkDir);
}
