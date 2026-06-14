import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProjectAndAttachedDataFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../shared/workflow-types.js';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
} from '../../../../shared/workflow-recording-types.js';
import { getWorkflowsRoot } from '../../security.js';
import { createHttpError } from '../../utils/httpError.js';
import { getManagedWorkflowStorageConfig, getWorkflowStorageBackendMode, isManagedWorkflowStorageEnabled } from './storage-config.js';
import { ManagedWorkflowBackend } from './managed/backend.js';
import {
  ensureWorkflowsRoot,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import { listWorkflowFolders, listWorkflowProjects, moveWorkflowFolder, moveWorkflowProject } from './workflow-query.js';
import {
  createWorkflowFolderItem,
  createWorkflowProjectItem,
  deleteWorkflowFolderItem,
  deleteWorkflowProjectItem,
  duplicateWorkflowProjectItem,
  publishWorkflowProjectItem,
  renameWorkflowFolderItem,
  renameWorkflowProjectItem,
  uploadWorkflowProjectItem,
  unpublishWorkflowProjectItem,
} from './workflow-mutations.js';
import { readWorkflowProjectDownload } from './workflow-download.js';
import {
  listWorkflowPublishedVersions,
  readWorkflowPublishedVersionDownload,
  readWorkflowPublishedVersionPreview,
  restoreWorkflowPublishedVersion,
  setWorkflowPublishedVersionComment,
  setWorkflowPublishedVersionStar,
} from './published-versions.js';
import {
  deleteWorkflowRecording,
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  listWorkflowRecordingWorkflows,
  persistWorkflowExecutionRecording,
  readWorkflowRecordingArtifact,
} from './recordings.js';
import { createPublishedWorkflowProjectReferenceLoader } from './publication.js';
import { NodeDatasetProvider } from '@valerypopoff/rivet2-node';
import type { AttachedData, Project, CombinedDataset } from '@valerypopoff/rivet2-node';
import { getFilesystemExecutionCache } from './filesystem-execution-cache.js';
import { normalizeHostedProjectTitle } from './hosted-project-contents.js';
import { writeWorkflowProjectStatsCacheFromContents } from './project-stats.js';

function mapHostedProjectFilesystemError(
  error: unknown,
  operation: 'read' | 'write',
  projectPath: string,
): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== 'EACCES' && code !== 'EPERM') {
    return error instanceof Error ? error : new Error(String(error));
  }

  const targetDir = path.dirname(projectPath).replace(/\\/g, '/');
  return createHttpError(
    500,
    operation === 'write'
      ? `Workflow storage is not writable. Check server permissions for ${targetDir}.`
      : `Workflow storage is not readable. Check server permissions for ${targetDir}.`,
    { expose: true },
  );
}

type SaveHostedProjectResult = {
  path: string;
  revisionId: string | null;
  project: WorkflowProjectItem | null;
  created: boolean;
};

type LoadHostedProjectResult = {
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
};

type ExecutionProjectResult = {
  project: Project;
  attachedData: AttachedData;
  datasetProvider: NodeDatasetProvider;
  projectVirtualPath: string;
  debug?: {
    cacheStatus: 'hit' | 'miss' | 'bypass';
    resolveMs: number;
    materializeMs: number;
  };
};

let managedBackendPromise: Promise<ManagedWorkflowBackend> | null = null;

async function getManagedBackend(): Promise<ManagedWorkflowBackend> {
  if (!managedBackendPromise) {
    managedBackendPromise = (async () => {
      const backend = new ManagedWorkflowBackend(getManagedWorkflowStorageConfig());
      await backend.initialize();
      return backend;
    })().catch((error) => {
      managedBackendPromise = null;
      throw error;
    });
  }

  return managedBackendPromise;
}

async function delegate<T>(
  managedFn: (backend: ManagedWorkflowBackend) => Promise<T>,
  fsFn: () => Promise<T>,
): Promise<T> {
  if (isManagedWorkflowStorageEnabled()) {
    const backend = await getManagedBackend();
    return managedFn(backend);
  }

  return fsFn();
}

async function delegateWithWorkflowsRoot<T>(
  managedFn: (backend: ManagedWorkflowBackend) => Promise<T>,
  fsFn: (root: string) => Promise<T>,
): Promise<T> {
  return delegate(managedFn, async () => fsFn(await ensureWorkflowsRoot()));
}

async function loadFilesystemExecutionProjectWithMissingRootRetry(
  load: (root: string) => Promise<ExecutionProjectResult | null>,
): Promise<ExecutionProjectResult | null> {
  const root = getWorkflowsRoot();

  try {
    return await load(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    if (await pathExists(root)) {
      throw error;
    }

    const ensuredRoot = await ensureWorkflowsRoot();
    getFilesystemExecutionCache().reset(ensuredRoot);
    return load(ensuredRoot);
  }
}

function invalidateFilesystemExecutionMaterializations(projectPaths: Iterable<string>): void {
  getFilesystemExecutionCache().invalidateProjectMaterializations(projectPaths);
}

function markFilesystemExecutionStructureDirty(projectPathsToInvalidate: Iterable<string> = []): void {
  const cache = getFilesystemExecutionCache();
  cache.markIndexDirty();
  cache.invalidateProjectMaterializations(projectPathsToInvalidate);
}

function invalidateFilesystemExecutionMove(movedProjectPaths: WorkflowProjectPathMove[]): void {
  if (movedProjectPaths.length === 0) {
    return;
  }

  markFilesystemExecutionStructureDirty(
    movedProjectPaths.flatMap(({ fromAbsolutePath, toAbsolutePath }) => [fromAbsolutePath, toAbsolutePath]),
  );
}

export async function initializeWorkflowStorage(): Promise<void> {
  await delegate(
    async () => {
      await getManagedBackend();
    },
    async () => {
      const root = await ensureWorkflowsRoot();
      await getFilesystemExecutionCache().initialize(root);
      await initializeWorkflowRecordingStorage(root);
    },
  );
}

export async function getWorkflowTree() {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.getTree(),
    async (root) => ({
      root,
      folders: await listWorkflowFolders(root),
      projects: await listWorkflowProjects(root),
    }),
  );
}

export async function listHostedProjectPaths(): Promise<string[]> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listProjectPathsForHostedIo(),
    async (root) => {
      const projects = await listWorkflowProjects(root);
      const folders = await listWorkflowFolders(root);
      const nestedProjects = folders.flatMap(function flatten(folder): WorkflowProjectItem[] {
        return [...folder.projects, ...folder.folders.flatMap(flatten)];
      });
      return [...projects, ...nestedProjects].map((project) => project.absolutePath);
    },
  );
}

export async function loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
  return delegate<LoadHostedProjectResult>(
    async (backend) => backend.loadHostedProject(projectPath),
    async () => {
      try {
        const [project, attachedData] = await loadProjectAndAttachedDataFromFile(projectPath);
        void project;
        void attachedData;
        const datasetPath = getWorkflowDatasetPath(projectPath);
        const datasetsContents = await pathExists(datasetPath) ? await fs.readFile(datasetPath, 'utf8') : null;

        return {
          contents: await fs.readFile(projectPath, 'utf8'),
          datasetsContents,
          revisionId: null,
        };
      } catch (error) {
        throw mapHostedProjectFilesystemError(error, 'read', projectPath);
      }
    },
  );
}

export async function saveHostedProject(options: {
  projectPath: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId?: string | null;
}): Promise<SaveHostedProjectResult> {
  return delegate<SaveHostedProjectResult>(
    async (backend) => backend.saveHostedProject(options),
    async () => {
      try {
        const projectName = path.basename(options.projectPath, PROJECT_EXTENSION);
        const normalized = normalizeHostedProjectTitle(
          options.contents,
          projectName,
          'Could not save project',
        );

        await fs.mkdir(path.dirname(options.projectPath), { recursive: true });
        await fs.writeFile(options.projectPath, normalized.contents, 'utf8');
        await writeWorkflowProjectStatsCacheFromContents(options.projectPath, normalized.contents);

        const datasetPath = getWorkflowDatasetPath(options.projectPath);
        if (options.datasetsContents != null) {
          await fs.writeFile(datasetPath, options.datasetsContents, 'utf8');
        } else {
          await fs.rm(datasetPath, { force: true }).catch(() => {});
        }

        invalidateFilesystemExecutionMaterializations([options.projectPath]);

        return {
          path: options.projectPath,
          revisionId: null,
          project: null,
          created: false,
        };
      } catch (error) {
        throw mapHostedProjectFilesystemError(error, 'write', options.projectPath);
      }
    },
  );
}

export async function readManagedHostedText(filePath: string): Promise<string> {
  if (!isManagedWorkflowStorageEnabled()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getManagedBackend()).readHostedText(filePath);
}

export async function managedHostedPathExists(filePath: string): Promise<boolean> {
  if (!isManagedWorkflowStorageEnabled()) {
    return false;
  }

  return (await getManagedBackend()).hostedPathExists(filePath);
}

export async function readManagedHostedRelativeProject(relativeFrom: string, projectFilePath: string): Promise<string> {
  if (!isManagedWorkflowStorageEnabled()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getManagedBackend()).resolveManagedRelativeProjectText(relativeFrom, projectFilePath);
}

export async function listWorkflowRecordingWorkflowsWithBackend(): Promise<WorkflowRecordingWorkflowListResponse> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listWorkflowRecordingWorkflows(),
    async (root) => listWorkflowRecordingWorkflows(root),
  );
}

export async function listWorkflowRecordingRunsPageWithBackend(
  workflowId: string,
  page: number,
  pageSize: number,
  statusFilter: WorkflowRecordingFilterStatus,
  inputFilter: WorkflowRecordingInputFilter | null = null,
  inputCursor = 0,
  signal?: AbortSignal,
): Promise<WorkflowRecordingRunsPageResponse> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listWorkflowRecordingRunsPage(
      workflowId,
      page,
      pageSize,
      statusFilter,
      inputFilter,
      inputCursor,
      signal,
    ),
    async (root) => listWorkflowRecordingRunsPage(
      root,
      workflowId,
      page,
      pageSize,
      statusFilter,
      inputFilter,
      inputCursor,
      signal,
    ),
  );
}

export async function readWorkflowRecordingArtifactWithBackend(recordingId: string, artifact: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.readWorkflowRecordingArtifact(recordingId, artifact),
    async (root) => readWorkflowRecordingArtifact(root, recordingId, artifact),
  );
}

export async function deleteWorkflowRecordingWithBackend(recordingId: string): Promise<void> {
  await delegateWithWorkflowsRoot(
    async (backend) => backend.deleteWorkflowRecording(recordingId),
    async (root) => deleteWorkflowRecording(root, recordingId),
  );
}

export async function moveWorkflowItemWithBackend(
  itemType: 'project' | 'folder',
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{ folder?: WorkflowFolderItem; project?: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
  return delegateWithWorkflowsRoot(
    async (backend) => itemType === 'project'
      ? backend.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
      : backend.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath),
    async (root) => {
      const result = itemType === 'project'
        ? await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath)
        : await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath);

      invalidateFilesystemExecutionMove(result.movedProjectPaths);

      return result;
    },
  );
}

export async function createWorkflowFolderItemWithBackend(name: unknown, parentRelativePath: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowFolderItem(name, parentRelativePath),
    async () => createWorkflowFolderItem(name, parentRelativePath),
  );
}

export async function renameWorkflowFolderItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowFolderItem(relativePath, newName),
    async () => {
      const result = await renameWorkflowFolderItem(relativePath, newName);
      invalidateFilesystemExecutionMove(result.movedProjectPaths);

      return result;
    },
  );
}

export async function deleteWorkflowFolderItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowFolderItem(relativePath),
    async () => deleteWorkflowFolderItem(relativePath),
  );
}

export async function createWorkflowProjectItemWithBackend(folderRelativePath: unknown, name: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowProjectItem(folderRelativePath, name),
    async () => {
      const project = await createWorkflowProjectItem(folderRelativePath, name);
      markFilesystemExecutionStructureDirty();
      return project;
    },
  );
}

export async function renameWorkflowProjectItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowProjectItem(relativePath, newName),
    async () => {
      const result = await renameWorkflowProjectItem(relativePath, newName);
      invalidateFilesystemExecutionMove(result.movedProjectPaths);
      return result;
    },
  );
}

export async function duplicateWorkflowProjectItemWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  return delegate(
    async (backend) => backend.duplicateWorkflowProjectItem(relativePath, version),
    async () => {
      const project = await duplicateWorkflowProjectItem(relativePath, version);
      markFilesystemExecutionStructureDirty();
      return project;
    },
  );
}

export async function uploadWorkflowProjectItemWithBackend(folderRelativePath: unknown, fileName: unknown, contents: unknown) {
  return delegate(
    async (backend) => backend.uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
    async () => {
      const project = await uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
      markFilesystemExecutionStructureDirty();
      return project;
    },
  );
}

export async function readWorkflowProjectDownloadWithBackend(relativePath: unknown, version: WorkflowProjectDownloadVersion) {
  return delegate(
    async (backend) => backend.readWorkflowProjectDownload(relativePath, version),
    async () => readWorkflowProjectDownload(relativePath, version),
  );
}

export async function listWorkflowPublishedVersionsWithBackend(
  relativePath: unknown,
): Promise<WorkflowPublishedVersionsResponse> {
  return delegate(
    async (backend) => backend.listWorkflowPublishedVersions(relativePath),
    async () => listWorkflowPublishedVersions(relativePath),
  );
}

export async function readWorkflowPublishedVersionDownloadWithBackend(relativePath: unknown, versionId: unknown) {
  return delegate(
    async (backend) => backend.readWorkflowPublishedVersionDownload(relativePath, versionId),
    async () => readWorkflowPublishedVersionDownload(relativePath, versionId),
  );
}

export async function readWorkflowPublishedVersionPreviewWithBackend(relativePath: unknown, versionId: unknown) {
  return delegate(
    async (backend) => backend.readWorkflowPublishedVersionPreview(relativePath, versionId),
    async () => readWorkflowPublishedVersionPreview(relativePath, versionId),
  );
}

export async function setWorkflowPublishedVersionStarWithBackend(
  relativePath: unknown,
  versionId: unknown,
  isStarred: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  return delegate(
    async (backend) => backend.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred),
    async () => setWorkflowPublishedVersionStar(relativePath, versionId, isStarred),
  );
}

export async function setWorkflowPublishedVersionCommentWithBackend(
  relativePath: unknown,
  versionId: unknown,
  comment: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  return delegate(
    async (backend) => backend.setWorkflowPublishedVersionComment(relativePath, versionId, comment),
    async () => setWorkflowPublishedVersionComment(relativePath, versionId, comment),
  );
}

export async function restoreWorkflowPublishedVersionWithBackend(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionRestoreResponse> {
  return delegate(
    async (backend) => backend.restoreWorkflowPublishedVersion(relativePath, versionId),
    async () => {
      let projectPath: string | null = null;
      try {
        const root = await ensureWorkflowsRoot();
        projectPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
          allowProjectFile: true,
        }));
        return await restoreWorkflowPublishedVersion(relativePath, versionId);
      } finally {
        if (projectPath) {
          markFilesystemExecutionStructureDirty([projectPath]);
        }
      }
    },
  );
}

export async function publishWorkflowProjectItemWithBackend(relativePath: unknown, settings: WorkflowProjectSettingsDraft | unknown) {
  return delegate(
    async (backend) => backend.publishWorkflowProjectItem(relativePath, settings),
    async () => {
      const project = await publishWorkflowProjectItem(relativePath, settings);
      markFilesystemExecutionStructureDirty([project.absolutePath]);
      return project;
    },
  );
}

export async function unpublishWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.unpublishWorkflowProjectItem(relativePath),
    async () => {
      const project = await unpublishWorkflowProjectItem(relativePath);
      markFilesystemExecutionStructureDirty([project.absolutePath]);
      return project;
    },
  );
}

export async function deleteWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowProjectItem(relativePath),
    async () => {
      const root = await ensureWorkflowsRoot();
      const resolvedPath = requireProjectPath(resolveWorkflowRelativePath(root, relativePath, {
        allowProjectFile: true,
      }));

      const projectId = await deleteWorkflowProjectItem(relativePath);
      markFilesystemExecutionStructureDirty([resolvedPath]);
      return projectId;
    },
  );
}

export async function resolvePublishedExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadPublishedExecutionProject(endpointName);
  }

  return loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
    getFilesystemExecutionCache().loadPublishedExecutionProject(root, endpointName));
}

export async function resolveLatestExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadLatestExecutionProject(endpointName);
  }

  return loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
    getFilesystemExecutionCache().loadLatestExecutionProject(root, endpointName));
}

export async function createExecutionProjectReferenceLoader(projectPath: string) {
  return delegate(
    async (backend) => backend.createProjectReferenceLoader(),
    async () => createPublishedWorkflowProjectReferenceLoader(getWorkflowsRoot(), projectPath),
  );
}

export async function persistWorkflowExecutionRecordingWithBackend(options: {
  sourceProject: Project;
  sourceProjectPath: string;
  executedProject: Project;
  executedAttachedData: AttachedData;
  executedDatasets: CombinedDataset[];
  endpointName: string;
  recordingSerialized: string;
  runKind: 'published' | 'latest';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
}) {
  if (isManagedWorkflowStorageEnabled()) {
    await (await getManagedBackend()).persistWorkflowExecutionRecording(options);
    return;
  }

  await persistWorkflowExecutionRecording({ workflowsRoot: getWorkflowsRoot(), ...options });
}

export function getWorkflowStorageMode() {
  return getWorkflowStorageBackendMode();
}
