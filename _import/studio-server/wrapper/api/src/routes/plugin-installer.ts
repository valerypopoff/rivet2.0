import fs from 'node:fs/promises';
import path from 'node:path';

import { getAppDataRoot, validatePath } from '../security.js';
import { badRequest, createHttpError, type HttpError } from '../utils/httpError.js';
import { exec } from '../utils/exec.js';

const pluginPackagePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const pluginTagPattern = /^(?![./])(?!.*[\\/])[\w.-]{1,128}$/;
const pluginPreparationPromises = new Map<string, Promise<void>>();

export function normalizePluginPackageName(value: string): string {
  const trimmed = value.trim();
  if (!pluginPackagePattern.test(trimmed)) {
    throw badRequest('Invalid plugin package name');
  }

  return trimmed;
}

export function normalizePluginTag(value: string): string {
  const trimmed = value.trim();
  if (!pluginTagPattern.test(trimmed)) {
    throw badRequest('Invalid plugin tag');
  }

  return trimmed;
}

export function getPluginRegistryMetadataUrl(pkg: string, tag: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${encodeURIComponent(tag)}`;
}

export function getPluginDir(pkg: string, tag: string): string {
  const packageName = normalizePluginPackageName(pkg);
  const packageTag = normalizePluginTag(tag);
  return path.join(getAppDataRoot(), 'plugins', `${packageName.replace('/', '__')}-${packageTag}`);
}

export function validatePluginPackagePath(pluginFilesPath: string, candidatePath: string): string {
  const resolvedPluginRoot = path.resolve(pluginFilesPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const isInsidePluginRoot = process.platform === 'win32'
    ? resolvedCandidate.toLowerCase() === resolvedPluginRoot.toLowerCase() || resolvedCandidate.toLowerCase().startsWith(`${resolvedPluginRoot.toLowerCase()}${path.sep}`)
    : resolvedCandidate === resolvedPluginRoot || resolvedCandidate.startsWith(`${resolvedPluginRoot}${path.sep}`);

  if (!isInsidePluginRoot) {
    throw badRequest('Plugin main field must resolve inside the extracted package');
  }

  return validatePath(resolvedCandidate);
}

export async function checkPluginForUpdate(pkg: string, tag: string, addLog: (msg: string) => void): Promise<boolean> {
  const packageName = normalizePluginPackageName(pkg);
  const packageTag = normalizePluginTag(tag);
  const pluginDir = getPluginDir(packageName, packageTag);
  const pluginFilesPath = path.join(pluginDir, 'package');
  const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
  const completedVersionFile = path.join(pluginFilesPath, '.install_complete_version');

  try {
    await fs.access(pluginFilesPath);
  } catch {
    return true;
  }

  try {
    await fs.access(path.join(pluginFilesPath, '.git'));
    addLog(`Plugin is a git repository, skipping reinstall: ${packageName}@${packageTag}`);
    return false;
  } catch {
    // not a git checkout
  }

  addLog(`Checking for plugin updates: ${packageName}@${packageTag}`);

  try {
    const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8')) as {
      version?: string;
      rivet?: { skipInstall?: boolean };
    };
    const npmResp = await fetch(getPluginRegistryMetadataUrl(packageName, packageTag));
    if (!npmResp.ok) {
      return true;
    }

    const npmData = await npmResp.json() as { version?: string };
    if (npmData.version !== pkgJsonData.version) {
      addLog(`Plugin update available: ${pkgJsonData.version ?? '(unknown)'} -> ${npmData.version ?? '(unknown)'}`);
      return true;
    }

    if (!pkgJsonData.rivet?.skipInstall) {
      await fs.access(path.join(pluginFilesPath, 'node_modules'));
    }
    const versionMarker = await fs.readFile(completedVersionFile, 'utf-8');
    return versionMarker.trim() !== packageTag;
  } catch {
    return true;
  }
}

export async function ensurePluginReady(pkg: string, tag: string, addLog: (msg: string) => void): Promise<void> {
  const packageName = normalizePluginPackageName(pkg);
  const packageTag = normalizePluginTag(tag);
  const preparationKey = `${packageName}@${packageTag}`;
  const existingPreparation = pluginPreparationPromises.get(preparationKey);
  if (existingPreparation) {
    addLog(`Waiting for plugin preparation already in progress: ${preparationKey}`);
    await existingPreparation;
    return;
  }

  const preparation = (async () => {
    if (await checkPluginForUpdate(packageName, packageTag, addLog)) {
      await downloadAndExtractPlugin(packageName, packageTag, addLog);
    }
  })();
  pluginPreparationPromises.set(preparationKey, preparation);
  try {
    await preparation;
  } finally {
    if (pluginPreparationPromises.get(preparationKey) === preparation) {
      pluginPreparationPromises.delete(preparationKey);
    }
  }
}

export async function downloadAndExtractPlugin(pkg: string, tag: string, addLog: (msg: string) => void): Promise<void> {
  const packageName = normalizePluginPackageName(pkg);
  const packageTag = normalizePluginTag(tag);
  const pluginDir = getPluginDir(packageName, packageTag);
  const pluginFilesPath = path.join(pluginDir, 'package');

  await fs.rm(pluginDir, { recursive: true, force: true });
  addLog(`Downloading plugin from NPM: ${packageName}@${packageTag}`);

  const npmResp = await fetch(getPluginRegistryMetadataUrl(packageName, packageTag));
  if (!npmResp.ok) {
    throw badRequest(`Plugin not found on NPM: ${packageName}@${packageTag}`);
  }

  const npmData = await npmResp.json() as { dist?: { tarball?: string } };
  const tarballUrl = npmData.dist?.tarball;
  if (!tarballUrl) {
    throw badRequest(`No tarball URL for plugin: ${packageName}@${packageTag}`);
  }

  addLog(`Downloading tarball: ${tarballUrl}`);
  const tarballResp = await fetch(tarballUrl);
  if (!tarballResp.ok) {
    throw badRequest(`Failed to download tarball: ${tarballUrl}`);
  }

  const tarballBuffer = Buffer.from(await tarballResp.arrayBuffer());
  await fs.mkdir(pluginDir, { recursive: true });
  const tarPath = path.join(pluginDir, 'package.tgz');
  await fs.writeFile(tarPath, tarballBuffer);

  addLog('Extracting tarball...');
  const tar = await import('tar');
  await tar.extract({
    file: tarPath,
    cwd: pluginDir,
  });

  const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
  let hasPackageJson = true;
  let skipInstall = false;
  try {
    const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8')) as { rivet?: { skipInstall?: boolean } };
    skipInstall = Boolean(pkgJsonData?.rivet?.skipInstall);
  } catch {
    hasPackageJson = false;
    addLog('No package.json found or install skipped');
  }

  if (hasPackageJson && !skipInstall) {
    addLog('Installing NPM dependencies...');
    const installResult = await exec('pnpm', ['install', '--prod', '--ignore-scripts'], {
      cwd: pluginFilesPath,
      timeoutMs: 120_000,
    });

    if (installResult.code !== 0) {
      throw new Error(`${installResult.stderr}\n${installResult.stdout}`.trim());
    }

    addLog('Installed NPM dependencies');
  } else if (hasPackageJson) {
    addLog('Skipping NPM dependencies install');
  }

  await fs.writeFile(path.join(pluginFilesPath, '.install_complete_version'), packageTag, 'utf-8');
}

export function appendInstallLog(error: unknown, log: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const formatted = `${log}${message}`.trim();
  const status = (error as Partial<HttpError>)?.status;

  if (typeof status === 'number') {
    return createHttpError(status, formatted);
  }

  return createHttpError(400, formatted);
}
