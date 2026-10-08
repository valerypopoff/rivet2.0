import Button from '@atlaskit/button';
import RecordingIcon from 'majesticons/line/video-line.svg?react';
import SettingsCogIcon from 'majesticons/line/settings-cog-line.svg?react';
import ScheduleIcon from 'majesticons/line/calendar-line.svg?react';
import type { Dispatch, FC, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import { ScheduledRunsModal } from './ScheduledRunsModal';
import { requestScheduledRuns } from './scheduledRunApi';
import type { ScheduledRunSummary } from '../../studio-server-shared/scheduled-run-types';
import { ActiveProjectSection } from './ActiveProjectSection';
import { WorkflowFolderTree } from './WorkflowFolderTree';
import { WorkflowLibraryContextMenus } from './WorkflowLibraryContextMenus';
import { WorkflowLibraryModals } from './WorkflowLibraryModals';
import type {
  HostedRouteConfig,
  RecordingOpenResult,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
} from './types';
import { getParentRelativePath } from './workflowLibraryHelpers';
import { getWorkflowProjectDotStatus } from './workflowProjectPublicationStatus';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';
import type {
  ProjectCompareSideLabels,
  WorkflowProjectBindingReconciliationResult,
  HostedProjectReconciliationContext,
} from '../../studio-server-shared/editor-bridge';
import type { WorkflowProjectEditorBinding } from '../../studio-server-shared/workflow-types';
import './WorkflowLibraryPanel.css';

interface WorkflowLibraryPanelProps {
  onOpenProject: (path: string, options?: WorkflowProjectOpenOptions) => void;
  onRefreshOpenProjectFromDisk: (path: string) => void;
  onOpenRecording: (recordingId: string, options?: { replaceCurrent?: boolean }) => Promise<RecordingOpenResult>;
  onOpenPublishedVersionPreview: (
    relativePath: string,
    versionId: string,
    options?: { replaceCurrent?: boolean },
  ) => void;
  onCompareOpenProjectWith: (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => void;
  onSaveProject: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onWorkflowPathsMoved: (moves: WorkflowProjectPathMove[]) => Promise<void> | void;
  onReconcileWorkflowProjectBindings: (
    bindings: WorkflowProjectEditorBinding[],
    context: HostedProjectReconciliationContext,
  ) => Promise<WorkflowProjectBindingReconciliationResult>;
  onCaptureProjectReconciliation: () => Promise<HostedProjectReconciliationContext | null>;
  reconciliationSequence: number;
  onWorkflowProjectOpenIntent: (path: string) => void;
  onWorkflowProjectOpenIntentCanceled: (path: string) => void;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  openedProjectPath: string;
  activeProjectHasUnsavedChanges: boolean;
  editorReady: boolean;
  projectSaveSequence: number;
  collapsed: boolean;
  contentVisible: boolean;
  onToggleCollapse: () => void;
  routeConfig: HostedRouteConfig;
  onRouteConfigChange?: Dispatch<SetStateAction<HostedRouteConfig>>;
}

const SidebarOpenIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <rect x="2.75" y="3.5" width="10.5" height="9" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
    <path d="M5.25 4.75v6.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
  </svg>
);

const SidebarExpandIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path
      d="M6 4.5 9.5 8 6 11.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
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
  onReconcileWorkflowProjectBindings,
  onCaptureProjectReconciliation,
  reconciliationSequence,
  onWorkflowProjectOpenIntent,
  onWorkflowProjectOpenIntentCanceled,
  onActiveWorkflowProjectPathChange,
  openedProjectPath,
  activeProjectHasUnsavedChanges,
  editorReady,
  projectSaveSequence,
  collapsed,
  contentVisible,
  onToggleCollapse,
  routeConfig,
  onRouteConfigChange,
}) => {
  const [scheduledRunsOpen, setScheduledRunsOpen] = useState(false);
  const [enabledScheduleCount, setEnabledScheduleCount] = useState<number | null>(null);
  useEffect(() => {
    if (scheduledRunsOpen) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        if (!document.hidden) {
          const result = await requestScheduledRuns<ScheduledRunSummary>(
            '/summary',
            'GET',
            undefined,
            controller.signal,
          );
          if (!controller.signal.aborted)
            setEnabledScheduleCount(
              Number.isSafeInteger(result.enabledCount) && result.enabledCount >= 0 ? result.enabledCount : null,
            );
        }
      } catch {
        if (!controller.signal.aborted) setEnabledScheduleCount(null);
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 30_000);
      }
    };
    const onVisibilityChange = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [scheduledRunsOpen]);
  const controller = useWorkflowLibraryController({
    onOpenProject,
    onRefreshOpenProjectFromDisk,
    onOpenRecording,
    onOpenPublishedVersionPreview,
    onCompareOpenProjectWith,
    onDeleteProject,
    onWorkflowPathsMoved,
    onReconcileWorkflowProjectBindings,
    onCaptureProjectReconciliation,
    reconciliationSequence,
    onWorkflowProjectOpenIntent,
    onWorkflowProjectOpenIntentCanceled,
    onActiveWorkflowProjectPathChange,
    openedProjectPath,
    editorReady,
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
    onProjectPreviewOpen,
    onProjectPersistentOpen,
    setProjectRowRef,
    openRunRecordingsModal,
    setRunStatisticsOpen,
    setPublishedItemsOpen,
    runRecordingsRetained,
    runRecordingsFoundCount,
    setAppSettingsOpen,
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
  const openedProjectDotStatus = openedWorkflowProject ? getWorkflowProjectDotStatus(openedWorkflowProject) : null;

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
          <span className="header-title">Rivet Studio Server</span>
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
        >
          {bodyContent}
          <div className="body-actions">
            <button type="button" className="link-button" onClick={() => void handleCreateFolder()}>
              + New folder
            </button>
          </div>
        </div>

        <div className="panel-bottom-actions">
          <div className={`panel-bottom-action-with-summary${runRecordingsRetained ? ' has-summary' : ''}`}>
            <Button
              appearance="subtle"
              className="panel-bottom-button project-settings-secondary-button button-size-m"
              onClick={openRunRecordingsModal}
              title="Browse workflow run recordings and load them into the editor"
            >
              <span className="panel-bottom-button-icon" aria-hidden="true">
                <RecordingIcon />
              </span>
              <span className="panel-bottom-button-label">Run recordings</span>
            </Button>
            {runRecordingsRetained ? (
              <div className="panel-bottom-action-summary">Found: {runRecordingsFoundCount}</div>
            ) : null}
          </div>
          <Button
            appearance="subtle"
            className="panel-bottom-button project-settings-secondary-button button-size-m"
            onClick={() => setRunStatisticsOpen(true)}
            title="Compare recorded workflow and web app execution time"
          >
            <span className="panel-bottom-button-label">Run statistics</span>
          </Button>
          <Button
            appearance="subtle"
            className="panel-bottom-button project-settings-secondary-button button-size-m"
            onClick={() => setPublishedItemsOpen(true)}
            title="Browse published workflow endpoints and web apps"
          >
            <span className="panel-bottom-button-label">Published</span>
          </Button>
          <div className={`panel-bottom-action-with-summary${enabledScheduleCount ? ' has-summary' : ''}`}>
            <Button
              appearance="subtle"
              className="panel-bottom-button project-settings-secondary-button button-size-m"
              onClick={() => setScheduledRunsOpen(true)}
              title="Schedule saved projects to run automatically"
            >
              <span className="panel-bottom-button-icon" aria-hidden="true">
                <ScheduleIcon />
              </span>
              <span className="panel-bottom-button-label">Scheduled runs</span>
            </Button>
            {enabledScheduleCount ? (
              <div
                className="panel-bottom-action-summary"
                aria-label={`${enabledScheduleCount} enabled scheduled runs`}
              >
                Enabled: {enabledScheduleCount}
              </div>
            ) : null}
          </div>
          <Button
            appearance="subtle"
            className="panel-bottom-button project-settings-secondary-button button-size-m"
            onClick={() => setAppSettingsOpen(true)}
            title="Open app settings"
          >
            <span className="panel-bottom-button-icon" aria-hidden="true">
              <SettingsCogIcon />
            </span>
            <span className="panel-bottom-button-label">Settings</span>
          </Button>
        </div>

        <WorkflowLibraryContextMenus controller={controller} />
        <WorkflowLibraryModals
          scheduledRunsOpen={scheduledRunsOpen}
          controller={controller}
          routeConfig={routeConfig}
          onRouteConfigChange={onRouteConfigChange}
        />
        {scheduledRunsOpen ? (
          <ScheduledRunsModal
            projects={controller.allProjects}
            onClose={() => setScheduledRunsOpen(false)}
            onOpenRecording={onOpenRecording}
            onEnabledCountChange={setEnabledScheduleCount}
          />
        ) : null}
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
          {openedProjectDotStatus ? (
            <span className={`collapsed-strip-status-dot ${openedProjectDotStatus}`} aria-hidden="true" />
          ) : null}
        </button>
      ) : null}
    </div>
  );
};
