import { createContext, useContext, type FC, type ReactNode } from 'react';
import type { FileMenuConfig } from '../utils/fileMenuConfiguration.js';
import type { WorkspaceTabsConfig } from '../utils/workspaceTabs.js';

export type RivetAppHostUiConfig = {
  checkForUpdates?: boolean;
  fileMenu?: FileMenuConfig;
  preloadCodeEditor?: boolean;
  webApps?: {
    desktopPreview?: boolean;
  };
  workspaceTabs?: WorkspaceTabsConfig;
};

const DEFAULT_HOST_UI_CONFIG: RivetAppHostUiConfig = {};

const HostUiConfigContext = createContext<RivetAppHostUiConfig>(DEFAULT_HOST_UI_CONFIG);

export const HostUiConfigProvider: FC<{ config?: RivetAppHostUiConfig; children: ReactNode }> = ({
  config,
  children,
}) => {
  const value = config ?? DEFAULT_HOST_UI_CONFIG;
  return <HostUiConfigContext.Provider value={value}>{children}</HostUiConfigContext.Provider>;
};

export function useRivetAppHostUiConfig(): RivetAppHostUiConfig {
  return useContext(HostUiConfigContext);
}

export function shouldCheckForUpdates(config?: RivetAppHostUiConfig): boolean {
  return config?.checkForUpdates !== false;
}

export function shouldPreloadCodeEditor(config?: RivetAppHostUiConfig): boolean {
  return config?.preloadCodeEditor !== false;
}
