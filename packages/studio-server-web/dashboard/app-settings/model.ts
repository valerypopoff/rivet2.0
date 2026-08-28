import type {
  DeploymentDatabaseMode,
  DeploymentDatabaseSslMode,
  DeploymentStorageMode,
  DeploymentStorageSettings,
  EnvironmentVariableSettings,
  ExecutorUrlOverrideSettings,
  PublicRouteSettings,
  RuntimeLimitSettings,
  TrustedHostSettings,
  WebAppAuthMode,
  WebAppAuthSettings,
  WebAppOAuthClientAuthMethod,
  WebAppOAuthProvider,
  WorkflowEndpointAuthSettings,
} from '../../../studio-server-shared/app-settings-types';
import type { HostedRouteConfig } from '../types';

export type AppSettingsTab =
  | 'general'
  | 'shell-execution'
  | 'storage'
  | 'node-executor-proxy'
  | 'environment-variables'
  | 'run-recordings'
  | 'web-apps'
  | 'oauth'
  | 'server-ui-access'
  | 'workflow-endpoints'
  | 'docker';
export type RunsKeptMode = 'latest' | 'all';
export type RecordingRetentionMode = 'limited' | 'forever';
export type PublicRouteSettingsScope = 'web-apps' | 'workflow-endpoints';
export type RuntimeLimitSettingsScope = 'shell' | 'proxy-timeout' | 'web-app-request-size' | 'docker';
export type WebAppAuthSettingsScope = 'web-apps' | 'oauth' | 'server-ui-access';

export type PublicRouteSettingsForm = {
  publishedWorkflowsSlug: string;
  latestWorkflowsSlug: string;
  publishedAppsSlug: string;
  latestAppsSlug: string;
};

export type RuntimeLimitSettingsForm = {
  commandTimeoutSeconds: string;
  maxOutputMiB: string;
  proxyReadTimeoutSeconds: string;
  webAppActionRequestLimitMiB: string;
  dockerWaitTimeoutSeconds: string;
};

export type TrustedHostSettingsForm = {
  trustedHostsText: string;
};

export type WorkflowEndpointAuthSettingsForm = Pick<WorkflowEndpointAuthSettings, 'requireBearerAuth'>;
export type ExecutorUrlOverrideSettingsForm = Pick<ExecutorUrlOverrideSettings, 'executorWsUrl' | 'remoteDebuggerDefaultWs'>;

export type WebAppAuthSettingsForm = {
  mode: WebAppAuthMode;
  provider: WebAppOAuthProvider;
  dummyEmail: string;
  dummyAllowNonLocalhost: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  clientSecretConfigured: boolean;
  callbackUrl: string;
  scopes: string;
  emailClaim: string;
  sessionSecret: string;
  sessionSecretConfigured: boolean;
  sessionTtlHours: string;
  clientAuthMethod: WebAppOAuthClientAuthMethod;
  debugLogProfile: boolean;
  serverUiAdminEmailsText: string;
};

export type DeploymentStorageSettingsForm = {
  storageMode: DeploymentStorageMode;
  artifactsHostPath: string;
  databaseMode: DeploymentDatabaseMode;
  databaseSslMode: DeploymentDatabaseSslMode;
  databaseConnectionString: string;
  databaseConnectionStringConfigured: boolean;
  storageUrl: string;
  storageAccessKeyId: string;
  storageAccessKey: string;
  storageAccessKeyConfigured: boolean;
};

export type NodeExecutorProxySettingsForm = {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
};

export type EnvironmentVariableSettingsFormEntry = {
  clientId: string;
  id?: string;
  name: string;
  value: string;
  valueConfigured: boolean;
  valueTouched: boolean;
  browserAccess: boolean;
};

export type EnvironmentVariableSettingsForm = {
  variables: EnvironmentVariableSettingsFormEntry[];
};

export type RunRecordingsSettingsForm = {
  maxPendingWrites: string;
  maxRunsPerEndpoint: string;
  maxRunsPerEndpointMode: RunsKeptMode;
  retentionDays: string;
  recordingRetentionMode: RecordingRetentionMode;
};

export const defaultMaxRunsPerEndpoint = '100';
export const defaultRetentionDays = '14';
export const defaultSessionTtlHours = '24';

export function isWebAppAuthSettingsTab(tab: AppSettingsTab): tab is WebAppAuthSettingsScope {
  return tab === 'web-apps' || tab === 'oauth' || tab === 'server-ui-access';
}

export function formatWebAppsAuthMode(value: HostedRouteConfig['webAppsAuthMode']): string {
  if (value === 'ui-gate') {
    return 'Key';
  }
  return value === 'oauth' ? 'OAuth' : 'No gate';
}

export function createWebAppAuthForm(settings: WebAppAuthSettings): WebAppAuthSettingsForm {
  return {
    mode: settings.mode,
    provider: settings.provider,
    dummyEmail: settings.dummyEmail,
    dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
    authorizeUrl: settings.authorizeUrl,
    tokenUrl: settings.tokenUrl,
    userUrl: settings.userUrl,
    clientId: settings.clientId,
    clientSecret: '',
    clientSecretConfigured: settings.clientSecretConfigured,
    callbackUrl: settings.callbackUrl,
    scopes: settings.scopes,
    emailClaim: settings.emailClaim,
    sessionSecret: '',
    sessionSecretConfigured: settings.sessionSecretConfigured,
    sessionTtlHours: String(Math.max(1, Math.round(settings.sessionTtlSeconds / 3600))),
    clientAuthMethod: settings.clientAuthMethod,
    debugLogProfile: settings.debugLogProfile,
    serverUiAdminEmailsText: settings.serverUiAdminEmails.join('\n'),
  };
}

export function createDeploymentStorageForm(settings: DeploymentStorageSettings): DeploymentStorageSettingsForm {
  return {
    storageMode: settings.storageMode,
    artifactsHostPath: settings.artifactsHostPath,
    databaseMode: settings.databaseMode,
    databaseSslMode: settings.databaseSslMode,
    databaseConnectionString: '',
    databaseConnectionStringConfigured: settings.databaseConnectionStringConfigured,
    storageUrl: settings.storageUrl,
    storageAccessKeyId: settings.storageAccessKeyId,
    storageAccessKey: '',
    storageAccessKeyConfigured: settings.storageAccessKeyConfigured,
  };
}

export function createEnvironmentVariableForm(
  settings: EnvironmentVariableSettings,
): EnvironmentVariableSettingsForm {
  return {
    variables: settings.variables.map((entry) => ({
      clientId: entry.id,
      id: entry.id,
      name: entry.name,
      value: '',
      valueConfigured: entry.valueConfigured,
      valueTouched: false,
      browserAccess: entry.browserAccess,
    })),
  };
}

export function basePathToRouteSlug(basePath: string): string {
  return basePath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

export function createPublicRouteForm(settings: PublicRouteSettings): PublicRouteSettingsForm {
  return {
    publishedWorkflowsSlug: basePathToRouteSlug(settings.publishedWorkflowsBasePath),
    latestWorkflowsSlug: basePathToRouteSlug(settings.latestWorkflowsBasePath),
    publishedAppsSlug: basePathToRouteSlug(settings.publishedAppsBasePath),
    latestAppsSlug: basePathToRouteSlug(settings.latestAppsBasePath),
  };
}

export function bytesToMiBString(value: number): string {
  return String(Math.max(1, Math.round(value / (1024 * 1024))));
}

export function miBStringToBytesString(value: string): string {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? String(Math.round(parsed * 1024 * 1024)) : value.trim();
}

export function createRuntimeLimitForm(settings: RuntimeLimitSettings): RuntimeLimitSettingsForm {
  return {
    commandTimeoutSeconds: String(settings.commandTimeoutSeconds),
    maxOutputMiB: bytesToMiBString(settings.maxOutputBytes),
    proxyReadTimeoutSeconds: String(settings.proxyReadTimeoutSeconds),
    webAppActionRequestLimitMiB: bytesToMiBString(settings.webAppActionRequestLimitBytes),
    dockerWaitTimeoutSeconds: String(settings.dockerWaitTimeoutSeconds),
  };
}

export function parseDelimitedListText(value: string): string[] {
  return value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
}

export function createTrustedHostForm(settings: Pick<TrustedHostSettings, 'trustedHosts'>): TrustedHostSettingsForm {
  return { trustedHostsText: settings.trustedHosts.join('\n') };
}

export function publicRouteSettingsMatchConfig(
  settings: Pick<PublicRouteSettings, 'publishedWorkflowsBasePath' | 'latestWorkflowsBasePath' | 'publishedAppsBasePath' | 'latestAppsBasePath'>,
  config: Partial<HostedRouteConfig>,
): boolean {
  return (
    config.publishedWorkflowsBasePath === settings.publishedWorkflowsBasePath &&
    config.latestWorkflowsBasePath === settings.latestWorkflowsBasePath &&
    config.publishedAppsBasePath === settings.publishedAppsBasePath &&
    config.latestAppsBasePath === settings.latestAppsBasePath
  );
}
