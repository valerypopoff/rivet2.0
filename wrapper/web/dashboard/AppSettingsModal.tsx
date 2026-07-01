import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useEffect, useMemo, useState } from 'react';

import type { HostedRouteConfig } from './types';
import {
  fetchNodeExecutorProxySettings,
  saveNodeExecutorProxySettings,
} from './appSettingsApi';

interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  routeConfig: HostedRouteConfig;
}

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

type AppSettingsTab = 'general' | 'node-executor-proxy';

function formatWebAppsAuthMode(value: HostedRouteConfig['webAppsAuthMode']): string {
  if (value === 'ui-gate') {
    return 'UI gate';
  }

  return value === 'oauth' ? 'OAuth' : 'None';
}

export const AppSettingsModal: FC<AppSettingsModalProps> = ({
  isOpen,
  onClose,
  routeConfig,
}) => {
  const [activeTab, setActiveTab] = useState<AppSettingsTab>('general');
  const [loadingProxySettings, setLoadingProxySettings] = useState(false);
  const [savingProxySettings, setSavingProxySettings] = useState(false);
  const [proxySettingsError, setProxySettingsError] = useState<string | null>(null);
  const [proxySettingsSaved, setProxySettingsSaved] = useState(false);
  const [httpProxy, setHttpProxy] = useState('');
  const [httpsProxy, setHttpsProxy] = useState('');
  const [noProxy, setNoProxy] = useState('');
  const [initialProxySettings, setInitialProxySettings] = useState({
    httpProxy: '',
    httpsProxy: '',
    noProxy: '',
  });

  const proxySettingsChanged = useMemo(() => (
    httpProxy.trim() !== initialProxySettings.httpProxy ||
    httpsProxy.trim() !== initialProxySettings.httpsProxy ||
    noProxy.trim() !== initialProxySettings.noProxy
  ), [httpProxy, httpsProxy, initialProxySettings, noProxy]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab('general');
    setProxySettingsSaved(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'node-executor-proxy') {
      return;
    }

    let cancelled = false;
    setLoadingProxySettings(true);
    setProxySettingsError(null);
    setProxySettingsSaved(false);

    fetchNodeExecutorProxySettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const nextSettings = {
          httpProxy: settings.httpProxy,
          httpsProxy: settings.httpsProxy,
          noProxy: settings.noProxy,
        };
        setHttpProxy(nextSettings.httpProxy);
        setHttpsProxy(nextSettings.httpsProxy);
        setNoProxy(nextSettings.noProxy);
        setInitialProxySettings(nextSettings);
      })
      .catch((error) => {
        if (!cancelled) {
          setProxySettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingProxySettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSaveProxySettings = async () => {
    setSavingProxySettings(true);
    setProxySettingsError(null);
    setProxySettingsSaved(false);

    try {
      const savedSettings = await saveNodeExecutorProxySettings({
        httpProxy,
        httpsProxy,
        noProxy,
      });
      const nextSettings = {
        httpProxy: savedSettings.httpProxy,
        httpsProxy: savedSettings.httpsProxy,
        noProxy: savedSettings.noProxy,
      };
      setHttpProxy(nextSettings.httpProxy);
      setHttpsProxy(nextSettings.httpsProxy);
      setNoProxy(nextSettings.noProxy);
      setInitialProxySettings(nextSettings);
      setProxySettingsSaved(true);
    } catch (error) {
      setProxySettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingProxySettings(false);
    }
  };

  const renderTabButton = (tab: AppSettingsTab, label: string) => (
    <button
      type="button"
      className={`project-settings-tab${activeTab === tab ? ' active' : ''}`}
      role="tab"
      aria-selected={activeTab === tab}
      onClick={() => setActiveTab(tab)}
    >
      {label}
    </button>
  );

  return (
    <ModalTransition>
      <ModalDialog
        testId="app-settings-modal"
        width="large"
        label="App settings"
        onClose={onClose}
      >
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
              <div className="project-settings-tabs" role="tablist" aria-label="App settings sections">
                {renderTabButton('general', 'General')}
                {renderTabButton('node-executor-proxy', 'Node executor proxy')}
              </div>

              {activeTab === 'general' ? (
                <div className="project-settings-tab-panel app-settings-general-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Application">
                    <div className="app-settings-section-title">Application</div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Name</span>
                      <span className="about-detail-value">{appName}</span>
                    </div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Version</span>
                      <span className="about-detail-value">{appVersion}</span>
                    </div>
                  </section>

                  <section className="app-settings-section" aria-label="Routes">
                    <div className="app-settings-section-title">Routes</div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Published workflows</span>
                      <span className="about-detail-value">{routeConfig.publishedWorkflowsBasePath}</span>
                    </div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Latest workflows</span>
                      <span className="about-detail-value">{routeConfig.latestWorkflowsBasePath}</span>
                    </div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Published web apps</span>
                      <span className="about-detail-value">{routeConfig.publishedAppsBasePath}</span>
                    </div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Latest web apps</span>
                      <span className="about-detail-value">{routeConfig.latestAppsBasePath}</span>
                    </div>
                  </section>

                  <section className="app-settings-section" aria-label="Access">
                    <div className="app-settings-section-title">Access</div>
                    <div className="about-detail-row">
                      <span className="about-detail-label">Web app auth</span>
                      <span className="about-detail-value">{formatWebAppsAuthMode(routeConfig.webAppsAuthMode)}</span>
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'node-executor-proxy' ? (
                <div className="project-settings-tab-panel app-settings-proxy-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Node executor proxy">
                    <div className="app-settings-section-title">Node executor proxy</div>

                    {proxySettingsError ? (
                      <div className="project-settings-error">{proxySettingsError}</div>
                    ) : null}
                    {proxySettingsSaved ? (
                      <div className="project-settings-success">Saved.</div>
                    ) : null}

                    <div className="app-settings-field-grid" aria-busy={loadingProxySettings || savingProxySettings}>
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">HTTP_PROXY</span>
                        <TextField
                          aria-label="HTTP_PROXY"
                          value={httpProxy}
                          isDisabled={loadingProxySettings || savingProxySettings}
                          placeholder="http://172.17.0.1:3128"
                          onChange={(event) => {
                            setHttpProxy(event.currentTarget.value);
                            setProxySettingsSaved(false);
                          }}
                        />
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">HTTPS_PROXY</span>
                        <TextField
                          aria-label="HTTPS_PROXY"
                          value={httpsProxy}
                          isDisabled={loadingProxySettings || savingProxySettings}
                          placeholder="http://172.17.0.1:3128"
                          onChange={(event) => {
                            setHttpsProxy(event.currentTarget.value);
                            setProxySettingsSaved(false);
                          }}
                        />
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">NO_PROXY</span>
                        <textarea
                          aria-label="NO_PROXY"
                          className="project-settings-textarea app-settings-proxy-no-proxy"
                          value={noProxy}
                          disabled={loadingProxySettings || savingProxySettings}
                          placeholder="localhost,127.0.0.1,::1,api,web,executor,proxy,172.17.0.1"
                          onChange={(event) => {
                            setNoProxy(event.currentTarget.value);
                            setProxySettingsSaved(false);
                          }}
                        />
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        isLoading={savingProxySettings}
                        isDisabled={loadingProxySettings || savingProxySettings || !proxySettingsChanged}
                        onClick={handleSaveProxySettings}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        isDisabled={loadingProxySettings || savingProxySettings || !proxySettingsChanged}
                        onClick={() => {
                          setHttpProxy(initialProxySettings.httpProxy);
                          setHttpsProxy(initialProxySettings.httpsProxy);
                          setNoProxy(initialProxySettings.noProxy);
                          setProxySettingsSaved(false);
                          setProxySettingsError(null);
                        }}
                      >
                        Revert
                      </Button>
                    </div>
                  </section>
                </div>
              ) : null}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
