import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { minimatch } from 'minimatch';

import { getAppDataRoot, validatePath } from '../security.js';
import { badRequest } from '../utils/httpError.js';
import {
  readManagedHostedRelativeProject,
  readManagedHostedText,
} from './workflows/storage-backend.js';
import {
  isManagedRelativeVirtualPath,
  isManagedVirtualPath,
  listManagedVirtualDirectory,
  managedVirtualPathExists,
} from './workflows/managed-virtual-io.js';

export const SUPPORTED_NATIVE_BASE_DIRS = [
  'app',
  'appCache',
  'appConfig',
  'appData',
  'appLocalData',
  'appLog',
  'home',
  'temp',
] as const;

export type NativeBaseDir = (typeof SUPPORTED_NATIVE_BASE_DIRS)[number];

const getNativeBaseDirMap = (): Record<NativeBaseDir, string> => {
  const appDataRoot = getAppDataRoot();
  return {
    app: appDataRoot,
    appCache: path.join(appDataRoot, 'cache'),
    appConfig: path.join(appDataRoot, 'config'),
    appData: appDataRoot,
    appLocalData: appDataRoot,
    appLog: path.join(appDataRoot, 'logs'),
    home: os.homedir(),
    temp: os.tmpdir(),
  };
};

type ReadDirOptions = {
  recursive: boolean;
  includeDirectories: boolean;
  filterGlobs: string[];
  relative: boolean;
  ignores: string[];
};

type DirEntry = {
  path: string;
  name: string;
  isDirectory: boolean;
};

export function applyReadDirFilters(paths: string[], options: Pick<ReadDirOptions, 'filterGlobs' | 'ignores'>): string[] {
  let results = paths;

  for (const glob of options.filterGlobs) {
    results = results.filter((candidate) => minimatch(candidate, glob, { dot: true }));
  }

  for (const ignore of options.ignores) {
    results = results.filter((candidate) => !minimatch(candidate, ignore, { dot: true }));
  }

  return results;
}

export function resolveNativePath(inputPath: string, baseDir?: NativeBaseDir): string {
  if (!baseDir) {
    return validatePath(inputPath);
  }

  const base = getNativeBaseDirMap()[baseDir];
  if (!base) {
    throw badRequest(`Invalid baseDir: ${baseDir}`);
  }

  return validatePath(path.join(base, inputPath));
}

export async function listNativeDirectory(dirPath: string, baseDir: NativeBaseDir | undefined, options: ReadDirOptions): Promise<string[]> {
  if (isManagedVirtualPath(dirPath, baseDir)) {
    return listManagedVirtualDirectory(dirPath, options);
  }

  const safePath = resolveNativePath(dirPath, baseDir);
  const entries = await readDirRecursive(safePath, options.recursive);

  let results = entries
    .filter((entry) => options.includeDirectories ? true : !entry.isDirectory)
    .map((entry) => entry.path);

  results = applyReadDirFilters(results, options);

  if (options.relative) {
    results = results.map((candidate) => path.relative(safePath, candidate));
  }

  return results;
}

export async function readNativeText(filePath: string, baseDir?: NativeBaseDir): Promise<string> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    return readManagedHostedText(filePath);
  }

  return fs.readFile(resolveNativePath(filePath, baseDir), 'utf-8');
}

export async function readNativeBinary(filePath: string, baseDir?: NativeBaseDir): Promise<string> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    const contents = await readManagedHostedText(filePath);
    return Buffer.from(contents, 'utf8').toString('base64');
  }

  const buffer = await fs.readFile(resolveNativePath(filePath, baseDir));
  return buffer.toString('base64');
}

export async function writeNativeText(filePath: string, contents: string, baseDir?: NativeBaseDir): Promise<void> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    throw badRequest('Managed workflow projects must be saved via the project save API');
  }

  const safePath = resolveNativePath(filePath, baseDir);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, contents, 'utf-8');
}

export async function writeNativeBinary(filePath: string, contents: string, baseDir?: NativeBaseDir): Promise<void> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    throw badRequest('Managed workflow projects must be saved via the project save API');
  }

  const safePath = resolveNativePath(filePath, baseDir);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, Buffer.from(contents, 'base64'));
}

export async function nativePathExists(filePath: string, baseDir?: NativeBaseDir): Promise<boolean> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    return managedVirtualPathExists(filePath);
  }

  try {
    await fs.access(resolveNativePath(filePath, baseDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function mkdirNativePath(dirPath: string, recursive: boolean): Promise<void> {
  await fs.mkdir(resolveNativePath(dirPath), { recursive });
}

export async function removeNativeDirectory(dirPath: string, recursive: boolean): Promise<void> {
  await fs.rm(resolveNativePath(dirPath), { recursive, force: true });
}

export async function removeNativeFile(filePath: string, baseDir?: NativeBaseDir): Promise<void> {
  if (isManagedVirtualPath(filePath, baseDir)) {
    throw badRequest('Managed workflow files cannot be removed through native IO');
  }

  await fs.unlink(resolveNativePath(filePath, baseDir));
}

export async function readNativeRelative(relativeFrom: string, projectFilePath: string): Promise<string> {
  if (isManagedRelativeVirtualPath(relativeFrom)) {
    return readManagedHostedRelativeProject(relativeFrom, projectFilePath);
  }

  const fullPath = path.resolve(path.dirname(relativeFrom), projectFilePath);
  return fs.readFile(validatePath(fullPath), 'utf-8');
}

async function readDirRecursive(dirPath: string, recursive: boolean): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const items = await fs.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    entries.push({
      path: fullPath,
      name: item.name,
      isDirectory: item.isDirectory(),
    });

    if (recursive && item.isDirectory()) {
      entries.push(...await readDirRecursive(fullPath, true));
    }
  }

  return entries;
}
