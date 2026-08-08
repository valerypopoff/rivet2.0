import { matchesKeyboardShortcut, type KeyboardShortcutEvent } from '../utils/keyboardShortcutMatcher.js';

export const GRAPH_HISTORY_PREVIOUS_SHORTCUT_LABEL = 'PgUp';
export const GRAPH_HISTORY_NEXT_SHORTCUT_LABEL = 'PgDwn';
export const MAIN_GRAPH_SHORTCUT_LABEL = 'Home';
export const GRAPH_TREE_TOGGLE_SHORTCUT_LABEL = 'Ctrl+Q / Cmd+Q';

export const GRAPH_HISTORY_PREVIOUS_TOOLTIP = `Go to previous graph (${GRAPH_HISTORY_PREVIOUS_SHORTCUT_LABEL})`;
export const GRAPH_HISTORY_NEXT_TOOLTIP = `Go to next graph (${GRAPH_HISTORY_NEXT_SHORTCUT_LABEL})`;

export type CanvasNavigationShortcut = 'previousGraph' | 'nextGraph' | 'openMainGraph' | 'toggleGraphTree';
export type CanvasNavigationFocusTarget = { blur(): void };

type CanvasNavigationShortcutEvent = KeyboardShortcutEvent;

export function getCanvasNavigationShortcut(
  event: CanvasNavigationShortcutEvent,
): CanvasNavigationShortcut | undefined {
  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === 'PageUp' || event.code === 'PageUp') {
      return 'previousGraph';
    }

    if (event.key === 'PageDown' || event.code === 'PageDown') {
      return 'nextGraph';
    }

    if (event.key === 'Home' || event.code === 'Home') {
      return 'openMainGraph';
    }
  }

  if (
    matchesKeyboardShortcut(event, {
      altKey: false,
      codes: ['KeyQ'],
      commandModifier: 'any-command',
      keys: ['q'],
      shiftKey: false,
    })
  ) {
    return 'toggleGraphTree';
  }

  return undefined;
}

export function blurCanvasNavigationShortcutFocus(activeElement: CanvasNavigationFocusTarget | null | undefined) {
  activeElement?.blur();
}
