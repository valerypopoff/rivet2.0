#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const appPackagePath = path.join(repoRoot, 'packages', 'app', 'package.json');
const tauriConfigPath = path.join(repoRoot, 'packages', 'app', 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(repoRoot, 'packages', 'app', 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(repoRoot, 'packages', 'app', 'src-tauri', 'Cargo.lock');

const appVersion = readJsonVersion(appPackagePath, ['version']);
validateVersion(appVersion);

const WINDOWS_WRITE_RETRY_DELAYS_MS = [50, 150, 350];

const updates = [
  updateJsonVersion(tauriConfigPath, ['package', 'version'], appVersion),
  updateCargoPackageVersion(cargoTomlPath, appVersion),
  updateCargoLockPackageVersion(cargoLockPath, 'app', appVersion),
];

const changed = updates.filter((update) => update.changed);

if (checkOnly && changed.length > 0) {
  console.error(
    `Desktop version metadata is out of sync with ${path.relative(repoRoot, appPackagePath)} (${appVersion}):`,
  );
  for (const update of changed) {
    console.error(`- ${path.relative(repoRoot, update.filePath)}: ${update.previousVersion}`);
  }
  console.error('Run `yarn sync:desktop-version` to update Tauri and Cargo metadata.');
  process.exit(1);
}

if (!checkOnly) {
  for (const update of changed) {
    writeFileWithRetry(update.filePath, update.nextContents);
  }
}

const action = checkOnly ? 'aligned' : changed.length > 0 ? 'synced' : 'already aligned';
console.log(`Desktop version metadata is ${action} at ${appVersion}.`);

function readJsonVersion(filePath, keyPath) {
  const value = keyPath.reduce((current, key) => current?.[key], JSON.parse(readFileSync(filePath, 'utf8')));

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Could not read ${keyPath.join('.')} from ${filePath}`);
  }

  return value;
}

function validateVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Desktop version ${version} from ${appPackagePath} is not valid semver.`);
  }
}

function writeFileWithRetry(filePath, contents) {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(filePath, contents);
      return;
    } catch (error) {
      const retryDelay =
        process.platform === 'win32' && isTransientWindowsWriteError(error)
          ? WINDOWS_WRITE_RETRY_DELAYS_MS[attempt]
          : undefined;

      if (retryDelay === undefined) {
        if (process.platform === 'win32' && isTransientWindowsWriteError(error)) {
          throw new Error(
            `Could not write ${filePath}. The file may be temporarily locked by Tauri or Rust tooling; close the related process and retry.`,
            { cause: error },
          );
        }
        throw error;
      }

      sleepSync(retryDelay);
    }
  }
}

function isTransientWindowsWriteError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EACCES', 'EBUSY', 'EPERM', 'UNKNOWN'].includes(error.code)
  );
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function updateJsonVersion(filePath, keyPath, version) {
  const contents = readFileSync(filePath, 'utf8');
  const currentVersion = readJsonVersion(filePath, keyPath);

  if (currentVersion === version) {
    return { changed: false, filePath, previousVersion: currentVersion, nextContents: contents };
  }

  const versionLinePattern = new RegExp(
    `("${escapeRegExp(keyPath.at(-1))}"\\s*:\\s*)"${escapeRegExp(currentVersion)}"`,
  );
  const nextContents = contents.replace(versionLinePattern, `$1"${version}"`);

  if (nextContents === contents) {
    throw new Error(`Could not update ${keyPath.join('.')} in ${filePath}`);
  }

  return { changed: true, filePath, previousVersion: currentVersion, nextContents };
}

function updateCargoPackageVersion(filePath, version) {
  return updateVersionInSection({
    filePath,
    sectionHeader: '[package]',
    label: '[package].version',
    version,
  });
}

function updateCargoLockPackageVersion(filePath, packageName, version) {
  const contents = readFileSync(filePath, 'utf8');
  const escapedPackageName = escapeRegExp(packageName);
  const packageBlockPattern = new RegExp(
    String.raw`(\[\[package\]\]\s+name = "${escapedPackageName}"\s+version = ")(?<version>[^"]+)(")`,
    'm',
  );
  const match = packageBlockPattern.exec(contents);

  if (!match?.groups?.version) {
    throw new Error(`Could not read package ${packageName} version from ${filePath}`);
  }

  const currentVersion = match.groups.version;
  if (currentVersion === version) {
    return { changed: false, filePath, previousVersion: currentVersion, nextContents: contents };
  }

  return {
    changed: true,
    filePath,
    previousVersion: currentVersion,
    nextContents: contents.replace(packageBlockPattern, `$1${version}$3`),
  };
}

function updateVersionInSection({ filePath, sectionHeader, label, version }) {
  const contents = readFileSync(filePath, 'utf8');
  const lines = contents.split(/(\r?\n)/);
  let inSection = false;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === sectionHeader) {
      inSection = true;
      continue;
    }

    if (inSection && trimmed.startsWith('[')) {
      break;
    }

    if (!inSection) {
      continue;
    }

    const match = /^(?<prefix>\s*version\s*=\s*")(?<version>[^"]+)(?<suffix>".*)$/.exec(line);
    if (!match?.groups?.version) {
      continue;
    }

    const currentVersion = match.groups.version;
    if (currentVersion === version) {
      return { changed: false, filePath, previousVersion: currentVersion, nextContents: contents };
    }

    lines[index] = `${match.groups.prefix}${version}${match.groups.suffix}`;
    return {
      changed: true,
      filePath,
      previousVersion: currentVersion,
      nextContents: lines.join(''),
    };
  }

  throw new Error(`Could not update ${label} in ${filePath}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
