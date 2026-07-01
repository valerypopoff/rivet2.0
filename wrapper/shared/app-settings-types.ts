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
