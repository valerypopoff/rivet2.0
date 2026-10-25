import { type FC, useCallback, useState } from 'react';
import {
  type FileMenuItemId,
  RivetAppHost,
  type RivetAppHostUiConfig,
  type RivetAppHostOpenErrorEvent,
  type RivetAppHostProjectSavedEvent,
  type RivetWorkspaceHost,
} from '../../app/src/host';
import { EditorMessageBridge, type SavedProjectSignal } from './EditorMessageBridge';
import {
  RIVET_EXECUTOR_WS_URL,
  RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
  normalizeRuntimeWebSocketUrl,
} from '../../studio-server-shared/hosted-env';
import { fetchHostedConfig } from './workflowApi';
import { postMessageToDashboard } from '../../studio-server-shared/editor-bridge';
import { hostedRivetProviders } from './hostedRivetProviders';
import { useReconcileHostedProjectTitleAfterSave } from './useReconcileHostedProjectTitleAfterSave';
import { subscribeToOtherHostedSurface } from './useHostedSurfaceDismiss';

const HOSTED_FILE_MENU_VISIBLE_ITEMS = [
  'import_graph',
  'export_graph',
  'settings',
  'get_help',
] as const satisfies readonly FileMenuItemId[];

const HOSTED_RIVET_UI = {
  checkForUpdates: false,
  preloadCodeEditor: false,
  debuggerConnection: {
    getDefaultUrl: () => RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
    normalizeUrl: normalizeRuntimeWebSocketUrl,
  },
  nodeClipboard: { useHoveredNodeFallback: true, nativeEvents: true },
  contextMenu: {
    subscribeToExternalDismiss: subscribeToOtherHostedSurface,
    releaseFocus: (menu) => {
      const activeElement = menu?.ownerDocument.activeElement;
      if (activeElement && menu?.contains(activeElement) && 'blur' in activeElement) {
        (activeElement as HTMLElement).blur();
      }
    },
  },
  fileMenu: {
    visibleItems: HOSTED_FILE_MENU_VISIBLE_ITEMS,
  },
  webApps: {
    desktopPreview: false,
  },
  keyboardShortcuts: {
    saveProject: true,
  },
  projectTabs: {
    showFileNames: false,
  },
  projectSettings: {
    showProjectReferences: false,
  },
} satisfies RivetAppHostUiConfig;

export const HostedEditorApp: FC = () => {
  const resolveInternalHostedExecutorUrl = useCallback(async () => {
    const config = await fetchHostedConfig({ signal: AbortSignal.timeout(10_000) });
    if (config.executorWsUrlIsOverride !== false || !config.executorWsUrl)
      throw new Error('Automatic executor owner discovery unavailable.');
    return config.executorWsUrl;
  }, []);
  const [workspaceHost, setWorkspaceHost] = useState<RivetWorkspaceHost | null>(null);
  const [savedProjectSignal, setSavedProjectSignal] = useState<SavedProjectSignal | null>(null);
  const reconcileHostedProjectTitleAfterSave = useReconcileHostedProjectTitleAfterSave(workspaceHost);

  const handleProjectSaved = useCallback(
    (event: RivetAppHostProjectSavedEvent) => {
      reconcileHostedProjectTitleAfterSave(event);
      setSavedProjectSignal({ projectId: event.project.metadata.id });

      if (!event.path) {
        return;
      }

      postMessageToDashboard({
        type: 'project-saved',
        hasNewerUnsavedChanges: event.hasNewerUnsavedChanges,
        path: event.path,
      });
    },
    [reconcileHostedProjectTitleAfterSave],
  );

  const handleActiveProjectChanged = useCallback((event: { path: string | null }) => {
    postMessageToDashboard({
      type: 'active-project-path-changed',
      path: event.path ?? '',
    });
  }, []);

  const handleOpenProjectCountChanged = useCallback((event: { count: number }) => {
    postMessageToDashboard({
      type: 'open-project-count-changed',
      count: event.count,
    });
  }, []);

  const handleOpenError = useCallback((event: RivetAppHostOpenErrorEvent) => {
    console.error('Rivet host open operation failed:', event);
  }, []);
  const handleInitializationError = useCallback(() => {
    // No raw storage/authentication diagnostics cross the iframe boundary.
    postMessageToDashboard({ type: 'editor-initialization-failed' });
  }, []);

  const handleWorkspaceHostReady = useCallback((host: RivetWorkspaceHost) => {
    setWorkspaceHost(host);
  }, []);

  const handleWorkspaceHostDisposed = useCallback((host: RivetWorkspaceHost) => {
    setWorkspaceHost((currentHost) => (currentHost === host ? null : currentHost));
  }, []);

  return (
    <RivetAppHost
      executor={{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL, resolveInternalHostedExecutorUrl }}
      providers={hostedRivetProviders}
      ui={HOSTED_RIVET_UI}
      onActiveProjectChanged={handleActiveProjectChanged}
      onOpenError={handleOpenError}
      onInitializationError={handleInitializationError}
      onOpenProjectCountChanged={handleOpenProjectCountChanged}
      onProjectSaved={handleProjectSaved}
      onWorkspaceHostDisposed={handleWorkspaceHostDisposed}
      onWorkspaceHostReady={handleWorkspaceHostReady}
    >
      {workspaceHost ? (
        <EditorMessageBridge savedProjectSignal={savedProjectSignal} workspaceHost={workspaceHost} />
      ) : null}
    </RivetAppHost>
  );
};
