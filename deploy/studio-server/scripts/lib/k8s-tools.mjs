import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const HELM_VERSION = 'v3.20.1';

const HELM_RELEASE_BASE_URL = 'https://get.helm.sh';

const HELM_PLATFORM_SPECS = {
  'darwin-arm64': {
    archiveName: `helm-${HELM_VERSION}-darwin-arm64.tar.gz`,
    extractedDir: 'darwin-arm64',
    executableName: 'helm',
    extractKind: 'tar.gz',
  },
  'darwin-x64': {
    archiveName: `helm-${HELM_VERSION}-darwin-amd64.tar.gz`,
    extractedDir: 'darwin-amd64',
    executableName: 'helm',
    extractKind: 'tar.gz',
  },
  'linux-arm64': {
    archiveName: `helm-${HELM_VERSION}-linux-arm64.tar.gz`,
    extractedDir: 'linux-arm64',
    executableName: 'helm',
    extractKind: 'tar.gz',
  },
  'linux-x64': {
    archiveName: `helm-${HELM_VERSION}-linux-amd64.tar.gz`,
    extractedDir: 'linux-amd64',
    executableName: 'helm',
    extractKind: 'tar.gz',
  },
  'win32-x64': {
    archiveName: `helm-${HELM_VERSION}-windows-amd64.zip`,
    extractedDir: 'windows-amd64',
    executableName: 'helm.exe',
    extractKind: 'zip',
  },
} ;

function getPlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function getHelmPlatformSpec(platform = process.platform, arch = process.arch) {
  const spec = HELM_PLATFORM_SPECS[getPlatformKey(platform, arch)];
  if (!spec) {
    throw new Error(
      `Unsupported platform for cached Helm bootstrap: ${platform}/${arch}. ` +
      'Set RIVET_K8S_HELM_BIN to an existing Helm binary instead.',
    );
  }

  return spec;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function splitPathEntries(env) {
  return String(env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getWindowsPathExts(env) {
  return String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasPathSeparator(command) {
  return command.includes('/') || command.includes('\\');
}

export function findExecutableOnPath(command, env = process.env) {
  if (!command) {
    return null;
  }

  if (hasPathSeparator(command)) {
    return fileExists(command) ? command : null;
  }

  const pathEntries = splitPathEntries(env);
  if (process.platform !== 'win32') {
    for (const pathEntry of pathEntries) {
      const candidate = path.join(pathEntry, command);
      if (fileExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  const ext = path.extname(command).toLowerCase();
  const pathExts = ext ? [''] : getWindowsPathExts(env);

  for (const pathEntry of pathEntries) {
    if (ext) {
      const candidate = path.join(pathEntry, command);
      if (fileExists(candidate)) {
        return candidate;
      }

      continue;
    }

    for (const pathExt of pathExts) {
      const candidate = path.join(pathEntry, `${command}${pathExt}`);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function getHelmCacheDirectory(rootDir, platform = process.platform, arch = process.arch) {
  return path.join(rootDir, '.data', 'tools', 'helm', HELM_VERSION, getPlatformKey(platform, arch));
}

export function getHelmCachedExecutablePath(rootDir, platform = process.platform, arch = process.arch) {
  const spec = getHelmPlatformSpec(platform, arch);
  return path.join(getHelmCacheDirectory(rootDir, platform, arch), spec.extractedDir, spec.executableName);
}

export function resolveHelmBin(rootDir, { env = process.env } = {}) {
  const explicit = String(env.RIVET_K8S_HELM_BIN ?? '').trim();
  if (explicit) {
    return { bin: explicit, source: 'env' };
  }

  const system = findExecutableOnPath(process.platform === 'win32' ? 'helm.exe' : 'helm', env);
  if (system) {
    return { bin: system, source: 'path' };
  }

  try {
    const cached = getHelmCachedExecutablePath(rootDir);
    if (fileExists(cached)) {
      return { bin: cached, source: 'cache' };
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveHelmBinOrThrow(rootDir, { env = process.env, launcherName = 'kubernetes' } = {}) {
  const resolved = resolveHelmBin(rootDir, { env });
  if (resolved) {
    return resolved.bin;
  }

  throw new Error(
    `[${launcherName}] Helm is not available. Set RIVET_K8S_HELM_BIN, install Helm on PATH, ` +
    'or run "npm run setup:k8s-tools" to install the pinned cached copy.',
  );
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

function parseChecksum(rawText) {
  const firstToken = rawText.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken || !/^[a-f0-9]{64}$/.test(firstToken)) {
    throw new Error(`Unexpected checksum file contents: ${rawText}`);
  }

  return firstToken;
}

function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function escapePowerShellLiteral(value) {
  return value.replace(/'/g, "''");
}

function extractArchive(archivePath, destinationDir, spec) {
  if (spec.extractKind === 'zip') {
    const extraction = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${escapePowerShellLiteral(archivePath)}' ` +
        `-DestinationPath '${escapePowerShellLiteral(destinationDir)}' -Force`,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (extraction.status !== 0) {
      throw new Error(extraction.stderr?.trim() || 'Failed to extract Helm zip archive with PowerShell.');
    }

    return;
  }

  const extraction = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (extraction.status !== 0) {
    throw new Error(extraction.stderr?.trim() || 'Failed to extract Helm tar.gz archive with tar.');
  }
}

export async function installCachedHelm(rootDir) {
  const spec = getHelmPlatformSpec();
  const cacheDir = getHelmCacheDirectory(rootDir);
  const archiveUrl = `${HELM_RELEASE_BASE_URL}/${spec.archiveName}`;
  const checksumUrl = `${archiveUrl}.sha256sum`;
  const cachedExecutable = getHelmCachedExecutablePath(rootDir);

  if (fileExists(cachedExecutable)) {
    return cachedExecutable;
  }

  ensureDirectory(cacheDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-helm-'));

  try {
    const archiveBuffer = await fetchBuffer(archiveUrl);
    const expectedChecksum = parseChecksum(await fetchText(checksumUrl));
    const actualChecksum = computeSha256(archiveBuffer);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Checksum mismatch for ${spec.archiveName}. Expected ${expectedChecksum}, received ${actualChecksum}.`,
      );
    }

    const archivePath = path.join(tempDir, spec.archiveName);
    fs.writeFileSync(archivePath, archiveBuffer);

    fs.rmSync(cacheDir, { recursive: true, force: true });
    ensureDirectory(cacheDir);
    extractArchive(archivePath, cacheDir, spec);

    if (!fileExists(cachedExecutable)) {
      throw new Error(`Cached Helm extraction did not produce ${cachedExecutable}.`);
    }

    if (process.platform !== 'win32') {
      fs.chmodSync(cachedExecutable, 0o755);
    }

    return cachedExecutable;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
