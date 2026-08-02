import type { OverlayKey } from '../state/ui.js';

export type WorkspaceTabKey = OverlayKey | 'welcomeScreen';

export type WorkspaceTabDefinition = {
  key: WorkspaceTabKey;
  label: string;
  className: string;
  targetOverlay: OverlayKey | undefined;
};

export const WELCOME_SCREEN_TAB: WorkspaceTabDefinition = {
  key: 'welcomeScreen',
  label: 'Welcome screen',
  className: 'welcome-screen-menu',
  targetOverlay: undefined,
};

export const WORKSPACE_TABS: WorkspaceTabDefinition[] = [
  { key: 'trivet', label: 'Trivet Tests', className: 'trivet-menu', targetOverlay: 'trivet' },
  { key: 'dataStudio', label: 'Data Studio', className: 'data-studio', targetOverlay: 'dataStudio' },
];

export const PROMPT_DESIGNER_TAB: WorkspaceTabDefinition = {
  key: 'promptDesigner',
  label: 'Prompt Designer',
  className: 'prompt-designer-menu',
  targetOverlay: 'promptDesigner',
};

export function getVisibleWorkspaceTabs({
  openOverlay,
  welcomeScreenAvailable = false,
}: {
  openOverlay: OverlayKey | undefined;
  welcomeScreenAvailable?: boolean;
}): WorkspaceTabDefinition[] {
  const workspaceTabs = [...WORKSPACE_TABS];

  if (welcomeScreenAvailable) {
    workspaceTabs.unshift(WELCOME_SCREEN_TAB);
  }

  if (openOverlay !== 'promptDesigner') {
    return workspaceTabs;
  }

  return [...workspaceTabs, PROMPT_DESIGNER_TAB];
}
