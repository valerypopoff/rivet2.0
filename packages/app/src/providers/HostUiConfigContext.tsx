import { createContext, useContext, type FC, type ReactNode } from 'react';
import type { FileMenuConfig } from '../utils/fileMenuConfiguration.js';

export type RivetAppHostUiConfig = {
  fileMenu?: FileMenuConfig;
  webApps?: {
    desktopPreview?: boolean;
  };
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
