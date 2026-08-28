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
import { RIVET_EXECUTOR_WS_URL } from '../../studio-server-shared/hosted-env';
import { postMessageToDashboard } from '../../studio-server-shared/editor-bridge';
import { hostedRivetProviders } from './hostedRivetProviders';
import { useReconcileHostedProjectTitleAfterSave } from './useReconcileHostedProjectTitleAfterSave';

const HOSTED_FILE_MENU_VISIBLE_ITEMS = [
  'import_graph',
  'export_graph',
  'settings',
  'get_help',
] as const satisfies readonly FileMenuItemId[];

const HOSTED_RIVET_UI = {
  fileMenu: {
    visibleItems: HOSTED_FILE_MENU_VISIBLE_ITEMS,
  },
  webApps: {
    desktopPreview: false,
  },
  keyboardShortcuts: {
    saveProject: true,
  },
} satisfies RivetAppHostUiConfig;

export const HostedEditorApp: FC = () => {
  const [workspaceHost, setWorkspaceHost] = useState<RivetWorkspaceHost | null>(null);
  const [savedProjectSignal, setSavedProjectSignal] = useState<SavedProjectSignal | null>(null);
  const reconcileHostedProjectTitleAfterSave = useReconcileHostedProjectTitleAfterSave(workspaceHost);

  const handleProjectSaved = useCallback((event: RivetAppHostProjectSavedEvent) => {
    reconcileHostedProjectTitleAfterSave(event);
    setSavedProjectSignal({ projectId: event.project.metadata.id });

    if (!event.path) {
      return;
    }

    postMessageToDashboard({ type: 'project-saved', path: event.path });
  }, [reconcileHostedProjectTitleAfterSave]);

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

  const handleWorkspaceHostReady = useCallback((host: RivetWorkspaceHost) => {
    setWorkspaceHost(host);
  }, []);

  const handleWorkspaceHostDisposed = useCallback((host: RivetWorkspaceHost) => {
    setWorkspaceHost((currentHost) => currentHost === host ? null : currentHost);
  }, []);

  return (
    <RivetAppHost
      executor={{ internalExecutorUrl: RIVET_EXECUTOR_WS_URL }}
      providers={hostedRivetProviders}
      ui={HOSTED_RIVET_UI}
      onActiveProjectChanged={handleActiveProjectChanged}
      onOpenError={handleOpenError}
      onOpenProjectCountChanged={handleOpenProjectCountChanged}
      onProjectSaved={handleProjectSaved}
      onWorkspaceHostDisposed={handleWorkspaceHostDisposed}
      onWorkspaceHostReady={handleWorkspaceHostReady}
    >
      {workspaceHost ? (
        <EditorMessageBridge
          savedProjectSignal={savedProjectSignal}
          workspaceHost={workspaceHost}
        />
      ) : null}
    </RivetAppHost>
  );
};
