export type AppSettingsSource = 'app-settings' | 'default';

export type NodeExecutorProxySettingsSource = AppSettingsSource;

export interface NodeExecutorProxySettings {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  updatedAt: string | null;
  source: NodeExecutorProxySettingsSource;
}

export interface NodeExecutorProxySettingsDraft {
  httpProxy?: unknown;
  httpsProxy?: unknown;
  noProxy?: unknown;
}

export interface RunRecordingsSettings {
  maxPendingWrites: number;
  maxRunsPerEndpoint: number;
  retentionDays: number;
  updatedAt: string | null;
  source: AppSettingsSource;
}

export interface RunRecordingsSettingsDraft {
  maxPendingWrites?: unknown;
  maxRunsPerEndpoint?: unknown;
  retentionDays?: unknown;
}

export interface PublicRouteSettings {
  publishedWorkflowsBasePath: string;
  latestWorkflowsBasePath: string;
  publishedAppsBasePath: string;
  latestAppsBasePath: string;
  updatedAt: string | null;
  source: AppSettingsSource;
}

export interface PublicRouteSettingsDraft {
  publishedWorkflowsBasePath?: unknown;
  latestWorkflowsBasePath?: unknown;
  publishedAppsBasePath?: unknown;
  latestAppsBasePath?: unknown;
}

export type WebAppRouteSettings = Pick<
  PublicRouteSettings,
  'publishedAppsBasePath' | 'latestAppsBasePath' | 'updatedAt' | 'source'
>;

export type WebAppRouteSettingsDraft = Pick<
  PublicRouteSettingsDraft,
  'publishedAppsBasePath' | 'latestAppsBasePath'
>;

export type WebAppAuthMode = 'ui-gate' | 'oauth' | 'none';
export type WebAppOAuthProvider = 'external' | 'dummy';
export type WebAppOAuthClientAuthMethod = 'body' | 'basic';
export type DeploymentStorageMode = 'filesystem' | 'managed';
export type DeploymentDatabaseMode = 'local-docker' | 'managed';
export type DeploymentDatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface WebAppAuthSettings {
  mode: WebAppAuthMode;
  provider: WebAppOAuthProvider;
  dummyEmail: string;
  dummyAllowNonLocalhost: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecretConfigured: boolean;
  callbackUrl: string;
  scopes: string;
  emailClaim: string;
  sessionSecretConfigured: boolean;
  sessionTtlSeconds: number;
  clientAuthMethod: WebAppOAuthClientAuthMethod;
  debugLogProfile: boolean;
  updatedAt: string | null;
  source: AppSettingsSource;
}

export interface WebAppAuthSettingsDraft {
  mode?: unknown;
  provider?: unknown;
  dummyEmail?: unknown;
  dummyAllowNonLocalhost?: unknown;
  authorizeUrl?: unknown;
  tokenUrl?: unknown;
  userUrl?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  callbackUrl?: unknown;
  scopes?: unknown;
  emailClaim?: unknown;
  sessionSecret?: unknown;
  sessionTtlSeconds?: unknown;
  clientAuthMethod?: unknown;
  debugLogProfile?: unknown;
}

export interface DeploymentStorageSettings {
  storageMode: DeploymentStorageMode;
  artifactsHostPath: string;
  databaseMode: DeploymentDatabaseMode;
  databaseSslMode: DeploymentDatabaseSslMode;
  databaseConnectionStringConfigured: boolean;
  storageUrl: string;
  storageAccessKeyId: string;
  storageAccessKeyConfigured: boolean;
  updatedAt: string | null;
  source: AppSettingsSource;
}

export interface DeploymentStorageSettingsDraft {
  storageMode?: unknown;
  artifactsHostPath?: unknown;
  databaseMode?: unknown;
  databaseSslMode?: unknown;
  databaseConnectionString?: unknown;
  storageUrl?: unknown;
  storageAccessKeyId?: unknown;
  storageAccessKey?: unknown;
}
