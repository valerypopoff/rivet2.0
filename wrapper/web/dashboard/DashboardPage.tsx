import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import type { WorkflowProjectOpenOptions, WorkflowProjectPathMove } from './types';
import { useEditorCommandQueue } from './useEditorCommandQueue';
import { focusIframeElement } from './editorBridgeFocus';
import { useDashboardSidebar } from './useDashboardSidebar';
import { useEditorBridgeEvents } from './useEditorBridgeEvents';
import type { ProjectCompareSideLabels } from '../../shared/editor-bridge';
import './DashboardPage.css';

const WORKFLOW_DASHBOARD_COLLAPSED_SIDEBAR_WIDTH = 30;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [openedProjectPath, setOpenedProjectPath] = useState('');
  const [activeWorkflowProjectPath, setActiveWorkflowProjectPath] = useState('');
  const [projectUnsavedChangesByPath, setProjectUnsavedChangesByPath] = useState<Record<string, boolean>>({});
  const [editorReady, setEditorReady] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [projectSaveSequence, setProjectSaveSequence] = useState(0);
  const postEditorCommand = useEditorCommandQueue(iframeRef, editorReady);
  const {
    handleResizeMouseDown,
    handleResizePointerDown,
    handleToggleSidebar,
    handleSidebarTransitionEnd,
    sidebarCollapsed,
    sidebarContentVisible,
    sidebarResizing,
    sidebarWidth,
  } = useDashboardSidebar({
    maxWidth: MAX_SIDEBAR_WIDTH,
    minWidth: MIN_SIDEBAR_WIDTH,
  });

  const handleOpenProject = useCallback((path: string, options?: WorkflowProjectOpenOptions) => {
    postEditorCommand({
      type: 'open-project',
      path,
      replaceCurrent: Boolean(options?.replaceCurrent),
      title: options?.title,
      preview: options?.preview === true ? true : undefined,
      reloadFromDisk: options?.reloadFromDisk === true ? true : undefined,
    });
  }, [postEditorCommand]);

  const handleRefreshOpenProjectFromDisk = useCallback((path: string) => {
    postEditorCommand({ type: 'refresh-open-project-from-disk', path });
  }, [postEditorCommand]);

  const handleOpenRecording = useCallback(
    (recordingId: string, options?: { replaceCurrent?: boolean }) => {
      postEditorCommand({
        type: 'open-recording',
        recordingId,
        replaceCurrent: Boolean(options?.replaceCurrent),
      });
    },
    [postEditorCommand],
  );

  const handleOpenPublishedVersionPreview = useCallback(
    (relativePath: string, versionId: string, options?: { replaceCurrent?: boolean }) => {
      postEditorCommand({
        type: 'open-published-version-preview',
        relativePath,
        versionId,
        replaceCurrent: Boolean(options?.replaceCurrent),
      });
    },
    [postEditorCommand],
  );

  const handleCompareOpenProjectWith = useCallback((
    path: string,
    referencePath?: string,
    labels?: ProjectCompareSideLabels,
  ) => {
    postEditorCommand({
      type: 'compare-open-project-with',
      path,
      referencePath,
      labels,
    });
  }, [postEditorCommand]);

  const handleSaveProject = useCallback(() => {
    postEditorCommand({ type: 'save-project' });
  }, [postEditorCommand]);

  const focusEditorFrame = useCallback(() => {
    focusIframeElement(iframeRef.current);
  }, []);

  const handleDeleteProject = useCallback((path: string, projectId?: string | null) => {
    setOpenedProjectPath((prev) => (prev === path ? '' : prev));
    setProjectUnsavedChangesByPath((prev) => {
      if (!(path in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[path];
      return next;
    });
    postEditorCommand({ type: 'delete-workflow-project', path, projectId });
  }, [postEditorCommand]);

  const handleWorkflowPathsMoved = useCallback(
    (moves: WorkflowProjectPathMove[]) => {
      if (moves.length === 0) {
        return;
      }

      setOpenedProjectPath((prev) => moves.find((move) => move.fromAbsolutePath === prev)?.toAbsolutePath ?? prev);
      setProjectUnsavedChangesByPath((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const move of moves) {
          if (!(move.fromAbsolutePath in next)) {
            continue;
          }

          next[move.toAbsolutePath] = next[move.fromAbsolutePath] ?? false;
          delete next[move.fromAbsolutePath];
          changed = true;
        }

        return changed ? next : prev;
      });
      postEditorCommand({ type: 'workflow-paths-moved', moves });
    },
    [postEditorCommand],
  );
  useEditorBridgeEvents({
    activeWorkflowProjectPath,
    editorReady,
    focusEditorFrame,
    handleSaveProject,
    iframeRef,
    onActiveWorkflowProjectPathChange: (path) => {
      setOpenedProjectPath(path);
      setActiveWorkflowProjectPath(path);
    },
    onActiveProjectUnsavedChangesChange: (path, hasUnsavedChanges) => {
      setProjectUnsavedChangesByPath((prev) => {
        if (path === '') {
          return prev;
        }

        if (prev[path] === hasUnsavedChanges) {
          return prev;
        }

        return {
          ...prev,
          [path]: hasUnsavedChanges,
        };
      });
    },
    onEditorReady: () => {
      setEditorReady(true);
    },
    onOpenProjectCountChange: (count) => {
      setOpenProjectCount(count);
    },
    onProjectOpenFailed: () => {
    },
    onProjectOpened: (path) => {
      setOpenedProjectPath(path);
      setActiveWorkflowProjectPath(path);
    },
    onProjectSaved: (path) => {
      setProjectSaveSequence((prev) => prev + 1);
      setProjectUnsavedChangesByPath((prev) => (
        prev[path] === false
          ? prev
          : {
              ...prev,
              [path]: false,
            }
      ));
    },
  });

  const showEditorLoading = !editorReady;
  const visibleSidebarWidth = sidebarCollapsed ? WORKFLOW_DASHBOARD_COLLAPSED_SIDEBAR_WIDTH : sidebarWidth;
  const activeProjectHasUnsavedChanges =
    activeWorkflowProjectPath !== '' && projectUnsavedChangesByPath[activeWorkflowProjectPath] === true;

  return (
    <div
      className={`dashboard-page${sidebarResizing ? ' dashboard-page-resizing' : ''}`}
      style={{ ['--workflow-dashboard-sidebar-width' as string]: `${visibleSidebarWidth}px` }}
    >
      {showEditorLoading ? (
        <div className="dashboard-app-loading">
          <div className="dashboard-editor-loading-spinner" aria-hidden="true" />
          <div className="dashboard-editor-loading-message">Loading...</div>
        </div>
      ) : null}
      <aside
        className={`dashboard-sidebar${sidebarCollapsed ? ' dashboard-sidebar-collapsed' : ''}${sidebarResizing ? ' dashboard-sidebar-resizing' : ''}`}
        onTransitionEnd={handleSidebarTransitionEnd}
      >
        <WorkflowLibraryPanel
          onOpenProject={handleOpenProject}
          onRefreshOpenProjectFromDisk={handleRefreshOpenProjectFromDisk}
          onOpenRecording={handleOpenRecording}
          onOpenPublishedVersionPreview={handleOpenPublishedVersionPreview}
          onCompareOpenProjectWith={handleCompareOpenProjectWith}
          onSaveProject={handleSaveProject}
          onDeleteProject={handleDeleteProject}
          onWorkflowPathsMoved={handleWorkflowPathsMoved}
          onActiveWorkflowProjectPathChange={setActiveWorkflowProjectPath}
          openedProjectPath={openedProjectPath}
          activeProjectHasUnsavedChanges={activeProjectHasUnsavedChanges}
          editorReady={editorReady}
          projectSaveSequence={projectSaveSequence}
          collapsed={sidebarCollapsed}
          contentVisible={sidebarContentVisible}
          onToggleCollapse={handleToggleSidebar}
        />
      </aside>
      {!sidebarCollapsed || sidebarResizing ? (
        <div
          className="dashboard-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize folders pane"
          onMouseDown={handleResizeMouseDown}
          onPointerDown={handleResizePointerDown}
        />
      ) : null}
      <main className="dashboard-main">
        {openProjectCount === 0 ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">Open or create a Rivet project in the left pane to start editing.</div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src="/?editor"
          onLoad={() => setEditorReady(false)}
          className={`dashboard-editor-frame ${openProjectCount === 0 ? 'dashboard-editor-frame-hidden' : ''}${sidebarResizing ? ' dashboard-editor-frame-resizing' : ''}`}
        />
      </main>
      <ToastContainer
        position="bottom-center"
        hideProgressBar
        newestOnTop
        closeButton={false}
        icon={false}
        toastClassName="dashboard-toast"
        bodyClassName="dashboard-toast-body"
      />
    </div>
  );
};
