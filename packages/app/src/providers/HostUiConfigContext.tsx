import { createContext, useContext, type FC, type ReactNode } from 'react';
import type { FileMenuConfig } from '../utils/fileMenuConfiguration.js';
import type { WorkspaceTabsConfig } from '../utils/workspaceTabs.js';

export type RivetAppHostCapability = 'aiAssist' | 'aiGraphBuilder' | 'recordings' | 'trivetInputCopy';

export type RivetAppHostUiConfig = {
  /**
   * Optional host-level opt-outs for editor features. Every capability remains
   * enabled unless a host explicitly sets it to false.
   */
  capabilities?: Partial<Record<RivetAppHostCapability, boolean>>;
  checkForUpdates?: boolean;
  fileMenu?: FileMenuConfig;
  keyboardShortcuts?: {
    /**
     * Controls Rivet's save-project shortcut in hosted browser apps.
     *
     * - `undefined` preserves Rivet's existing platform behavior.
     * - `true` makes Rivet own Ctrl+S (Windows/Linux) or Cmd+S (macOS)
     *   without opting into any other browser-host shortcuts.
     * - `false` disables Rivet's save-project shortcut.
     */
    saveProject?: boolean;
  };
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

export function isRivetAppHostCapabilityEnabled(
  config: RivetAppHostUiConfig | undefined,
  capability: RivetAppHostCapability,
): boolean {
  return config?.capabilities?.[capability] !== false;
}
