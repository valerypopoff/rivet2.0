import type { WorkflowFolderItem } from '../../../../studio-server-shared/workflow-types.js';
import {
  WORKFLOW_DATASET_EXTENSION,
  WORKFLOW_PROJECT_EXTENSION,
  getManagedWorkflowVirtualDatasetPath,
} from '../../../../studio-server-shared/workflow-types.js';
import { minimatch } from 'minimatch';
import { badRequest, createHttpError } from '../../utils/httpError.js';
import { getWorkflowTree, managedHostedPathExists } from './storage-backend.js';
import { getManagedWorkflowVirtualRoot, isManagedWorkflowVirtualReference } from './virtual-paths.js';
import { isManagedWorkflowStorageEnabled } from './storage-config.js';
import { getLocalMetadataServingSelection } from '../../local-metadata/serving-selection.js';
import path from 'node:path';

function virtualRoot(): string {
  return getLocalMetadataServingSelection()?.source.workflows.replaceAll('\\', '/') ?? getManagedWorkflowVirtualRoot();
}
function isCatalogReference(value: string): boolean {
  const local = getLocalMetadataServingSelection();
  if (!local) return isManagedWorkflowStorageEnabled() && isManagedWorkflowVirtualReference(value);
  const relative = path.relative(local.source.workflows, path.resolve(value));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export type ManagedVirtualReadDirOptions = {
  recursive: boolean;
  includeDirectories: boolean;
  filterGlobs: string[];
  relative: boolean;
  ignores: string[];
};

type ManagedVirtualEntry = {
  path: string;
  isDirectory: boolean;
};

function applyReadDirFilters(
  paths: string[],
  options: Pick<ManagedVirtualReadDirOptions, 'filterGlobs' | 'ignores'>,
): string[] {
  let results = paths;

  for (const glob of options.filterGlobs) {
    results = results.filter((candidate) => minimatch(candidate, glob, { dot: true }));
  }

  for (const ignore of options.ignores) {
    results = results.filter((candidate) => !minimatch(candidate, ignore, { dot: true }));
  }

  return results;
}

export function normalizeManagedVirtualPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || virtualRoot();
}

export function isManagedVirtualPath(filePath: string, baseDir?: string): boolean {
  return !baseDir && isCatalogReference(filePath);
}

export function isManagedRelativeVirtualPath(relativeFrom: string): boolean {
  return isCatalogReference(relativeFrom);
}

async function listManagedVirtualEntries(): Promise<ManagedVirtualEntry[]> {
  const tree = await getWorkflowTree();
  const entries: ManagedVirtualEntry[] = [
    {
      path: virtualRoot(),
      isDirectory: true,
    },
  ];
  const projectPaths: string[] = [];

  const visitFolders = (folders: WorkflowFolderItem[]) => {
    for (const folder of folders) {
      entries.push({
        path: normalizeManagedVirtualPath(folder.absolutePath),
        isDirectory: true,
      });
      projectPaths.push(
        ...folder.projects.map((project: { absolutePath: string }) =>
          normalizeManagedVirtualPath(project.absolutePath),
        ),
      );
      visitFolders(folder.folders);
    }
  };

  projectPaths.push(
    ...tree.projects.map((project: { absolutePath: string }) => normalizeManagedVirtualPath(project.absolutePath)),
  );
  visitFolders(tree.folders);

  for (const projectPath of projectPaths) {
    entries.push({
      path: projectPath,
      isDirectory: false,
    });
  }

  const datasetEntries: ManagedVirtualEntry[] = [];
  for (const projectPath of projectPaths) {
    const datasetPath = getManagedWorkflowVirtualDatasetPath(projectPath);
    if (!datasetPath || !(await managedHostedPathExists(datasetPath))) {
      continue;
    }

    datasetEntries.push({
      path: normalizeManagedVirtualPath(datasetPath),
      isDirectory: false,
    });
  }

  entries.push(...datasetEntries);

  return entries
    .sort((left, right) => left.path.localeCompare(right.path))
    .filter((entry, index, all) => index === 0 || entry.path !== all[index - 1]!.path);
}

export async function listManagedVirtualDirectory(
  dirPath: string,
  options: ManagedVirtualReadDirOptions,
): Promise<string[]> {
  const root = virtualRoot();
  const normalizedDirPath = normalizeManagedVirtualPath(dirPath);
  const entries = await listManagedVirtualEntries();

  if (normalizedDirPath !== root) {
    const targetEntry = entries.find((entry) => entry.path === normalizedDirPath);
    if (!targetEntry) {
      throw createHttpError(404, 'Directory not found');
    }

    if (!targetEntry.isDirectory) {
      throw badRequest('Path is not a directory');
    }
  }

  const prefix = normalizedDirPath === root ? `${root}/` : `${normalizedDirPath}/`;
  let results = entries
    .filter((entry) => entry.path !== normalizedDirPath && entry.path.startsWith(prefix))
    .filter((entry) => options.recursive || !entry.path.slice(prefix.length).includes('/'));

  if (!options.includeDirectories) {
    results = results.filter((entry) => !entry.isDirectory);
  }

  const filteredPaths = applyReadDirFilters(
    results.map((entry) => entry.path),
    options,
  );

  return filteredPaths
    .map((entryPath) => (options.relative ? entryPath.slice(prefix.length) : entryPath))
    .sort((left, right) => left.localeCompare(right));
}

export async function managedVirtualPathExists(filePath: string): Promise<boolean> {
  const normalizedPath = normalizeManagedVirtualPath(filePath);
  if (normalizedPath === virtualRoot()) {
    return true;
  }

  if (normalizedPath.endsWith(WORKFLOW_PROJECT_EXTENSION) || normalizedPath.endsWith(WORKFLOW_DATASET_EXTENSION)) {
    return managedHostedPathExists(normalizedPath);
  }

  const entries = await listManagedVirtualEntries();
  return entries.some((entry) => entry.path === normalizedPath);
}
