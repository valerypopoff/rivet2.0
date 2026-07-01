export type NodeExecutorProxySettingsSource = 'app-settings' | 'default';

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
