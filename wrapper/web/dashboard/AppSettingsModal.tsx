import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { type Dispatch, type FC, type SetStateAction, useEffect, useState } from 'react';

import { SettingsActions } from './app-settings/SettingsControls';
import { DockerSettingsTab } from './app-settings/tabs/DockerSettingsTab';
import { GeneralSettingsTab } from './app-settings/tabs/GeneralSettingsTab';
import { NodeExecutorSettingsTab } from './app-settings/tabs/NodeExecutorSettingsTab';
import { OAuthSettingsTab } from './app-settings/tabs/OAuthSettingsTab';
import { RunRecordingsSettingsTab } from './app-settings/tabs/RunRecordingsSettingsTab';
import { ServerUiAccessSettingsTab } from './app-settings/tabs/ServerUiAccessSettingsTab';
import { ShellExecutionSettingsTab } from './app-settings/tabs/ShellExecutionSettingsTab';
import { StorageSettingsTab } from './app-settings/tabs/StorageSettingsTab';
import { WebAppsSettingsTab } from './app-settings/tabs/WebAppsSettingsTab';
import { WorkflowEndpointsSettingsTab } from './app-settings/tabs/WorkflowEndpointsSettingsTab';
import { isWebAppAuthSettingsTab, type AppSettingsTab } from './app-settings/model';
import { useDeploymentStorageForm } from './app-settings/useDeploymentStorageForm';
import { useNodeExecutorForms } from './app-settings/useNodeExecutorForms';
import { usePublicRoutesForm } from './app-settings/usePublicRoutesForm';
import { useRunRecordingsForm } from './app-settings/useRunRecordingsForm';
import { useRuntimeLimitsForm } from './app-settings/useRuntimeLimitsForm';
import { useTrustedHostsForm } from './app-settings/useTrustedHostsForm';
import { useWebAppAuthForm } from './app-settings/useWebAppAuthForm';
import { useWorkflowEndpointAuthForm } from './app-settings/useWorkflowEndpointAuthForm';
import type { HostedRouteConfig } from './types';

interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  routeConfig: HostedRouteConfig;
  onRouteConfigChange?: Dispatch<SetStateAction<HostedRouteConfig>>;
}

const tabs: ReadonlyArray<{ id: AppSettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'shell-execution', label: 'Shell execution' },
  { id: 'server-ui-access', label: 'Server UI access' },
  { id: 'storage', label: 'Storage' },
  { id: 'workflow-endpoints', label: 'Workflow endpoints' },
  { id: 'run-recordings', label: 'Run recordings' },
  { id: 'node-executor-proxy', label: 'Node executor proxy' },
  { id: 'web-apps', label: 'Web apps' },
  { id: 'oauth', label: 'OAuth' },
  { id: 'docker', label: 'Docker' },
];

type TabSettingsAction = {
  changed: boolean;
  disabled: boolean;
  error?: string | null;
  name: string;
  revert: () => void;
  save: () => Promise<unknown | undefined>;
  savedMessage?: string;
};

type TabActionFeedback = { error?: string; saved?: boolean; savedMessage?: string } | null;

function describeActions(actions: TabSettingsAction[]) {
  return actions.map((action) => action.name).join(', ');
}

function OpenAppSettingsModal({
  onClose,
  onRouteConfigChange,
  routeConfig,
}: Omit<AppSettingsModalProps, 'isOpen'>) {
  const [activeTab, setActiveTab] = useState<AppSettingsTab>('general');
  const [actionFeedback, setActionFeedback] = useState<TabActionFeedback>(null);
  const [savingTab, setSavingTab] = useState(false);
  const usesRuntimeLimits = (
    activeTab === 'shell-execution' ||
    activeTab === 'workflow-endpoints' ||
    activeTab === 'web-apps' ||
    activeTab === 'docker'
  );
  const usesPublicRoutes = activeTab === 'workflow-endpoints' || activeTab === 'web-apps';

  const limits = useRuntimeLimitsForm(usesRuntimeLimits);
  const trustedHosts = useTrustedHostsForm(activeTab === 'general');
  const storage = useDeploymentStorageForm(activeTab === 'storage');
  const routes = usePublicRoutesForm(usesPublicRoutes, routeConfig, onRouteConfigChange);
  const workflowAuth = useWorkflowEndpointAuthForm(activeTab === 'workflow-endpoints');
  const recordings = useRunRecordingsForm(activeTab === 'run-recordings');
  const nodeExecutor = useNodeExecutorForms(activeTab === 'node-executor-proxy', onRouteConfigChange);
  const webAppAuth = useWebAppAuthForm(isWebAppAuthSettingsTab(activeTab), onRouteConfigChange);

  const panel = activeTab === 'general'
    ? <GeneralSettingsTab trustedHosts={trustedHosts} />
    : activeTab === 'shell-execution'
      ? <ShellExecutionSettingsTab limits={limits} />
      : activeTab === 'server-ui-access'
      ? <ServerUiAccessSettingsTab auth={webAppAuth} />
      : activeTab === 'storage'
        ? <StorageSettingsTab storage={storage} />
        : activeTab === 'workflow-endpoints'
          ? <WorkflowEndpointsSettingsTab auth={workflowAuth} limits={limits} routes={routes} />
          : activeTab === 'run-recordings'
            ? <RunRecordingsSettingsTab recordings={recordings} />
            : activeTab === 'node-executor-proxy'
              ? <NodeExecutorSettingsTab nodeExecutor={nodeExecutor} routeConfig={routeConfig} />
              : activeTab === 'web-apps'
                ? <WebAppsSettingsTab auth={webAppAuth} limits={limits} routes={routes} />
                : activeTab === 'oauth'
                  ? <OAuthSettingsTab auth={webAppAuth} routeConfig={routeConfig} />
                  : <DockerSettingsTab limits={limits} />;

  const tabActions: TabSettingsAction[] = activeTab === 'general'
    ? [{
        changed: trustedHosts.changed,
        disabled: trustedHosts.controlsDisabled,
        error: trustedHosts.error,
        name: 'trusted hosts',
        revert: trustedHosts.revert,
        save: trustedHosts.save,
      }]
    : activeTab === 'shell-execution'
      ? [{
          changed: limits.changed.shell,
          disabled: limits.controlsDisabled,
          error: limits.status === 'shell' || limits.status === null ? limits.error : null,
          name: 'shell execution',
          revert: () => limits.revert('shell'),
          save: () => limits.save('shell'),
        }]
      : activeTab === 'server-ui-access'
      ? [{
          changed: webAppAuth.changed.serverUiAccess,
          disabled: webAppAuth.controlsDisabled,
          error: webAppAuth.status === 'server-ui-access' ? webAppAuth.error : null,
          name: 'server UI access',
          revert: () => webAppAuth.revert('server-ui-access'),
          save: () => webAppAuth.save('server-ui-access'),
        }]
      : activeTab === 'storage'
        ? [{
            changed: storage.changed,
            disabled: storage.controlsDisabled,
            error: storage.error,
            name: 'storage',
            revert: storage.revert,
            save: storage.save,
            savedMessage: 'Saved. Restart Docker services or roll out Kubernetes pods to apply storage changes.',
          }]
        : activeTab === 'workflow-endpoints'
          ? [
              {
                changed: routes.changed.workflowEndpoints,
                disabled: routes.controlsDisabled,
                error: routes.status === 'workflow-endpoints' ? routes.error : null,
                name: 'workflow endpoint routes',
                revert: () => routes.revert('workflow-endpoints'),
                save: () => routes.save('workflow-endpoints'),
              },
              {
                changed: workflowAuth.changed,
                disabled: workflowAuth.controlsDisabled,
                error: workflowAuth.error,
                name: 'workflow endpoint access control',
                revert: workflowAuth.revert,
                save: workflowAuth.save,
              },
              {
                changed: limits.changed.proxyTimeout,
                disabled: limits.controlsDisabled,
                error: limits.status === 'proxy-timeout' || limits.status === null ? limits.error : null,
                name: 'workflow endpoint timeout',
                revert: () => limits.revert('proxy-timeout'),
                save: () => limits.save('proxy-timeout'),
              },
            ]
          : activeTab === 'run-recordings'
            ? [{
                changed: recordings.changed,
                disabled: recordings.controlsDisabled,
                error: recordings.error,
                name: 'run recordings',
                revert: recordings.revert,
                save: recordings.save,
              }]
            : activeTab === 'node-executor-proxy'
              ? [
                  {
                    changed: nodeExecutor.proxy.changed,
                    disabled: !nodeExecutor.proxy.loaded || nodeExecutor.proxy.loading || nodeExecutor.proxy.saving,
                    error: nodeExecutor.proxy.error,
                    name: 'Node executor proxy',
                    revert: nodeExecutor.proxy.revert,
                    save: nodeExecutor.proxy.save,
                  },
                  {
                    changed: nodeExecutor.urls.changed,
                    disabled: !nodeExecutor.urls.loaded || nodeExecutor.urls.loading || nodeExecutor.urls.saving,
                    error: nodeExecutor.urls.error,
                    name: 'websocket URL overrides',
                    revert: nodeExecutor.urls.revert,
                    save: nodeExecutor.urls.save,
                    savedMessage: 'Saved. Reload the editor to apply websocket URL overrides to active sessions.',
                  },
                ]
              : activeTab === 'web-apps'
                ? [
                    {
                      changed: routes.changed.webApps,
                      disabled: routes.controlsDisabled,
                      error: routes.status === 'web-apps' ? routes.error : null,
                      name: 'web app routes',
                      revert: () => routes.revert('web-apps'),
                      save: () => routes.save('web-apps'),
                    },
                    {
                      changed: webAppAuth.changed.mode,
                      disabled: webAppAuth.controlsDisabled,
                      error: webAppAuth.status === 'web-apps' ? webAppAuth.error : null,
                      name: 'web app authentication',
                      revert: () => webAppAuth.revert('web-apps'),
                      save: () => webAppAuth.save('web-apps'),
                    },
                    {
                      changed: limits.changed.webAppRequestSize,
                      disabled: limits.controlsDisabled,
                      error: limits.status === 'web-app-request-size' || limits.status === null ? limits.error : null,
                      name: 'web app button data limit',
                      revert: () => limits.revert('web-app-request-size'),
                      save: () => limits.save('web-app-request-size'),
                      savedMessage: 'Saved. Nginx reloads shortly; restart the API to apply the new WebSocket message limit.',
                    },
                  ]
                : activeTab === 'oauth'
                  ? [{
                      changed: webAppAuth.changed.oauth,
                      disabled: webAppAuth.controlsDisabled,
                      error: webAppAuth.status === 'oauth' ? webAppAuth.error : null,
                      name: 'OAuth settings',
                      revert: () => webAppAuth.revert('oauth'),
                      save: () => webAppAuth.save('oauth'),
                    }]
                  : [{
                      changed: limits.changed.docker,
                      disabled: limits.controlsDisabled,
                      error: limits.status === 'docker' || limits.status === null ? limits.error : null,
                      name: 'Docker launcher',
                      revert: () => limits.revert('docker'),
                      save: () => limits.save('docker'),
                    }];
  const tabError = tabActions.find((action) => action.error)?.error ?? actionFeedback?.error ?? null;

  useEffect(() => {
    setActionFeedback(null);
  }, [activeTab]);

  const saveActiveTab = async () => {
    const changedActions = tabActions.filter((action) => action.changed);
    if (changedActions.length === 0) {
      return;
    }

    setActionFeedback(null);
    setSavingTab(true);
    try {
      const results = await Promise.all(changedActions.map((action) => action.save()));
      const failedActions = changedActions.filter((_, index) => results[index] === undefined);
      if (failedActions.length > 0) {
        setActionFeedback({ error: `Could not save ${describeActions(failedActions)}. Review the values and try again.` });
        return;
      }

      const savedMessage = changedActions.find((action) => action.savedMessage)?.savedMessage;
      setActionFeedback({ saved: true, savedMessage });
    } catch (error) {
      setActionFeedback({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingTab(false);
    }
  };

  const revertActiveTab = () => {
    tabActions.filter((action) => action.changed).forEach((action) => action.revert());
    setActionFeedback(null);
  };

  const actionsDisabled = savingTab || tabActions.some((action) => action.disabled);

  return (
    <ModalDialog testId="app-settings-modal" width="large" label="App settings" onClose={onClose}>
      <ModalBody>
        <div className="project-settings-modal-shell app-settings-modal-shell">
          <div className="project-settings-modal-header-row app-settings-modal-header-row">
            <div className="project-settings-modal-heading">
              <div className="project-settings-modal-title">Settings</div>
            </div>
            <button
              type="button"
              className="project-settings-close-button"
              onClick={onClose}
              aria-label="Close app settings"
            >
              &times;
            </button>
          </div>

          <div className="project-settings-modal-content app-settings-modal-content">
            <div className="app-settings-layout">
              <aside className="app-settings-sidebar" aria-label="Settings navigation">
                <div
                  className="project-settings-tabs app-settings-tab-list"
                  role="tablist"
                  aria-label="App settings sections"
                  aria-orientation="vertical"
                >
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`project-settings-tab app-settings-nav-tab${activeTab === tab.id ? ' active' : ''}`}
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      disabled={savingTab}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </aside>
              <div
                className="app-settings-panel-region"
                onChangeCapture={() => setActionFeedback(null)}
                onClickCapture={() => setActionFeedback(null)}
                onInputCapture={() => setActionFeedback(null)}
              >
                {panel}
                <SettingsActions
                  changed={tabActions.some((action) => action.changed)}
                  disabled={actionsDisabled}
                  error={tabError}
                  loading={savingTab}
                  onRevert={revertActiveTab}
                  onSave={saveActiveTab}
                  pending={routes.applying ? 'Applying routes...' : undefined}
                  saved={actionFeedback?.saved}
                  savedMessage={actionFeedback?.savedMessage}
                />
              </div>
            </div>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}

export const AppSettingsModal: FC<AppSettingsModalProps> = ({ isOpen, ...props }) => (
  <ModalTransition>{isOpen ? <OpenAppSettingsModal {...props} /> : null}</ModalTransition>
);
