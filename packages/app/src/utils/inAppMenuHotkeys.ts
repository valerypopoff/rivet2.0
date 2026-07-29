import type { MenuIds } from './menuCommandIds.js';
import {
  matchesKeyboardShortcut,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutEvent,
  type KeyboardShortcutPlatform,
} from './keyboardShortcutMatcher.js';

export type InAppMenuHotkeyPlatform = KeyboardShortcutPlatform;

export type InAppMenuHotkeyEvent = KeyboardShortcutEvent;

type InAppMenuHotkeyDefinition = {
  command: MenuIds;
  shortcut: KeyboardShortcutDefinition;
};

const IN_APP_MENU_HOTKEYS: readonly InAppMenuHotkeyDefinition[] = [
  {
    command: 'remote_debugger',
    shortcut: { altKey: false, codes: ['F5'], keys: ['F5'], shiftKey: false },
  },
  {
    command: 'load_recording',
    shortcut: { altKey: false, codes: ['KeyO'], commandModifier: 'platform-command', keys: ['o'], shiftKey: true },
  },
  {
    command: 'new_project',
    shortcut: { altKey: false, codes: ['KeyN'], commandModifier: 'platform-command', keys: ['n'], shiftKey: false },
  },
  {
    command: 'open_project',
    shortcut: { altKey: false, codes: ['KeyO'], commandModifier: 'platform-command', keys: ['o'], shiftKey: false },
  },
  {
    command: 'save_project',
    shortcut: { altKey: false, codes: ['KeyS'], commandModifier: 'platform-command', keys: ['s'], shiftKey: false },
  },
  {
    command: 'export_graph',
    shortcut: { altKey: false, codes: ['KeyE'], commandModifier: 'platform-command', keys: ['e'], shiftKey: true },
  },
  {
    command: 'save_project_as',
    shortcut: { altKey: false, codes: ['KeyS'], commandModifier: 'platform-command', keys: ['s'], shiftKey: true },
  },
  {
    command: 'run',
    shortcut: {
      altKey: false,
      codes: ['Enter'],
      commandModifier: 'platform-command',
      keys: ['Enter'],
      shiftKey: false,
    },
  },
];

export function getInAppMenuHotkeyCommand(
  event: InAppMenuHotkeyEvent,
  platform: InAppMenuHotkeyPlatform,
): MenuIds | undefined {
  return IN_APP_MENU_HOTKEYS.find(({ shortcut }) => matchesKeyboardShortcut(event, shortcut, { platform }))?.command;
}
