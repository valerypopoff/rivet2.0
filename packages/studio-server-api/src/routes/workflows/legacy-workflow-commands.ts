import type { WorkflowProjectRepository, WorkflowPublicationRepository } from './data-backend.js';
import type {
  WorkflowProjectDownloadVersion,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowProjectPathMove,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
} from '../../../../studio-server-shared/workflow-types.js';
import { ensureWorkflowsRoot, requireProjectPath, resolveWorkflowRelativePath } from './fs-helpers.js';
import { moveWorkflowFolder, moveWorkflowProject } from './workflow-query.js';
import {
  createWorkflowFolderItem,
  createWorkflowProjectItem,
  deleteWorkflowFolderItem,
  deleteWorkflowProjectItem,
  duplicateWorkflowProjectItem,
  publishWorkflowProjectItem,
  updateWorkflowEndpointAccess,
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
  listFilesystemProjectReferenceCatalog,
  readFilesystemProjectReferenceSnapshots,
} from './project-reference-snapshots.js';
import {
  listWorkflowPublishedVersions,
  readWorkflowPublishedVersionDownload,
  readWorkflowPublishedVersionPreview,
  restoreWorkflowPublishedVersion,
  setWorkflowPublishedVersionComment,
  setWorkflowPublishedVersionStar,
} from './published-versions.js';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import {
  withFilesystemWorkflowStorageRead,
  withFilesystemWorkflowStorageWrite,
} from './filesystem-project-transactions.js';
import type { RivetStudioEvaluationStore } from '../../evaluation-runs/store.js';
export type LegacyWorkflowCommands = Pick<
  WorkflowProjectRepository & WorkflowPublicationRepository,
  | 'createWorkflowFolderItem'
  | 'renameWorkflowFolderItem'
  | 'deleteWorkflowFolderItem'
  | 'createWorkflowProjectItem'
  | 'renameWorkflowProjectItem'
  | 'duplicateWorkflowProjectItem'
  | 'uploadWorkflowProjectItem'
  | 'readWorkflowProjectDownload'
  | 'readWorkflowProjectReferenceSnapshots'
  | 'listWorkflowProjectReferenceCatalog'
  | 'listWorkflowPublishedVersions'
  | 'readWorkflowPublishedVersionDownload'
  | 'readWorkflowPublishedVersionPreview'
  | 'setWorkflowPublishedVersionStar'
  | 'setWorkflowPublishedVersionComment'
  | 'restoreWorkflowPublishedVersion'
  | 'publishWorkflowProjectItem'
  | 'updateWorkflowEndpointAccess'
  | 'listWorkflowProjectWebApps'
  | 'publishWorkflowProjectWebApps'
  | 'updateWorkflowProjectWebAppAccess'
  | 'unpublishWorkflowProjectWebApp'
  | 'unpublishWorkflowProjectItem'
  | 'deleteWorkflowProjectItem'
  | 'moveWorkflowProject'
  | 'moveWorkflowFolder'
>;

export function createLegacyWorkflowCommands(hooks: {
  markFilesystemExecutionStructureDirty(projectPaths?: Iterable<string>): void;
  invalidateFilesystemExecutionMove(moves: WorkflowProjectPathMove[]): void;
  resetFilesystemLLMProfileHealthForProject(projectId: ProjectId): Promise<void>;
  getEvaluationStore(): Promise<RivetStudioEvaluationStore>;
}): LegacyWorkflowCommands {
  const {
    markFilesystemExecutionStructureDirty,
    invalidateFilesystemExecutionMove,
    resetFilesystemLLMProfileHealthForProject,
    getEvaluationStore,
  } = hooks;
  return {
    async createWorkflowFolderItem(name: string, parentRelativePath: string) {
      return withFilesystemWorkflowStorageWrite(() => createWorkflowFolderItem(name, parentRelativePath));
    },
    async renameWorkflowFolderItem(relativePath: string, newName: string) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const result = await renameWorkflowFolderItem(relativePath, newName);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);

        return result;
      });
    },
    async deleteWorkflowFolderItem(relativePath: string) {
      return withFilesystemWorkflowStorageWrite(() => deleteWorkflowFolderItem(relativePath));
    },
    async createWorkflowProjectItem(folderRelativePath: string, name: string) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await createWorkflowProjectItem(folderRelativePath, name);
        markFilesystemExecutionStructureDirty();
        return project;
      });
    },
    async renameWorkflowProjectItem(relativePath: string, newName: string) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const result = await renameWorkflowProjectItem(relativePath, newName);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);
        return result;
      });
    },
    async duplicateWorkflowProjectItem(relativePath: string, version: WorkflowProjectDownloadVersion) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await duplicateWorkflowProjectItem(relativePath, version);
        markFilesystemExecutionStructureDirty();
        return project;
      });
    },
    async uploadWorkflowProjectItem(folderRelativePath: string, fileName: string, contents: string) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await uploadWorkflowProjectItem(folderRelativePath, fileName, contents);
        markFilesystemExecutionStructureDirty();
        return project;
      });
    },
    async readWorkflowProjectDownload(relativePath: string, version: WorkflowProjectDownloadVersion) {
      return withFilesystemWorkflowStorageRead(() => readWorkflowProjectDownload(relativePath, version));
    },
    async readWorkflowProjectReferenceSnapshots(relativePath: string) {
      return withFilesystemWorkflowStorageRead(() => readFilesystemProjectReferenceSnapshots(relativePath));
    },
    async listWorkflowProjectReferenceCatalog() {
      return withFilesystemWorkflowStorageRead(listFilesystemProjectReferenceCatalog);
    },
    async listWorkflowPublishedVersions(relativePath: string) {
      return withFilesystemWorkflowStorageRead(() => listWorkflowPublishedVersions(relativePath));
    },
    async readWorkflowPublishedVersionDownload(relativePath: string, versionId: string) {
      return withFilesystemWorkflowStorageRead(() => readWorkflowPublishedVersionDownload(relativePath, versionId));
    },
    async readWorkflowPublishedVersionPreview(relativePath: string, versionId: string) {
      return withFilesystemWorkflowStorageRead(() => readWorkflowPublishedVersionPreview(relativePath, versionId));
    },
    async setWorkflowPublishedVersionStar(relativePath: string, versionId: string, isStarred: boolean) {
      return withFilesystemWorkflowStorageWrite(() =>
        setWorkflowPublishedVersionStar(relativePath, versionId, isStarred),
      );
    },
    async setWorkflowPublishedVersionComment(relativePath: string, versionId: string, comment: string) {
      return withFilesystemWorkflowStorageWrite(() =>
        setWorkflowPublishedVersionComment(relativePath, versionId, comment),
      );
    },
    async restoreWorkflowPublishedVersion(
      relativePath: string,
      versionId: string,
      preconditions: WorkflowDraftPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const root = await ensureWorkflowsRoot();
        const projectPath = requireProjectPath(
          resolveWorkflowRelativePath(root, relativePath, {
            allowProjectFile: true,
          }),
        );
        return restoreWorkflowPublishedVersion(relativePath, versionId, preconditions, () => {
          markFilesystemExecutionStructureDirty([projectPath]);
        });
      });
    },
    async publishWorkflowProjectItem(
      relativePath: string,
      settings: WorkflowProjectSettingsDraft,
      preconditions: WorkflowDraftPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await publishWorkflowProjectItem(relativePath, settings, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async updateWorkflowEndpointAccess(
      relativePath: string,
      access: 'public' | 'internal',
      preconditions: WorkflowPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await updateWorkflowEndpointAccess(relativePath, access, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async listWorkflowProjectWebApps(relativePath: string) {
      return withFilesystemWorkflowStorageRead(() => listWorkflowProjectWebApps(relativePath));
    },
    async publishWorkflowProjectWebApps(
      relativePath: string,
      publications: WorkflowProjectWebAppPublicationDraft[],
      preconditions: WorkflowDraftPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await publishWorkflowProjectWebApps(relativePath, publications, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async updateWorkflowProjectWebAppAccess(
      relativePath: string,
      accessUpdates: WorkflowProjectWebAppAccessDraft[],
      preconditions: WorkflowPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await updateWorkflowProjectWebAppAccess(relativePath, accessUpdates, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async unpublishWorkflowProjectWebApp(
      relativePath: string,
      uiGraphId: string,
      preconditions: WorkflowPublicationPreconditions,
    ) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await unpublishWorkflowProjectWebApp(relativePath, uiGraphId, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async unpublishWorkflowProjectItem(relativePath: string, preconditions: WorkflowPublicationPreconditions) {
      return withFilesystemWorkflowStorageWrite(async () => {
        const project = await unpublishWorkflowProjectItem(relativePath, preconditions);
        markFilesystemExecutionStructureDirty([project.absolutePath]);
        return project;
      });
    },
    async deleteWorkflowProjectItem(relativePath: string) {
      return withFilesystemWorkflowStorageWrite(async () => {
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
              await (await getEvaluationStore()).deleteProject(projectMetadataId as ProjectId);
            }
          },
        });
        markFilesystemExecutionStructureDirty([resolvedPath]);
        return projectId;
      });
    },
    async moveWorkflowProject(sourceRelativePath, destinationFolderRelativePath) {
      const root = await ensureWorkflowsRoot();
      return withFilesystemWorkflowStorageWrite(async () => {
        const result = await moveWorkflowProject(root, sourceRelativePath, destinationFolderRelativePath);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);
        return result;
      });
    },
    async moveWorkflowFolder(sourceRelativePath, destinationFolderRelativePath) {
      const root = await ensureWorkflowsRoot();
      return withFilesystemWorkflowStorageWrite(async () => {
        const result = await moveWorkflowFolder(root, sourceRelativePath, destinationFolderRelativePath);
        invalidateFilesystemExecutionMove(result.movedProjectPaths);
        return result;
      });
    },
  };
}
