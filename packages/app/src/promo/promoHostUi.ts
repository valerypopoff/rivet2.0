import type { RivetAppHostUiConfig } from '../host.js';

/**
 * GitHub Pages demo policy. This is intentionally an explicit host policy
 * rather than a global "promo" mode, so normal Rivet and other wrappers keep
 * their full editor surface by default.
 */
export const PROMO_HOST_UI = {
  capabilities: {
    aiAssist: false,
    aiGraphBuilder: false,
    recordings: false,
    trivetInputCopy: false,
  },
  checkForUpdates: false,
  fileMenu: { visibleItems: ['new_project', 'open_project', 'save_project', 'settings'] },
  preloadCodeEditor: false,
  workspaceTabs: { visibleItems: [] },
} as const satisfies RivetAppHostUiConfig;
