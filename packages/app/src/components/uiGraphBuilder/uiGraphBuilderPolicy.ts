import type { RivetAppHostUiConfig } from '../../providers/HostUiConfigContext.js';

export function canRunDesktopWebAppPreview(ui: RivetAppHostUiConfig): boolean {
  return ui.webApps?.desktopPreview !== false;
}
