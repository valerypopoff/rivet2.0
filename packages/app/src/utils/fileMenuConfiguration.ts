import type { MenuIds } from './menuCommandIds.js';

export type FileMenuItemId = Extract<
  MenuIds,
  | 'new_project'
  | 'open_project'
  | 'save_project'
  | 'save_project_as'
  | 'import_graph'
  | 'export_graph'
  | 'settings'
  | 'get_help'
>;

export type FileMenuItemDefinition = {
  id: FileMenuItemId;
  label: string;
};

export type FileMenuGroupDefinition = readonly FileMenuItemDefinition[];

export type FileMenuConfig = {
  visibleItems?: readonly FileMenuItemId[];
};

export type FileMenuCommandSource = 'host-save-shortcut';

export const FILE_MENU_GROUPS = [
  [
    { id: 'new_project', label: 'New project' },
    { id: 'open_project', label: 'Open project' },
  ],
  [
    { id: 'save_project', label: 'Save project' },
    { id: 'save_project_as', label: 'Save project as...' },
  ],
  [
    { id: 'import_graph', label: 'Import graph' },
    { id: 'export_graph', label: 'Export graph' },
  ],
  [
    { id: 'settings', label: 'Rivet settings' },
    { id: 'get_help', label: 'Help' },
  ],
] as const satisfies readonly FileMenuGroupDefinition[];

export const DEFAULT_FILE_MENU_ITEM_IDS = FILE_MENU_GROUPS.flatMap((group) => group.map((item) => item.id));

const FILE_MENU_ITEM_IDS = new Set<MenuIds>(DEFAULT_FILE_MENU_ITEM_IDS);

export function getVisibleFileMenuGroups(config?: FileMenuConfig): FileMenuGroupDefinition[] {
  const visibleItemIds = new Set<FileMenuItemId>(config?.visibleItems ?? DEFAULT_FILE_MENU_ITEM_IDS);

  return FILE_MENU_GROUPS.map((group) => group.filter((item) => visibleItemIds.has(item.id))).filter(
    (group) => group.length > 0,
  );
}

export function isFileMenuItemId(command: MenuIds): command is FileMenuItemId {
  return FILE_MENU_ITEM_IDS.has(command);
}

export function shouldRunFileMenuCommand(
  command: MenuIds,
  config?: FileMenuConfig,
  options: { hostedSaveShortcutEnabled?: boolean; source?: FileMenuCommandSource } = {},
): boolean {
  if (
    command === 'save_project' &&
    options.hostedSaveShortcutEnabled === true &&
    options.source === 'host-save-shortcut'
  ) {
    return true;
  }

  if (!isFileMenuItemId(command) || config?.visibleItems == null) {
    return true;
  }

  return config.visibleItems.includes(command);
}
