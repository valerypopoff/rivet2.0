import fs from 'node:fs/promises';
import path from 'node:path';

import { validatePath } from '../../security.js';
import { badRequest, conflict } from '../../utils/httpError.js';
import {
  listProjectPathsRecursive,
  moveProjectWithSidecars,
  pathExists,
  PROJECT_EXTENSION,
  renamePathHandlingCaseChange,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import { getWorkflowProjectIndexDataFromFileCached } from './project-stats.js';
import { getWorkflowProjectSettings } from './publication.js';
import type { WorkflowFolderItem, WorkflowProjectItem, WorkflowProjectPathMove } from './types.js';

export async function listWorkflowFolders(root: string): Promise<WorkflowFolderItem[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowFolder(root, path.join(root, entry.name))),
  );
}

export async function listWorkflowProjects(root: string): Promise<WorkflowProjectItem[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowProject(root, path.join(root, entry.name))),
  );
}

export async function getWorkflowFolder(root: string, folderPath: string): Promise<WorkflowFolderItem> {
  const stats = await fs.stat(folderPath);
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowFolder(root, path.join(folderPath, entry.name))),
  );
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_EXTENSION))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => getWorkflowProject(root, path.join(folderPath, entry.name))),
  );

  return {
    id: path.relative(root, folderPath).replace(/\\/g, '/'),
    name: path.basename(folderPath),
    relativePath: path.relative(root, folderPath).replace(/\\/g, '/'),
    absolutePath: folderPath,
    updatedAt: stats.mtime.toISOString(),
    folders,
    projects,
  };
}

export async function getWorkflowProject(
  root: string,
  filePath: string,
  options: {
    includeAggregatePublicationStatus?: boolean;
    includeStats?: boolean;
  } = {},
): Promise<WorkflowProjectItem> {
  const stats = await fs.stat(filePath);
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  const projectName = fileName.slice(0, -PROJECT_EXTENSION.length);
  const settings = await getWorkflowProjectSettings(filePath, projectName, {
    includeAggregatePublicationStatus: options.includeAggregatePublicationStatus,
    root,
  });
  const projectIndexData = await getWorkflowProjectIndexDataFromFileCached(filePath);

  return {
    id: relativePath,
    ...(projectIndexData.projectMetadataId ? { projectMetadataId: projectIndexData.projectMetadataId } : {}),
    name: projectName,
    fileName,
    relativePath,
    absolutePath: filePath,
    updatedAt: stats.mtime.toISOString(),
    settings,
    ...(options.includeStats === false ? {} : { stats: projectIndexData.stats }),
  };
}

export async function moveWorkflowProject(
  root: string,
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
  const sourceProjectPath = requireProjectPath(resolveWorkflowRelativePath(root, sourceRelativePath, {
    allowProjectFile: true,
  }));
  const destinationFolderPath = resolveWorkflowRelativePath(root, destinationFolderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });

  const targetProjectPath = validatePath(path.join(destinationFolderPath, path.basename(sourceProjectPath)));
  if (targetProjectPath === sourceProjectPath) {
    return {
      project: await getWorkflowProject(root, sourceProjectPath),
      movedProjectPaths: [],
    };
  }

  if (await pathExists(targetProjectPath)) {
    throw conflict(`Project already exists: ${path.basename(targetProjectPath)}`);
  }
  await moveProjectWithSidecars(sourceProjectPath, targetProjectPath);

  return {
    project: await getWorkflowProject(root, targetProjectPath),
    movedProjectPaths: [
      {
        fromAbsolutePath: sourceProjectPath,
        toAbsolutePath: targetProjectPath,
      },
    ] satisfies WorkflowProjectPathMove[],
  };
}

export async function moveWorkflowFolder(
  root: string,
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
  const sourceFolderPath = resolveWorkflowRelativePath(root, sourceRelativePath, {
    allowProjectFile: false,
  });
  const destinationFolderPath = resolveWorkflowRelativePath(root, destinationFolderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });

  if (destinationFolderPath === sourceFolderPath || destinationFolderPath.startsWith(`${sourceFolderPath}${path.sep}`)) {
    throw badRequest('Cannot move a folder into itself');
  }

  const targetFolderPath = validatePath(path.join(destinationFolderPath, path.basename(sourceFolderPath)));
  if (targetFolderPath === sourceFolderPath) {
    return {
      folder: await getWorkflowFolder(root, sourceFolderPath),
      movedProjectPaths: [],
    };
  }

  if (await pathExists(targetFolderPath)) {
    throw conflict(`Folder already exists: ${path.basename(targetFolderPath)}`);
  }

  const movedProjectPaths = await getFolderProjectPathMoves(sourceFolderPath, targetFolderPath);
  await renamePathHandlingCaseChange(sourceFolderPath, targetFolderPath);

  return {
    folder: await getWorkflowFolder(root, targetFolderPath),
    movedProjectPaths,
  };
}

async function getFolderProjectPathMoves(sourceFolderPath: string, targetFolderPath: string): Promise<WorkflowProjectPathMove[]> {
  const projectPaths = await listProjectPathsRecursive(sourceFolderPath);
  return projectPaths.map((projectPath) => ({
    fromAbsolutePath: projectPath,
    toAbsolutePath: validatePath(path.join(targetFolderPath, path.relative(sourceFolderPath, projectPath))),
  }));
}
