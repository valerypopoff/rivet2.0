import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type FC, useEffect, useMemo, useState } from 'react';

import type { HostedRouteConfig } from './types';
import {
  fetchDeploymentStorageSettings,
  fetchExecutorUrlOverrideSettings,
  fetchNodeExecutorProxySettings,
  fetchPublicRouteSettings,
  fetchRunRecordingsSettings,
  fetchRuntimeLimitSettings,
  fetchWebAppAuthSettings,
  saveDeploymentStorageSettings,
  saveExecutorUrlOverrideSettings,
  saveNodeExecutorProxySettings,
  savePublicRouteSettings,
  saveRunRecordingsSettings,
  saveRuntimeLimitSettings,
  saveWebAppAuthSettings,
} from './appSettingsApi';
import { fetchHostedConfig } from './workflowApi';
import type {
  DeploymentDatabaseMode,
  DeploymentDatabaseSslMode,
  DeploymentStorageMode,
  DeploymentStorageSettings,
  ExecutorUrlOverrideSettings,
  PublicRouteSettings,
  RuntimeLimitSettings,
  RuntimeLimitSettingsDraft,
  WebAppAuthMode,
  WebAppAuthSettings,
  WebAppOAuthClientAuthMethod,
  WebAppOAuthProvider,
} from '../../shared/app-settings-types';

interface AppSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  routeConfig: HostedRouteConfig;
  onRouteConfigChange?: (config: HostedRouteConfig) => void;
}

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

type AppSettingsTab =
  | 'general'
  | 'storage'
  | 'node-executor-proxy'
  | 'run-recordings'
  | 'web-apps'
  | 'workflow-endpoints'
  | 'docker';
type RunsKeptMode = 'latest' | 'all';
type RecordingRetentionMode = 'limited' | 'forever';
type PublicRouteSettingsScope = 'web-apps' | 'workflow-endpoints';
type RuntimeLimitSettingsScope = 'shell' | 'proxy-timeout' | 'docker';
type PublicRouteSettingsFormSnapshot = {
  publishedWorkflowsSlug: string;
  latestWorkflowsSlug: string;
  publishedAppsSlug: string;
  latestAppsSlug: string;
};
type RuntimeLimitSettingsFormSnapshot = {
  commandTimeoutSeconds: string;
  maxOutputMiB: string;
  proxyReadTimeoutSeconds: string;
  dockerWaitTimeoutSeconds: string;
};
type ExecutorUrlOverrideSettingsFormSnapshot = Pick<
  ExecutorUrlOverrideSettings,
  'executorWsUrl' | 'remoteDebuggerDefaultWs'
>;
type WebAppAuthSettingsFormSnapshot = {
  mode: WebAppAuthMode;
  provider: WebAppOAuthProvider;
  dummyEmail: string;
  dummyAllowNonLocalhost: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  callbackUrl: string;
  scopes: string;
  emailClaim: string;
  sessionTtlHours: string;
  clientAuthMethod: WebAppOAuthClientAuthMethod;
  debugLogProfile: boolean;
};
type DeploymentStorageSettingsFormSnapshot = {
  storageMode: DeploymentStorageMode;
  artifactsHostPath: string;
  databaseMode: DeploymentDatabaseMode;
  databaseSslMode: DeploymentDatabaseSslMode;
  databaseConnectionStringConfigured: boolean;
  storageUrl: string;
  storageAccessKeyId: string;
  storageAccessKeyConfigured: boolean;
};

const defaultMaxRunsPerEndpoint = '100';
const defaultRetentionDays = '14';
const defaultSessionTtlHours = '24';
function formatWebAppsAuthMode(value: HostedRouteConfig['webAppsAuthMode']): string {
  if (value === 'ui-gate') {
    return 'Rivet key gate';
  }

  return value === 'oauth' ? 'OAuth' : 'None';
}

function getWebAppAuthSessionTtlHours(settings: Pick<WebAppAuthSettings, 'sessionTtlSeconds'>): string {
  return String(Math.max(1, Math.round(settings.sessionTtlSeconds / 3600)));
}

function createWebAppAuthSnapshot(settings: WebAppAuthSettings): WebAppAuthSettingsFormSnapshot {
  return {
    mode: settings.mode,
    provider: settings.provider,
    dummyEmail: settings.dummyEmail,
    dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
    authorizeUrl: settings.authorizeUrl,
    tokenUrl: settings.tokenUrl,
    userUrl: settings.userUrl,
    clientId: settings.clientId,
    callbackUrl: settings.callbackUrl,
    scopes: settings.scopes,
    emailClaim: settings.emailClaim,
    sessionTtlHours: getWebAppAuthSessionTtlHours(settings),
    clientAuthMethod: settings.clientAuthMethod,
    debugLogProfile: settings.debugLogProfile,
  };
}

function createDeploymentStorageSnapshot(
  settings: DeploymentStorageSettings,
): DeploymentStorageSettingsFormSnapshot {
  return {
    storageMode: settings.storageMode,
    artifactsHostPath: settings.artifactsHostPath,
    databaseMode: settings.databaseMode,
    databaseSslMode: settings.databaseSslMode,
    databaseConnectionStringConfigured: settings.databaseConnectionStringConfigured,
    storageUrl: settings.storageUrl,
    storageAccessKeyId: settings.storageAccessKeyId,
    storageAccessKeyConfigured: settings.storageAccessKeyConfigured,
  };
}

function basePathToRouteSlug(basePath: string): string {
  return basePath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function createPublicRouteSnapshot(settings: PublicRouteSettings): PublicRouteSettingsFormSnapshot {
  return {
    publishedWorkflowsSlug: basePathToRouteSlug(settings.publishedWorkflowsBasePath),
    latestWorkflowsSlug: basePathToRouteSlug(settings.latestWorkflowsBasePath),
    publishedAppsSlug: basePathToRouteSlug(settings.publishedAppsBasePath),
    latestAppsSlug: basePathToRouteSlug(settings.latestAppsBasePath),
  };
}

function bytesToMiBString(value: number): string {
  return String(Math.max(1, Math.round(value / (1024 * 1024))));
}

function miBStringToBytesString(value: string): string {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return value.trim();
  }

  return String(Math.round(parsed * 1024 * 1024));
}

function createRuntimeLimitSnapshot(settings: RuntimeLimitSettings): RuntimeLimitSettingsFormSnapshot {
  return {
    commandTimeoutSeconds: String(settings.commandTimeoutSeconds),
    maxOutputMiB: bytesToMiBString(settings.maxOutputBytes),
    proxyReadTimeoutSeconds: String(settings.proxyReadTimeoutSeconds),
    dockerWaitTimeoutSeconds: String(settings.dockerWaitTimeoutSeconds),
  };
}

function publicRouteSettingsMatchConfig(
  settings: Pick<
    PublicRouteSettings,
    | 'publishedWorkflowsBasePath'
    | 'latestWorkflowsBasePath'
    | 'publishedAppsBasePath'
    | 'latestAppsBasePath'
  >,
  config: Partial<HostedRouteConfig>,
): boolean {
  return (
    config.publishedWorkflowsBasePath === settings.publishedWorkflowsBasePath &&
    config.latestWorkflowsBasePath === settings.latestWorkflowsBasePath &&
    config.publishedAppsBasePath === settings.publishedAppsBasePath &&
    config.latestAppsBasePath === settings.latestAppsBasePath
  );
}

async function waitForHostedRouteConfig(settings: PublicRouteSettings): Promise<Partial<HostedRouteConfig>> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const config = await fetchHostedConfig();
    if (publicRouteSettingsMatchConfig(settings, config)) {
      return config;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Route settings were saved, but the active route config has not updated yet.');
}

export const AppSettingsModal: FC<AppSettingsModalProps> = ({
  isOpen,
  onClose,
  routeConfig,
  onRouteConfigChange,
}) => {
  const [activeTab, setActiveTab] = useState<AppSettingsTab>('general');
  const [loadingDeploymentStorageSettings, setLoadingDeploymentStorageSettings] = useState(false);
  const [savingDeploymentStorageSettings, setSavingDeploymentStorageSettings] = useState(false);
  const [deploymentStorageSettingsError, setDeploymentStorageSettingsError] = useState<string | null>(null);
  const [deploymentStorageSettingsSaved, setDeploymentStorageSettingsSaved] = useState(false);
  const [storageMode, setStorageMode] = useState<DeploymentStorageMode>('filesystem');
  const [artifactsHostPath, setArtifactsHostPath] = useState('../');
  const [databaseMode, setDatabaseMode] = useState<DeploymentDatabaseMode>('local-docker');
  const [databaseSslMode, setDatabaseSslMode] = useState<DeploymentDatabaseSslMode>('disable');
  const [databaseConnectionString, setDatabaseConnectionString] = useState('');
  const [databaseConnectionStringConfigured, setDatabaseConnectionStringConfigured] = useState(false);
  const [storageUrl, setStorageUrl] = useState('');
  const [storageAccessKeyId, setStorageAccessKeyId] = useState('');
  const [storageAccessKey, setStorageAccessKey] = useState('');
  const [storageAccessKeyConfigured, setStorageAccessKeyConfigured] = useState(false);
  const [initialDeploymentStorageSettings, setInitialDeploymentStorageSettings] = useState<DeploymentStorageSettingsFormSnapshot>({
    storageMode: 'filesystem',
    artifactsHostPath: '../',
    databaseMode: 'local-docker',
    databaseSslMode: 'disable',
    databaseConnectionStringConfigured: false,
    storageUrl: '',
    storageAccessKeyId: '',
    storageAccessKeyConfigured: false,
  });
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
  const [loadingExecutorUrlOverrideSettings, setLoadingExecutorUrlOverrideSettings] = useState(false);
  const [savingExecutorUrlOverrideSettings, setSavingExecutorUrlOverrideSettings] = useState(false);
  const [executorUrlOverrideSettingsError, setExecutorUrlOverrideSettingsError] = useState<string | null>(null);
  const [executorUrlOverrideSettingsSaved, setExecutorUrlOverrideSettingsSaved] = useState(false);
  const [executorWsUrlOverride, setExecutorWsUrlOverride] = useState('');
  const [remoteDebuggerWsUrlOverride, setRemoteDebuggerWsUrlOverride] = useState('');
  const [initialExecutorUrlOverrideSettings, setInitialExecutorUrlOverrideSettings] = useState<ExecutorUrlOverrideSettingsFormSnapshot>({
    executorWsUrl: '',
    remoteDebuggerDefaultWs: '',
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
  const [loadingRuntimeLimitSettings, setLoadingRuntimeLimitSettings] = useState(false);
  const [runtimeLimitSettingsLoaded, setRuntimeLimitSettingsLoaded] = useState(false);
  const [savingRuntimeLimitSettings, setSavingRuntimeLimitSettings] = useState(false);
  const [runtimeLimitSettingsError, setRuntimeLimitSettingsError] = useState<string | null>(null);
  const [runtimeLimitSettingsSaved, setRuntimeLimitSettingsSaved] = useState(false);
  const [runtimeLimitSettingsStatusScope, setRuntimeLimitSettingsStatusScope] = useState<RuntimeLimitSettingsScope | null>(null);
  const [commandTimeoutSeconds, setCommandTimeoutSeconds] = useState('30');
  const [maxOutputMiB, setMaxOutputMiB] = useState('10');
  const [proxyReadTimeoutSeconds, setProxyReadTimeoutSeconds] = useState('180');
  const [dockerWaitTimeoutSeconds, setDockerWaitTimeoutSeconds] = useState('1200');
  const [initialRuntimeLimitSettings, setInitialRuntimeLimitSettings] = useState<RuntimeLimitSettingsFormSnapshot>({
    commandTimeoutSeconds: '30',
    maxOutputMiB: '10',
    proxyReadTimeoutSeconds: '180',
    dockerWaitTimeoutSeconds: '1200',
  });
  const [loadingPublicRouteSettings, setLoadingPublicRouteSettings] = useState(false);
  const [savingPublicRouteSettings, setSavingPublicRouteSettings] = useState(false);
  const [applyingPublicRouteSettings, setApplyingPublicRouteSettings] = useState(false);
  const [publicRouteSettingsError, setPublicRouteSettingsError] = useState<string | null>(null);
  const [publicRouteSettingsSaved, setPublicRouteSettingsSaved] = useState(false);
  const [publicRouteSettingsStatusScope, setPublicRouteSettingsStatusScope] = useState<PublicRouteSettingsScope | null>(null);
  const [publishedWorkflowsSlug, setPublishedWorkflowsSlug] = useState(basePathToRouteSlug(routeConfig.publishedWorkflowsBasePath));
  const [latestWorkflowsSlug, setLatestWorkflowsSlug] = useState(basePathToRouteSlug(routeConfig.latestWorkflowsBasePath));
  const [publishedAppsSlug, setPublishedAppsSlug] = useState(basePathToRouteSlug(routeConfig.publishedAppsBasePath));
  const [latestAppsSlug, setLatestAppsSlug] = useState(basePathToRouteSlug(routeConfig.latestAppsBasePath));
  const [initialPublicRouteSettings, setInitialPublicRouteSettings] = useState<PublicRouteSettingsFormSnapshot>({
    publishedWorkflowsSlug: basePathToRouteSlug(routeConfig.publishedWorkflowsBasePath),
    latestWorkflowsSlug: basePathToRouteSlug(routeConfig.latestWorkflowsBasePath),
    publishedAppsSlug: basePathToRouteSlug(routeConfig.publishedAppsBasePath),
    latestAppsSlug: basePathToRouteSlug(routeConfig.latestAppsBasePath),
  });
  const [loadingWebAppAuthSettings, setLoadingWebAppAuthSettings] = useState(false);
  const [savingWebAppAuthSettings, setSavingWebAppAuthSettings] = useState(false);
  const [webAppAuthSettingsError, setWebAppAuthSettingsError] = useState<string | null>(null);
  const [webAppAuthSettingsSaved, setWebAppAuthSettingsSaved] = useState(false);
  const [webAppAuthMode, setWebAppAuthMode] = useState<WebAppAuthMode>('ui-gate');
  const [webAppOAuthProvider, setWebAppOAuthProvider] = useState<WebAppOAuthProvider>('external');
  const [webAppDummyEmail, setWebAppDummyEmail] = useState('local@example.test');
  const [webAppDummyAllowNonLocalhost, setWebAppDummyAllowNonLocalhost] = useState(false);
  const [webAppAuthorizeUrl, setWebAppAuthorizeUrl] = useState('');
  const [webAppTokenUrl, setWebAppTokenUrl] = useState('');
  const [webAppUserUrl, setWebAppUserUrl] = useState('');
  const [webAppClientId, setWebAppClientId] = useState('');
  const [webAppClientSecret, setWebAppClientSecret] = useState('');
  const [webAppClientSecretConfigured, setWebAppClientSecretConfigured] = useState(false);
  const [webAppCallbackUrl, setWebAppCallbackUrl] = useState('');
  const [webAppScopes, setWebAppScopes] = useState('email');
  const [webAppEmailClaim, setWebAppEmailClaim] = useState('email');
  const [webAppSessionSecret, setWebAppSessionSecret] = useState('');
  const [webAppSessionSecretConfigured, setWebAppSessionSecretConfigured] = useState(false);
  const [webAppSessionTtlHours, setWebAppSessionTtlHours] = useState(defaultSessionTtlHours);
  const [webAppClientAuthMethod, setWebAppClientAuthMethod] = useState<WebAppOAuthClientAuthMethod>('body');
  const [webAppDebugLogProfile, setWebAppDebugLogProfile] = useState(false);
  const [initialWebAppAuthSettings, setInitialWebAppAuthSettings] = useState<WebAppAuthSettingsFormSnapshot>({
    mode: 'ui-gate',
    provider: 'external',
    dummyEmail: 'local@example.test',
    dummyAllowNonLocalhost: false,
    authorizeUrl: '',
    tokenUrl: '',
    userUrl: '',
    clientId: '',
    callbackUrl: '',
    scopes: 'email',
    emailClaim: 'email',
    sessionTtlHours: defaultSessionTtlHours,
    clientAuthMethod: 'body',
    debugLogProfile: false,
  });

  const currentDeploymentStorageSettings = useMemo(() => ({
    storageMode,
    artifactsHostPath: artifactsHostPath.trim(),
    databaseMode,
    databaseSslMode,
    databaseConnectionString: databaseConnectionString.trim(),
    storageUrl: storageUrl.trim(),
    storageAccessKeyId: storageAccessKeyId.trim(),
    storageAccessKey: storageAccessKey.trim(),
  }), [
    artifactsHostPath,
    databaseConnectionString,
    databaseMode,
    databaseSslMode,
    storageAccessKey,
    storageAccessKeyId,
    storageMode,
    storageUrl,
  ]);

  const deploymentStorageSettingsChanged = useMemo(() => (
    currentDeploymentStorageSettings.storageMode !== initialDeploymentStorageSettings.storageMode ||
    currentDeploymentStorageSettings.artifactsHostPath !== initialDeploymentStorageSettings.artifactsHostPath ||
    currentDeploymentStorageSettings.databaseMode !== initialDeploymentStorageSettings.databaseMode ||
    currentDeploymentStorageSettings.databaseSslMode !== initialDeploymentStorageSettings.databaseSslMode ||
    currentDeploymentStorageSettings.databaseConnectionString !== '' ||
    currentDeploymentStorageSettings.storageUrl !== initialDeploymentStorageSettings.storageUrl ||
    currentDeploymentStorageSettings.storageAccessKeyId !== initialDeploymentStorageSettings.storageAccessKeyId ||
    currentDeploymentStorageSettings.storageAccessKey !== ''
  ), [currentDeploymentStorageSettings, initialDeploymentStorageSettings]);

  const proxySettingsChanged = useMemo(() => (
    httpProxy.trim() !== initialProxySettings.httpProxy ||
    httpsProxy.trim() !== initialProxySettings.httpsProxy ||
    noProxy.trim() !== initialProxySettings.noProxy
  ), [httpProxy, httpsProxy, initialProxySettings, noProxy]);

  const currentExecutorUrlOverrideSettings = useMemo(() => ({
    executorWsUrl: executorWsUrlOverride.trim(),
    remoteDebuggerDefaultWs: remoteDebuggerWsUrlOverride.trim(),
  }), [executorWsUrlOverride, remoteDebuggerWsUrlOverride]);

  const executorUrlOverrideSettingsChanged = useMemo(() => (
    currentExecutorUrlOverrideSettings.executorWsUrl !== initialExecutorUrlOverrideSettings.executorWsUrl ||
    currentExecutorUrlOverrideSettings.remoteDebuggerDefaultWs !== initialExecutorUrlOverrideSettings.remoteDebuggerDefaultWs
  ), [currentExecutorUrlOverrideSettings, initialExecutorUrlOverrideSettings]);

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

  const currentRuntimeLimitSettings = useMemo(() => ({
    commandTimeoutSeconds: commandTimeoutSeconds.trim(),
    maxOutputMiB: maxOutputMiB.trim(),
    proxyReadTimeoutSeconds: proxyReadTimeoutSeconds.trim(),
    dockerWaitTimeoutSeconds: dockerWaitTimeoutSeconds.trim(),
  }), [commandTimeoutSeconds, dockerWaitTimeoutSeconds, maxOutputMiB, proxyReadTimeoutSeconds]);

  const shellLimitSettingsChanged = useMemo(() => (
    currentRuntimeLimitSettings.commandTimeoutSeconds !== initialRuntimeLimitSettings.commandTimeoutSeconds ||
    currentRuntimeLimitSettings.maxOutputMiB !== initialRuntimeLimitSettings.maxOutputMiB
  ), [currentRuntimeLimitSettings, initialRuntimeLimitSettings]);

  const proxyTimeoutSettingsChanged = useMemo(() => (
    currentRuntimeLimitSettings.proxyReadTimeoutSeconds !== initialRuntimeLimitSettings.proxyReadTimeoutSeconds
  ), [currentRuntimeLimitSettings, initialRuntimeLimitSettings]);

  const dockerLimitSettingsChanged = useMemo(() => (
    currentRuntimeLimitSettings.dockerWaitTimeoutSeconds !== initialRuntimeLimitSettings.dockerWaitTimeoutSeconds
  ), [currentRuntimeLimitSettings, initialRuntimeLimitSettings]);

  const runtimeLimitControlsDisabled = (
    !runtimeLimitSettingsLoaded ||
    loadingRuntimeLimitSettings ||
    savingRuntimeLimitSettings
  );

  const currentPublicRouteSettings = useMemo(() => ({
    publishedWorkflowsSlug: publishedWorkflowsSlug.trim(),
    latestWorkflowsSlug: latestWorkflowsSlug.trim(),
    publishedAppsSlug: publishedAppsSlug.trim(),
    latestAppsSlug: latestAppsSlug.trim(),
  }), [latestAppsSlug, latestWorkflowsSlug, publishedAppsSlug, publishedWorkflowsSlug]);

  const workflowRouteSettingsChanged = useMemo(() => (
    currentPublicRouteSettings.publishedWorkflowsSlug !== initialPublicRouteSettings.publishedWorkflowsSlug ||
    currentPublicRouteSettings.latestWorkflowsSlug !== initialPublicRouteSettings.latestWorkflowsSlug
  ), [currentPublicRouteSettings, initialPublicRouteSettings]);

  const webAppRouteSettingsChanged = useMemo(() => (
    currentPublicRouteSettings.publishedAppsSlug !== initialPublicRouteSettings.publishedAppsSlug ||
    currentPublicRouteSettings.latestAppsSlug !== initialPublicRouteSettings.latestAppsSlug
  ), [currentPublicRouteSettings, initialPublicRouteSettings]);

  const currentWebAppAuthSettings = useMemo(() => ({
    mode: webAppAuthMode,
    provider: webAppOAuthProvider,
    dummyEmail: webAppDummyEmail.trim(),
    dummyAllowNonLocalhost: webAppDummyAllowNonLocalhost,
    authorizeUrl: webAppAuthorizeUrl.trim(),
    tokenUrl: webAppTokenUrl.trim(),
    userUrl: webAppUserUrl.trim(),
    clientId: webAppClientId.trim(),
    clientSecret: webAppClientSecret.trim(),
    callbackUrl: webAppCallbackUrl.trim(),
    scopes: webAppScopes.trim(),
    emailClaim: webAppEmailClaim.trim(),
    sessionSecret: webAppSessionSecret.trim(),
    sessionTtlSeconds: String(Math.max(1, Number(webAppSessionTtlHours.trim()) || 1) * 3600),
    clientAuthMethod: webAppClientAuthMethod,
    debugLogProfile: webAppDebugLogProfile,
  }), [
    webAppAuthMode,
    webAppAuthorizeUrl,
    webAppCallbackUrl,
    webAppClientAuthMethod,
    webAppClientId,
    webAppClientSecret,
    webAppDebugLogProfile,
    webAppDummyAllowNonLocalhost,
    webAppDummyEmail,
    webAppEmailClaim,
    webAppOAuthProvider,
    webAppScopes,
    webAppSessionSecret,
    webAppSessionTtlHours,
    webAppTokenUrl,
    webAppUserUrl,
  ]);

  const webAppAuthSettingsChanged = useMemo(() => (
    currentWebAppAuthSettings.mode !== initialWebAppAuthSettings.mode ||
    currentWebAppAuthSettings.provider !== initialWebAppAuthSettings.provider ||
    currentWebAppAuthSettings.dummyEmail !== initialWebAppAuthSettings.dummyEmail ||
    currentWebAppAuthSettings.dummyAllowNonLocalhost !== initialWebAppAuthSettings.dummyAllowNonLocalhost ||
    currentWebAppAuthSettings.authorizeUrl !== initialWebAppAuthSettings.authorizeUrl ||
    currentWebAppAuthSettings.tokenUrl !== initialWebAppAuthSettings.tokenUrl ||
    currentWebAppAuthSettings.userUrl !== initialWebAppAuthSettings.userUrl ||
    currentWebAppAuthSettings.clientId !== initialWebAppAuthSettings.clientId ||
    currentWebAppAuthSettings.clientSecret !== '' ||
    currentWebAppAuthSettings.callbackUrl !== initialWebAppAuthSettings.callbackUrl ||
    currentWebAppAuthSettings.scopes !== initialWebAppAuthSettings.scopes ||
    currentWebAppAuthSettings.emailClaim !== initialWebAppAuthSettings.emailClaim ||
    currentWebAppAuthSettings.sessionSecret !== '' ||
    webAppSessionTtlHours.trim() !== initialWebAppAuthSettings.sessionTtlHours ||
    currentWebAppAuthSettings.clientAuthMethod !== initialWebAppAuthSettings.clientAuthMethod ||
    currentWebAppAuthSettings.debugLogProfile !== initialWebAppAuthSettings.debugLogProfile
  ), [currentWebAppAuthSettings, initialWebAppAuthSettings, webAppSessionTtlHours]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab('general');
    setProxySettingsSaved(false);
    setExecutorUrlOverrideSettingsSaved(false);
    setDeploymentStorageSettingsSaved(false);
    setRunRecordingsSettingsSaved(false);
    setRuntimeLimitSettingsLoaded(false);
    setRuntimeLimitSettingsSaved(false);
    setPublicRouteSettingsSaved(false);
    setWebAppAuthSettingsSaved(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'storage') {
      return;
    }

    let cancelled = false;
    setLoadingDeploymentStorageSettings(true);
    setDeploymentStorageSettingsError(null);
    setDeploymentStorageSettingsSaved(false);

    fetchDeploymentStorageSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const snapshot = createDeploymentStorageSnapshot(settings);
        setStorageMode(snapshot.storageMode);
        setArtifactsHostPath(snapshot.artifactsHostPath);
        setDatabaseMode(snapshot.databaseMode);
        setDatabaseSslMode(snapshot.databaseSslMode);
        setDatabaseConnectionString('');
        setDatabaseConnectionStringConfigured(snapshot.databaseConnectionStringConfigured);
        setStorageUrl(snapshot.storageUrl);
        setStorageAccessKeyId(snapshot.storageAccessKeyId);
        setStorageAccessKey('');
        setStorageAccessKeyConfigured(snapshot.storageAccessKeyConfigured);
        setInitialDeploymentStorageSettings(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setDeploymentStorageSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDeploymentStorageSettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen]);

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
    if (!isOpen || activeTab !== 'node-executor-proxy') {
      return;
    }

    let cancelled = false;
    setLoadingExecutorUrlOverrideSettings(true);
    setExecutorUrlOverrideSettingsError(null);
    setExecutorUrlOverrideSettingsSaved(false);

    fetchExecutorUrlOverrideSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const nextSettings = {
          executorWsUrl: settings.executorWsUrl,
          remoteDebuggerDefaultWs: settings.remoteDebuggerDefaultWs,
        };
        setExecutorWsUrlOverride(nextSettings.executorWsUrl);
        setRemoteDebuggerWsUrlOverride(nextSettings.remoteDebuggerDefaultWs);
        setInitialExecutorUrlOverrideSettings(nextSettings);
      })
      .catch((error) => {
        if (!cancelled) {
          setExecutorUrlOverrideSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingExecutorUrlOverrideSettings(false);
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

  useEffect(() => {
    if (
      !isOpen ||
      runtimeLimitSettingsLoaded ||
      (activeTab !== 'general' && activeTab !== 'workflow-endpoints' && activeTab !== 'docker')
    ) {
      return;
    }

    let cancelled = false;
    setLoadingRuntimeLimitSettings(true);
    setRuntimeLimitSettingsError(null);
    setRuntimeLimitSettingsSaved(false);
    setRuntimeLimitSettingsStatusScope(null);

    fetchRuntimeLimitSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const snapshot = createRuntimeLimitSnapshot(settings);
        setCommandTimeoutSeconds(snapshot.commandTimeoutSeconds);
        setMaxOutputMiB(snapshot.maxOutputMiB);
        setProxyReadTimeoutSeconds(snapshot.proxyReadTimeoutSeconds);
        setDockerWaitTimeoutSeconds(snapshot.dockerWaitTimeoutSeconds);
        setInitialRuntimeLimitSettings(snapshot);
        setRuntimeLimitSettingsLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setRuntimeLimitSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRuntimeLimitSettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen, runtimeLimitSettingsLoaded]);

  useEffect(() => {
    if (!isOpen || (activeTab !== 'workflow-endpoints' && activeTab !== 'web-apps')) {
      return;
    }

    let cancelled = false;
    setLoadingPublicRouteSettings(true);
    setPublicRouteSettingsError(null);
    setPublicRouteSettingsSaved(false);
    setPublicRouteSettingsStatusScope(null);

    fetchPublicRouteSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const snapshot = createPublicRouteSnapshot(settings);
        setPublishedWorkflowsSlug(snapshot.publishedWorkflowsSlug);
        setLatestWorkflowsSlug(snapshot.latestWorkflowsSlug);
        setPublishedAppsSlug(snapshot.publishedAppsSlug);
        setLatestAppsSlug(snapshot.latestAppsSlug);
        setInitialPublicRouteSettings(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setPublicRouteSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPublicRouteSettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'web-apps') {
      return;
    }

    let cancelled = false;
    setLoadingWebAppAuthSettings(true);
    setWebAppAuthSettingsError(null);
    setWebAppAuthSettingsSaved(false);

    fetchWebAppAuthSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        const snapshot = createWebAppAuthSnapshot(settings);
        setWebAppAuthMode(settings.mode);
        setWebAppOAuthProvider(settings.provider);
        setWebAppDummyEmail(settings.dummyEmail);
        setWebAppDummyAllowNonLocalhost(settings.dummyAllowNonLocalhost);
        setWebAppAuthorizeUrl(settings.authorizeUrl);
        setWebAppTokenUrl(settings.tokenUrl);
        setWebAppUserUrl(settings.userUrl);
        setWebAppClientId(settings.clientId);
        setWebAppClientSecret('');
        setWebAppClientSecretConfigured(settings.clientSecretConfigured);
        setWebAppCallbackUrl(settings.callbackUrl);
        setWebAppScopes(settings.scopes);
        setWebAppEmailClaim(settings.emailClaim);
        setWebAppSessionSecret('');
        setWebAppSessionSecretConfigured(settings.sessionSecretConfigured);
        setWebAppSessionTtlHours(snapshot.sessionTtlHours);
        setWebAppClientAuthMethod(settings.clientAuthMethod);
        setWebAppDebugLogProfile(settings.debugLogProfile);
        setInitialWebAppAuthSettings(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setWebAppAuthSettingsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingWebAppAuthSettings(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleSaveDeploymentStorageSettings = async () => {
    setSavingDeploymentStorageSettings(true);
    setDeploymentStorageSettingsError(null);
    setDeploymentStorageSettingsSaved(false);

    try {
      const saved = await saveDeploymentStorageSettings(currentDeploymentStorageSettings);
      const snapshot = createDeploymentStorageSnapshot(saved);
      setStorageMode(snapshot.storageMode);
      setArtifactsHostPath(snapshot.artifactsHostPath);
      setDatabaseMode(snapshot.databaseMode);
      setDatabaseSslMode(snapshot.databaseSslMode);
      setDatabaseConnectionString('');
      setDatabaseConnectionStringConfigured(snapshot.databaseConnectionStringConfigured);
      setStorageUrl(snapshot.storageUrl);
      setStorageAccessKeyId(snapshot.storageAccessKeyId);
      setStorageAccessKey('');
      setStorageAccessKeyConfigured(snapshot.storageAccessKeyConfigured);
      setInitialDeploymentStorageSettings(snapshot);
      setDeploymentStorageSettingsSaved(true);
    } catch (error) {
      setDeploymentStorageSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingDeploymentStorageSettings(false);
    }
  };

  const handleRevertDeploymentStorageSettings = () => {
    setStorageMode(initialDeploymentStorageSettings.storageMode);
    setArtifactsHostPath(initialDeploymentStorageSettings.artifactsHostPath);
    setDatabaseMode(initialDeploymentStorageSettings.databaseMode);
    setDatabaseSslMode(initialDeploymentStorageSettings.databaseSslMode);
    setDatabaseConnectionString('');
    setDatabaseConnectionStringConfigured(initialDeploymentStorageSettings.databaseConnectionStringConfigured);
    setStorageUrl(initialDeploymentStorageSettings.storageUrl);
    setStorageAccessKeyId(initialDeploymentStorageSettings.storageAccessKeyId);
    setStorageAccessKey('');
    setStorageAccessKeyConfigured(initialDeploymentStorageSettings.storageAccessKeyConfigured);
    setDeploymentStorageSettingsSaved(false);
    setDeploymentStorageSettingsError(null);
  };

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

  const handleSaveExecutorUrlOverrideSettings = async () => {
    setSavingExecutorUrlOverrideSettings(true);
    setExecutorUrlOverrideSettingsError(null);
    setExecutorUrlOverrideSettingsSaved(false);

    try {
      const savedSettings = await saveExecutorUrlOverrideSettings(currentExecutorUrlOverrideSettings);
      const nextSettings = {
        executorWsUrl: savedSettings.executorWsUrl,
        remoteDebuggerDefaultWs: savedSettings.remoteDebuggerDefaultWs,
      };
      setExecutorWsUrlOverride(nextSettings.executorWsUrl);
      setRemoteDebuggerWsUrlOverride(nextSettings.remoteDebuggerDefaultWs);
      setInitialExecutorUrlOverrideSettings(nextSettings);
      const activeConfig = await fetchHostedConfig();
      onRouteConfigChange?.({
        ...routeConfig,
        ...activeConfig,
      });
      setExecutorUrlOverrideSettingsSaved(true);
    } catch (error) {
      setExecutorUrlOverrideSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingExecutorUrlOverrideSettings(false);
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

  const handleSaveRuntimeLimitSettings = async (scope: RuntimeLimitSettingsScope) => {
    setSavingRuntimeLimitSettings(true);
    setRuntimeLimitSettingsError(null);
    setRuntimeLimitSettingsSaved(false);
    setRuntimeLimitSettingsStatusScope(scope);

    const draft: RuntimeLimitSettingsDraft = {
      commandTimeoutSeconds: scope === 'shell'
        ? currentRuntimeLimitSettings.commandTimeoutSeconds
        : initialRuntimeLimitSettings.commandTimeoutSeconds,
      maxOutputBytes: scope === 'shell'
        ? miBStringToBytesString(currentRuntimeLimitSettings.maxOutputMiB)
        : miBStringToBytesString(initialRuntimeLimitSettings.maxOutputMiB),
      proxyReadTimeoutSeconds: scope === 'proxy-timeout'
        ? currentRuntimeLimitSettings.proxyReadTimeoutSeconds
        : initialRuntimeLimitSettings.proxyReadTimeoutSeconds,
      dockerWaitTimeoutSeconds: scope === 'docker'
        ? currentRuntimeLimitSettings.dockerWaitTimeoutSeconds
        : initialRuntimeLimitSettings.dockerWaitTimeoutSeconds,
    };

    try {
      const savedSettings = await saveRuntimeLimitSettings(draft);
      const snapshot = createRuntimeLimitSnapshot(savedSettings);
      if (scope === 'shell') {
        setCommandTimeoutSeconds(snapshot.commandTimeoutSeconds);
        setMaxOutputMiB(snapshot.maxOutputMiB);
      } else if (scope === 'proxy-timeout') {
        setProxyReadTimeoutSeconds(snapshot.proxyReadTimeoutSeconds);
      } else {
        setDockerWaitTimeoutSeconds(snapshot.dockerWaitTimeoutSeconds);
      }
      setInitialRuntimeLimitSettings(snapshot);
      setRuntimeLimitSettingsSaved(true);
    } catch (error) {
      setRuntimeLimitSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRuntimeLimitSettings(false);
    }
  };

  const handleSavePublicRouteSettings = async (scope: PublicRouteSettingsScope) => {
    setSavingPublicRouteSettings(true);
    setApplyingPublicRouteSettings(false);
    setPublicRouteSettingsError(null);
    setPublicRouteSettingsSaved(false);
    setPublicRouteSettingsStatusScope(scope);

    try {
      const savedSettings = await savePublicRouteSettings({
        publishedWorkflowsBasePath: scope === 'workflow-endpoints'
          ? currentPublicRouteSettings.publishedWorkflowsSlug
          : initialPublicRouteSettings.publishedWorkflowsSlug,
        latestWorkflowsBasePath: scope === 'workflow-endpoints'
          ? currentPublicRouteSettings.latestWorkflowsSlug
          : initialPublicRouteSettings.latestWorkflowsSlug,
        publishedAppsBasePath: scope === 'web-apps'
          ? currentPublicRouteSettings.publishedAppsSlug
          : initialPublicRouteSettings.publishedAppsSlug,
        latestAppsBasePath: scope === 'web-apps'
          ? currentPublicRouteSettings.latestAppsSlug
          : initialPublicRouteSettings.latestAppsSlug,
      });
      const snapshot = createPublicRouteSnapshot(savedSettings);
      if (scope === 'workflow-endpoints') {
        setPublishedWorkflowsSlug(snapshot.publishedWorkflowsSlug);
        setLatestWorkflowsSlug(snapshot.latestWorkflowsSlug);
      } else {
        setPublishedAppsSlug(snapshot.publishedAppsSlug);
        setLatestAppsSlug(snapshot.latestAppsSlug);
      }
      setInitialPublicRouteSettings(snapshot);
      setSavingPublicRouteSettings(false);
      setApplyingPublicRouteSettings(true);
      const activeConfig = await waitForHostedRouteConfig(savedSettings);
      onRouteConfigChange?.({
        ...routeConfig,
        ...activeConfig,
      });
      setPublicRouteSettingsSaved(true);
    } catch (error) {
      setPublicRouteSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPublicRouteSettings(false);
      setApplyingPublicRouteSettings(false);
    }
  };

  const handleSaveWebAppAuthSettings = async () => {
    setSavingWebAppAuthSettings(true);
    setWebAppAuthSettingsError(null);
    setWebAppAuthSettingsSaved(false);

    try {
      const savedSettings = await saveWebAppAuthSettings(currentWebAppAuthSettings);
      const snapshot = createWebAppAuthSnapshot(savedSettings);
      setWebAppAuthMode(savedSettings.mode);
      setWebAppOAuthProvider(savedSettings.provider);
      setWebAppDummyEmail(savedSettings.dummyEmail);
      setWebAppDummyAllowNonLocalhost(savedSettings.dummyAllowNonLocalhost);
      setWebAppAuthorizeUrl(savedSettings.authorizeUrl);
      setWebAppTokenUrl(savedSettings.tokenUrl);
      setWebAppUserUrl(savedSettings.userUrl);
      setWebAppClientId(savedSettings.clientId);
      setWebAppClientSecret('');
      setWebAppClientSecretConfigured(savedSettings.clientSecretConfigured);
      setWebAppCallbackUrl(savedSettings.callbackUrl);
      setWebAppScopes(savedSettings.scopes);
      setWebAppEmailClaim(savedSettings.emailClaim);
      setWebAppSessionSecret('');
      setWebAppSessionSecretConfigured(savedSettings.sessionSecretConfigured);
      setWebAppSessionTtlHours(snapshot.sessionTtlHours);
      setWebAppClientAuthMethod(savedSettings.clientAuthMethod);
      setWebAppDebugLogProfile(savedSettings.debugLogProfile);
      setInitialWebAppAuthSettings(snapshot);
      setWebAppAuthSettingsSaved(true);
      onRouteConfigChange?.({
        ...routeConfig,
        webAppsAuthMode: savedSettings.mode,
      });
    } catch (error) {
      setWebAppAuthSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingWebAppAuthSettings(false);
    }
  };

  const handleRevertPublicRouteSettings = () => {
    if (activeTab === 'workflow-endpoints') {
      setPublishedWorkflowsSlug(initialPublicRouteSettings.publishedWorkflowsSlug);
      setLatestWorkflowsSlug(initialPublicRouteSettings.latestWorkflowsSlug);
    } else {
      setPublishedAppsSlug(initialPublicRouteSettings.publishedAppsSlug);
      setLatestAppsSlug(initialPublicRouteSettings.latestAppsSlug);
    }
    setPublicRouteSettingsSaved(false);
    setPublicRouteSettingsError(null);
    setPublicRouteSettingsStatusScope(null);
  };

  const handleRevertRuntimeLimitSettings = (scope: RuntimeLimitSettingsScope) => {
    if (scope === 'shell') {
      setCommandTimeoutSeconds(initialRuntimeLimitSettings.commandTimeoutSeconds);
      setMaxOutputMiB(initialRuntimeLimitSettings.maxOutputMiB);
    } else if (scope === 'proxy-timeout') {
      setProxyReadTimeoutSeconds(initialRuntimeLimitSettings.proxyReadTimeoutSeconds);
    } else {
      setDockerWaitTimeoutSeconds(initialRuntimeLimitSettings.dockerWaitTimeoutSeconds);
    }
    setRuntimeLimitSettingsSaved(false);
    setRuntimeLimitSettingsError(null);
    setRuntimeLimitSettingsStatusScope(null);
  };

  const handleRevertWebAppAuthSettings = () => {
    setWebAppAuthMode(initialWebAppAuthSettings.mode);
    setWebAppOAuthProvider(initialWebAppAuthSettings.provider);
    setWebAppDummyEmail(initialWebAppAuthSettings.dummyEmail);
    setWebAppDummyAllowNonLocalhost(initialWebAppAuthSettings.dummyAllowNonLocalhost);
    setWebAppAuthorizeUrl(initialWebAppAuthSettings.authorizeUrl);
    setWebAppTokenUrl(initialWebAppAuthSettings.tokenUrl);
    setWebAppUserUrl(initialWebAppAuthSettings.userUrl);
    setWebAppClientId(initialWebAppAuthSettings.clientId);
    setWebAppClientSecret('');
    setWebAppCallbackUrl(initialWebAppAuthSettings.callbackUrl);
    setWebAppScopes(initialWebAppAuthSettings.scopes);
    setWebAppEmailClaim(initialWebAppAuthSettings.emailClaim);
    setWebAppSessionSecret('');
    setWebAppSessionTtlHours(initialWebAppAuthSettings.sessionTtlHours);
    setWebAppClientAuthMethod(initialWebAppAuthSettings.clientAuthMethod);
    setWebAppDebugLogProfile(initialWebAppAuthSettings.debugLogProfile);
    setWebAppAuthSettingsSaved(false);
    setWebAppAuthSettingsError(null);
  };

  const renderTabButton = (tab: AppSettingsTab, label: string) => (
    <button
      type="button"
      className={`project-settings-tab app-settings-nav-tab${activeTab === tab ? ' active' : ''}`}
      role="tab"
      aria-selected={activeTab === tab}
      onClick={() => setActiveTab(tab)}
    >
      {label}
    </button>
  );

  const renderActionStatus = (error: string | null, saved: boolean, pending?: string, savedMessage = 'Saved.') => {
    if (error) {
      return <div className="project-settings-error app-settings-action-status">{error}</div>;
    }

    if (pending) {
      return <div className="project-settings-muted app-settings-action-status">{pending}</div>;
    }

    if (saved) {
      return <div className="project-settings-success app-settings-action-status">{savedMessage}</div>;
    }

    return null;
  };

  const renderModeButton = (
    active: boolean,
    label: string,
    onClick: () => void,
    disabled = loadingRunRecordingsSettings || savingRunRecordingsSettings,
  ) => (
    <button
      type="button"
      className={`project-settings-tab app-settings-mode-tab${active ? ' active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const renderBooleanSetting = (
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    disabled: boolean,
  ) => (
    <label className="app-settings-checkbox-field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="app-settings-checkbox-label">{label}</span>
    </label>
  );

  const webAppAuthBusy = loadingWebAppAuthSettings || savingWebAppAuthSettings;
  const webAppAuthModeHelp = webAppAuthMode === 'oauth'
    ? 'Visitors sign in with OAuth and are checked against each web app\'s allowed-email list.'
    : webAppAuthMode === 'none'
      ? 'Web app routes are open at the API layer. Use this only behind another access-control layer.'
      : 'Visitors use the same Rivet key prompt as the server UI.';

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
              <div className="app-settings-layout">
                <aside className="app-settings-sidebar" aria-label="Settings navigation">
                  <div
                    className="project-settings-tabs app-settings-tab-list"
                    role="tablist"
                    aria-label="App settings sections"
                    aria-orientation="vertical"
                  >
                    {renderTabButton('general', 'General')}
                    {renderTabButton('storage', 'Storage')}
                    {renderTabButton('workflow-endpoints', 'Workflow endpoints')}
                    {renderTabButton('run-recordings', 'Run recordings')}
                    {renderTabButton('node-executor-proxy', 'Node executor proxy')}
                    {renderTabButton('web-apps', 'Web apps')}
                    {renderTabButton('docker', 'Docker')}
                  </div>
                </aside>

                <div className="app-settings-panel-region">

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

                  <section className="app-settings-section" aria-label="Shell execution">
                    <div className="app-settings-section-title">Shell execution</div>
                    <div className="app-settings-field-grid" aria-busy={!runtimeLimitSettingsLoaded || loadingRuntimeLimitSettings || savingRuntimeLimitSettings}>
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Command timeout</span>
                        <TextField
                          aria-label="Command timeout in seconds"
                          type="number"
                          min={1}
                          value={commandTimeoutSeconds}
                          isDisabled={runtimeLimitControlsDisabled}
                          elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
                          onChange={(event) => {
                            setCommandTimeoutSeconds(event.currentTarget.value);
                            setRuntimeLimitSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          How long hosted shell commands may run before the API stops them.
                        </span>
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Maximum captured output</span>
                        <TextField
                          aria-label="Maximum captured output in MiB"
                          type="number"
                          min={1}
                          value={maxOutputMiB}
                          isDisabled={runtimeLimitControlsDisabled}
                          elemAfterInput={<span className="app-settings-input-suffix">MiB</span>}
                          onChange={(event) => {
                            setMaxOutputMiB(event.currentTarget.value);
                            setRuntimeLimitSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          How much command output the API keeps before truncating it.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingRuntimeLimitSettings && runtimeLimitSettingsStatusScope === 'shell'}
                        isDisabled={runtimeLimitControlsDisabled || !shellLimitSettingsChanged}
                        onClick={() => handleSaveRuntimeLimitSettings('shell')}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={runtimeLimitControlsDisabled || !shellLimitSettingsChanged}
                        onClick={() => handleRevertRuntimeLimitSettings('shell')}
                      >
                        Revert
                      </Button>
                      {runtimeLimitSettingsStatusScope === 'shell' || runtimeLimitSettingsStatusScope === null
                        ? renderActionStatus(runtimeLimitSettingsError, runtimeLimitSettingsSaved)
                        : null}
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'storage' ? (
                <div className="project-settings-tab-panel app-settings-storage-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Project artifact storage">
                    <div className="app-settings-field-grid" aria-busy={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}>
                      <div className="app-settings-field">
                        <span className="app-settings-field-label">Project artifact storage</span>
                        <div className="project-settings-tabs app-settings-mode-tabs app-settings-wide-mode-tabs" role="group" aria-label="Storage backend">
                          {renderModeButton(
                            storageMode === 'filesystem',
                            'Local folders',
                            () => {
                              setStorageMode('filesystem');
                              setDeploymentStorageSettingsSaved(false);
                            },
                            loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                          )}
                          {renderModeButton(
                            storageMode === 'managed',
                            'Object storage',
                            () => {
                              setStorageMode('managed');
                              setDeploymentStorageSettingsSaved(false);
                            },
                            loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                          )}
                        </div>
                        <span className="app-settings-field-help">
                          {storageMode === 'filesystem'
                            ? 'Saved projects, recordings, published snapshots, and runtime libraries use the mounted local folders.'
                            : 'Saved projects, recordings, published snapshots, and runtime-library artifacts use S3-compatible object storage. Metadata is controlled by the database section below.'}
                        </span>
                      </div>

                      {storageMode === 'filesystem' ? (
                        <label className="app-settings-field">
                          <span className="app-settings-field-label">Host artifacts folder</span>
                          <TextField
                            aria-label="Host artifacts folder"
                            value={artifactsHostPath}
                            isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}
                            placeholder="../"
                            onChange={(event) => {
                              setArtifactsHostPath(event.currentTarget.value);
                              setDeploymentStorageSettingsSaved(false);
                            }}
                          />
                          <span className="app-settings-field-help">
                            This records the intended host root for filesystem storage. Docker and Kubernetes mounts must still point at that host root before the app starts.
                          </span>
                        </label>
                      ) : null}

                      {storageMode === 'managed' ? (
                        <>
                          <label className="app-settings-field">
                            <span className="app-settings-field-label">Object storage URL</span>
                            <TextField
                              aria-label="Object storage URL"
                              value={storageUrl}
                              isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}
                              placeholder="https://bucket.region.example.com"
                              onChange={(event) => {
                                setStorageUrl(event.currentTarget.value);
                                setDeploymentStorageSettingsSaved(false);
                              }}
                            />
                            <span className="app-settings-field-help">
                              Use an S3-compatible bucket URL. For local MinIO rehearsals, enter the MinIO URL and credentials from the optional Compose service.
                            </span>
                          </label>

                          <label className="app-settings-field">
                            <span className="app-settings-field-label">Object storage access key ID</span>
                            <TextField
                              aria-label="Object storage access key ID"
                              value={storageAccessKeyId}
                              isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}
                              placeholder="access-key-id"
                              onChange={(event) => {
                                setStorageAccessKeyId(event.currentTarget.value);
                                setDeploymentStorageSettingsSaved(false);
                              }}
                            />
                          </label>

                          <label className="app-settings-field">
                            <span className="app-settings-field-label">Object storage secret access key</span>
                            <TextField
                              aria-label="Object storage secret access key"
                              type="password"
                              value={storageAccessKey}
                              isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}
                              placeholder={storageAccessKeyConfigured ? 'Already saved; leave blank to keep it' : 'secret-access-key'}
                              onChange={(event) => {
                                setStorageAccessKey(event.currentTarget.value);
                                setDeploymentStorageSettingsSaved(false);
                              }}
                            />
                            <span className="app-settings-field-help">
                              {storageAccessKeyConfigured
                                ? 'A secret access key is saved. Enter a new value only when rotating it.'
                                : 'Required before managed object storage can be enabled.'}
                            </span>
                          </label>
                        </>
                      ) : null}
                    </div>
                  </section>

                  <section className="app-settings-section" aria-label="Metadata database">
                    <div className="app-settings-field-grid" aria-busy={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}>
                      <div className="app-settings-field">
                        <span className="app-settings-field-label">Metadata database</span>
                        <div className="project-settings-tabs app-settings-mode-tabs app-settings-wide-mode-tabs" role="group" aria-label="Database backend">
                          {renderModeButton(
                            databaseMode === 'local-docker',
                            'Local Docker Postgres',
                            () => {
                              setDatabaseMode('local-docker');
                              setDatabaseSslMode('disable');
                              setDeploymentStorageSettingsSaved(false);
                            },
                            loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                          )}
                          {renderModeButton(
                            databaseMode === 'managed',
                            'Managed Postgres',
                            () => {
                              setDatabaseMode('managed');
                              setDatabaseSslMode('require');
                              setDeploymentStorageSettingsSaved(false);
                            },
                            loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                          )}
                        </div>
                        <span className="app-settings-field-help">
                          {databaseMode === 'local-docker'
                            ? 'Use the optional Compose Postgres service for local managed-storage rehearsals. It must already be running before object storage mode can apply.'
                            : 'Use an external PostgreSQL cluster for managed metadata. These fields can be prepared before switching project artifact storage to object storage.'}
                        </span>
                      </div>

                      {databaseMode === 'managed' ? (
                        <>
                          <label className="app-settings-field">
                            <span className="app-settings-field-label">PostgreSQL connection string</span>
                            <TextField
                              aria-label="PostgreSQL connection string"
                              type="password"
                              value={databaseConnectionString}
                              isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings}
                              placeholder={databaseConnectionStringConfigured ? 'Already saved; leave blank to keep it' : 'postgresql://user:password@host:5432/database'}
                              onChange={(event) => {
                                setDatabaseConnectionString(event.currentTarget.value);
                                setDeploymentStorageSettingsSaved(false);
                              }}
                            />
                            <span className="app-settings-field-help">
                              {databaseConnectionStringConfigured
                                ? 'A connection string is saved. Enter a new value only when rotating it.'
                                : 'Required before object storage mode can use a managed PostgreSQL cluster.'}
                            </span>
                          </label>

                          <div className="app-settings-field">
                            <span className="app-settings-field-label">PostgreSQL SSL</span>
                            <div className="project-settings-tabs app-settings-mode-tabs" role="group" aria-label="PostgreSQL SSL mode">
                              {renderModeButton(
                                databaseSslMode === 'require',
                                'Require',
                                () => {
                                  setDatabaseSslMode('require');
                                  setDeploymentStorageSettingsSaved(false);
                                },
                                loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                              )}
                              {renderModeButton(
                                databaseSslMode === 'verify-full',
                                'Verify full',
                                () => {
                                  setDatabaseSslMode('verify-full');
                                  setDeploymentStorageSettingsSaved(false);
                                },
                                loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                              )}
                              {renderModeButton(
                                databaseSslMode === 'disable',
                                'Disable',
                                () => {
                                  setDatabaseSslMode('disable');
                                  setDeploymentStorageSettingsSaved(false);
                                },
                                loadingDeploymentStorageSettings || savingDeploymentStorageSettings,
                              )}
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </section>

                  <div className="app-settings-actions-row">
                    <LoadingButton
                      appearance="primary"
                      className="app-settings-action-button button-size-l"
                      isLoading={savingDeploymentStorageSettings}
                      isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings || !deploymentStorageSettingsChanged}
                      onClick={handleSaveDeploymentStorageSettings}
                    >
                      Save
                    </LoadingButton>
                    <Button
                      appearance="subtle"
                      className="app-settings-action-button button-size-l"
                      isDisabled={loadingDeploymentStorageSettings || savingDeploymentStorageSettings || !deploymentStorageSettingsChanged}
                      onClick={handleRevertDeploymentStorageSettings}
                    >
                      Revert
                    </Button>
                    {renderActionStatus(
                      deploymentStorageSettingsError,
                      deploymentStorageSettingsSaved,
                      undefined,
                      'Saved. Restart Docker services or roll out Kubernetes pods to apply storage changes.',
                    )}
                  </div>
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

              {activeTab === 'workflow-endpoints' ? (
                <div className="project-settings-tab-panel app-settings-workflow-endpoints-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Workflow endpoint routes">
                    <div className="app-settings-section-title">Routes</div>
                    <div
                      className="app-settings-field-grid"
                      aria-busy={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                    >
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Published workflow endpoint URL slug</span>
                        <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
                          <span className="project-settings-url-prefix">/</span>
                          <TextField
                            aria-label="Published workflow endpoint URL slug"
                            className="project-settings-input text-field-size-l"
                            value={publishedWorkflowsSlug}
                            isDisabled={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                            placeholder="workflows"
                            onChange={(event) => {
                              setPublishedWorkflowsSlug(event.currentTarget.value);
                              setPublicRouteSettingsSaved(false);
                              setPublicRouteSettingsStatusScope(null);
                            }}
                          />
                        </div>
                        <span className="app-settings-field-help">
                          Published workflow endpoints open from this top-level URL slug.
                        </span>
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Latest saved workflow endpoint URL slug</span>
                        <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
                          <span className="project-settings-url-prefix">/</span>
                          <TextField
                            aria-label="Latest saved workflow endpoint URL slug"
                            className="project-settings-input text-field-size-l"
                            value={latestWorkflowsSlug}
                            isDisabled={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                            placeholder="workflows-latest"
                            onChange={(event) => {
                              setLatestWorkflowsSlug(event.currentTarget.value);
                              setPublicRouteSettingsSaved(false);
                              setPublicRouteSettingsStatusScope(null);
                            }}
                          />
                        </div>
                        <span className="app-settings-field-help">
                          Latest saved draft workflow endpoints open from this top-level URL slug.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingPublicRouteSettings || applyingPublicRouteSettings}
                        isDisabled={
                          loadingPublicRouteSettings ||
                          savingPublicRouteSettings ||
                          applyingPublicRouteSettings ||
                          !workflowRouteSettingsChanged
                        }
                        onClick={() => handleSavePublicRouteSettings('workflow-endpoints')}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={
                          loadingPublicRouteSettings ||
                          savingPublicRouteSettings ||
                          applyingPublicRouteSettings ||
                          !workflowRouteSettingsChanged
                        }
                        onClick={handleRevertPublicRouteSettings}
                      >
                        Revert
                      </Button>
                      {renderActionStatus(
                        publicRouteSettingsStatusScope === 'workflow-endpoints' ? publicRouteSettingsError : null,
                        publicRouteSettingsStatusScope === 'workflow-endpoints' && publicRouteSettingsSaved,
                        publicRouteSettingsStatusScope === 'workflow-endpoints' && applyingPublicRouteSettings
                          ? 'Applying routes...'
                          : undefined,
                      )}
                    </div>
                  </section>

                  <section className="app-settings-section" aria-label="HTTP request timeout">
                    <div className="app-settings-section-title">HTTP request timeout</div>
                    <div className="app-settings-field-grid" aria-busy={!runtimeLimitSettingsLoaded || loadingRuntimeLimitSettings || savingRuntimeLimitSettings}>
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Proxy read timeout</span>
                        <TextField
                          aria-label="Proxy read timeout in seconds"
                          type="number"
                          min={1}
                          value={proxyReadTimeoutSeconds}
                          isDisabled={runtimeLimitControlsDisabled}
                          elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
                          onChange={(event) => {
                            setProxyReadTimeoutSeconds(event.currentTarget.value);
                            setRuntimeLimitSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          How long standard API, workflow endpoint, and web-app action requests may stay open through nginx. Websocket routes stay long-lived separately.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingRuntimeLimitSettings && runtimeLimitSettingsStatusScope === 'proxy-timeout'}
                        isDisabled={runtimeLimitControlsDisabled || !proxyTimeoutSettingsChanged}
                        onClick={() => handleSaveRuntimeLimitSettings('proxy-timeout')}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={runtimeLimitControlsDisabled || !proxyTimeoutSettingsChanged}
                        onClick={() => handleRevertRuntimeLimitSettings('proxy-timeout')}
                      >
                        Revert
                      </Button>
                      {runtimeLimitSettingsStatusScope === 'proxy-timeout' || runtimeLimitSettingsStatusScope === null
                        ? renderActionStatus(runtimeLimitSettingsError, runtimeLimitSettingsSaved)
                        : null}
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'web-apps' ? (
                <div className="project-settings-tab-panel app-settings-web-apps-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Web app routes">
                    <div className="app-settings-section-title">Routes</div>
                    <div
                      className="app-settings-field-grid"
                      aria-busy={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                    >
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Published web app URL slug</span>
                        <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
                          <span className="project-settings-url-prefix">/</span>
                          <TextField
                            aria-label="Published web app URL slug"
                            className="project-settings-input text-field-size-l"
                            value={publishedAppsSlug}
                            isDisabled={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                            placeholder="apps"
                            onChange={(event) => {
                              setPublishedAppsSlug(event.currentTarget.value);
                              setPublicRouteSettingsSaved(false);
                              setPublicRouteSettingsStatusScope(null);
                            }}
                          />
                        </div>
                        <span className="app-settings-field-help">
                          Published web apps open from this top-level URL slug.
                        </span>
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Latest saved changes URL slug</span>
                        <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
                          <span className="project-settings-url-prefix">/</span>
                          <TextField
                            aria-label="Latest saved changes URL slug"
                            className="project-settings-input text-field-size-l"
                            value={latestAppsSlug}
                            isDisabled={loadingPublicRouteSettings || savingPublicRouteSettings || applyingPublicRouteSettings}
                            placeholder="apps-latest"
                            onChange={(event) => {
                              setLatestAppsSlug(event.currentTarget.value);
                              setPublicRouteSettingsSaved(false);
                              setPublicRouteSettingsStatusScope(null);
                            }}
                          />
                        </div>
                        <span className="app-settings-field-help">
                          Latest saved draft web apps open from this top-level URL slug.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingPublicRouteSettings || applyingPublicRouteSettings}
                        isDisabled={
                          loadingPublicRouteSettings ||
                          savingPublicRouteSettings ||
                          applyingPublicRouteSettings ||
                          !webAppRouteSettingsChanged
                        }
                        onClick={() => handleSavePublicRouteSettings('web-apps')}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={
                          loadingPublicRouteSettings ||
                          savingPublicRouteSettings ||
                          applyingPublicRouteSettings ||
                          !webAppRouteSettingsChanged
                        }
                        onClick={handleRevertPublicRouteSettings}
                      >
                        Revert
                      </Button>
                      {renderActionStatus(
                        publicRouteSettingsStatusScope === 'web-apps' ? publicRouteSettingsError : null,
                        publicRouteSettingsStatusScope === 'web-apps' && publicRouteSettingsSaved,
                        publicRouteSettingsStatusScope === 'web-apps' && applyingPublicRouteSettings
                          ? 'Applying routes...'
                          : undefined,
                      )}
                    </div>
                  </section>

                  <section className="app-settings-section" aria-label="Web app auth">
                    <div className="app-settings-section-title">Auth</div>
                    <div className="app-settings-field-grid" aria-busy={webAppAuthBusy}>
                      <div className="app-settings-field">
                        <span className="app-settings-field-label">How visitors access web apps</span>
                        <div className="project-settings-tabs app-settings-mode-tabs app-settings-wide-mode-tabs" role="group" aria-label="Web app auth mode">
                          {renderModeButton(
                            webAppAuthMode === 'ui-gate',
                            'Rivet key',
                            () => {
                              setWebAppAuthMode('ui-gate');
                              setWebAppAuthSettingsSaved(false);
                            },
                            webAppAuthBusy,
                          )}
                          {renderModeButton(
                            webAppAuthMode === 'oauth',
                            'OAuth',
                            () => {
                              setWebAppAuthMode('oauth');
                              setWebAppAuthSettingsSaved(false);
                            },
                            webAppAuthBusy,
                          )}
                          {renderModeButton(
                            webAppAuthMode === 'none',
                            'No app gate',
                            () => {
                              setWebAppAuthMode('none');
                              setWebAppAuthSettingsSaved(false);
                            },
                            webAppAuthBusy,
                          )}
                        </div>
                        <span className="app-settings-field-help">{webAppAuthModeHelp}</span>
                      </div>

                      {webAppAuthMode === 'oauth' ? (
                        <>
                          <div className="app-settings-field">
                            <span className="app-settings-field-label">OAuth provider</span>
                            <div className="project-settings-tabs app-settings-mode-tabs" role="group" aria-label="OAuth provider">
                              {renderModeButton(
                                webAppOAuthProvider === 'external',
                                'External provider',
                                () => {
                                  setWebAppOAuthProvider('external');
                                  setWebAppAuthSettingsSaved(false);
                                },
                                webAppAuthBusy,
                              )}
                              {renderModeButton(
                                webAppOAuthProvider === 'dummy',
                                'Local dummy',
                                () => {
                                  setWebAppOAuthProvider('dummy');
                                  setWebAppAuthSettingsSaved(false);
                                },
                                webAppAuthBusy,
                              )}
                            </div>
                            <span className="app-settings-field-help">
                              {webAppOAuthProvider === 'dummy'
                                ? 'Use a local test sign-in page instead of leaving localhost for a real provider.'
                                : 'Use a real OAuth provider for public or shared deployments.'}
                            </span>
                          </div>

                          {webAppOAuthProvider === 'dummy' ? (
                            <>
                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Default test email</span>
                                <TextField
                                  aria-label="Default test email"
                                  value={webAppDummyEmail}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="local@example.test"
                                  onChange={(event) => {
                                    setWebAppDummyEmail(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                                <span className="app-settings-field-help">
                                  The dummy sign-in form is prefilled with this email for local testing.
                                </span>
                              </label>

                              <div className="app-settings-field">
                                {renderBooleanSetting(
                                  'Allow dummy sign-in outside localhost',
                                  webAppDummyAllowNonLocalhost,
                                  (checked) => {
                                    setWebAppDummyAllowNonLocalhost(checked);
                                    setWebAppAuthSettingsSaved(false);
                                  },
                                  webAppAuthBusy,
                                )}
                                <span className="app-settings-field-help">
                                  Keep this off for shared environments. It exists only for local integration testing.
                                </span>
                              </div>
                            </>
                          ) : (
                            <>
                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Authorization URL</span>
                                <TextField
                                  aria-label="Authorization URL"
                                  value={webAppAuthorizeUrl}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="https://identity.example.com/oauth/authorize"
                                  onChange={(event) => {
                                    setWebAppAuthorizeUrl(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Token URL</span>
                                <TextField
                                  aria-label="Token URL"
                                  value={webAppTokenUrl}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="https://identity.example.com/oauth/token"
                                  onChange={(event) => {
                                    setWebAppTokenUrl(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Profile URL</span>
                                <TextField
                                  aria-label="Profile URL"
                                  value={webAppUserUrl}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="https://identity.example.com/api/profile"
                                  onChange={(event) => {
                                    setWebAppUserUrl(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                                <span className="app-settings-field-help">
                                  The profile response must contain the visitor email.
                                </span>
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Client ID</span>
                                <TextField
                                  aria-label="Client ID"
                                  value={webAppClientId}
                                  isDisabled={webAppAuthBusy}
                                  onChange={(event) => {
                                    setWebAppClientId(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Client secret</span>
                                <TextField
                                  aria-label="Client secret"
                                  type="password"
                                  value={webAppClientSecret}
                                  isDisabled={webAppAuthBusy}
                                  placeholder={webAppClientSecretConfigured ? 'Already saved; leave blank to keep it' : ''}
                                  onChange={(event) => {
                                    setWebAppClientSecret(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                                <span className="app-settings-field-help">
                                  {webAppClientSecretConfigured
                                    ? 'A client secret is saved. Enter a new value only when rotating it.'
                                    : 'Required before OAuth web app auth can be enabled.'}
                                </span>
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Callback URL</span>
                                <TextField
                                  aria-label="Callback URL"
                                  value={webAppCallbackUrl}
                                  isDisabled={webAppAuthBusy}
                                  placeholder={`${window.location.origin}${routeConfig.publishedAppsBasePath}/auth/callback`}
                                  onChange={(event) => {
                                    setWebAppCallbackUrl(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                                <span className="app-settings-field-help">
                                  Leave blank to derive it from the current host and published web app route.
                                </span>
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Scopes</span>
                                <TextField
                                  aria-label="OAuth scopes"
                                  value={webAppScopes}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="email"
                                  onChange={(event) => {
                                    setWebAppScopes(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                              </label>

                              <label className="app-settings-field">
                                <span className="app-settings-field-label">Email claim path</span>
                                <TextField
                                  aria-label="Email claim path"
                                  value={webAppEmailClaim}
                                  isDisabled={webAppAuthBusy}
                                  placeholder="email"
                                  onChange={(event) => {
                                    setWebAppEmailClaim(event.currentTarget.value);
                                    setWebAppAuthSettingsSaved(false);
                                  }}
                                />
                                <span className="app-settings-field-help">
                                  Use dot paths like data.email when the provider nests the email.
                                </span>
                              </label>

                              <div className="app-settings-field">
                                <span className="app-settings-field-label">Token request credentials</span>
                                <div className="project-settings-tabs app-settings-mode-tabs" role="group" aria-label="Token request credentials">
                                  {renderModeButton(
                                    webAppClientAuthMethod === 'body',
                                    'Request body',
                                    () => {
                                      setWebAppClientAuthMethod('body');
                                      setWebAppAuthSettingsSaved(false);
                                    },
                                    webAppAuthBusy,
                                  )}
                                  {renderModeButton(
                                    webAppClientAuthMethod === 'basic',
                                    'HTTP Basic',
                                    () => {
                                      setWebAppClientAuthMethod('basic');
                                      setWebAppAuthSettingsSaved(false);
                                    },
                                    webAppAuthBusy,
                                  )}
                                </div>
                              </div>
                            </>
                          )}

                          <label className="app-settings-field">
                            <span className="app-settings-field-label">Session signing secret</span>
                            <TextField
                              aria-label="Session signing secret"
                              type="password"
                              value={webAppSessionSecret}
                              isDisabled={webAppAuthBusy}
                              placeholder={webAppSessionSecretConfigured ? 'Already saved; leave blank to keep it' : ''}
                              onChange={(event) => {
                                setWebAppSessionSecret(event.currentTarget.value);
                                setWebAppAuthSettingsSaved(false);
                              }}
                            />
                            <span className="app-settings-field-help">
                              {webAppSessionSecretConfigured
                                ? 'A signing secret is saved. Enter a new value only when rotating it.'
                                : webAppOAuthProvider === 'dummy'
                                  ? 'Required for the local dummy provider.'
                                  : 'Recommended. When blank, the OAuth client secret signs sessions.'}
                            </span>
                          </label>

                          <label className="app-settings-field">
                            <span className="app-settings-field-label">Keep users signed in for</span>
                            <TextField
                              aria-label="OAuth session duration in hours"
                              type="number"
                              min={1}
                              value={webAppSessionTtlHours}
                              isDisabled={webAppAuthBusy}
                              placeholder={defaultSessionTtlHours}
                              elemAfterInput={<span className="app-settings-input-suffix">hours</span>}
                              onChange={(event) => {
                                setWebAppSessionTtlHours(event.currentTarget.value);
                                setWebAppAuthSettingsSaved(false);
                              }}
                            />
                          </label>

                          <div className="app-settings-field">
                            {renderBooleanSetting(
                              'Log provider profile response for troubleshooting',
                              webAppDebugLogProfile,
                              (checked) => {
                                setWebAppDebugLogProfile(checked);
                                setWebAppAuthSettingsSaved(false);
                              },
                              webAppAuthBusy,
                            )}
                            <span className="app-settings-field-help">
                              Turn this off after finding the email claim path because profile logs can contain user data.
                            </span>
                          </div>
                        </>
                      ) : null}
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingWebAppAuthSettings}
                        isDisabled={webAppAuthBusy || !webAppAuthSettingsChanged}
                        onClick={handleSaveWebAppAuthSettings}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={webAppAuthBusy || !webAppAuthSettingsChanged}
                        onClick={handleRevertWebAppAuthSettings}
                      >
                        Revert
                      </Button>
                      {renderActionStatus(webAppAuthSettingsError, webAppAuthSettingsSaved)}
                    </div>
                  </section>
                </div>
              ) : null}

              {activeTab === 'docker' ? (
                <div className="project-settings-tab-panel app-settings-docker-panel" role="tabpanel">
                  <section className="app-settings-section" aria-label="Docker launcher">
                    <div className="app-settings-field-grid" aria-busy={!runtimeLimitSettingsLoaded || loadingRuntimeLimitSettings || savingRuntimeLimitSettings}>
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Startup wait timeout</span>
                        <TextField
                          aria-label="Docker startup wait timeout in seconds"
                          type="number"
                          min={1}
                          value={dockerWaitTimeoutSeconds}
                          isDisabled={runtimeLimitControlsDisabled}
                          elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
                          onChange={(event) => {
                            setDockerWaitTimeoutSeconds(event.currentTarget.value);
                            setRuntimeLimitSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          How long npm Docker launchers wait for Compose services to become healthy. Kubernetes ignores this setting.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingRuntimeLimitSettings && runtimeLimitSettingsStatusScope === 'docker'}
                        isDisabled={runtimeLimitControlsDisabled || !dockerLimitSettingsChanged}
                        onClick={() => handleSaveRuntimeLimitSettings('docker')}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={runtimeLimitControlsDisabled || !dockerLimitSettingsChanged}
                        onClick={() => handleRevertRuntimeLimitSettings('docker')}
                      >
                        Revert
                      </Button>
                      {runtimeLimitSettingsStatusScope === 'docker' || runtimeLimitSettingsStatusScope === null
                        ? renderActionStatus(runtimeLimitSettingsError, runtimeLimitSettingsSaved)
                        : null}
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
                          placeholder="http://proxy.example.internal:3128"
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
                          placeholder="http://proxy.example.internal:3128"
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
                          placeholder="localhost,127.0.0.1,::1,api,web,executor,proxy,.svc,.cluster.local"
                          onChange={(event) => {
                            setNoProxy(event.currentTarget.value);
                            setProxySettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          Include internal service names that should bypass the proxy. In Kubernetes, include cluster-local suffixes such as .svc and .cluster.local when your proxy should not handle in-cluster calls.
                        </span>
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

                  <section className="app-settings-section" aria-label="Websocket URL overrides">
                    <div className="app-settings-section-title">Websocket URL overrides</div>
                    <div
                      className="app-settings-field-grid"
                      aria-busy={loadingExecutorUrlOverrideSettings || savingExecutorUrlOverrideSettings}
                    >
                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Node executor websocket URL override</span>
                        <TextField
                          aria-label="Node executor websocket URL override"
                          value={executorWsUrlOverride}
                          isDisabled={loadingExecutorUrlOverrideSettings || savingExecutorUrlOverrideSettings}
                          placeholder={routeConfig.executorWsUrl}
                          onChange={(event) => {
                            setExecutorWsUrlOverride(event.currentTarget.value);
                            setExecutorUrlOverrideSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          Optional override for the hosted editor's Node executor websocket. Leave blank to derive it from the current host. Active URL: {routeConfig.executorWsUrl || 'none'}.
                        </span>
                      </label>

                      <label className="app-settings-field">
                        <span className="app-settings-field-label">Remote Debugger websocket URL override</span>
                        <TextField
                          aria-label="Remote Debugger websocket URL override"
                          value={remoteDebuggerWsUrlOverride}
                          isDisabled={loadingExecutorUrlOverrideSettings || savingExecutorUrlOverrideSettings}
                          placeholder={routeConfig.remoteDebuggerDefaultWs || 'No default Remote Debugger URL'}
                          onChange={(event) => {
                            setRemoteDebuggerWsUrlOverride(event.currentTarget.value);
                            setExecutorUrlOverrideSettingsSaved(false);
                          }}
                        />
                        <span className="app-settings-field-help">
                          Optional override for the editor's default Remote Debugger URL. Leave blank to use the hosted latest-debugger websocket when available. Active URL: {routeConfig.remoteDebuggerDefaultWs || 'none'}.
                        </span>
                      </label>
                    </div>

                    <div className="app-settings-actions-row">
                      <LoadingButton
                        appearance="primary"
                        className="app-settings-action-button button-size-l"
                        isLoading={savingExecutorUrlOverrideSettings}
                        isDisabled={
                          loadingExecutorUrlOverrideSettings ||
                          savingExecutorUrlOverrideSettings ||
                          !executorUrlOverrideSettingsChanged
                        }
                        onClick={handleSaveExecutorUrlOverrideSettings}
                      >
                        Save
                      </LoadingButton>
                      <Button
                        appearance="subtle"
                        className="app-settings-action-button button-size-l"
                        isDisabled={
                          loadingExecutorUrlOverrideSettings ||
                          savingExecutorUrlOverrideSettings ||
                          !executorUrlOverrideSettingsChanged
                        }
                        onClick={() => {
                          setExecutorWsUrlOverride(initialExecutorUrlOverrideSettings.executorWsUrl);
                          setRemoteDebuggerWsUrlOverride(initialExecutorUrlOverrideSettings.remoteDebuggerDefaultWs);
                          setExecutorUrlOverrideSettingsSaved(false);
                          setExecutorUrlOverrideSettingsError(null);
                        }}
                      >
                        Revert
                      </Button>
                      {renderActionStatus(
                        executorUrlOverrideSettingsError,
                        executorUrlOverrideSettingsSaved,
                        undefined,
                        'Saved. Reload the editor to apply websocket URL overrides to active sessions.',
                      )}
                    </div>
                  </section>
                </div>
              ) : null}
                </div>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
