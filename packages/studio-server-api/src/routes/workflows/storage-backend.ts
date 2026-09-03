import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deserializeDatasets, loadProjectAndAttachedDataFromFile } from '@valerypopoff/rivet2-node';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingFilterStatus,
  WorkflowRecordingExecutionIdentity,
  WorkflowRecordingInputFilter,
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import { getWorkflowsRoot } from '../../security.js';
import type { RuntimeHealthCheckContext } from '../../runtime-health.js';
import { createHttpError } from '../../utils/httpError.js';
import {
  getManagedWorkflowStorageConfig,
  getWorkflowStorageBackendMode,
  isManagedWorkflowStorageEnabled,
} from './storage-config.js';
import { ManagedWorkflowBackend } from './managed/backend.js';
import type { ManagedReconciliationFindingDetailQuery } from './managed/reconciliation.js';
import {
  ensureWorkflowsRoot,
  getWorkflowDatasetPath,
  pathExists,
  PROJECT_EXTENSION,
  requireProjectPath,
  resolveWorkflowRelativePath,
} from './fs-helpers.js';
import {
  listWorkflowFolders,
  listWorkflowProjects,
  moveWorkflowFolder,
  moveWorkflowProject,
} from './workflow-query.js';
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
import {
  listWorkflowProjectWebApps,
  publishWorkflowProjectWebApps,
  unpublishWorkflowProjectWebApp,
  updateWorkflowProjectWebAppAccess,
} from './web-app-publication.js';
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
  flushWorkflowExecutionRecordingPersistence,
  initializeWorkflowRecordingStorage,
  listWorkflowRecordingRunsPage,
  getWorkflowRunStatistics,
  listWorkflowRunStatisticsCatalog,
  listWorkflowRecordingWorkflows,
  persistWorkflowExecutionRecording,
  readWorkflowRecordingArtifact,
} from './recordings.js';
import { createPublishedWorkflowProjectReferenceLoader, findPublishedWorkflowWebAppBySlug } from './publication.js';
import { NodeDatasetProvider } from '@valerypopoff/rivet2-node';
import type { AttachedData, CombinedDataset, Project, ProjectId } from '@valerypopoff/rivet2-node';
import { getFilesystemExecutionCache } from './filesystem-execution-cache.js';
import { normalizeHostedProjectTitle } from './hosted-project-contents.js';
import { writeWorkflowProjectStatsCacheFromContents } from './project-stats.js';
import {
  checkFilesystemProjectTransactionHealth,
  initializeFilesystemProjectTransactions,
  saveFilesystemProjectTransaction,
  waitForFilesystemWorkflowStorageIdle,
  withFilesystemWorkflowProjectRead,
  withFilesystemWorkflowStorageRead,
  withFilesystemWorkflowStorageWrite,
} from './filesystem-project-transactions.js';
import {
  FilesystemRivetLLMProfileHealthStore,
  getFilesystemLLMProfileHealthDatabasePath,
} from '../../llm-profile-health/filesystem-store.js';
import { flushLLMProfileHealthRecordingOutcomes } from '../../llm-profile-health/recording-outcomes.js';
import type { RivetStudioLLMProfileHealthStore } from '../../llm-profile-health/store.js';
import { FilesystemRivetEvaluationStore } from '../../evaluation-runs/filesystem-store.js';
import type { RivetStudioEvaluationStore } from '../../evaluation-runs/store.js';
import type { HostedEvaluationCoordinator } from '../../evaluation-runs/hosted-coordinator.js';

function mapHostedProjectFilesystemError(error: unknown, operation: 'read' | 'write', projectPath: string): Error {
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

function assertMatchingHostedProjectIdentity(
  project: Project,
  expectedProjectId: ProjectId,
  projectPath: string,
): void {
  if (!project.metadata.id || project.metadata.id !== expectedProjectId) {
    throw createHttpError(409, `The save target ${projectPath} belongs to a different project.`, { expose: true });
  }
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
  revisionKey: string;
  webAppUiGraphId?: string;
  webAppAllowedEmails?: string[];
  debug?: {
    cacheStatus: 'hit' | 'miss' | 'bypass';
    resolveMs: number;
    materializeMs: number;
  };
};

let managedBackendPromise: Promise<ManagedWorkflowBackend> | null = null;
let filesystemLLMProfileHealthStore: FilesystemRivetLLMProfileHealthStore | null = null;
let filesystemEvaluationStore: FilesystemRivetEvaluationStore | null = null;

function getFilesystemLLMProfileHealthStore(): FilesystemRivetLLMProfileHealthStore {
  filesystemLLMProfileHealthStore ??= new FilesystemRivetLLMProfileHealthStore();
  return filesystemLLMProfileHealthStore;
}

function getFilesystemEvaluationStore(): FilesystemRivetEvaluationStore {
  filesystemEvaluationStore ??= new FilesystemRivetEvaluationStore();
  return filesystemEvaluationStore;
}

async function resetFilesystemLLMProfileHealthForProject(projectId: ProjectId): Promise<void> {
  const existingStore = filesystemLLMProfileHealthStore;
  if (existingStore != null) {
    await existingStore.reset({ projectId });
    return;
  }

  if (!(await pathExists(getFilesystemLLMProfileHealthDatabasePath()))) {
    // Avoid creating an empty health database just because a project is deleted.
    // Recheck the singleton after the asynchronous filesystem lookup in case an
    // execution initialized it while the lookup was in progress.
    if (filesystemLLMProfileHealthStore == null) return;
  }

  await getFilesystemLLMProfileHealthStore().reset({ projectId });
}

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

export async function listManagedReconciliationFindingDetailsWithBackend(
  query: ManagedReconciliationFindingDetailQuery,
) {
  if (!isManagedWorkflowStorageEnabled()) {
    throw createHttpError(409, 'Detailed reconciliation findings require managed workflow storage.', { expose: true });
  }
  return (await getManagedBackend()).listManagedReconciliationFindingDetails(query);
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

async function createFilesystemPublishedWebAppRevisionKey(
  sourceProjectPath: string,
  publishedProjectPath: string,
  slug: string,
  uiGraphId: string,
): Promise<string> {
  const hash = createHash('sha256');
  for (const filePath of [publishedProjectPath, getWorkflowDatasetPath(publishedProjectPath)]) {
    const signature = await fs.stat(filePath).then(
      (stats) => `${stats.isFile() ? 'file' : 'other'}:${stats.size}:${stats.mtimeMs}`,
      (error) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : Promise.reject(error)),
    );
    hash.update(signature);
    hash.update('\0');
  }
  hash.update(sourceProjectPath);
  hash.update('\0');
  hash.update(publishedProjectPath);
  hash.update('\0');
  hash.update(slug);
  hash.update('\0');
  hash.update(uiGraphId);
  return `filesystem-web-app:${hash.digest('hex').slice(0, 32)}`;
}

async function loadFilesystemPublishedWebAppExecutionProject(
  root: string,
  slug: string,
): Promise<ExecutionProjectResult | null> {
  const match = await findPublishedWorkflowWebAppBySlug(root, slug);
  if (!match) {
    return null;
  }

  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(match.publishedProjectPath);
  const datasetPath = getWorkflowDatasetPath(match.publishedProjectPath);
  const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;
  const datasetProvider = new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []);

  return {
    project,
    attachedData,
    datasetProvider,
    projectVirtualPath: match.projectPath,
    revisionKey: await createFilesystemPublishedWebAppRevisionKey(
      match.projectPath,
      match.publishedProjectPath,
      match.slug,
      match.uiGraphId,
    ),
    webAppUiGraphId: match.uiGraphId,
    webAppAllowedEmails: match.allowedEmails,
  };
}

async function loadFilesystemLatestWebAppExecutionProject(
  root: string,
  slug: string,
): Promise<ExecutionProjectResult | null> {
  const match = await findPublishedWorkflowWebAppBySlug(root, slug);
  if (!match) {
    return null;
  }

  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(match.projectPath);
  const datasetPath = getWorkflowDatasetPath(match.projectPath);
  const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;
  const datasetProvider = new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []);

  return {
    project,
    attachedData,
    datasetProvider,
    projectVirtualPath: match.projectPath,
    revisionKey: await createFilesystemPublishedWebAppRevisionKey(
      match.projectPath,
      match.projectPath,
      match.slug,
      match.uiGraphId,
    ),
    webAppUiGraphId: match.uiGraphId,
    webAppAllowedEmails: match.allowedEmails,
  };
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

export async function checkWorkflowStorageHealth(context?: RuntimeHealthCheckContext): Promise<void> {
  if (isManagedWorkflowStorageEnabled()) {
    await (await getManagedBackend()).checkHealth(context);
    return;
  }

  const root = await ensureWorkflowsRoot();
  checkFilesystemProjectTransactionHealth(root);
  await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
}

export async function initializeWorkflowStorage(): Promise<void> {
  await delegate(
    async () => {
      await getManagedBackend();
    },
    async () => {
      const root = await ensureWorkflowsRoot();
      await initializeFilesystemProjectTransactions(root);
      await getFilesystemExecutionCache().initialize(root);
      await initializeWorkflowRecordingStorage(root);
    },
  );
}

export async function getWorkflowTree() {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.getTree(),
    async (root) =>
      withFilesystemWorkflowStorageRead(async () => ({
        root,
        folders: await listWorkflowFolders(root),
        projects: await listWorkflowProjects(root),
      })),
  );
}

export async function listHostedProjectPaths(): Promise<string[]> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listProjectPathsForHostedIo(),
    async (root) =>
      withFilesystemWorkflowStorageRead(async () => {
        const projects = await listWorkflowProjects(root);
        const folders = await listWorkflowFolders(root);
        const nestedProjects = folders.flatMap(function flatten(folder): WorkflowProjectItem[] {
          return [...folder.projects, ...folder.folders.flatMap(flatten)];
        });
        return [...projects, ...nestedProjects].map((project) => project.absolutePath);
      }),
  );
}

export async function loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
  return delegate<LoadHostedProjectResult>(
    async (backend) => backend.loadHostedProject(projectPath),
    async () => {
      try {
        const root = await ensureWorkflowsRoot();
        return await withFilesystemWorkflowProjectRead(root, projectPath, async () => {
          const [project, attachedData] = await loadProjectAndAttachedDataFromFile(projectPath);
          void project;
          void attachedData;
          const datasetPath = getWorkflowDatasetPath(projectPath);
          const datasetsContents = (await pathExists(datasetPath)) ? await fs.readFile(datasetPath, 'utf8') : null;

          return {
            contents: await fs.readFile(projectPath, 'utf8'),
            datasetsContents,
            revisionId: null,
          };
        });
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
        const normalized = normalizeHostedProjectTitle(options.contents, projectName, 'Could not save project');

        const sourceProjectId = normalized.project.metadata.id;
        if (!sourceProjectId) {
          throw createHttpError(400, 'Could not save project', { expose: true });
        }
        if (options.datasetsContents != null) {
          try {
            deserializeDatasets(options.datasetsContents);
          } catch {
            throw createHttpError(400, 'Could not save datasets', { expose: true });
          }
        }

        const root = await ensureWorkflowsRoot();
        let targetAlreadyExists = false;
        await saveFilesystemProjectTransaction({
          root,
          projectPath: options.projectPath,
          projectContents: normalized.contents,
          datasetsContents: options.datasetsContents,
          beforeTransaction: async () => {
            targetAlreadyExists = await pathExists(options.projectPath);
            if (!targetAlreadyExists) return;

            let targetProject: Project;
            try {
              [targetProject] = await loadProjectAndAttachedDataFromFile(options.projectPath);
            } catch {
              throw createHttpError(409, 'Could not verify the existing save target. Reopen it before saving.', {
                expose: true,
              });
            }
            assertMatchingHostedProjectIdentity(targetProject, sourceProjectId, options.projectPath);
          },
          afterCommit: async () => {
            try {
              await writeWorkflowProjectStatsCacheFromContents(options.projectPath, normalized.contents);
            } finally {
              // The statistics cache is derived and may be rebuilt later. The
              // execution materialization is not: always discard it so a
              // committed project can never keep serving its old graph merely
              // because updating derived statistics failed.
              invalidateFilesystemExecutionMaterializations([options.projectPath]);
            }
          },
        });

        return {
          path: options.projectPath,
          revisionId: null,
          project: null,
          created: !targetAlreadyExists,
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
    async (backend) =>
      backend.listWorkflowRecordingRunsPage(workflowId, page, pageSize, statusFilter, inputFilter, inputCursor, signal),
    async (root) =>
      listWorkflowRecordingRunsPage(root, workflowId, page, pageSize, statusFilter, inputFilter, inputCursor, signal),
  );
}

export async function getLLMProfileHealthStore(): Promise<RivetStudioLLMProfileHealthStore> {
  return delegate<RivetStudioLLMProfileHealthStore>(
    async (backend) => backend.getLLMProfileHealthStore(),
    async () => getFilesystemLLMProfileHealthStore(),
  );
}

export async function getEvaluationStore(): Promise<RivetStudioEvaluationStore> {
  return delegate<RivetStudioEvaluationStore>(
    async (backend) => backend.getEvaluationStore(),
    async () => getFilesystemEvaluationStore(),
  );
}

/** Returns the durable hosted-Evaluations scheduler only in managed storage mode. */
export async function getHostedEvaluationCoordinator(): Promise<HostedEvaluationCoordinator | null> {
  if (!isManagedWorkflowStorageEnabled()) return null;
  return (await getManagedBackend()).getHostedEvaluationCoordinator();
}

export async function listWorkflowRunStatisticsCatalogWithBackend(
  surface: WorkflowRunStatisticsSurface,
): Promise<WorkflowRunStatisticsCatalogResponse> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.listWorkflowRunStatisticsCatalog(surface),
    async (root) => listWorkflowRunStatisticsCatalog(root, surface),
  );
}

export async function getWorkflowRunStatisticsWithBackend(
  query: WorkflowRunStatisticsQuery,
): Promise<WorkflowRunStatisticsResponse> {
  return delegateWithWorkflowsRoot(
    async (backend) => backend.getWorkflowRunStatistics(query),
    async (root) => getWorkflowRunStatistics(root, query),
  );
}

export async function disposeWorkflowStorage(): Promise<void> {
  if (!isManagedWorkflowStorageEnabled()) {
    await waitForFilesystemWorkflowStorageIdle();
  }
  // Recording persistence can schedule its final health-evidence update after
  // the bundle write. Drain both layers before their shared stores close.
  await flushWorkflowExecutionRecordingPersistence();
  await flushLLMProfileHealthRecordingOutcomes();

  const backendPromise = managedBackendPromise;
  managedBackendPromise = null;
  const filesystemStore = filesystemLLMProfileHealthStore;
  const evaluationStore = filesystemEvaluationStore;
  filesystemLLMProfileHealthStore = null;
  filesystemEvaluationStore = null;
  await Promise.all([
    backendPromise?.then((backend) => backend.dispose()),
    filesystemStore?.dispose(),
    evaluationStore?.dispose(),
  ]);
}

export async function readWorkflowRecordingArtifactWithBackend(
  recordingId: string,
  artifact: 'recording' | 'replay-project' | 'replay-dataset',
): Promise<string> {
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
  // Explicit operator deletion deliberately overrides an active suspension's
  // temporary retention hold. The recording is already gone if the health-store
  // status update is temporarily unavailable, so do not turn a successful delete
  // into a false API failure.
  try {
    await (await getLLMProfileHealthStore()).markRecordingDeleted(recordingId);
  } catch (error) {
    console.error('[llm-profile-health] Failed to mark deleted recording evidence:', error);
  }
}

export async function moveWorkflowItemWithBackend(
  itemType: 'project' | 'folder',
  sourceRelativePath: unknown,
  destinationFolderRelativePath: unknown,
): Promise<{
  folder?: WorkflowFolderItem;
  project?: WorkflowProjectItem;
  movedProjectPaths: WorkflowProjectPathMove[];
}> {
  return delegateWithWorkflowsRoot(
    async (backend) =>
      itemType === 'project'
        ? backend.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
        : backend.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath),
    async (root) =>
      withFilesystemWorkflowStorageWrite(async () => {
        const result =
          itemType === 'project'
            ? await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath)
            : await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath);

        invalidateFilesystemExecutionMove(result.movedProjectPaths);

        return result;
      }),
  );
}

export async function createWorkflowFolderItemWithBackend(name: unknown, parentRelativePath: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowFolderItem(name, parentRelativePath),
    async () => withFilesystemWorkflowStorageWrite(() => createWorkflowFolderItem(name, parentRelativePath)),
  );
}

export async function renameWorkflowFolderItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowFolderItem(relativePath, newName),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const result = await renameWorkflowFolderItem(relativePath, newName);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);

        return result;
      }),
  );
}

export async function deleteWorkflowFolderItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowFolderItem(relativePath),
    async () => withFilesystemWorkflowStorageWrite(() => deleteWorkflowFolderItem(relativePath)),
  );
}

export async function createWorkflowProjectItemWithBackend(folderRelativePath: unknown, name: unknown) {
  return delegate(
    async (backend) => backend.createWorkflowProjectItem(folderRelativePath, name),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await createWorkflowProjectItem(folderRelativePath, name);
        markFilesystemExecutionStructureDirty();
        return project;
      }),
  );
}

export async function renameWorkflowProjectItemWithBackend(relativePath: unknown, newName: unknown) {
  return delegate(
    async (backend) => backend.renameWorkflowProjectItem(relativePath, newName),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const result = await renameWorkflowProjectItem(relativePath, newName);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);
        return result;
      }),
  );
}

export async function duplicateWorkflowProjectItemWithBackend(
  relativePath: unknown,
  version: WorkflowProjectDownloadVersion,
) {
  return delegate(
    async (backend) => backend.duplicateWorkflowProjectItem(relativePath, version),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await duplicateWorkflowProjectItem(relativePath, version);
        markFilesystemExecutionStructureDirty();
        return project;
      }),
  );
}

export async function uploadWorkflowProjectItemWithBackend(
  folderRelativePath: unknown,
  fileName: unknown,
  contents: unknown,
) {
  return delegate(
    async (backend) => backend.uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
        markFilesystemExecutionStructureDirty();
        return project;
      }),
  );
}

export async function readWorkflowProjectDownloadWithBackend(
  relativePath: unknown,
  version: WorkflowProjectDownloadVersion,
) {
  return delegate(
    async (backend) => backend.readWorkflowProjectDownload(relativePath, version),
    async () => withFilesystemWorkflowStorageRead(() => readWorkflowProjectDownload(relativePath, version)),
  );
}

export async function listWorkflowPublishedVersionsWithBackend(
  relativePath: unknown,
): Promise<WorkflowPublishedVersionsResponse> {
  return delegate(
    async (backend) => backend.listWorkflowPublishedVersions(relativePath),
    async () => withFilesystemWorkflowStorageRead(() => listWorkflowPublishedVersions(relativePath)),
  );
}

export async function readWorkflowPublishedVersionDownloadWithBackend(relativePath: unknown, versionId: unknown) {
  return delegate(
    async (backend) => backend.readWorkflowPublishedVersionDownload(relativePath, versionId),
    async () => withFilesystemWorkflowStorageRead(() => readWorkflowPublishedVersionDownload(relativePath, versionId)),
  );
}

export async function readWorkflowPublishedVersionPreviewWithBackend(relativePath: unknown, versionId: unknown) {
  return delegate(
    async (backend) => backend.readWorkflowPublishedVersionPreview(relativePath, versionId),
    async () => withFilesystemWorkflowStorageRead(() => readWorkflowPublishedVersionPreview(relativePath, versionId)),
  );
}

export async function setWorkflowPublishedVersionStarWithBackend(
  relativePath: unknown,
  versionId: unknown,
  isStarred: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  return delegate(
    async (backend) => backend.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred),
    async () =>
      withFilesystemWorkflowStorageWrite(() => setWorkflowPublishedVersionStar(relativePath, versionId, isStarred)),
  );
}

export async function setWorkflowPublishedVersionCommentWithBackend(
  relativePath: unknown,
  versionId: unknown,
  comment: unknown,
): Promise<WorkflowPublishedVersionSummary> {
  return delegate(
    async (backend) => backend.setWorkflowPublishedVersionComment(relativePath, versionId, comment),
    async () =>
      withFilesystemWorkflowStorageWrite(() => setWorkflowPublishedVersionComment(relativePath, versionId, comment)),
  );
}

export async function restoreWorkflowPublishedVersionWithBackend(
  relativePath: unknown,
  versionId: unknown,
): Promise<WorkflowPublishedVersionRestoreResponse> {
  return delegate(
    async (backend) => backend.restoreWorkflowPublishedVersion(relativePath, versionId),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        let projectPath: string | null = null;
        try {
          const root = await ensureWorkflowsRoot();
          projectPath = requireProjectPath(
            resolveWorkflowRelativePath(root, relativePath, {
              allowProjectFile: true,
            }),
          );
          return await restoreWorkflowPublishedVersion(relativePath, versionId);
        } finally {
          if (projectPath) {
            markFilesystemExecutionStructureDirty([projectPath]);
          }
        }
      }),
  );
}

export async function publishWorkflowProjectItemWithBackend(
  relativePath: unknown,
  settings: WorkflowProjectSettingsDraft | unknown,
) {
  return delegate(
    async (backend) => backend.publishWorkflowProjectItem(relativePath, settings),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await publishWorkflowProjectItem(relativePath, settings);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      }),
  );
}

export async function listWorkflowProjectWebAppsWithBackend(
  relativePath: unknown,
): Promise<WorkflowProjectWebAppsResponse> {
  return delegate(
    async (backend) => backend.listWorkflowProjectWebApps(relativePath),
    async () => withFilesystemWorkflowStorageRead(() => listWorkflowProjectWebApps(relativePath)),
  );
}

export async function publishWorkflowProjectWebAppsWithBackend(
  relativePath: unknown,
  publications: WorkflowProjectWebAppPublicationDraft[] | unknown,
) {
  return delegate(
    async (backend) => backend.publishWorkflowProjectWebApps(relativePath, publications),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await publishWorkflowProjectWebApps(relativePath, publications);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      }),
  );
}

export async function updateWorkflowProjectWebAppAccessWithBackend(
  relativePath: unknown,
  accessUpdates: WorkflowProjectWebAppAccessDraft[] | unknown,
) {
  return delegate(
    async (backend) => backend.updateWorkflowProjectWebAppAccess(relativePath, accessUpdates),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await updateWorkflowProjectWebAppAccess(relativePath, accessUpdates);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      }),
  );
}

export async function unpublishWorkflowProjectWebAppWithBackend(relativePath: unknown, uiGraphId: unknown) {
  return delegate(
    async (backend) => backend.unpublishWorkflowProjectWebApp(relativePath, uiGraphId),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await unpublishWorkflowProjectWebApp(relativePath, uiGraphId);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      }),
  );
}

export async function unpublishWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.unpublishWorkflowProjectItem(relativePath),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const project = await unpublishWorkflowProjectItem(relativePath);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      }),
  );
}

export async function deleteWorkflowProjectItemWithBackend(relativePath: unknown) {
  return delegate(
    async (backend) => backend.deleteWorkflowProjectItem(relativePath),
    async () =>
      withFilesystemWorkflowStorageWrite(async () => {
        const root = await ensureWorkflowsRoot();
        const resolvedPath = requireProjectPath(
          resolveWorkflowRelativePath(root, relativePath, {
            allowProjectFile: true,
          }),
        );

        const projectId = await deleteWorkflowProjectItem(relativePath, {
          beforeDelete: async (projectMetadataId) => {
            if (projectMetadataId != null) {
              await resetFilesystemLLMProfileHealthForProject(projectMetadataId as ProjectId);
              await getFilesystemEvaluationStore().deleteProject(projectMetadataId as ProjectId);
            }
          },
        });
        markFilesystemExecutionStructureDirty([resolvedPath]);
        return projectId;
      }),
  );
}

export async function resolvePublishedExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadPublishedExecutionProject(endpointName);
  }

  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
      getFilesystemExecutionCache().loadPublishedExecutionProject(root, endpointName),
    ),
  );
}

export async function resolvePublishedWebAppExecutionProject(slug: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadPublishedWebAppExecutionProject(slug);
  }

  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
      loadFilesystemPublishedWebAppExecutionProject(root, slug),
    ),
  );
}

export async function resolveLatestWebAppExecutionProject(slug: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadLatestWebAppExecutionProject(slug);
  }

  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
      loadFilesystemLatestWebAppExecutionProject(root, slug),
    ),
  );
}

export async function resolveLatestExecutionProject(endpointName: string): Promise<ExecutionProjectResult | null> {
  if (isManagedWorkflowStorageEnabled()) {
    return (await getManagedBackend()).loadLatestExecutionProject(endpointName);
  }

  return withFilesystemWorkflowStorageRead(() =>
    loadFilesystemExecutionProjectWithMissingRootRetry((root) =>
      getFilesystemExecutionCache().loadLatestExecutionProject(root, endpointName),
    ),
  );
}

export async function createExecutionProjectReferenceLoader(projectPath: string) {
  return delegate(
    async (backend) => backend.createProjectReferenceLoader(),
    async () => {
      const loader = createPublishedWorkflowProjectReferenceLoader(getWorkflowsRoot(), projectPath);
      return {
        loadProject: (...args: Parameters<typeof loader.loadProject>) =>
          withFilesystemWorkflowStorageRead(() => loader.loadProject(...args)),
      };
    },
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
  runKind: 'published' | 'latest' | 'editor';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  errorMessage?: string;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  onPersisted?: (recordingId: string) => Promise<void>;
}): Promise<string | undefined> {
  if (isManagedWorkflowStorageEnabled()) {
    return await (await getManagedBackend()).persistWorkflowExecutionRecording(options);
  }

  return await persistWorkflowExecutionRecording({ workflowsRoot: getWorkflowsRoot(), ...options });
}

export function getWorkflowStorageMode() {
  return getWorkflowStorageBackendMode();
}
