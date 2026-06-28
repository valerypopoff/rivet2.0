import Button from '@atlaskit/button';
import type { FC } from 'react';
import { ActiveProjectSection } from './ActiveProjectSection';
import { WorkflowFolderTree } from './WorkflowFolderTree';
import { WorkflowLibraryContextMenus } from './WorkflowLibraryContextMenus';
import { WorkflowLibraryModals } from './WorkflowLibraryModals';
import type { HostedRouteConfig, WorkflowProjectOpenOptions, WorkflowProjectPathMove } from './types';
import { getParentRelativePath } from './workflowLibraryHelpers';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';
import type { ProjectCompareSideLabels } from '../../shared/editor-bridge';
import './WorkflowLibraryPanel.css';

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: WorkflowProjectOpenOptions) => void;
  onRefreshOpenProjectFromDisk: (path: string) => void;
  onOpenRecording: (recordingId: string, options?: { replaceCurrent?: boolean }) => void;
  onOpenPublishedVersionPreview: (
    relativePath: string,
    versionId: string,
    options?: { replaceCurrent?: boolean },
  ) => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  onSaveProject: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => Promise<void> | void;
  onWorkflowProjectOpenIntent: (path: string) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  activeProjectHasUnsavedChanges: boolean;
  editorReady: boolean;
  projectSaveSequence: number;
  collapsed: boolean;
  contentVisible: boolean;
  onToggleCollapse: () => void;
  routeConfig: HostedRouteConfig;
}

const SidebarOpenIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <rect x="2.75" y="3.5" width="10.5" height="9" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
    <path d="M5.25 4.75v6.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
  </svg>
);

const SidebarExpandIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path d="M6 4.5 9.5 8 6 11.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
  </svg>
);

export const WorkflowLibraryPanel: FC<WorkflowLibraryPanelProps> = ({
  onOpenProject,
  onRefreshOpenProjectFromDisk,
  onOpenRecording,
  onOpenPublishedVersionPreview,
  onCompareOpenProjectWith,
  onSaveProject,
  onDeleteProject,
  onWorkflowPathsMoved,
  onWorkflowProjectOpenIntent,
  onActiveWorkflowProjectPathChange,
  openedProjectPath,
  activeProjectHasUnsavedChanges,
  editorReady,
  projectSaveSequence,
  collapsed,
  contentVisible,
  onToggleCollapse,
  routeConfig,
}) => {
  const controller = useWorkflowLibraryController({
    onOpenProject,
    onRefreshOpenProjectFromDisk,
    onOpenRecording,
    onOpenPublishedVersionPreview,
    onCompareOpenProjectWith,
    onDeleteProject,
    onWorkflowPathsMoved,
    onWorkflowProjectOpenIntent,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    projectSaveSequence,
  });

  const {
    folders,
    rootProjects,
    folderIds,
    activePath,
    openedWorkflowProject,
    activeProject,
    loading,
    error,
    expandedFolders,
    draggedItem,
    dropTargetFolderPath,
    editingFolderId,
    renamingFolderId,
    editingProjectPath,
    renamingProjectPath,
    dragOverRoot,
    isActiveProjectOpen,
    handleCreateFolder,
    handleOpenSettings,
    handleProjectContextMenu,
    handleFolderContextMenu,
    handleDragStart,
    handleDragEnd,
    handleFolderRowClick,
    handleFolderRowKeyDown,
    handleProjectRowKeyDown,
    handleSubmitFolderRename,
    handleCancelFolderRename,
    handleSubmitProjectRename,
    handleCancelProjectRename,
    handleFolderDragOver,
    handleFolderDrop,
    handleFolderDragLeave,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    handlePanelBodyClick,
    onProjectPreviewOpen,
    onProjectPersistentOpen,
    setProjectRowRef,
    setAboutOpen,
    setRuntimeLibsOpen,
    openRunRecordingsModal,
    runRecordingsRetained,
    runRecordingsFoundCount,
  } = controller;

  let bodyContent: JSX.Element | null = null;
  if (loading) {
    bodyContent = <div className="state">Loading folders...</div>;
  } else if (error) {
    bodyContent = <div className="state">{error}</div>;
  } else if (folderIds.length === 0 && rootProjects.length === 0) {
    bodyContent = <div className="state">No workflow projects yet. Use + New folder to create the first folder.</div>;
  } else {
    bodyContent = (
      <WorkflowFolderTree
        folders={folders}
        rootProjects={rootProjects}
        activePath={activePath}
        draggedItem={draggedItem}
        dropTargetFolderPath={dropTargetFolderPath}
        editingFolderId={editingFolderId}
        renamingFolderId={renamingFolderId}
        editingProjectPath={editingProjectPath}
        renamingProjectPath={renamingProjectPath}
        expandedFolders={expandedFolders}
        editorReady={editorReady}
        setProjectRowRef={setProjectRowRef}
        onProjectPreviewOpen={onProjectPreviewOpen}
        onProjectPersistentOpen={onProjectPersistentOpen}
        onProjectContextMenu={handleProjectContextMenu}
        onFolderContextMenu={handleFolderContextMenu}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onFolderClick={handleFolderRowClick}
        onFolderKeyDown={handleFolderRowKeyDown}
        onProjectKeyDown={handleProjectRowKeyDown}
        onFolderRenameSubmit={handleSubmitFolderRename}
        onFolderRenameCancel={handleCancelFolderRename}
        onProjectRenameSubmit={handleSubmitProjectRename}
        onProjectRenameCancel={handleCancelProjectRename}
        onFolderDragOver={handleFolderDragOver}
        onFolderDrop={(folder) => (event) => void handleFolderDrop(folder)(event)}
        onFolderDragLeave={handleFolderDragLeave}
        getParentRelativePath={getParentRelativePath}
      />
    );
  }

  const panelContentVisible = contentVisible && !collapsed;
  const openedProjectStatus = openedWorkflowProject?.settings.status ?? null;

  return (
    <div className="workflow-library-panel">
      <div
        className={`workflow-library-panel-content${panelContentVisible ? '' : ' workflow-library-panel-content-hidden'}`}
        aria-hidden={panelContentVisible ? undefined : true}
      >
        <button
          type="button"
          className="header"
          onClick={onToggleCollapse}
          title="Collapse folders pane"
          aria-label="Collapse folders pane"
          aria-expanded={collapsed ? 'false' : 'true'}
          tabIndex={panelContentVisible ? undefined : -1}
        >
          <span className="header-collapse-icon">
            <SidebarOpenIcon />
          </span>
          <span className="header-title">Rivet Projects</span>
        </button>

        <div className="active-project-slot">
          <ActiveProjectSection
            activeProject={activeProject}
            isCurrentlyOpen={isActiveProjectOpen}
            hasUnsavedChanges={activeProjectHasUnsavedChanges}
            editorReady={editorReady}
            onSave={onSaveProject}
            onOpenSettings={handleOpenSettings}
          />
        </div>

        <div
          className={`body${dragOverRoot ? ' drag-over-root' : ''}`}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={(event) => void handleRootDrop(event)}
          onClick={handlePanelBodyClick}
        >
          {!editorReady ? <div className="body-status body-status-top">Loading editor...</div> : null}
          {bodyContent}
          <div className="body-actions">
            <button type="button" className="link-button" onClick={() => void handleCreateFolder()}>
              + New folder
            </button>
          </div>
        </div>

        <div className="panel-bottom-actions">
          <Button
            appearance="subtle"
            className="panel-bottom-button project-settings-secondary-button button-size-m"
            onClick={() => setRuntimeLibsOpen(true)}
            title="Manage runtime libraries available to Code nodes"
          >
            Runtime libraries
          </Button>
          <div className={`panel-bottom-action-with-summary${runRecordingsRetained ? ' has-summary' : ''}`}>
            <Button
              appearance="subtle"
              className="panel-bottom-button project-settings-secondary-button button-size-m"
              onClick={openRunRecordingsModal}
              title="Browse workflow run recordings and load them into the editor"
            >
              Run recordings
            </Button>
            {runRecordingsRetained ? (
              <div className="panel-bottom-action-summary">Found: {runRecordingsFoundCount}</div>
            ) : null}
          </div>
          <Button
            appearance="subtle"
            className="panel-bottom-button project-settings-secondary-button button-size-m"
            onClick={() => setAboutOpen(true)}
            title="Show version information"
          >
            About
          </Button>
        </div>

        <WorkflowLibraryContextMenus controller={controller} />
        <WorkflowLibraryModals controller={controller} routeConfig={routeConfig} />
      </div>

      {collapsed ? (
        <button
          type="button"
          className="collapsed-strip-button"
          onClick={onToggleCollapse}
          title="Expand folders pane"
          aria-label="Expand folders pane"
          aria-expanded="false"
        >
          <SidebarExpandIcon />
          {openedProjectStatus ? (
            <span
              className={`collapsed-strip-status-dot ${openedProjectStatus}`}
              aria-hidden="true"
            />
          ) : null}
        </button>
      ) : null}
    </div>
  );
};
