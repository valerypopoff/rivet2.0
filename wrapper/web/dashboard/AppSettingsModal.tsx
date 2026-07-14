import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { type FC, useState } from 'react';

import { DockerSettingsTab } from './app-settings/tabs/DockerSettingsTab';
import { GeneralSettingsTab } from './app-settings/tabs/GeneralSettingsTab';
import { NodeExecutorSettingsTab } from './app-settings/tabs/NodeExecutorSettingsTab';
import { OAuthSettingsTab } from './app-settings/tabs/OAuthSettingsTab';
import { RunRecordingsSettingsTab } from './app-settings/tabs/RunRecordingsSettingsTab';
import { ServerUiAccessSettingsTab } from './app-settings/tabs/ServerUiAccessSettingsTab';
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
  onRouteConfigChange?: (config: HostedRouteConfig) => void;
}

const tabs: ReadonlyArray<{ id: AppSettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'server-ui-access', label: 'Server UI access' },
  { id: 'storage', label: 'Storage' },
  { id: 'workflow-endpoints', label: 'Workflow endpoints' },
  { id: 'run-recordings', label: 'Run recordings' },
  { id: 'node-executor-proxy', label: 'Node executor proxy' },
  { id: 'web-apps', label: 'Web apps' },
  { id: 'oauth', label: 'OAuth' },
  { id: 'docker', label: 'Docker' },
];

function OpenAppSettingsModal({
  onClose,
  onRouteConfigChange,
  routeConfig,
}: Omit<AppSettingsModalProps, 'isOpen'>) {
  const [activeTab, setActiveTab] = useState<AppSettingsTab>('general');
  const usesRuntimeLimits = (
    activeTab === 'general' ||
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
  const nodeExecutor = useNodeExecutorForms(
    activeTab === 'node-executor-proxy',
    routeConfig,
    onRouteConfigChange,
  );
  const webAppAuth = useWebAppAuthForm(
    isWebAppAuthSettingsTab(activeTab),
    routeConfig,
    onRouteConfigChange,
  );

  const panel = activeTab === 'general'
    ? <GeneralSettingsTab limits={limits} routeConfig={routeConfig} trustedHosts={trustedHosts} />
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
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </aside>
              <div className="app-settings-panel-region">{panel}</div>
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
