import type { FC } from 'react';
import { WorkflowFolderContextMenu } from './WorkflowFolderContextMenu';
import { WorkflowProjectContextMenu } from './WorkflowProjectContextMenu';
import { isWorkflowProjectFullyUnpublished } from './projectSettingsForm';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';

type WorkflowLibraryController = ReturnType<typeof useWorkflowLibraryController>;

export const WorkflowLibraryContextMenus: FC<{
  controller: WorkflowLibraryController;
}> = ({ controller }) => {
  const {
    folderContextMenuState,
    projectContextMenuState,
    closeFolderContextMenu,
    closeProjectContextMenu,
    handleRenameFolderFromContextMenu,
    handleCreateFolderFromContextMenu,
    handleCreateProjectFromContextMenu,
    handleUploadProjectFromFolder,
    handleDeleteFolderFromContextMenu,
    handleRenameProjectFromContextMenu,
    handleDownloadProject,
    handleDuplicateProject,
    handleCompareProjectFromContextMenu,
    canCompareWithProject,
    handleCompareOpenedProjectToPublishedVersionFromContextMenu,
    canCompareOpenedProjectToPublishedVersion,
    handleDeleteProjectFromContextMenu,
    isFolderEmpty,
  } = controller;

  return (
    <>
      {folderContextMenuState ? (
        <WorkflowFolderContextMenu
          key={`${folderContextMenuState.folder.relativePath}:${folderContextMenuState.x}:${folderContextMenuState.y}`}
          isOpen
          folder={folderContextMenuState.folder}
          x={folderContextMenuState.x}
          y={folderContextMenuState.y}
          onClose={closeFolderContextMenu}
          canDelete={isFolderEmpty(folderContextMenuState.folder)}
          bundleActions={
            controller.explicitBundles
              ? {
                  canConvert:
                    Boolean(folderContextMenuState.folder.bundleId) ||
                    !controller.bundleFolders.some(
                      (folder) =>
                        folder.bundleId &&
                        (folderContextMenuState.folder.relativePath.startsWith(`${folder.relativePath}/`) ||
                          folder.relativePath.startsWith(`${folderContextMenuState.folder.relativePath}/`)),
                    ),
                  convert: () => void controller.handleToggleBundleKind(),
                  duplicate: controller.handleDuplicateBundle,
                  download: controller.handleDownloadBundle,
                }
              : undefined
          }
          onRename={() => void handleRenameFolderFromContextMenu()}
          onCreateFolder={() => void handleCreateFolderFromContextMenu()}
          onCreateProject={() => void handleCreateProjectFromContextMenu()}
          onUploadProject={() => void handleUploadProjectFromFolder()}
          onUploadBundle={
            controller.canUploadBundleToFolder(folderContextMenuState.folder)
              ? controller.handleUploadBundleFromFolder
              : undefined
          }
          onDelete={() => void handleDeleteFolderFromContextMenu()}
        />
      ) : null}
      {projectContextMenuState ? (
        <WorkflowProjectContextMenu
          key={`${projectContextMenuState.project.relativePath}:${projectContextMenuState.x}:${projectContextMenuState.y}`}
          isOpen
          project={projectContextMenuState.project}
          x={projectContextMenuState.x}
          y={projectContextMenuState.y}
          onClose={closeProjectContextMenu}
          onRename={() => void handleRenameProjectFromContextMenu()}
          onDownload={() => void handleDownloadProject()}
          onDuplicate={() => void handleDuplicateProject()}
          canCompare={canCompareWithProject(projectContextMenuState.project)}
          onCompare={() => void handleCompareProjectFromContextMenu()}
          canCompareToPublishedVersion={canCompareOpenedProjectToPublishedVersion(projectContextMenuState.project)}
          onCompareToPublishedVersion={() => void handleCompareOpenedProjectToPublishedVersionFromContextMenu()}
          canDelete={isWorkflowProjectFullyUnpublished(projectContextMenuState.project)}
          onDelete={() => void handleDeleteProjectFromContextMenu()}
        />
      ) : null}
    </>
  );
};
