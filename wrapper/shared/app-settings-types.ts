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

export type WebAppAuthMode = 'ui-gate' | 'oauth' | 'none';
export type WebAppOAuthProvider = 'external' | 'dummy';
export type WebAppOAuthClientAuthMethod = 'body' | 'basic';

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
