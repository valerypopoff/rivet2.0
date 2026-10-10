import {
  matchesKeyboardShortcut,
  type KeyboardShortcutEvent,
  type KeyboardShortcutPlatform,
} from './keyboardShortcutMatcher.js';
import type { ProjectTabListItem } from './openingProjectTabs.js';

export type ProjectTabDirection = -1 | 1;

export function getProjectTabHotkeyDirection(
  event: KeyboardShortcutEvent,
  platform: KeyboardShortcutPlatform,
): ProjectTabDirection | undefined {
  const matches = (key: string, shiftKey: boolean, altKey: boolean) =>
    matchesKeyboardShortcut(
      event,
      { codes: [key], keys: [key], commandModifier: 'platform-command', shiftKey, altKey },
      { platform },
    );

  if (platform === 'macos') {
    if (matches('ArrowLeft', false, true)) return -1;
    if (matches('ArrowRight', false, true)) return 1;
  } else {
    if (matches('Tab', true, false) || matches('PageUp', false, false)) return -1;
    if (matches('Tab', false, false) || matches('PageDown', false, false)) return 1;
  }
  return undefined;
}

function sameTab(a: ProjectTabListItem, b: ProjectTabListItem | undefined): boolean {
  return a.type === 'project'
    ? b?.type === 'project' && a.projectId === b.projectId
    : b?.type === 'opening' && a.openingTabId === b.openingTabId;
}

export function getAdjacentProjectTab(
  tabs: readonly ProjectTabListItem[],
  selected: ProjectTabListItem | undefined,
  direction: ProjectTabDirection,
): ProjectTabListItem | undefined {
  if (tabs.length < 2) return undefined;
  const index = tabs.findIndex((tab) => sameTab(tab, selected));
  if (index < 0) return direction === 1 ? tabs[0] : tabs[tabs.length - 1];
  return tabs[(index + direction + tabs.length) % tabs.length];
}

export type ProjectTabHotkeyState = {
  enabled: boolean;
  platform: KeyboardShortcutPlatform;
  tabs: readonly ProjectTabListItem[];
  selected?: ProjectTabListItem;
  activation: { revision: number; pending: boolean };
};

/** Keep rapid presses relative to the last requested tab while its guarded
 * activation is pending. Mouse/host selections invalidate that cursor through
 * the existing activation revision; failures return navigation to the live tab. */
export function installProjectTabHotkeyListener(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  getState: () => ProjectTabHotkeyState,
  selectTab: (tab: ProjectTabListItem) => void,
): () => void {
  let requested: { tab: ProjectTabListItem; revision: number } | undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
    const state = getState();
    if (!state.enabled) return;
    const direction = getProjectTabHotkeyDirection(event, state.platform);
    if (direction === undefined) return;
    const selected =
      state.activation.pending &&
      requested?.revision === state.activation.revision &&
      state.tabs.some((tab) => sameTab(tab, requested?.tab))
        ? requested.tab
        : state.selected;
    const next = getAdjacentProjectTab(state.tabs, selected, direction);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    selectTab(next);
    requested = { tab: next, revision: getState().activation.revision };
  };
  target.addEventListener('keydown', onKeyDown, { capture: true });
  return () => target.removeEventListener('keydown', onKeyDown, { capture: true });
}
