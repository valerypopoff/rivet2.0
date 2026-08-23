import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  loadProjectAndAttachedDataFromFile,
  loadProjectAndAttachedDataFromString,
  loadProjectFromFile,
  serializeProject,
  type AttachedData,
  type Project,
} from '@valerypopoff/rivet2-node';
import type { WorkflowProjectDownloadVersion } from '../../../../shared/workflow-types.js';

import { validatePath } from '../../security.js';
import { conflict, createHttpError } from '../../utils/httpError.js';
import {
  createBlankProjectFile,
  deleteProjectWithSidecars,
  ensureWorkflowsRoot,
  listProjectPathsRecursive,
  moveProjectWithSidecars,
  pathExists,
  pathsDifferOnlyByCase,
  PROJECT_EXTENSION,
  renamePathHandlingCaseChange,
  requireProjectPath,
  resolveWorkflowRelativePath,
  sanitizeWorkflowName,
} from './fs-helpers.js';
import {
  createWorkflowPublicationStateHash,
  deletePublishedWorkflowSnapshot,
  ensureWorkflowEndpointNameIsUnique,
  getWorkflowProjectSettings,
  hasPublishedWorkflowLineage,
  normalizeWorkflowProjectSettingsDraft,
  readStoredWorkflowProjectSettings,
  resolvePublishedWorkflowProjectPath,
  writePublishedWorkflowSnapshot,
  writeStoredWorkflowProjectSettings,
} from './publication.js';
import {
  deleteWorkflowPublishedVersionsByProjectId,
  ensureCurrentPublishedWorkflowVersionMetadata,
  writePublishedWorkflowVersionMetadata,
} from './published-versions.js';
import { requireProjectMainGraphForEndpoint } from './main-graph.js';
import { normalizeHostedProjectTitle } from './hosted-project-contents.js';
import { getWorkflowDuplicateProjectName } from './workflow-project-naming.js';
import { deleteWorkflowRecordingsBySourceProjectPath, deleteWorkflowRecordingsByWorkflowId } from './recordings.js';
import { getWorkflowFolder, getWorkflowProject } from './workflow-query.js';
import type { WorkflowProjectPathMove } from './types.js';

async function getFolderProjectPathMoves(
  sourceFolderPath: string,
  targetFolderPath: string,
): Promise<WorkflowProjectPathMove[]> {
  const projectPaths = await listProjectPathsRecursive(sourceFolderPath);

  return projectPaths.map((projectPath) => ({
    fromAbsolutePath: projectPath,
    toAbsolutePath: validatePath(path.join(targetFolderPath, path.relative(sourceFolderPath, projectPath))),
  }));
}

export async function createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
  const folderName = sanitizeWorkflowName(name, 'folder name');
  const root = await ensureWorkflowsRoot();
  const parentFolderPath = resolveWorkflowRelativePath(root, parentRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const folderPath = validatePath(path.join(parentFolderPath, folderName));

  if (await pathExists(folderPath)) {
    throw conflict(`Folder already exists: ${folderName}`);
  }

  await fs.mkdir(folderPath, { recursive: false });
  return getWorkflowFolder(root, folderPath);
}

export async function renameWorkflowFolderItem(relativePath: unknown, newName: unknown) {
  const root = await ensureWorkflowsRoot();
  const currentFolderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });
  const sanitizedName = sanitizeWorkflowName(newName, 'new folder name');
  const renamedFolderPath = validatePath(path.join(path.dirname(currentFolderPath), sanitizedName));
  const isCaseOnlyRename = pathsDifferOnlyByCase(currentFolderPath, renamedFolderPath);
  const movedProjectPaths =
    renamedFolderPath === currentFolderPath
      ? []
      : await getFolderProjectPathMoves(currentFolderPath, renamedFolderPath);

  if (renamedFolderPath !== currentFolderPath && !isCaseOnlyRename && await pathExists(renamedFolderPath)) {
    throw conflict(`Folder already exists: ${sanitizedName}`);
  }

  await renamePathHandlingCaseChange(currentFolderPath, renamedFolderPath);

  return {
    folder: await getWorkflowFolder(root, renamedFolderPath),
    movedProjectPaths,
  };
}

export async function deleteWorkflowFolderItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: false,
  });

  const entries = await fs.readdir(folderPath);
  if (entries.length > 0) {
    throw conflict('Only empty folders can be deleted');
  }

  await fs.rmdir(folderPath);
}

export async function createWorkflowProjectItem(folderRelativePath: unknown, name: unknown) {
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, folderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  const projectName = sanitizeWorkflowName(name, 'project name');
  const fileName = `${projectName}${PROJECT_EXTENSION}`;
  const filePath = validatePath(path.join(folderPath, fileName));

  if (await pathExists(filePath)) {
    throw conflict(`Project already exists: ${fileName}`);
  }

  await fs.writeFile(filePath, createBlankProjectFile(projectName), 'utf8');
  return getWorkflowProject(root, filePath);
}

function getDuplicateWorkflowProjectPath(
  sourceProjectPath: string,
  sourceProjectName: string,
  version: WorkflowProjectDownloadVersion,
  sourceStatus: Awaited<ReturnType<typeof getWorkflowProjectSettings>>['status'],
  duplicateIndex: number,
): {
  duplicateProjectName: string;
  duplicateProjectPath: string;
} {
  const sourceFolderPath = path.dirname(sourceProjectPath);
  const duplicateProjectName = getWorkflowDuplicateProjectName(
    sourceProjectName,
    version,
    sourceStatus,
    duplicateIndex,
  );
  const duplicateProjectPath = validatePath(path.join(sourceFolderPath, `${duplicateProjectName}${PROJECT_EXTENSION}`));

  return {
    duplicateProjectName,
    duplicateProjectPath,
  };
}

function getUploadedWorkflowProjectBaseName(fileName: unknown): string {
  if (typeof fileName !== 'string') {
    throw createHttpError(400, 'Missing fileName');
  }

  const trimmedFileName = fileName.trim();
  if (!trimmedFileName) {
    throw createHttpError(400, 'Missing fileName');
  }

  const normalizedFileName = trimmedFileName.replace(/\\/g, '/').split('/').pop() ?? trimmedFileName;
  if (!normalizedFileName.toLowerCase().endsWith(PROJECT_EXTENSION)) {
    throw createHttpError(400, `Expected ${PROJECT_EXTENSION} file`);
  }

  return sanitizeWorkflowName(
    normalizedFileName.slice(0, -PROJECT_EXTENSION.length),
    'project file name',
  );
}

function getUploadedWorkflowProjectContents(contents: unknown): string {
  if (typeof contents !== 'string' || !contents.trim()) {
    throw createHttpError(400, 'Missing project contents');
  }

  return contents;
}

function getUploadedWorkflowProjectName(sourceProjectName: string, uploadIndex: number): string {
  return uploadIndex === 0
    ? sourceProjectName
    : `${sourceProjectName} ${uploadIndex}`;
}

function getUploadedWorkflowProjectPath(
  folderPath: string,
  sourceProjectName: string,
  uploadIndex: number,
): {
  uploadedProjectName: string;
  uploadedProjectPath: string;
} {
  const uploadedProjectName = getUploadedWorkflowProjectName(sourceProjectName, uploadIndex);
  const uploadedProjectPath = validatePath(path.join(folderPath, `${uploadedProjectName}${PROJECT_EXTENSION}`));

  return {
    uploadedProjectName,
    uploadedProjectPath,
  };
}

async function ensureWorkflowFolderExists(folderPath: string): Promise<void> {
  try {
    const folderStats = await fs.stat(folderPath);
    if (!folderStats.isDirectory()) {
      throw createHttpError(404, 'Folder not found');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Folder not found');
    }

    throw error;
  }
}

async function resolveDuplicateSourceProjectPath(
  root: string,
  projectPath: string,
  projectName: string,
  version: WorkflowProjectDownloadVersion,
): Promise<string> {
  if (version === 'live') {
    return projectPath;
  }

  const storedSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const publishedProjectPath = await resolvePublishedWorkflowProjectPath(root, projectPath, storedSettings);
  if (!publishedProjectPath) {
    throw conflict('Published version is not available for this project');
  }

  return publishedProjectPath;
}

async function writeUniqueProjectFile(options: {
  root: string;
  project: Project;
  attachedData: AttachedData | undefined;
  projectId: Project['metadata']['id'];
  getPathForIndex: (index: number) => { projectName: string; projectPath: string };
  invalidProjectMessage: string;
  notFoundMessage: string;
}): Promise<Awaited<ReturnType<typeof getWorkflowProject>>> {
  for (let index = 0; ; index += 1) {
    const { projectName, projectPath } = options.getPathForIndex(index);
    let serializedProject: string;

    try {
      options.project.metadata.id = options.projectId;
      options.project.metadata.title = projectName;

      const nextSerializedProject = serializeProject(options.project, options.attachedData);
      if (typeof nextSerializedProject !== 'string') {
        throw new Error('Project serialization did not return a string');
      }

      serializedProject = nextSerializedProject;
    } catch (error) {
      throw createHttpError(400, options.invalidProjectMessage);
    }

    try {
      await fs.writeFile(projectPath, serializedProject, { encoding: 'utf8', flag: 'wx' });
      return getWorkflowProject(options.root, projectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw createHttpError(404, options.notFoundMessage);
      }

      throw error;
    }
  }
}

export async function duplicateWorkflowProjectItem(
  relativePath: unknown,
  version: WorkflowProjectDownloadVersion = 'live',
) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);

  if (!await pathExists(projectPath)) {
    throw createHttpError(404, 'Project not found');
  }

  let sourceSettings: Awaited<ReturnType<typeof getWorkflowProjectSettings>>;
  try {
    sourceSettings = await getWorkflowProjectSettings(projectPath, projectName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw error;
  }

  let sourceProjectPath = projectPath;
  try {
    sourceProjectPath = await resolveDuplicateSourceProjectPath(root, projectPath, projectName, version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw error;
  }

  let project: Awaited<ReturnType<typeof loadProjectAndAttachedDataFromFile>>[0];
  let attachedData: Awaited<ReturnType<typeof loadProjectAndAttachedDataFromFile>>[1];

  try {
    [project, attachedData] = await loadProjectAndAttachedDataFromFile(sourceProjectPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw createHttpError(404, 'Project not found');
    }

    throw createHttpError(400, 'Could not duplicate project: invalid project file');
  }

  const duplicateProjectId = randomUUID() as typeof project.metadata.id;

  return writeUniqueProjectFile({
    root,
    project,
    attachedData,
    projectId: duplicateProjectId,
    getPathForIndex: (duplicateIndex) => {
      const result = getDuplicateWorkflowProjectPath(
        projectPath,
        projectName,
        version,
        sourceSettings.status,
        duplicateIndex,
      );

      return {
        projectName: result.duplicateProjectName,
        projectPath: result.duplicateProjectPath,
      };
    },
    invalidProjectMessage: 'Could not duplicate project: invalid project file',
    notFoundMessage: 'Project not found',
  });
}

export async function uploadWorkflowProjectItem(
  folderRelativePath: unknown,
  fileName: unknown,
  contents: unknown,
) {
  const root = await ensureWorkflowsRoot();
  const folderPath = resolveWorkflowRelativePath(root, folderRelativePath, {
    allowProjectFile: false,
    allowEmpty: true,
  });
  await ensureWorkflowFolderExists(folderPath);

  const uploadedProjectBaseName = getUploadedWorkflowProjectBaseName(fileName);
  const uploadedProjectContents = getUploadedWorkflowProjectContents(contents);

  let project: ReturnType<typeof loadProjectAndAttachedDataFromString>[0];
  let attachedData: ReturnType<typeof loadProjectAndAttachedDataFromString>[1];

  try {
    [project, attachedData] = loadProjectAndAttachedDataFromString(uploadedProjectContents);
  } catch (error) {
    throw createHttpError(400, 'Could not upload project: invalid project file');
  }

  const uploadedProjectId = randomUUID() as typeof project.metadata.id;

  return writeUniqueProjectFile({
    root,
    project,
    attachedData,
    projectId: uploadedProjectId,
    getPathForIndex: (uploadIndex) => {
      const result = getUploadedWorkflowProjectPath(folderPath, uploadedProjectBaseName, uploadIndex);
      return {
        projectName: result.uploadedProjectName,
        projectPath: result.uploadedProjectPath,
      };
    },
    invalidProjectMessage: 'Could not upload project: invalid project file',
    notFoundMessage: 'Folder not found',
  });
}

export async function renameWorkflowProjectItem(relativePath: unknown, newName: unknown) {
  const root = await ensureWorkflowsRoot();
  const currentProjectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = sanitizeWorkflowName(newName, 'new project name');
  const renamedProjectPath = validatePath(path.join(path.dirname(currentProjectPath), `${projectName}${PROJECT_EXTENSION}`));
  const isCaseOnlyRename = pathsDifferOnlyByCase(currentProjectPath, renamedProjectPath);

  if (renamedProjectPath !== currentProjectPath && !isCaseOnlyRename && await pathExists(renamedProjectPath)) {
    throw conflict(`Project already exists: ${path.basename(renamedProjectPath)}`);
  }

  const currentContents = await fs.readFile(currentProjectPath, 'utf8');
  const normalizedRenamedContents = normalizeHostedProjectTitle(
    currentContents,
    projectName,
    'Could not rename project: invalid project file',
  );

  await moveProjectWithSidecars(currentProjectPath, renamedProjectPath);
  await fs.writeFile(renamedProjectPath, normalizedRenamedContents.contents, 'utf8');

  return {
    project: await getWorkflowProject(root, renamedProjectPath),
    movedProjectPaths: [
      {
        fromAbsolutePath: currentProjectPath,
        toAbsolutePath: renamedProjectPath,
      },
    ],
  };
}

export async function publishWorkflowProjectItem(relativePath: unknown, settings: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));
  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  const normalizedSettings = normalizeWorkflowProjectSettingsDraft(settings);
  requireProjectMainGraphForEndpoint(await loadProjectFromFile(projectPath));
  await ensureWorkflowEndpointNameIsUnique(root, projectPath, normalizedSettings.endpointName);
  const publishedSnapshotId = randomUUID();
  const lastPublishedAt = new Date().toISOString();

  try {
    await ensureCurrentPublishedWorkflowVersionMetadata({
      root,
      projectPath,
      settings: existingSettings,
    });
    const publishedSnapshotPath = await writePublishedWorkflowSnapshot(root, projectPath, publishedSnapshotId);
    requireProjectMainGraphForEndpoint(await loadProjectFromFile(publishedSnapshotPath));
    const publishedStateHash = await createWorkflowPublicationStateHash(
      publishedSnapshotPath,
      normalizedSettings.endpointName,
    );
    await writePublishedWorkflowVersionMetadata({
      root,
      projectPath,
      snapshotId: publishedSnapshotId,
      endpointName: normalizedSettings.endpointName,
      stateHash: publishedStateHash,
      publishedAt: lastPublishedAt,
    });
    await writeStoredWorkflowProjectSettings(projectPath, {
      endpointName: normalizedSettings.endpointName,
      publishedEndpointName: normalizedSettings.endpointName,
      publishedSnapshotId,
      publishedStateHash,
      lastPublishedAt,
      publishedWebApps: existingSettings.publishedWebApps,
    });
  } catch (error) {
    await deletePublishedWorkflowSnapshot(root, publishedSnapshotId).catch(() => {});
    throw error;
  }

  return getWorkflowProject(root, projectPath);
}

export async function unpublishWorkflowProjectItem(relativePath: unknown) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  await ensureCurrentPublishedWorkflowVersionMetadata({
    root,
    projectPath,
    settings: existingSettings,
  });
  await writeStoredWorkflowProjectSettings(projectPath, {
    endpointName: existingSettings.endpointName,
    publishedEndpointName: '',
    publishedSnapshotId: null,
    publishedStateHash: null,
    lastPublishedAt: existingSettings.lastPublishedAt,
    publishedWebApps: existingSettings.publishedWebApps,
  });

  return getWorkflowProject(root, projectPath);
}

export async function deleteWorkflowProjectItem(
  relativePath: unknown,
  options: { beforeDelete?: (projectId: string | null) => Promise<void> } = {},
) {
  const root = await ensureWorkflowsRoot();
  const projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
    allowProjectFile: true,
  }));

  const projectName = path.basename(projectPath, PROJECT_EXTENSION);
  const existingSettings = await readStoredWorkflowProjectSettings(projectPath, projectName);
  if (
    existingSettings.publishedEndpointName ||
    hasPublishedWorkflowLineage(existingSettings) ||
    existingSettings.publishedWebApps.length > 0
  ) {
    throw conflict('Unpublish the workflow endpoint and web apps before deleting the project');
  }

  const projectMetadataId = await loadProjectFromFile(projectPath)
    .then((project) => project.metadata.id ?? null)
    .catch(() => null);
  await options.beforeDelete?.(projectMetadataId);
  await deletePublishedWorkflowSnapshot(root, existingSettings.publishedSnapshotId);
  await Promise.all(existingSettings.publishedWebApps.map((webApp) =>
    deletePublishedWorkflowSnapshot(root, webApp.publishedSnapshotId).catch(() => {})));
  await deleteWorkflowPublishedVersionsByProjectId(root, projectMetadataId);
  await deleteProjectWithSidecars(projectPath);
  await deleteWorkflowRecordingsByWorkflowId(root, projectMetadataId);
  await deleteWorkflowRecordingsBySourceProjectPath(root, projectPath);

  return projectMetadataId;
}
