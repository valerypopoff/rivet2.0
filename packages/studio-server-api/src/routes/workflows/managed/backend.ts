import type { WorkflowRecordingPageQuery } from '../data-backend.js';
import type { PreparedProjectBundleImport } from '../project-bundle-import.js';
import { importManagedProjectBundle } from './bundle-import.js';
import { createManagedBundleService } from './bundles.js';
import { validateManagedSubgraphTarget } from './subgraph-access.js';
import { isLegacyRestorePaused } from '../../../legacy-restore/service.js';
import { createManagedProject } from './project-creation.js';
import { recoverMutationByHash } from './namespace-receipts.js';
import { prepareProjectBundleImport } from '../project-bundle-import.js';
import { previousStructuralResult } from './structural-admission.js';
import { captureOperation } from './namespace-receipts.js';
import type {
  WorkflowFolderItem,
  WorkflowEndpointAccess,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowProjectPathMove,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../studio-server-shared/workflow-types.js';
import type {
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingWorkflowListResponse,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
} from '../../../../../studio-server-shared/workflow-recording-types.js';
import type { RuntimeHealthCheckContext } from '../../../runtime-health.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import type { ManagedWorkflowOperations, ManagedWorkflowOperationsFactory } from './operations.js';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import { createManagedWorkflowCatalogService } from './catalog.js';
import { mutateManagedNamespace, recoverManagedNamespace } from './namespace-mutations.js';
import type { WorkflowNamespaceMutation } from '../../../../../studio-server-shared/workflow-namespace-types.js';
import {
  listManagedReconciliationFindingDetails,
  type ManagedReconciliationFindingDetailQuery,
} from './reconciliation.js';
import { createManagedWorkflowContext } from './context.js';
import type { ManagedExecutionProjectResult, ManagedWebAppAccessPolicy } from './execution-types.js';
import type { ResolvedSubgraphProject, SubgraphProjectTarget } from '@valerypopoff/rivet2-node';
import { ManagedWorkflowExecutionService } from './execution-service.js';
import { createManagedWorkflowPublicationService } from './publication.js';
import { createManagedWorkflowRecordingService } from './recordings.js';
import { createManagedWorkflowRevisionService } from './revisions.js';
import { readManagedWorkflowMigrationSnapshot } from './migration-snapshot.js';
import type { WorkflowDataBackend } from '../data-backend.js';
import type {
  ImportManagedWorkflowOptions,
  ImportManagedWorkflowRecordingOptions,
  ManagedWorkflowMigrationSnapshot,
  LoadHostedProjectResult,
  PersistWorkflowExecutionRecordingOptions,
  SaveHostedProjectResult,
} from './types.js';

export { resolveManagedHostedProjectSaveTarget } from './revision-factory.js';

export class ManagedWorkflowBackend implements WorkflowDataBackend {
  readonly bundles;
  readonly #context;
  readonly #executionService: ManagedWorkflowExecutionService;
  readonly #catalog: ReturnType<typeof createManagedWorkflowCatalogService>;
  readonly #revisions: ReturnType<typeof createManagedWorkflowRevisionService>;
  readonly #publication: ReturnType<typeof createManagedWorkflowPublicationService>;
  readonly #recordings: ReturnType<typeof createManagedWorkflowRecordingService>;
  #operations?: ManagedWorkflowOperations;
  readonly #createOperations?: ManagedWorkflowOperationsFactory;
  #retiring = false;
  readonly #runBackgroundTasks: boolean;
  #phase: 'open' | 'draining' | 'closed' = 'open';
  #initializing?: Promise<void>;
  #draining?: Promise<void>;
  #disposing?: Promise<void>;

  constructor(
    config: ManagedWorkflowStorageConfig,
    blobStore?: ManagedWorkflowBlobStore,
    options?: { migrationMode?: 'copy' | 'verify' | 'restore'; createOperations?: ManagedWorkflowOperationsFactory },
  ) {
    this.#runBackgroundTasks = options?.migrationMode === undefined && !isLegacyRestorePaused();
    this.#context = createManagedWorkflowContext(config, blobStore, options);
    this.bundles = createManagedBundleService(this.#context);
    this.#executionService = new ManagedWorkflowExecutionService({
      context: this.#context,
    });
    this.#revisions = createManagedWorkflowRevisionService({
      context: this.#context,
    });
    this.#catalog = createManagedWorkflowCatalogService({
      context: this.#context,
    });
    this.#publication = createManagedWorkflowPublicationService({
      context: this.#context,
    });
    this.#recordings = createManagedWorkflowRecordingService({
      context: this.#context,
    });
    this.#createOperations = options?.createOperations;
  }

  async #getOperations(): Promise<ManagedWorkflowOperations> {
    if (!this.#createOperations) throw new Error('Operational stores are unavailable outside serving composition.');
    await this.initialize();
    return this.#ensureOperations();
  }

  #ensureOperations(): ManagedWorkflowOperations {
    if (this.#operations) return this.#operations;
    // A late getter must not create producers after retirement has progressed
    // to drain/disposal. The storage owner already holds this backend, so a
    // factory failure cannot abandon its persistence resources.
    if (this.#phase !== 'open') throw new Error('Managed workflow storage is shutting down.');
    const operations = this.#createOperations!({
      pool: this.#context.pool,
      backgroundTasks: this.#runBackgroundTasks,
      sources: {
        createProjectReferenceLoader: () => this.#executionService.createProjectReferenceLoader(),
        loadSubgraphTarget: (target) => this.#executionService.loadSubgraphTarget(target),
        validateSubgraphTarget: (target) => this.validateSubgraphTarget(target),
      },
    });
    this.#operations = operations;
    if (this.#retiring) operations.coordinator?.beginRetirement();
    return operations;
  }

  async initialize(): Promise<void> {
    if (this.#phase === 'closed' || (this.#phase === 'draining' && !this.#initializing)) {
      throw new Error('Managed workflow storage is shutting down.');
    }
    // Migration verification must not run startup retention or start a
    // scheduler against an offline destination being compared byte-for-byte.
    return (this.#initializing ??= (async () => {
      // The resource owner already holds this backend before initialize() is
      // called. Keep serving stores available for accepted shutdown flushes,
      // while making factory failures observable through owned initialization.
      if (this.#createOperations) this.#ensureOperations();
      if (this.#runBackgroundTasks) await this.#recordings.initialize();
      else await this.#context.initialize();
      // The server starts workers after runtime libraries are ready. Opening
      // storage for startup, health or an HTTP request must not execute graphs.
    })());
  }

  async dispose(): Promise<void> {
    return (this.#disposing ??= (async () => {
      await this.drain();
      this.#phase = 'closed';
      await this.#context.dispose();
    })());
  }

  async drain(): Promise<void> {
    this.#phase = this.#phase === 'closed' ? 'closed' : 'draining';
    return (this.#draining ??= (async () => {
      await this.#initializing?.catch(() => undefined);
      await this.#operations?.coordinator?.stop();
    })());
  }
  beginRetirement(): void {
    this.#retiring = true;
    this.#operations?.coordinator?.beginRetirement();
  }
  async drainAcceptedWork(): Promise<void> {
    await this.#operations?.coordinator?.drainAcceptedWork();
  }

  async checkHealth(context?: RuntimeHealthCheckContext): Promise<void> {
    await this.#context.checkHealth(context);
  }

  async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
    return this.#catalog.getTree();
  }

  async importProjectBundle(parent: string, bundle: PreparedProjectBundleImport) {
    await this.initialize();
    return importManagedProjectBundle(this.#context, parent, bundle);
  }

  async listProjectPathsForHostedIo(): Promise<string[]> {
    return this.#catalog.listProjectPathsForHostedIo();
  }

  async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
    return this.#revisions.loadHostedProject(projectPath);
  }

  async saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
    projectId?: string;
    saveIntent?: 'in-place' | 'save-as';
    structuralMutation?: import('../../../../../studio-server-shared/workflow-mutation-contract.js').StructuralMutation;
  }): Promise<SaveHostedProjectResult> {
    return this.#revisions.saveHostedProject(options);
  }

  async importWorkflow(options: ImportManagedWorkflowOptions): Promise<WorkflowProjectItem> {
    return this.#revisions.importWorkflow(options);
  }

  async readWorkflowMigrationSnapshot(relativePath: string): Promise<ManagedWorkflowMigrationSnapshot | null> {
    return readManagedWorkflowMigrationSnapshot(this.#context, relativePath);
  }

  async readHostedText(filePath: string): Promise<string> {
    return this.#catalog.readHostedText(filePath);
  }

  async hostedPathExists(filePath: string): Promise<boolean> {
    return this.#catalog.hostedPathExists(filePath);
  }

  async resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string> {
    return this.#catalog.resolveManagedRelativeProjectText(relativeFrom, projectFilePath);
  }

  async createWorkflowFolderItem(name: string, parentRelativePath: string) {
    return this.#catalog.createWorkflowFolderItem(name, parentRelativePath);
  }

  async mutateStructural(
    command: import('../../../../../studio-server-shared/workflow-mutation-contract.js').StructuralCommand,
    mutation: import('../../../../../studio-server-shared/workflow-mutation-contract.js').StructuralMutation,
  ) {
    switch (command.operation) {
      case 'create-folder':
        return this.#catalog.createWorkflowFolderItem(command.input.name, command.input.parentRelativePath, mutation);
      case 'create-project':
      case 'copy-project':
      case 'upload-project':
        return createManagedProject(this.#context, command, mutation);
      case 'create-bundle':
        return this.bundles.create(command.input.name, command.input.parentRelativePath, mutation);
      case 'bundle-kind':
        return this.bundles.setKind(
          command.input.relativePath,
          command.input.enabled,
          command.input.namespaceId,
          mutation,
        );
      case 'delete-bundle':
        return this.bundles.delete(
          command.input.bundleId,
          { name: command.input.name, relativePath: command.input.relativePath },
          mutation,
        );
      case 'copy-bundle':
        return this.bundles.duplicate(command.input.bundleId, {
          automatic: true,
          relativePath: command.input.relativePath,
          mutation,
        });
      case 'import-bundle': {
        const captured = captureOperation(
          { command, mutation },
          (input) => input.mutation,
          (input) => input.command,
        );
        const snapshot = captured.input;
        const previous = await previousStructuralResult(this.#context, captured.admission);
        if (previous.state === 'committed') return previous.result;
        return importManagedProjectBundle(
          this.#context,
          snapshot.command.input.parentRelativePath,
          prepareProjectBundleImport(snapshot.command.input.files),
          snapshot.mutation,
          snapshot.command,
          captured.admission,
        );
      }
    }
  }

  async recoverStructural(operationId: string, hash: string) {
    await this.initialize();
    return recoverMutationByHash(this.#context.pool, operationId, hash);
  }

  mutateNamespace(request: WorkflowNamespaceMutation) {
    return mutateManagedNamespace(this.#context, request);
  }
  recoverNamespace(request: WorkflowNamespaceMutation) {
    return recoverManagedNamespace(this.#context, request);
  }

  async renameWorkflowFolderItem(
    relativePath: string,
    newName: string,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowFolderItem(relativePath, newName);
  }

  async moveWorkflowFolder(
    sourceRelativePath: string,
    destinationFolderRelativePath: string,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath);
  }

  async deleteWorkflowFolderItem(relativePath: string): Promise<void> {
    return this.#catalog.deleteWorkflowFolderItem(relativePath);
  }

  async createWorkflowProjectItem(folderRelativePath: string, name: string): Promise<WorkflowProjectItem> {
    return this.#catalog.createWorkflowProjectItem(folderRelativePath, name);
  }

  async renameWorkflowProjectItem(
    relativePath: string,
    newName: string,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.renameWorkflowProjectItem(relativePath, newName);
  }

  async moveWorkflowProject(
    sourceRelativePath: string,
    destinationFolderRelativePath: string,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
    return this.#catalog.moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath);
  }

  async duplicateWorkflowProjectItem(
    relativePath: string,
    version: WorkflowProjectDownloadVersion = 'live',
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.duplicateWorkflowProjectItem(relativePath, version);
  }

  async uploadWorkflowProjectItem(
    folderRelativePath: string,
    fileName: string,
    contents: string,
  ): Promise<WorkflowProjectItem> {
    return this.#catalog.uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
  }

  async readWorkflowProjectDownload(
    relativePath: string,
    version: WorkflowProjectDownloadVersion,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#catalog.readWorkflowProjectDownload(relativePath, version);
  }

  async readWorkflowProjectReferenceSnapshots(relativePath: string) {
    return this.#catalog.readWorkflowProjectReferenceSnapshots(relativePath);
  }
  async listWorkflowProjectReferenceCatalog() {
    return this.#catalog.listWorkflowProjectReferenceCatalog();
  }

  async getLLMProfileHealthStore() {
    return (await this.#getOperations()).profileHealth;
  }

  async getManagedReconciliationStatus() {
    await this.initialize();
    return this.#context.getReconciliationStatus();
  }

  async listManagedReconciliationFindingDetails(query: ManagedReconciliationFindingDetailQuery) {
    await this.initialize();
    return listManagedReconciliationFindingDetails(this.#context.pool, query);
  }

  async getEvaluationStore() {
    return (await this.#getOperations()).evaluations;
  }

  async getHostedEvaluationCoordinator() {
    if (!this.#createOperations) {
      throw new Error('Hosted Evaluation coordination is unavailable in migration mode.');
    }
    const { coordinator } = await this.#getOperations();
    if (!coordinator) throw new Error('Hosted Evaluation coordination is unavailable in migration mode.');
    return coordinator;
  }

  async listWorkflowPublishedVersions(relativePath: string): Promise<WorkflowPublishedVersionsResponse> {
    return this.#publication.listWorkflowPublishedVersions(relativePath);
  }

  async readWorkflowPublishedVersionDownload(
    relativePath: string,
    versionId: string,
  ): Promise<{ contents: string; fileName: string }> {
    return this.#publication.readWorkflowPublishedVersionDownload(relativePath, versionId);
  }

  async readWorkflowPublishedVersionPreview(
    relativePath: string,
    versionId: string,
  ): Promise<{ contents: string; datasetsContents: string | null }> {
    return this.#publication.readWorkflowPublishedVersionPreview(relativePath, versionId);
  }

  async setWorkflowPublishedVersionStar(
    relativePath: string,
    versionId: string,
    isStarred: boolean,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionStar(relativePath, versionId, isStarred);
  }

  async setWorkflowPublishedVersionComment(
    relativePath: string,
    versionId: string,
    comment: string,
  ): Promise<WorkflowPublishedVersionSummary> {
    return this.#publication.setWorkflowPublishedVersionComment(relativePath, versionId, comment);
  }

  async restoreWorkflowPublishedVersion(
    relativePath: string,
    versionId: string,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowPublishedVersionRestoreResponse> {
    return this.#publication.restoreWorkflowPublishedVersion(relativePath, versionId, preconditions);
  }

  async publishWorkflowProjectItem(
    relativePath: string,
    settings: WorkflowProjectSettingsDraft,
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectItem(relativePath, settings, preconditions);
  }

  async updateWorkflowEndpointAccess(
    relativePath: string,
    access: WorkflowEndpointAccess,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.updateWorkflowEndpointAccess(relativePath, access, preconditions);
  }

  async listWorkflowProjectWebApps(relativePath: string): Promise<WorkflowProjectWebAppsResponse> {
    return this.#publication.listWorkflowProjectWebApps(relativePath);
  }

  async publishWorkflowProjectWebApps(
    relativePath: string,
    publications: WorkflowProjectWebAppPublicationDraft[],
    preconditions: WorkflowDraftPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.publishWorkflowProjectWebApps(relativePath, publications, preconditions);
  }

  async updateWorkflowProjectWebAppAccess(
    relativePath: string,
    accessUpdates: WorkflowProjectWebAppAccessDraft[],
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.updateWorkflowProjectWebAppAccess(relativePath, accessUpdates, preconditions);
  }

  async unpublishWorkflowProjectWebApp(
    relativePath: string,
    uiGraphId: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectWebApp(relativePath, uiGraphId, preconditions);
  }

  async unpublishWorkflowProjectItem(
    relativePath: string,
    preconditions: WorkflowPublicationPreconditions,
  ): Promise<WorkflowProjectItem> {
    return this.#publication.unpublishWorkflowProjectItem(relativePath, preconditions);
  }

  async deleteWorkflowProjectItem(relativePath: string): Promise<string | null> {
    return this.#catalog.deleteWorkflowProjectItem(relativePath);
  }

  async loadPublishedExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedExecutionProject(endpointName, requireFreshPointer);
  }

  async loadLatestExecutionProject(
    endpointName: string,
    requireFreshPointer = false,
  ): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestExecutionProject(endpointName, requireFreshPointer);
  }

  async loadPublishedWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadPublishedWebAppExecutionProject(slug);
  }

  async loadLatestWebAppExecutionProject(slug: string): Promise<ManagedExecutionProjectResult | null> {
    await this.initialize();
    return this.#executionService.loadLatestWebAppExecutionProject(slug);
  }

  async resolveWebAppAccessPolicy(slug: string): Promise<ManagedWebAppAccessPolicy | null> {
    await this.initialize();
    return this.#executionService.resolveWebAppAccessPolicy(slug);
  }

  createProjectReferenceLoader() {
    return this.#executionService.createProjectReferenceLoader();
  }

  async loadSubgraphTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject> {
    await this.initialize();
    return this.#executionService.loadSubgraphTarget(target);
  }

  async validateSubgraphTarget(target: SubgraphProjectTarget): Promise<void> {
    await this.initialize();
    await validateManagedSubgraphTarget(this.#context.pool, target);
  }

  async importWorkflowRecording(options: ImportManagedWorkflowRecordingOptions): Promise<void> {
    return this.#recordings.importWorkflowRecording(options);
  }

  async cleanupWorkflowRecordings(): Promise<void> {
    return this.#recordings.cleanupWorkflowRecordingStorage();
  }

  async listWorkflowRecordingWorkflows(): Promise<WorkflowRecordingWorkflowListResponse> {
    return this.#recordings.listWorkflowRecordingWorkflows();
  }

  async listWorkflowRecordingRunsPage(query: WorkflowRecordingPageQuery): Promise<WorkflowRecordingRunsPageResponse> {
    const {
      workflowId,
      page,
      pageSize,
      statusFilter = 'all',
      inputFilter = null,
      inputCursor = 0,
      signal,
      inputAfter,
      includeSubgraphRuns = false,
      runScope = inputFilter ? 'roots' : 'all',
    } = query;
    return this.#recordings.listWorkflowRecordingRunsPage(
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
    );
  }

  async listWorkflowRunStatisticsCatalog(
    surface: WorkflowRunStatisticsSurface,
  ): Promise<WorkflowRunStatisticsCatalogResponse> {
    return this.#recordings.listWorkflowRunStatisticsCatalog(surface);
  }

  async getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery): Promise<WorkflowRunStatisticsResponse> {
    return this.#recordings.getWorkflowRunStatistics(query);
  }

  async readWorkflowRecordingArtifact(
    recordingId: string,
    artifact: 'recording' | 'replay-project' | 'replay-dataset',
  ): Promise<string> {
    return this.#recordings.readWorkflowRecordingArtifact(recordingId, artifact);
  }

  async getWorkflowRecordingSummary(recordingId: string) {
    return this.#recordings.getWorkflowRecordingSummary(recordingId);
  }

  async deleteWorkflowRecording(recordingId: string): Promise<void> {
    return this.#recordings.deleteWorkflowRecording(recordingId);
  }

  async persistWorkflowExecutionRecording(
    options: PersistWorkflowExecutionRecordingOptions,
  ): Promise<string | undefined> {
    return this.#recordings.persistWorkflowExecutionRecording(options);
  }
}
