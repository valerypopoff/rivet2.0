export type ProjectTabPresentation = {
  active: boolean;
  displayName: string;
  preview: boolean;
  unsaved: boolean;
};

// Ordinary tab presses should resolve as clicks. dnd-kit waits for this small
// movement threshold before it turns the same gesture into a sortable drag.
export const projectTabDragActivationConstraint = { distance: 4 };

export function resolveProjectTabPresentation(options: {
  title: string;
  fsPath?: string | null | undefined;
  current: boolean;
  projectTabsSelected: boolean;
  openingTabSelected: boolean;
  preview?: boolean | undefined;
}): ProjectTabPresentation {
  const active = options.projectTabsSelected && !options.openingTabSelected && options.current;
  const unsaved = !options.fsPath;
  const fileName = unsaved ? 'Unsaved' : getFileName(options.fsPath);

  return {
    active,
    displayName: active && fileName ? `${options.title} [${fileName}]` : options.title,
    preview: options.preview === true,
    unsaved,
  };
}

export function resolveOpeningProjectTabPresentation(options: {
  title: string;
  path?: string | null | undefined;
  projectTabsSelected: boolean;
  selected: boolean;
  preview?: boolean | undefined;
}): Omit<ProjectTabPresentation, 'unsaved'> {
  const active = options.projectTabsSelected && options.selected;
  const fileName = getFileName(options.path);

  return {
    active,
    displayName: active && fileName ? `${options.title} [${fileName}]` : options.title,
    preview: options.preview === true,
  };
}

export function resolveProjectSelectorPlatformPolicy(options: { inTauri: boolean; macOS: boolean; windows: boolean }): {
  showFileMenu: boolean;
  showWindowsWindowControls: boolean;
} {
  return {
    showFileMenu: !options.inTauri || options.windows || options.macOS,
    showWindowsWindowControls: options.inTauri && options.windows,
  };
}

function getFileName(path: string | null | undefined): string | undefined {
  return path?.split(/[\\/]/).pop() || undefined;
}
