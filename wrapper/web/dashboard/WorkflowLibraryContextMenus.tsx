import type { FC } from 'react';
import { WorkflowFolderContextMenu } from './WorkflowFolderContextMenu';
import { WorkflowProjectContextMenu } from './WorkflowProjectContextMenu';
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
          onRename={() => void handleRenameFolderFromContextMenu()}
          onCreateProject={() => void handleCreateProjectFromContextMenu()}
          onUploadProject={() => void handleUploadProjectFromFolder()}
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
          canDelete={projectContextMenuState.project.settings.status === 'unpublished'}
          onDelete={() => void handleDeleteProjectFromContextMenu()}
        />
      ) : null}
    </>
  );
};
