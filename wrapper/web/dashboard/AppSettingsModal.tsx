import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useEffect, useMemo, useState } from 'react';

import type { HostedRouteConfig } from './types';
import {
  fetchNodeExecutorProxySettings,
  fetchRunRecordingsSettings,
  saveNodeExecutorProxySettings,
  saveRunRecordingsSettings,
} from './appSettingsApi';

interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  routeConfig: HostedRouteConfig;
}

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

type AppSettingsTab = 'general' | 'node-executor-proxy' | 'run-recordings';
type RunsKeptMode = 'latest' | 'all';
type RecordingRetentionMode = 'limited' | 'forever';

const defaultMaxRunsPerEndpoint = '100';
const defaultRetentionDays = '14';

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
  const [loadingRunRecordingsSettings, setLoadingRunRecordingsSettings] = useState(false);
  const [savingRunRecordingsSettings, setSavingRunRecordingsSettings] = useState(false);
  const [runRecordingsSettingsError, setRunRecordingsSettingsError] = useState<string | null>(null);
  const [runRecordingsSettingsSaved, setRunRecordingsSettingsSaved] = useState(false);
  const [maxPendingWrites, setMaxPendingWrites] = useState('100');
  const [maxRunsPerEndpoint, setMaxRunsPerEndpoint] = useState('100');
  const [maxRunsPerEndpointMode, setMaxRunsPerEndpointMode] = useState<RunsKeptMode>('latest');
  const [retentionDays, setRetentionDays] = useState('14');
  const [recordingRetentionMode, setRecordingRetentionMode] = useState<RecordingRetentionMode>('limited');
  const [initialRunRecordingsSettings, setInitialRunRecordingsSettings] = useState({
    maxPendingWrites: '100',
    maxRunsPerEndpoint: '100',
    retentionDays: '14',
  });

  const proxySettingsChanged = useMemo(() => (
    httpProxy.trim() !== initialProxySettings.httpProxy ||
    httpsProxy.trim() !== initialProxySettings.httpsProxy ||
    noProxy.trim() !== initialProxySettings.noProxy
  ), [httpProxy, httpsProxy, initialProxySettings, noProxy]);

  const currentRunRecordingsSettings = useMemo(() => ({
    maxPendingWrites: maxPendingWrites.trim(),
    maxRunsPerEndpoint: maxRunsPerEndpointMode === 'all' ? '0' : maxRunsPerEndpoint.trim(),
    retentionDays: recordingRetentionMode === 'forever' ? '0' : retentionDays.trim(),
  }), [
    maxPendingWrites,
    maxRunsPerEndpoint,
    maxRunsPerEndpointMode,
    recordingRetentionMode,
    retentionDays,
  ]);

  const runRecordingsSettingsChanged = useMemo(() => (
    currentRunRecordingsSettings.maxPendingWrites !== initialRunRecordingsSettings.maxPendingWrites ||
    currentRunRecordingsSettings.maxRunsPerEndpoint !== initialRunRecordingsSettings.maxRunsPerEndpoint ||
    currentRunRecordingsSettings.retentionDays !== initialRunRecordingsSettings.retentionDays
  ), [currentRunRecordingsSettings, initialRunRecordingsSettings]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab('general');
    setProxySettingsSaved(false);
    setRunRecordingsSettingsSaved(false);
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

  useEffect(() => {
    if (!isOpen || activeTab !== 'run-recordings') {
      return;
    }

    let cancelled = false;
    setLoadingRunRecordingsSettings(true);
    setRunRecordingsSettingsError(null);
    setRunRecordingsSettingsSaved(false);

    fetchRunRecordingsSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const nextSettings = {
          maxPendingWrites: String(settings.maxPendingWrites),
          maxRunsPerEndpoint: String(settings.maxRunsPerEndpoint),
          retentionDays: String(settings.retentionDays),
        };
        const nextMaxRunsMode = settings.maxRunsPerEndpoint === 0 ? 'all' : 'latest';
        const nextRetentionMode = settings.retentionDays === 0 ? 'forever' : 'limited';
        setMaxPendingWrites(nextSettings.maxPendingWrites);
        setMaxRunsPerEndpoint(nextMaxRunsMode === 'all' ? defaultMaxRunsPerEndpoint : nextSettings.maxRunsPerEndpoint);
        setMaxRunsPerEndpointMode(nextMaxRunsMode);
        setRetentionDays(nextRetentionMode === 'forever' ? defaultRetentionDays : nextSettings.retentionDays);
        setRecordingRetentionMode(nextRetentionMode);
        setInitialRunRecordingsSettings(nextSettings);
      })
      .catch((error) => {
        if (!cancelled) {
          setRunRecordingsSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRunRecordingsSettings(false);
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

  const handleSaveRunRecordingsSettings = async () => {
    setSavingRunRecordingsSettings(true);
    setRunRecordingsSettingsError(null);
    setRunRecordingsSettingsSaved(false);

    try {
      const savedSettings = await saveRunRecordingsSettings({
        ...currentRunRecordingsSettings,
      });
      const nextSettings = {
        maxPendingWrites: String(savedSettings.maxPendingWrites),
        maxRunsPerEndpoint: String(savedSettings.maxRunsPerEndpoint),
        retentionDays: String(savedSettings.retentionDays),
      };
      const nextMaxRunsMode = savedSettings.maxRunsPerEndpoint === 0 ? 'all' : 'latest';
      const nextRetentionMode = savedSettings.retentionDays === 0 ? 'forever' : 'limited';
      setMaxPendingWrites(nextSettings.maxPendingWrites);
      setMaxRunsPerEndpoint(nextMaxRunsMode === 'all' ? defaultMaxRunsPerEndpoint : nextSettings.maxRunsPerEndpoint);
      setMaxRunsPerEndpointMode(nextMaxRunsMode);
      setRetentionDays(nextRetentionMode === 'forever' ? defaultRetentionDays : nextSettings.retentionDays);
      setRecordingRetentionMode(nextRetentionMode);
      setInitialRunRecordingsSettings(nextSettings);
      setRunRecordingsSettingsSaved(true);
    } catch (error) {
      setRunRecordingsSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRunRecordingsSettings(false);
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

  const renderActionStatus = (error: string | null, saved: boolean) => {
    if (error) {
      return <div className="project-settings-error app-settings-action-status">{error}</div>;
    }

    if (saved) {
      return <div className="project-settings-success app-settings-action-status">Saved.</div>;
    }

    return null;
  };

  const renderModeButton = (
    active: boolean,
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      className={`project-settings-tab app-settings-mode-tab${active ? ' active' : ''}`}
      aria-pressed={active}
      disabled={loadingRunRecordingsSettings || savingRunRecordingsSettings}
      onClick={onClick}
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
                {renderTabButton('run-recordings', 'Run recordings')}
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

              {activeTab === 'run-recordings' ? (
                <div className="project-settings-tab-panel app-settings-recordings-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Run recordings">
                    <div className="app-settings-field-grid" aria-busy={loadingRunRecordingsSettings || savingRunRecordingsSettings}>
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Queued recording writes</span>
                        <TextField
                          aria-label="Queued recording writes"
                          type="number"
                          min={0}
                          value={maxPendingWrites}
                          isDisabled={loadingRunRecordingsSettings || savingRunRecordingsSettings}
                          placeholder="100"
                          onChange={(event) => {
                            setMaxPendingWrites(event.currentTarget.value);
                            setRunRecordingsSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          How many recording save jobs can wait in memory before new recordings are skipped.
                        </span>
                      </label>

                      <div className="app-settings-field">
                        <span className="app-settings-field-label">Runs kept per workflow endpoint</span>
                        <div className="project-settings-tabs app-settings-mode-tabs" role="group" aria-label="Runs kept per workflow endpoint mode">
                          {renderModeButton(
                            maxRunsPerEndpointMode === 'latest',
                            'Keep latest runs',
                            () => {
                              setMaxRunsPerEndpointMode('latest');
                              setRunRecordingsSettingsSaved(false);
                            },
                          )}
                          {renderModeButton(
                            maxRunsPerEndpointMode === 'all',
                            'Keep all runs',
                            () => {
                              setMaxRunsPerEndpointMode('all');
                              setRunRecordingsSettingsSaved(false);
                            },
                          )}
                        </div>
                        {maxRunsPerEndpointMode === 'latest' ? (
                          <TextField
                            aria-label="Newest runs to keep per workflow endpoint"
                            type="number"
                            min={1}
                            value={maxRunsPerEndpoint}
                            isDisabled={loadingRunRecordingsSettings || savingRunRecordingsSettings}
                            placeholder={defaultMaxRunsPerEndpoint}
                            onChange={(event) => {
                              setMaxRunsPerEndpoint(event.currentTarget.value);
                              setRunRecordingsSettingsSaved(false);
                            }}
                          />
                        ) : null}
                        <span className="app-settings-field-help">
                          {maxRunsPerEndpointMode === 'latest'
                            ? 'Keeping only the newest runs for each endpoint. Older runs are removed during cleanup.'
                            : 'Keeping every recorded run for each endpoint.'}
                        </span>
                      </div>

                      <div className="app-settings-field">
                        <span className="app-settings-field-label">Days to keep recordings</span>
                        <div className="project-settings-tabs app-settings-mode-tabs" role="group" aria-label="Recording retention mode">
                          {renderModeButton(
                            recordingRetentionMode === 'forever',
                            'Keep forever',
                            () => {
                              setRecordingRetentionMode('forever');
                              setRunRecordingsSettingsSaved(false);
                            },
                          )}
                          {renderModeButton(
                            recordingRetentionMode === 'limited',
                            'Keep for some time',
                            () => {
                              setRecordingRetentionMode('limited');
                              setRunRecordingsSettingsSaved(false);
                            },
                          )}
                        </div>
                        {recordingRetentionMode === 'limited' ? (
                          <TextField
                            aria-label="Days to keep recordings"
                            type="number"
                            min={1}
                            value={retentionDays}
                            isDisabled={loadingRunRecordingsSettings || savingRunRecordingsSettings}
                            placeholder={defaultRetentionDays}
                            onChange={(event) => {
                              setRetentionDays(event.currentTarget.value);
                              setRunRecordingsSettingsSaved(false);
                            }}
                          />
                        ) : null}
                        <span className="app-settings-field-help">
                          {recordingRetentionMode === 'forever'
                            ? 'Recordings are kept indefinitely unless another saved limit removes them.'
                            : 'Recordings older than the selected number of days are removed during cleanup.'}
                        </span>
                      </div>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingRunRecordingsSettings}
                        isDisabled={
                          loadingRunRecordingsSettings ||
                          savingRunRecordingsSettings ||
                          !runRecordingsSettingsChanged
                        }
                        onClick={handleSaveRunRecordingsSettings}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={
                          loadingRunRecordingsSettings ||
                          savingRunRecordingsSettings ||
                          !runRecordingsSettingsChanged
                        }
                        onClick={() => {
                          setMaxPendingWrites(initialRunRecordingsSettings.maxPendingWrites);
                          setMaxRunsPerEndpoint(
                            initialRunRecordingsSettings.maxRunsPerEndpoint === '0'
                              ? defaultMaxRunsPerEndpoint
                              : initialRunRecordingsSettings.maxRunsPerEndpoint,
                          );
                          setMaxRunsPerEndpointMode(
                            initialRunRecordingsSettings.maxRunsPerEndpoint === '0' ? 'all' : 'latest',
                          );
                          setRetentionDays(
                            initialRunRecordingsSettings.retentionDays === '0'
                              ? defaultRetentionDays
                              : initialRunRecordingsSettings.retentionDays,
                          );
                          setRecordingRetentionMode(
                            initialRunRecordingsSettings.retentionDays === '0' ? 'forever' : 'limited',
                          );
                          setRunRecordingsSettingsSaved(false);
                          setRunRecordingsSettingsError(null);
                        }}
                      >
                        Revert
                      </Button>
                      {renderActionStatus(runRecordingsSettingsError, runRecordingsSettingsSaved)}
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'node-executor-proxy' ? (
                <div className="project-settings-tab-panel app-settings-proxy-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Node executor proxy">
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
                        className="app-settings-action-button button-size-l"
                        isLoading={savingProxySettings}
                        isDisabled={loadingProxySettings || savingProxySettings || !proxySettingsChanged}
                        onClick={handleSaveProxySettings}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
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
                      {renderActionStatus(proxySettingsError, proxySettingsSaved)}
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
