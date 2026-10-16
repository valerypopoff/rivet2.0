import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { WorkflowLibraryPanel } from './WorkflowLibraryPanel';
import type {
  HostedRouteConfig,
  RecordingOpenResult,
  WorkflowProjectOpenOptions,
  WorkflowProjectPathMove,
} from './types';
import { useEditorBridgeSession } from './useEditorBridgeSession';
import { focusIframeElement } from './editorBridgeFocus';
import { useDashboardSidebar } from './useDashboardSidebar';
import { useEditorBridgeEvents } from './useEditorBridgeEvents';
import { fetchHostedConfig, fetchWorkflowTree } from './workflowApi';
import { normalizeWorkflowPath } from './workflowLibraryHelpers';
import type {
  ProjectCompareSideLabels,
  WorkflowProjectBindingReconciliationResult,
  WorkflowProjectContentChange,
  HostedProjectReconciliationContext,
  HostedProjectConflictSnapshot,
} from '../../studio-server-shared/editor-bridge';
import type {
  WorkflowFolderItem,
  WorkflowProjectEditorBinding,
  WorkflowProjectItem,
} from '../../studio-server-shared/workflow-types';
import { acceptConflictSnapshot, useHostedProjectConflictNotices } from './useHostedProjectConflictNotices';
import {
  RIVET_EXECUTOR_WS_URL,
  RIVET_LATEST_WEB_APPS_BASE_PATH,
  RIVET_LATEST_WORKFLOWS_BASE_PATH,
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
  RIVET_WEB_APPS_BASE_PATH,
} from '../../studio-server-shared/hosted-env';
import './DashboardPage.css';
import { DevelopmentUpdates } from './DevelopmentUpdates';
import { getDevelopmentGeneration } from './developmentRefreshGuard';
import { editorSource } from './editorSource';

const WORKFLOW_DASHBOARD_COLLAPSED_SIDEBAR_WIDTH = 30;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 560;
const RECORDING_OPEN_TIMEOUT_MS = 120_000;
const DEFAULT_HOSTED_ROUTE_CONFIG: HostedRouteConfig = {
  executorWsUrl: RIVET_EXECUTOR_WS_URL,
  remoteDebuggerDefaultWs: RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
  publishedWorkflowsBasePath: RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  latestWorkflowsBasePath: RIVET_LATEST_WORKFLOWS_BASE_PATH,
  internalPublishedWorkflowsBaseUrl: 'http://api/internal/workflows',
  internalLatestWorkflowsBaseUrl: 'http://api/internal/workflows-latest',
  publishedAppsBasePath: RIVET_WEB_APPS_BASE_PATH,
  latestAppsBasePath: RIVET_LATEST_WEB_APPS_BASE_PATH,
  webAppsAuthMode: 'ui-gate',
};

function resolveHostedRouteConfig(config: Partial<HostedRouteConfig>): HostedRouteConfig {
  return {
    executorWsUrl: config.executorWsUrl ?? DEFAULT_HOSTED_ROUTE_CONFIG.executorWsUrl,
    remoteDebuggerDefaultWs: config.remoteDebuggerDefaultWs ?? DEFAULT_HOSTED_ROUTE_CONFIG.remoteDebuggerDefaultWs,
    publishedWorkflowsBasePath:
      config.publishedWorkflowsBasePath || DEFAULT_HOSTED_ROUTE_CONFIG.publishedWorkflowsBasePath,
    latestWorkflowsBasePath: config.latestWorkflowsBasePath || DEFAULT_HOSTED_ROUTE_CONFIG.latestWorkflowsBasePath,
    internalPublishedWorkflowsBaseUrl:
      config.internalPublishedWorkflowsBaseUrl || DEFAULT_HOSTED_ROUTE_CONFIG.internalPublishedWorkflowsBaseUrl,
    internalLatestWorkflowsBaseUrl:
      config.internalLatestWorkflowsBaseUrl || DEFAULT_HOSTED_ROUTE_CONFIG.internalLatestWorkflowsBaseUrl,
    publishedAppsBasePath: config.publishedAppsBasePath || DEFAULT_HOSTED_ROUTE_CONFIG.publishedAppsBasePath,
    latestAppsBasePath: config.latestAppsBasePath || DEFAULT_HOSTED_ROUTE_CONFIG.latestAppsBasePath,
    webAppsAuthMode: config.webAppsAuthMode || DEFAULT_HOSTED_ROUTE_CONFIG.webAppsAuthMode,
  };
}

function findSubgraphProjects(
  folders: WorkflowFolderItem[],
  projects: WorkflowProjectItem[],
  projectId: string,
): WorkflowProjectItem[] {
  const matches = projects.filter((project) => project.projectMetadataId === projectId);
  for (const folder of folders) {
    matches.push(...findSubgraphProjects(folder.folders, folder.projects, projectId));
  }
  return matches;
}

export const DashboardPage: FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const pendingWorkflowProjectOpenPathRef = useRef<string | null>(null);
  const pendingWorkflowProjectOpenRequestIdRef = useRef<string | null>(null);
  const pendingWorkflowProjectOpenDeadlineRef = useRef(0);
  const editorInstanceRef = useRef<string | null>(null);
  const conflictSnapshotRef = useRef<HostedProjectConflictSnapshot | null>(null);
  const [conflictSnapshot, setConflictSnapshot] = useState<HostedProjectConflictSnapshot | null>(null);
  const [reconciliationSequence, setReconciliationSequence] = useState(0);
  const [openedProjectPath, setOpenedProjectPath] = useState('');
  const [activeWorkflowProjectPath, setActiveWorkflowProjectPath] = useState('');
  const [projectUnsavedChangesByPath, setProjectUnsavedChangesByPath] = useState<Record<string, boolean>>({});
  const [editorReady, setEditorReady] = useState(false);
  const [editorInitializationFailed, setEditorInitializationFailed] = useState(false);
  const [openProjectCount, setOpenProjectCount] = useState(0);
  const [projectSaveSequence, setProjectSaveSequence] = useState(0);
  const [routeConfig, setRouteConfig] = useState<HostedRouteConfig>(DEFAULT_HOSTED_ROUTE_CONFIG);
  const {
    session: editorSession,
    postCommand: postEditorCommand,
    ready: attachEditor,
  } = useEditorBridgeSession(iframeRef, () => setReconciliationSequence((sequence) => sequence + 1));
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

  const clearPendingWorkflowProjectOpen = useCallback((path?: string, requestId?: string) => {
    if (
      path &&
      pendingWorkflowProjectOpenPathRef.current &&
      normalizeWorkflowPath(path) !== normalizeWorkflowPath(pendingWorkflowProjectOpenPathRef.current)
    ) {
      return;
    }

    if (requestId && pendingWorkflowProjectOpenRequestIdRef.current !== requestId) {
      return;
    }

    pendingWorkflowProjectOpenPathRef.current = null;
    pendingWorkflowProjectOpenRequestIdRef.current = null;
    pendingWorkflowProjectOpenDeadlineRef.current = 0;
  }, []);

  const rememberPendingWorkflowProjectOpen = useCallback(
    (path: string, requestId?: string) => {
      const previous = pendingWorkflowProjectOpenRequestIdRef.current;
      if (previous) editorSession.cancelQueued(previous);
      clearPendingWorkflowProjectOpen();
      pendingWorkflowProjectOpenPathRef.current = path;
      pendingWorkflowProjectOpenRequestIdRef.current = requestId ?? null;
      pendingWorkflowProjectOpenDeadlineRef.current = Date.now() + 120_000;
    },
    [clearPendingWorkflowProjectOpen, editorSession],
  );

  const shouldIgnoreTransientActiveProjectPath = useCallback((path: string, requestId?: string) => {
    // Presentation intent can precede request admission. It must not suppress
    // active-tab events forever if the upstream lookup never produces a command.
    if (Date.now() >= pendingWorkflowProjectOpenDeadlineRef.current) return false;
    const pendingPath = pendingWorkflowProjectOpenPathRef.current;
    const pendingRequestId = pendingWorkflowProjectOpenRequestIdRef.current;
    return Boolean(
      pendingPath &&
        ((path && normalizeWorkflowPath(path) !== normalizeWorkflowPath(pendingPath)) ||
          (requestId && pendingRequestId && requestId !== pendingRequestId)),
    );
  }, []);

  const handleOpenProject = useCallback(
    (path: string, options?: WorkflowProjectOpenOptions) => {
      const requestId = editorSession.nextId('open-project');
      rememberPendingWorkflowProjectOpen(path, requestId);
      void editorSession
        .request(
          {
            type: 'open-project',
            path,
            replaceCurrent: Boolean(options?.replaceCurrent),
            title: options?.title,
            preview: options?.preview === true ? true : undefined,
            reloadFromDisk: options?.reloadFromDisk === true ? true : undefined,
            preferredGraphId: options?.preferredGraphId,
            expectedProjectId: options?.expectedProjectId,
            requestId,
          },
          'project-open-result',
          120_000,
        )
        .then((result) => {
          const stillCurrent = pendingWorkflowProjectOpenRequestIdRef.current === requestId;
          clearPendingWorkflowProjectOpen(path, requestId);
          if (
            stillCurrent &&
            result.status !== 'completed' &&
            result.status !== 'replaced' &&
            result.status !== 'closed'
          )
            toast.error(
              result.status === 'unknown'
                ? 'The editor has not confirmed opening the project. Check its tabs before trying again.'
                : 'The project could not be opened in the editor. Please try again.',
            );
        });
    },
    [editorSession, rememberPendingWorkflowProjectOpen, clearPendingWorkflowProjectOpen],
  );

  const handleWorkflowProjectOpenIntent = useCallback(
    (path: string) => {
      rememberPendingWorkflowProjectOpen(path);
    },
    [rememberPendingWorkflowProjectOpen],
  );

  const handleOpenSubgraphTarget = useCallback(
    async (projectId: string, graphId: string) => {
      try {
        const tree = await fetchWorkflowTree();
        const matches = findSubgraphProjects(tree.folders, tree.projects, projectId);
        if (matches.length !== 1) {
          throw new Error(
            matches.length === 0
              ? 'The selected Subgraph project is no longer available.'
              : 'More than one project has the selected Subgraph project ID. Resolve the duplicate before opening it.',
          );
        }
        const project = matches[0]!;
        handleOpenProject(project.absolutePath, {
          title: project.name,
          preferredGraphId: graphId,
          expectedProjectId: projectId,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not open the selected Subgraph project.');
      }
    },
    [handleOpenProject],
  );

  const handleWorkflowProjectOpenIntentCanceled = useCallback(
    (path: string) => {
      if (pendingWorkflowProjectOpenPathRef.current === path && pendingWorkflowProjectOpenRequestIdRef.current)
        editorSession.cancelQueued(pendingWorkflowProjectOpenRequestIdRef.current);
      clearPendingWorkflowProjectOpen(path);
    },
    [clearPendingWorkflowProjectOpen, editorSession],
  );

  const handleRefreshOpenProjectFromDisk = useCallback(
    (path: string) => {
      postEditorCommand({ type: 'refresh-open-project-from-disk', path });
    },
    [postEditorCommand],
  );

  const settlePendingRecordingOpen = useCallback(
    (requestId: string | undefined, result: RecordingOpenResult): boolean => {
      return editorSession.acknowledge(requestId, 'project-open-result', result);
    },
    [editorSession],
  );

  const handleOpenRecording = useCallback(
    (recordingId: string, options?: { replaceCurrent?: boolean }): Promise<RecordingOpenResult> => {
      const requestId = editorSession.nextId('open-recording');
      return editorSession
        .request<RecordingOpenResult>(
          {
            type: 'open-recording',
            recordingId,
            replaceCurrent: Boolean(options?.replaceCurrent),
            requestId,
          },
          'project-open-result',
          RECORDING_OPEN_TIMEOUT_MS,
        )
        .then((result) => {
          if (result.status === 'completed') return result.value;
          return {
            opened: false,
            error:
              result.status === 'unknown'
                ? 'The editor has not confirmed opening the recording. Check its tabs before trying again.'
                : 'The recording could not be opened in the editor. Please try again.',
          };
        });
    },
    [editorSession],
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

  const handleCompareOpenProjectWith = useCallback(
    (path: string, referencePath?: string, labels?: ProjectCompareSideLabels) => {
      postEditorCommand({
        type: 'compare-open-project-with',
        path,
        referencePath,
        labels,
      });
    },
    [postEditorCommand],
  );

  const requestDashboardProjectSave = useCallback(() => {
    postEditorCommand({ type: 'save-project' });
  }, [postEditorCommand]);

  const requestShortcutProjectSave = useCallback(() => {
    postEditorCommand({ type: 'save-project', source: 'shortcut' });
  }, [postEditorCommand]);

  const focusEditorFrame = useCallback(() => {
    focusIframeElement(iframeRef.current);
  }, []);

  const handleDeleteProject = useCallback(
    (path: string, projectId?: string | null) => {
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
    },
    [postEditorCommand],
  );

  const handleWorkflowPathsMovedApplied = useCallback(
    (requestId?: string) => {
      editorSession.acknowledge(requestId, 'paths-moved', undefined);
    },
    [editorSession],
  );

  const handleWorkflowProjectBindingsReconciled = useCallback(
    (result: WorkflowProjectBindingReconciliationResult, requestId?: string) => {
      editorSession.acknowledge(requestId, 'bindings-reconciled', result);
    },
    [editorSession],
  );

  const handleWorkflowPathsMoved = useCallback(
    (moves: WorkflowProjectPathMove[]) => {
      if (moves.length === 0) {
        return Promise.resolve();
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

      const requestId = editorSession.nextId('workflow-paths-moved');
      // The server move is already committed. The session signals the existing
      // tree reconciler if delivery is rejected or its outcome is unknown.
      return editorSession
        .request<void>({ type: 'workflow-paths-moved', moves, requestId }, 'paths-moved', 5_000)
        .then(() => undefined);
    },
    [editorSession],
  );

  const captureProjectReconciliation = useCallback(async (): Promise<HostedProjectReconciliationContext | null> => {
    if (!editorReady) return null;
    const requestId = editorSession.nextId('workflow-project-capture');
    const result = await editorSession.request<HostedProjectReconciliationContext>(
      { type: 'capture-workflow-project-reconciliation', requestId },
      'reconciliation-captured',
      5_000,
    );
    return result.status === 'completed' && result.value.editorInstanceId === editorInstanceRef.current
      ? result.value
      : null;
  }, [editorReady, editorSession]);

  const reconcileWorkflowProjectBindings = useCallback(
    async (
      bindings: WorkflowProjectEditorBinding[],
      context: HostedProjectReconciliationContext,
    ): Promise<WorkflowProjectBindingReconciliationResult> => {
      if (!editorReady || context.editorInstanceId !== editorInstanceRef.current)
        return { changes: [], status: 'retry' };
      const requestId = editorSession.nextId('workflow-project-bindings');
      const result = await editorSession.request<WorkflowProjectBindingReconciliationResult>(
        { type: 'reconcile-workflow-project-bindings', bindings, context, requestId },
        'bindings-reconciled',
        5_000,
      );
      return result.status === 'completed' ? result.value : { changes: [], status: 'retry' };
    },
    [editorReady, editorSession],
  );

  const resolveWorkflowProjectContentChange = useCallback(
    async (change: WorkflowProjectContentChange, resolution: 'reload' | 'keep-local'): Promise<boolean> => {
      if (!editorReady) return false;
      const requestId = editorSession.nextId('workflow-project-content-change');
      const result = await editorSession.request<boolean>(
        {
          type: 'resolve-workflow-project-content-change',
          changeId: change.changeId,
          projectId: change.projectId,
          path: change.path,
          revisionId: change.revisionId,
          resolution,
          requestId,
        },
        'content-change-resolved',
        10_000,
      );
      return result.status === 'completed' && result.value;
    },
    [editorReady, editorSession],
  );

  useHostedProjectConflictNotices(conflictSnapshot, resolveWorkflowProjectContentChange);

  const resetEditorReconciliation = useCallback(() => {
    editorInstanceRef.current = null;
    editorSession.detach();
    clearPendingWorkflowProjectOpen();
    conflictSnapshotRef.current = null;
    setConflictSnapshot(null);
    setEditorReady(false);
    setEditorInitializationFailed(false);
  }, [editorSession, clearPendingWorkflowProjectOpen]);

  useEffect(
    () => () => {
      clearPendingWorkflowProjectOpen();
    },
    [clearPendingWorkflowProjectOpen],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchHostedConfig()
      .then((config) => {
        if (!cancelled) {
          setRouteConfig(resolveHostedRouteConfig(config));
        }
      })
      .catch((error) => {
        console.warn('Failed to load hosted route config; using bundled defaults.', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEditorBridgeEvents({
    activeWorkflowProjectPath,
    editorReady,
    focusEditorFrame,
    onSaveShortcut: requestShortcutProjectSave,
    onOpenSubgraphTarget: handleOpenSubgraphTarget,
    iframeRef,
    onActiveWorkflowProjectPathChange: (path) => {
      if (shouldIgnoreTransientActiveProjectPath(path)) {
        return;
      }

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
    onEditorReady: (editorInstanceId) => {
      setEditorInitializationFailed(false);
      if (editorInstanceRef.current !== editorInstanceId) {
        resetEditorReconciliation();
        editorInstanceRef.current = editorInstanceId;
        setReconciliationSequence((sequence) => sequence + 1);
      }
      attachEditor(editorInstanceId);
      setEditorReady(true);
    },
    onEditorInitializationFailed: () => setEditorInitializationFailed(true),
    onReconciliationCaptured: (context, requestId) => {
      editorSession.acknowledge(requestId, 'reconciliation-captured', context);
    },
    onProjectConflicts: (snapshot) => {
      const previous = conflictSnapshotRef.current;
      const accepted = acceptConflictSnapshot(editorInstanceRef.current, previous, snapshot);
      if (accepted === previous) return;
      conflictSnapshotRef.current = accepted;
      setConflictSnapshot(accepted);
      if (accepted?.recheckSequence !== previous?.recheckSequence)
        setReconciliationSequence((sequence) => sequence + 1);
    },
    onOpenProjectCountChange: (count) => {
      setOpenProjectCount(count);
    },
    onProjectOpenFailed: (error, requestId) => {
      settlePendingRecordingOpen(requestId, { opened: false, error });
    },
    onProjectOpened: (path, requestId) => {
      const acknowledgedOpen = settlePendingRecordingOpen(requestId, { opened: true });
      if (requestId && !pendingWorkflowProjectOpenPathRef.current && !acknowledgedOpen) {
        return;
      }

      if (shouldIgnoreTransientActiveProjectPath(path, requestId)) {
        return;
      }

      clearPendingWorkflowProjectOpen(path, requestId);
      setOpenedProjectPath(path);
      setActiveWorkflowProjectPath(path);
    },
    onProjectSaved: (path, hasNewerUnsavedChanges = false) => {
      setProjectSaveSequence((prev) => prev + 1);
      setProjectUnsavedChangesByPath((prev) =>
        prev[path] === hasNewerUnsavedChanges
          ? prev
          : {
              ...prev,
              [path]: hasNewerUnsavedChanges,
            },
      );
    },
    onWorkflowPathsMovedApplied: handleWorkflowPathsMovedApplied,
    onWorkflowProjectBindingsReconciled: handleWorkflowProjectBindingsReconciled,
    onWorkflowProjectContentChangeResolved: (requestId, resolved) => {
      editorSession.acknowledge(requestId, 'content-change-resolved', resolved);
    },
  });

  const showEditorLoading = !editorReady && !editorInitializationFailed;
  const visibleSidebarWidth = sidebarCollapsed ? WORKFLOW_DASHBOARD_COLLAPSED_SIDEBAR_WIDTH : sidebarWidth;
  const activeProjectHasUnsavedChanges =
    activeWorkflowProjectPath !== '' && projectUnsavedChangesByPath[activeWorkflowProjectPath] === true;

  return (
    <div
      className={`dashboard-page${sidebarResizing ? ' dashboard-page-resizing' : ''}`}
      style={{ ['--workflow-dashboard-sidebar-width' as string]: `${visibleSidebarWidth}px` }}
    >
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
          onSaveProject={requestDashboardProjectSave}
          onDeleteProject={handleDeleteProject}
          onWorkflowPathsMoved={handleWorkflowPathsMoved}
          onReconcileWorkflowProjectBindings={reconcileWorkflowProjectBindings}
          onCaptureProjectReconciliation={captureProjectReconciliation}
          reconciliationSequence={reconciliationSequence}
          onWorkflowProjectOpenIntent={handleWorkflowProjectOpenIntent}
          onWorkflowProjectOpenIntentCanceled={handleWorkflowProjectOpenIntentCanceled}
          onActiveWorkflowProjectPathChange={setActiveWorkflowProjectPath}
          openedProjectPath={openedProjectPath}
          activeProjectHasUnsavedChanges={activeProjectHasUnsavedChanges}
          editorReady={editorReady}
          projectSaveSequence={projectSaveSequence}
          collapsed={sidebarCollapsed}
          contentVisible={sidebarContentVisible}
          onToggleCollapse={handleToggleSidebar}
          routeConfig={routeConfig}
          onRouteConfigChange={setRouteConfig}
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
        <DevelopmentUpdates iframeRef={iframeRef} editorReady={editorReady} />
        {showEditorLoading ? (
          <div className="dashboard-app-loading">
            <div className="dashboard-editor-loading-spinner" aria-hidden="true" />
            <div className="dashboard-editor-loading-message">Loading...</div>
          </div>
        ) : null}
        {openProjectCount === 0 && !editorInitializationFailed ? (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-state-message">
              Open or create a Rivet project in the left pane to start editing.
            </div>
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src={editorSource(document, getDevelopmentGeneration())}
          onLoad={() => {
            // Bootstrap messages may precede load; retain this document's result.
            const state = iframeRef.current?.contentWindow?.__rivetEditorBootstrapState;
            if (state === 'failed') {
              setEditorReady(false);
              setEditorInitializationFailed(true);
            } else if (state !== 'ready') resetEditorReconciliation();
          }}
          className={`dashboard-editor-frame ${openProjectCount === 0 && !editorInitializationFailed ? 'dashboard-editor-frame-hidden' : ''}${sidebarResizing ? ' dashboard-editor-frame-resizing' : ''}`}
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
