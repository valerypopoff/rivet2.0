import type { OverlayKey } from '../state/ui.js';

export type WorkspaceTabKey = OverlayKey | 'welcomeScreen';
export type WorkspaceTabItemId = 'evaluations' | 'dataStudio';

export type WorkspaceTabDefinition = {
  key: WorkspaceTabKey;
  label: string;
  className: string;
  targetOverlay: OverlayKey | undefined;
  requiresProject?: boolean;
};

export type WorkspaceTabsConfig = {
  visibleItems?: readonly WorkspaceTabItemId[];
};

export const WELCOME_SCREEN_TAB: WorkspaceTabDefinition = {
  key: 'welcomeScreen',
  label: 'Welcome screen',
  className: 'welcome-screen-menu',
  targetOverlay: undefined,
};

export const WORKSPACE_TABS = [
  {
    key: 'evaluations',
    label: 'Evaluations',
    className: 'evaluations-menu',
    targetOverlay: 'evaluations',
  },
  {
    key: 'dataStudio',
    label: 'Data Studio',
    className: 'data-studio',
    targetOverlay: 'dataStudio',
    requiresProject: true,
  },
] satisfies WorkspaceTabDefinition[];

export const PROMPT_DESIGNER_TAB: WorkspaceTabDefinition = {
  key: 'promptDesigner',
  label: 'Prompt Designer',
  className: 'prompt-designer-menu',
  targetOverlay: 'promptDesigner',
};

export function getVisibleWorkspaceTabs({
  config,
  openOverlay,
  projectAvailable = true,
  welcomeScreenAvailable = false,
}: {
  config?: WorkspaceTabsConfig;
  openOverlay: OverlayKey | undefined;
  projectAvailable?: boolean;
  welcomeScreenAvailable?: boolean;
}): WorkspaceTabDefinition[] {
  const visibleItems = config?.visibleItems == null ? undefined : new Set(config.visibleItems);
  let workspaceTabs: WorkspaceTabDefinition[] =
    visibleItems == null ? [...WORKSPACE_TABS] : WORKSPACE_TABS.filter((tab) => visibleItems.has(tab.key));

  if (!projectAvailable) {
    workspaceTabs = workspaceTabs.filter((tab) => tab.requiresProject !== true);
  }

  if (welcomeScreenAvailable) {
    workspaceTabs.unshift(WELCOME_SCREEN_TAB);
  }

  if (openOverlay === 'promptDesigner') {
    workspaceTabs.push(PROMPT_DESIGNER_TAB);
  }

  return workspaceTabs;
}
