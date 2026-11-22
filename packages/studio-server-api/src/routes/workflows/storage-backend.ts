import type { ServerResponse } from 'node:http';
import { getPublicEndpointLookups } from '../../public-endpoint-lookups.js';
import { createLegacyWorkflowCommands } from './legacy-workflow-commands.js';
import { recordingMemory } from './recording-memory.js';
import type { ExecutionRecorder } from '@valerypopoff/rivet2-core';
import type { ProjectReferenceQuery } from './managed/reference-index.js';
import { REFERENCE_QUERY_TIMEOUT_MS } from './managed/reference-query.js';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  HostedProjectStorageLoadResult as LoadHostedProjectResult,
  HostedProjectStorageSaveResult as SaveHostedProjectResult,
  HostedProjectStorageSaveOptions,
  WorkflowRepositories,
  WorkflowExecutionDefinition,
  WorkflowPublishedExecutionTarget,
  WorkflowRecordingPageQuery,
  WorkflowPublicationRepository,
  PersistWorkflowExecutionRecordingOptions,
  WorkflowWebAppAccessPolicy as WebAppAccessPolicy,
} from './data-backend.js';
export type { HostedProjectSaveIntent, WorkflowWebAppAccessPolicy as WebAppAccessPolicy } from './data-backend.js';
import {
  getWorkflowStorageServices,
  peekWorkflowStorageServices,
  disposeWorkflowStorageServices,
} from './storage-composition.js';
import type {
  ResolvedSubgraphProject,
  SubgraphProjectTarget,
  ProjectReferenceLoader,
  ProjectId,
} from '@valerypopoff/rivet2-node';
import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import { getWorkflowsRoot } from '../../security.js';
import type { RuntimeHealthCheckContext } from '../../runtime-health.js';
import { createHttpError } from '../../utils/httpError.js';
import { getWorkflowStorageBackendMode } from './storage-config.js';
import type { WorkflowPublicationCommand } from './publication-command.js';
import type { ManagedReconciliationFindingDetailQuery } from './managed/reconciliation.js';
import { ensureWorkflowsRoot } from './fs-helpers.js';
import {
  deleteWorkflowRecording,
  listWorkflowRecordingRunsPage,
  getWorkflowRunStatistics,
  listWorkflowRunStatisticsCatalog,
  listWorkflowRecordingWorkflows,
  persistWorkflowExecutionRecording,
  readWorkflowRecordingArtifact,
  getWorkflowRecordingSummary,
  initializeWorkflowRecordingQueuePolicy,
  disposeWorkflowRecordingQueuePolicy,
} from './recordings.js';
import { shouldSnapshotWorkflowRecordingDatasets } from './recordings-config.js';
import { getManagedWorkflowProjectVirtualPath } from './virtual-paths.js';
import { checkFilesystemProjectTransactionHealth } from './filesystem-project-transactions.js';
import type { RivetStudioLLMProfileHealthStore } from '../../llm-profile-health/store.js';
import type { RivetStudioEvaluationStore } from '../../evaluation-runs/store.js';
import type { HostedEvaluationCoordinator } from '../../evaluation-runs/hosted-coordinator.js';
import {
  getLegacyWorkflowTree,
  listLegacyHostedProjectPaths,
  loadLegacyHostedProject,
  saveLegacyHostedProject,
} from './legacy-project-storage.js';
import {
  createLegacyExecutionProjectReferenceLoader,
  invalidateFilesystemExecutionMaterializations,
  markFilesystemExecutionStructureDirty,
  invalidateFilesystemExecutionMove,
  resolveLegacyPublishedExecutionProject,
  resolveLegacyPublishedExecutionTarget,
  resolveLegacyLatestExecutionProject,
  resolveLegacyPublishedWebAppExecutionProject,
  resolveLegacyLatestWebAppExecutionProject,
  resolveLegacyWebAppAccessPolicy,
  loadLegacySubgraphTarget,
} from './legacy-execution-storage.js';

type ExecutionProjectResult = WorkflowExecutionDefinition;

export function getLocalWorkflowActiveWriteCount(): number {
  return peekWorkflowStorageServices()?.getLocalActiveWriteCount() ?? 0;
}
export function getLocalWorkflowPendingCatalogOperationCount(): number {
  return peekWorkflowStorageServices()?.getLocalPendingOperationCount() ?? 0;
}
const getManagedBackend = () => getWorkflowStorageServices().getManaged();
export const usesManagedNamespace = () => getWorkflowStorageServices().mode === 'managed';
export async function mutateStructuralWithBackend(
  command: import('../../../../studio-server-shared/workflow-mutation-contract.js').StructuralCommand,
  mutation: import('../../../../studio-server-shared/workflow-mutation-contract.js').StructuralMutation,
) {
  if (!usesManagedNamespace()) throw createHttpError(409, 'Structural admission requires managed storage.');
  return (await getManagedBackend()).mutateStructural(command, mutation);
}
export async function recoverStructuralWithBackend(operationId: string, hash: string) {
  if (!usesManagedNamespace()) throw createHttpError(409, 'Structural admission requires managed storage.');
  return (await getManagedBackend()).recoverStructural(operationId, hash);
}
export function requireGuardedNamespaceMutations(): void {
  if (getWorkflowStorageServices().mode === 'managed')
    throw createHttpError(
      428,
      'Refresh Rivet before changing project locations. Identity-guarded namespace mutations are required.',
    );
}
export async function mutateWorkflowNamespaceWithBackend(
  request: import('../../../../studio-server-shared/workflow-namespace-types.js').WorkflowNamespaceMutation,
) {
  if (getWorkflowStorageServices().mode !== 'managed')
    throw createHttpError(409, 'Guarded namespace mutations require managed storage.');
  return (await getManagedBackend()).mutateNamespace(request);
}
export async function recoverWorkflowNamespaceWithBackend(
  request: import('../../../../studio-server-shared/workflow-namespace-types.js').WorkflowNamespaceMutation,
) {
  if (getWorkflowStorageServices().mode !== 'managed')
    throw createHttpError(409, 'Guarded namespace mutations require managed storage.');
  return (await getManagedBackend()).recoverNamespace(request);
}
export async function getExplicitBundleService() {
  const services = getWorkflowStorageServices();
  if (services.mode !== 'managed')
    throw createHttpError(409, 'Explicit bundles require PostgreSQL and S3 storage.', { expose: true });
  return (await services.getManaged()).bundles;
}
const resetFilesystemLLMProfileHealthForProject = (id: ProjectId) =>
  getWorkflowStorageServices().resetLocalProjectHealth(id);
function usesDatabaseCatalog(): boolean {
  return getWorkflowStorageServices().mode !== 'legacy';
}

function withWorkflowPublicationRepository<T>(
  run: (repository: WorkflowPublicationRepository) => Promise<T>,
): Promise<T> {
  return delegate('publications', run, () => run(legacyCommands));
}

export async function listManagedReconciliationFindingDetailsWithBackend(
  query: ManagedReconciliationFindingDetailQuery,
) {
  if (getWorkflowStorageServices().mode !== 'managed') {
    throw createHttpError(409, 'Detailed reconciliation findings require managed workflow storage.', { expose: true });
  }
  return (await getManagedBackend()).listManagedReconciliationFindingDetails(query);
}

async function delegate<T, K extends keyof WorkflowRepositories>(
  repository: K,
  managedFn: (backend: WorkflowRepositories[K]) => Promise<T>,
  fsFn: () => Promise<T>,
): Promise<T> {
  if (usesDatabaseCatalog()) {
    const backend = await getWorkflowStorageServices().getRepository(repository);
    return managedFn(backend);
  }

  return fsFn();
}

const legacyCommands = createLegacyWorkflowCommands({
  markFilesystemExecutionStructureDirty,
  invalidateFilesystemExecutionMove,
  resetFilesystemLLMProfileHealthForProject,
  getEvaluationStore,
});

let indexedReferenceChecks = 0;
export async function readIndexedProjectReferencesWithBackend(query: ProjectReferenceQuery) {
  if (!usesManagedNamespace()) return null;
  query.signal.throwIfAborted();
  if (indexedReferenceChecks >= 2) throw createHttpError(503, 'Reference checks are busy. Try again shortly.');
  indexedReferenceChecks++;
  const deadline = Date.now() + REFERENCE_QUERY_TIMEOUT_MS;
  const bounded = AbortSignal.any([query.signal, AbortSignal.timeout(REFERENCE_QUERY_TIMEOUT_MS)]);
  // Include shared backend initialization in the request budget. Its lifecycle
  // remains owned by storage services even if this caller stops waiting.
  const work = delegate(
    'projects',
    async (backend) => {
      bounded.throwIfAborted();
      if (!backend.readIndexedProjectReferences)
        throw createHttpError(503, 'Indexed reference checking is unavailable.');
      return backend.readIndexedProjectReferences({ ...query, signal: bounded });
    },
    async () => null,
  ).finally(() => {
    indexedReferenceChecks--;
  });
  let abort: () => void = () => {};
  try {
    const result = await new Promise<Awaited<typeof work>>((resolve, reject) => {
      abort = () => reject(bounded.reason);
      bounded.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject);
      if (bounded.aborted) abort();
    });
    query.signal.throwIfAborted();
    if (Date.now() >= deadline) throw createHttpError(503, 'Reference checking timed out. Try again shortly.');
    return result;
  } catch (error) {
    query.signal.throwIfAborted();
    if (bounded.aborted) throw createHttpError(503, 'Reference checking timed out. Try again shortly.');
    throw error;
  } finally {
    bounded.removeEventListener('abort', abort);
  }
}

async function delegateWithWorkflowsRoot<T, K extends keyof WorkflowRepositories>(
  repository: K,
  managedFn: (backend: WorkflowRepositories[K]) => Promise<T>,
  fsFn: (root: string) => Promise<T>,
): Promise<T> {
  return delegate(repository, managedFn, async () => fsFn(await ensureWorkflowsRoot()));
}

export async function checkWorkflowStorageHealth(context?: RuntimeHealthCheckContext): Promise<void> {
  if (getWorkflowStorageServices().mode === 'sqlite') {
    await (await getWorkflowStorageServices().getLocal()).checkHealth(context);
    return;
  }
  if (getWorkflowStorageServices().mode === 'managed') {
    await (await getManagedBackend()).checkHealth(context);
    return;
  }

  const root = await ensureWorkflowsRoot();
  checkFilesystemProjectTransactionHealth(root);
  await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
}

export async function initializeWorkflowStorage(): Promise<void> {
  await initializeWorkflowRecordingQueuePolicy();
  await getWorkflowStorageServices().initialize();
}

export async function getWorkflowTree() {
  const tree = await delegate(
    'projects',
    async (backend) => backend.getTree(),
    () => getLegacyWorkflowTree(),
  );
  return {
    ...tree,
    capabilities: {
      explicitBundles: usesManagedNamespace(),
      namespaceMutations: usesManagedNamespace(),
      bundleMerge: usesManagedNamespace(),
      bundleCompare: usesManagedNamespace(),
    },
  };
}

export async function listHostedProjectPaths(): Promise<string[]> {
  return delegate(
    'projects',
    async (backend) => backend.listProjectPathsForHostedIo(),
    () => listLegacyHostedProjectPaths(),
  );
}

export async function loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
  return delegate<LoadHostedProjectResult, 'projects'>(
    'projects',
    async (backend) => backend.loadHostedProject(projectPath),
    () => loadLegacyHostedProject(projectPath),
  );
}

export async function saveHostedProject(options: HostedProjectStorageSaveOptions): Promise<SaveHostedProjectResult> {
  // Capture before backend acquisition or writer waits so persistence, revision
  // checks and derived statistics describe the same submitted bytes.
  options = structuredClone(options);
  return delegate<SaveHostedProjectResult, 'projects'>(
    'projects',
    async (backend) => backend.saveHostedProject(options),
    () => saveLegacyHostedProject(options, invalidateFilesystemExecutionMaterializations),
  );
}

export async function readManagedHostedText(filePath: string): Promise<string> {
  if (!usesDatabaseCatalog()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getWorkflowStorageServices().getRepository('projects')).readHostedText(filePath);
}

export async function managedHostedPathExists(filePath: string): Promise<boolean> {
  if (!usesDatabaseCatalog()) {
    return false;
  }

  return (await getWorkflowStorageServices().getRepository('projects')).hostedPathExists(filePath);
}

export async function readManagedHostedRelativeProject(relativeFrom: string, projectFilePath: string): Promise<string> {
  if (!usesDatabaseCatalog()) {
    throw createHttpError(400, 'Managed workflow storage is disabled');
  }

  return (await getWorkflowStorageServices().getRepository('projects')).resolveManagedRelativeProjectText(
    relativeFrom,
    projectFilePath,
  );
}

export async function listWorkflowRecordingWorkflowsWithBackend(
  includeEvidence = false,
): Promise<WorkflowRecordingWorkflowListResponse> {
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) => backend.listWorkflowRecordingWorkflows(includeEvidence),
    async (root) => listWorkflowRecordingWorkflows(root),
  );
}

export async function listWorkflowRecordingRunsPageWithBackend(
  query: WorkflowRecordingPageQuery,
): Promise<WorkflowRecordingRunsPageResponse> {
  const {
    workflowId,
    page,
    pageSize,
    statusFilter = 'all',
    inputCursor = 0,
    signal,
    inputAfter,
    includeSubgraphRuns = false,
  } = query;
  const inputFilter = query.inputFilter ? structuredClone(query.inputFilter) : null;
  const runScope = query.runScope ?? (inputFilter ? 'roots' : 'all');
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) =>
      backend.listWorkflowRecordingRunsPage({
        includeEvidence: query.includeEvidence,
        workflowId,
        page,
        pageSize,
        statusFilter,
        inputFilter,
        inputCursor,
        signal,
        inputAfter,
        includeSubgraphRuns,
        runScope,
      }),
    async (root) =>
      listWorkflowRecordingRunsPage(
        root,
        workflowId,
        page,
        pageSize,
        statusFilter,
        inputFilter,
        inputCursor,
        signal,
        inputAfter,
        includeSubgraphRuns,
        runScope,
      ),
  );
}

export async function getLLMProfileHealthStore(): Promise<RivetStudioLLMProfileHealthStore> {
  return getWorkflowStorageServices().getProfileHealth();
}

export async function getEvaluationStore(): Promise<RivetStudioEvaluationStore> {
  return getWorkflowStorageServices().getEvaluations();
}

/** Returns the durable hosted-Evaluations scheduler only in managed storage mode. */
export async function getHostedEvaluationCoordinator(): Promise<HostedEvaluationCoordinator | null> {
  if (getWorkflowStorageServices().mode !== 'managed') return null;
  return (await getManagedBackend()).getHostedEvaluationCoordinator();
}

export async function listWorkflowRunStatisticsCatalogWithBackend(
  surface: WorkflowRunStatisticsSurface,
): Promise<WorkflowRunStatisticsCatalogResponse> {
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) => backend.listWorkflowRunStatisticsCatalog(surface),
    async (root) => listWorkflowRunStatisticsCatalog(root, surface),
  );
}

export async function getWorkflowRunStatisticsWithBackend(
  query: WorkflowRunStatisticsQuery,
): Promise<WorkflowRunStatisticsResponse> {
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) => backend.getWorkflowRunStatistics(query),
    async (root) => getWorkflowRunStatistics(root, query),
  );
}

export async function disposeWorkflowStorage(): Promise<void> {
  await disposeWorkflowStorageServices();
  disposeWorkflowRecordingQueuePolicy();
}

export async function drainWorkflowStorageAcceptedWork(): Promise<void> {
  await peekWorkflowStorageServices()?.drainAcceptedWork();
  await peekWorkflowStorageServices()?.drain();
}
export function beginWorkflowStorageRetirement(): void {
  peekWorkflowStorageServices()?.beginRetirement();
}

export async function readWorkflowRecordingArtifactWithBackend(
  recordingId: string,
  artifact: 'recording' | 'replay-project' | 'replay-dataset',
): Promise<string> {
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) => backend.readWorkflowRecordingArtifact(recordingId, artifact),
    async (root) => readWorkflowRecordingArtifact(root, recordingId, artifact),
  );
}

export async function getWorkflowRecordingSummaryWithBackend(
  recordingId: string,
): Promise<WorkflowRecordingRunSummary> {
  return delegateWithWorkflowsRoot(
    'recordings',
    async (backend) => backend.getWorkflowRecordingSummary(recordingId),
    async (root) => getWorkflowRecordingSummary(root, recordingId),
  );
}

export async function deleteWorkflowRecordingWithBackend(recordingId: string): Promise<void> {
  await delegateWithWorkflowsRoot(
    'recordings',
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
  sourceRelativePath: string,
  destinationFolderRelativePath: string,
): Promise<{
  folder?: WorkflowFolderItem;
  project?: WorkflowProjectItem;
  movedProjectPaths: WorkflowProjectPathMove[];
}> {
  return delegate<Awaited<ReturnType<typeof moveWorkflowItemWithBackend>>, 'projects'>(
    'projects',
    async (backend) =>
      itemType === 'project'
        ? backend.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
        : backend.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath),
    () =>
      itemType === 'project'
        ? legacyCommands.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath)
        : legacyCommands.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath),
  );
}

export async function createWorkflowFolderItemWithBackend(name: string, parentRelativePath: string) {
  return delegate(
    'projects',
    async (backend) => backend.createWorkflowFolderItem(name, parentRelativePath),
    () => legacyCommands.createWorkflowFolderItem(name, parentRelativePath),
  );
}

export async function renameWorkflowFolderItemWithBackend(relativePath: string, newName: string) {
  return delegate(
    'projects',
    async (backend) => backend.renameWorkflowFolderItem(relativePath, newName),
    () => legacyCommands.renameWorkflowFolderItem(relativePath, newName),
  );
}

export async function deleteWorkflowFolderItemWithBackend(relativePath: string) {
  return delegate(
    'projects',
    async (backend) => backend.deleteWorkflowFolderItem(relativePath),
    () => legacyCommands.deleteWorkflowFolderItem(relativePath),
  );
}

export async function createWorkflowProjectItemWithBackend(folderRelativePath: string, name: string) {
  return delegate(
    'projects',
    async (backend) => backend.createWorkflowProjectItem(folderRelativePath, name),
    () => legacyCommands.createWorkflowProjectItem(folderRelativePath, name),
  );
}

export async function renameWorkflowProjectItemWithBackend(relativePath: string, newName: string) {
  return delegate(
    'projects',
    async (backend) => backend.renameWorkflowProjectItem(relativePath, newName),
    () => legacyCommands.renameWorkflowProjectItem(relativePath, newName),
  );
}

export async function duplicateWorkflowProjectItemWithBackend(
  relativePath: string,
  version: WorkflowProjectDownloadVersion,
) {
  return delegate(
    'projects',
    async (backend) => backend.duplicateWorkflowProjectItem(relativePath, version),
    () => legacyCommands.duplicateWorkflowProjectItem(relativePath, version),
  );
}

export async function uploadWorkflowProjectItemWithBackend(
  folderRelativePath: string,
  fileName: string,
  contents: string,
) {
  return delegate(
    'projects',
    async (backend) => backend.uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
    () => legacyCommands.uploadWorkflowProjectItem(folderRelativePath, fileName, contents),
  );
}

export async function readWorkflowProjectDownloadWithBackend(
  relativePath: string,
  version: WorkflowProjectDownloadVersion,
) {
  return delegate(
    'projects',
    async (backend) => backend.readWorkflowProjectDownload(relativePath, version),
    () => legacyCommands.readWorkflowProjectDownload(relativePath, version),
  );
}

export async function readWorkflowProjectReferenceSnapshotsWithBackend(relativePath: string) {
  return delegate(
    'projects',
    async (backend) => backend.readWorkflowProjectReferenceSnapshots(relativePath),
    () => legacyCommands.readWorkflowProjectReferenceSnapshots(relativePath),
  );
}

export async function listWorkflowProjectReferenceCatalogWithBackend() {
  return delegate(
    'projects',
    async (backend) => backend.listWorkflowProjectReferenceCatalog(),
    () => legacyCommands.listWorkflowProjectReferenceCatalog(),
  );
}

export async function listWorkflowPublishedVersionsWithBackend(
  relativePath: string,
): Promise<WorkflowPublishedVersionsResponse> {
  return withWorkflowPublicationRepository((backend) => backend.listWorkflowPublishedVersions(relativePath));
}

export async function readWorkflowPublishedVersionDownloadWithBackend(relativePath: string, versionId: string) {
  return withWorkflowPublicationRepository((backend) =>
    backend.readWorkflowPublishedVersionDownload(relativePath, versionId),
  );
}

export async function readWorkflowPublishedVersionPreviewWithBackend(
  relativePath: string,
  versionId: string,
  artifactId?: string,
  ownerId?: string,
) {
  return withWorkflowPublicationRepository((backend) =>
    backend.readWorkflowPublishedVersionPreview(relativePath, versionId, artifactId, ownerId),
  );
}

export async function readWorkflowReferenceOverviewWithBackend() {
  return withWorkflowPublicationRepository(async (backend) => backend.readWorkflowReferenceOverview?.() ?? null);
}

export async function readWorkflowBundleReferenceDetailsWithBackend(bundleId: string) {
  return withWorkflowPublicationRepository(
    async (backend) => backend.readWorkflowBundleReferenceDetails?.(bundleId) ?? null,
  );
}

export async function readWorkflowHistoryPreviewWithBackend(relativePath: string, versionId: string, ownerId?: string) {
  return withWorkflowPublicationRepository(async (backend) => {
    if (backend.readWorkflowHistoryPreview) return backend.readWorkflowHistoryPreview(relativePath, versionId, ownerId);
    const { versions } = await backend.listWorkflowPublishedVersions(relativePath);
    const selected = versions.find((row) => row.id === versionId && (!ownerId || row.projectId === ownerId));
    if (!selected) throw createHttpError(404, 'Published revision not found.');
    return {
      coverage: 'project-only' as const,
      rootArtifactId: versionId,
      endpointName: selected.endpointName,
      publishedAt: selected.publishedAt,
      projects: [
        {
          artifactId: versionId,
          projectId: selected.projectId,
          name: selected.projectName,
          relativePath,
          savedAt: selected.publishedAt,
        },
      ],
      references: [],
    };
  });
}

export async function reviewEndpointReleaseWithBackend(
  relativePath: string,
  preconditions: Extract<WorkflowPublicationCommand, { kind: 'publish-endpoint' }>['preconditions'],
) {
  return withWorkflowPublicationRepository(
    async (backend) => backend.reviewEndpointRelease?.(relativePath, preconditions) ?? null,
  );
}

export async function setWorkflowPublishedVersionStarWithBackend(
  relativePath: string,
  versionId: string,
  isStarred: boolean,
): Promise<WorkflowPublishedVersionSummary> {
  return withWorkflowPublicationRepository((backend) =>
    backend.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred),
  );
}

export async function setWorkflowPublishedVersionCommentWithBackend(
  relativePath: string,
  versionId: string,
  comment: string,
): Promise<WorkflowPublishedVersionSummary> {
  return withWorkflowPublicationRepository((backend) =>
    backend.setWorkflowPublishedVersionComment(relativePath, versionId, comment),
  );
}

export async function listWorkflowProjectWebAppsWithBackend(
  relativePath: string,
): Promise<WorkflowProjectWebAppsResponse> {
  return withWorkflowPublicationRepository((backend) => backend.listWorkflowProjectWebApps(relativePath));
}

type RestorePublicationCommand = Extract<WorkflowPublicationCommand, { kind: 'restore-version' }>;
type ProjectPublicationCommand = Exclude<WorkflowPublicationCommand, RestorePublicationCommand>;

export function executeWorkflowPublicationCommandWithBackend(
  command: RestorePublicationCommand,
): Promise<WorkflowPublishedVersionRestoreResponse>;
export function executeWorkflowPublicationCommandWithBackend(
  command: ProjectPublicationCommand,
): Promise<WorkflowProjectItem>;
export async function executeWorkflowPublicationCommandWithBackend(
  command: WorkflowPublicationCommand,
): Promise<WorkflowProjectItem | WorkflowPublishedVersionRestoreResponse> {
  // Capture reviewed state before adapter acquisition or a filesystem writer
  // wait. A caller changing its object cannot authorize a different command.
  command = structuredClone(command);
  switch (command.kind) {
    case 'publish-endpoint':
      return withWorkflowPublicationRepository((backend) =>
        backend.publishWorkflowProjectItem(
          command.relativePath,
          {
            endpointName: command.endpointName,
            releaseReviewToken: command.releaseReviewToken,
            acknowledgeMissingRollback: command.acknowledgeMissingRollback,
          },
          command.preconditions,
        ),
      );
    case 'publish-web-apps':
      return withWorkflowPublicationRepository((backend) =>
        backend.publishWorkflowProjectWebApps(command.relativePath, command.publications, command.preconditions),
      );
    case 'restore-version':
      return withWorkflowPublicationRepository((backend) =>
        backend.restoreWorkflowPublishedVersion(command.relativePath, command.versionId, command.preconditions),
      );
    case 'unpublish-endpoint':
      return withWorkflowPublicationRepository((backend) =>
        backend.unpublishWorkflowProjectItem(command.relativePath, command.preconditions),
      );
    case 'set-endpoint-access':
      return withWorkflowPublicationRepository((backend) =>
        backend.updateWorkflowEndpointAccess(command.relativePath, command.access, command.preconditions),
      );
    case 'set-web-app-access':
      return withWorkflowPublicationRepository((backend) =>
        backend.updateWorkflowProjectWebAppAccess(command.relativePath, command.accessUpdates, command.preconditions),
      );
    case 'unpublish-web-app':
      return withWorkflowPublicationRepository((backend) =>
        backend.unpublishWorkflowProjectWebApp(command.relativePath, command.uiGraphId, command.preconditions),
      );
    default: {
      const unsupportedCommand: never = command;
      throw createHttpError(400, `Unsupported publication command: ${String(unsupportedCommand)}`);
    }
  }
}

export async function deleteWorkflowProjectItemWithBackend(relativePath: string) {
  return delegate(
    'projects',
    async (backend) => backend.deleteWorkflowProjectItem(relativePath),
    () => legacyCommands.deleteWorkflowProjectItem(relativePath),
  );
}

export async function resolvePublishedExecutionTarget(
  endpointName: string,
  requireFreshPointer = false,
  client?: ServerResponse,
): Promise<WorkflowPublishedExecutionTarget | null> {
  const services = getWorkflowStorageServices();
  if (services.mode === 'legacy') return resolveLegacyPublishedExecutionTarget(endpointName);
  const resolve = async () =>
    (await services.getRepository('execution')).resolvePublishedExecutionTarget(endpointName, requireFreshPointer);
  return services.mode === 'managed' && requireFreshPointer && client
    ? getPublicEndpointLookups().resolve(client, resolve)
    : resolve();
}

export async function resolvePublishedExecutionProject(
  endpointName: string,
  requireFreshPointer = false,
): Promise<ExecutionProjectResult | null> {
  if (usesDatabaseCatalog()) {
    return (await getWorkflowStorageServices().getRepository('execution')).loadPublishedExecutionProject(
      endpointName,
      requireFreshPointer,
    );
  }

  return resolveLegacyPublishedExecutionProject(endpointName);
}

export async function resolvePublishedWebAppExecutionProject(slug: string): Promise<ExecutionProjectResult | null> {
  if (usesDatabaseCatalog()) {
    return (await getWorkflowStorageServices().getRepository('execution')).loadPublishedWebAppExecutionProject(slug);
  }

  return resolveLegacyPublishedWebAppExecutionProject(slug);
}

export async function resolveLatestWebAppExecutionProject(slug: string): Promise<ExecutionProjectResult | null> {
  if (usesDatabaseCatalog()) {
    return (await getWorkflowStorageServices().getRepository('execution')).loadLatestWebAppExecutionProject(slug);
  }

  return resolveLegacyLatestWebAppExecutionProject(slug);
}

/** Reads the current app binding and allowlist without loading project data. */
export async function resolveWebAppAccessPolicy(
  slug: string,
  expectedProjectVirtualPath?: string,
): Promise<WebAppAccessPolicy | null> {
  if (getWorkflowStorageServices().mode === 'sqlite') {
    const policy = await (
      await getWorkflowStorageServices().getRepository('execution')
    ).resolveWebAppAccessPolicy(slug);
    return policy == null
      ? null
      : {
          projectVirtualPath: path.join(getWorkflowsRoot(), ...policy.relativePath.split('/')),
          uiGraphId: policy.uiGraphId,
          allowedEmails: policy.allowedEmails,
          bindingId: `filesystem:${policy.appId}`,
        };
  }
  if (getWorkflowStorageServices().mode === 'managed') {
    const policy = await (await getManagedBackend()).resolveWebAppAccessPolicy(slug);
    return policy == null
      ? null
      : {
          projectVirtualPath: getManagedWorkflowProjectVirtualPath(policy.relativePath),
          uiGraphId: policy.uiGraphId,
          allowedEmails: policy.allowedEmails,
          bindingId: `managed:${policy.appId}`,
        };
  }

  return resolveLegacyWebAppAccessPolicy(slug, expectedProjectVirtualPath);
}

export async function resolveLatestExecutionProject(
  endpointName: string,
  requireFreshPointer = false,
): Promise<ExecutionProjectResult | null> {
  if (usesDatabaseCatalog()) {
    return (await getWorkflowStorageServices().getRepository('execution')).loadLatestExecutionProject(
      endpointName,
      requireFreshPointer,
    );
  }

  return resolveLegacyLatestExecutionProject(endpointName);
}

export async function createExecutionProjectReferenceLoader(projectPath: string) {
  return delegate<ProjectReferenceLoader, 'execution'>(
    'execution',
    async (backend) => backend.createProjectReferenceLoader(),
    () => createLegacyExecutionProjectReferenceLoader(projectPath),
  );
}

export function createExecutionSubgraphProjectLoader() {
  return {
    async validateTarget(target: SubgraphProjectTarget): Promise<void> {
      await delegate(
        'execution',
        async (backend) => backend.validateSubgraphTarget?.(target),
        async () => {},
      );
    },
    async loadTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject> {
      return delegate(
        'execution',
        async (backend) => backend.loadSubgraphTarget(target),
        () => loadLegacySubgraphTarget(target),
      );
    },
  };
}

export async function persistWorkflowExecutionRecordingWithBackend(
  options: PersistWorkflowExecutionRecordingOptions,
  retainedCapture?: ExecutionRecorder,
): Promise<string | undefined> {
  // Every recording surface, including editor uploads and called-project runs,
  // must honor the same server-side dataset retention policy.
  const permittedOptions = shouldSnapshotWorkflowRecordingDatasets() ? options : { ...options, executedDatasets: [] };
  return await recordingMemory.prepared(
    [
      permittedOptions.recordingSerialized,
      permittedOptions.sourceProject,
      permittedOptions.executedProject,
      permittedOptions.executedAttachedData,
      permittedOptions.executedDatasets,
    ],
    async () => {
      if (usesDatabaseCatalog()) {
        return await (
          await getWorkflowStorageServices().getRepository('recordings')
        ).persistWorkflowExecutionRecording(permittedOptions);
      }
      return await persistWorkflowExecutionRecording({ workflowsRoot: getWorkflowsRoot(), ...permittedOptions });
    },
    retainedCapture,
  );
}

export function getWorkflowStorageMode() {
  return getWorkflowStorageBackendMode();
}
