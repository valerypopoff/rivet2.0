import type { MenuIds } from './menuCommandIds.js';
import {
  matchesKeyboardShortcut,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutEvent,
  type KeyboardShortcutPlatform,
} from './keyboardShortcutMatcher.js';

export type InAppMenuHotkeyPlatform = KeyboardShortcutPlatform;

export type InAppMenuHotkeyEvent = KeyboardShortcutEvent;

export type InAppMenuHotkeyPolicy = {
  /** Whether Rivet's pre-hosted-app shortcut set applies on this platform. */
  legacyShortcutsEnabled: boolean;
  /** An explicit hosted-app override for the save-project shortcut. */
  saveProject?: boolean;
};

export type InAppMenuHotkeyRuntimeConfig = {
  platform: InAppMenuHotkeyPlatform;
  policy: InAppMenuHotkeyPolicy;
};

export type InAppMenuHotkeyCommandOptions = {
  source: 'host-save-shortcut';
};

export type InAppMenuHotkeyCommandRunner = (command: MenuIds, options?: InAppMenuHotkeyCommandOptions) => void;

type InAppMenuHotkeyEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

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

/**
 * Resolves the command Rivet owns for one keyboard event after applying the
 * hosted save-shortcut policy. An explicit `true` adds browser-host ownership
 * only for Save, while unrelated commands continue to follow legacy platform
 * ownership. `false` removes Save without changing those legacy commands.
 */
export function getInAppMenuHotkeyCommandForPolicy(
  event: InAppMenuHotkeyEvent,
  platform: InAppMenuHotkeyPlatform,
  policy: InAppMenuHotkeyPolicy,
): MenuIds | undefined {
  const command = getInAppMenuHotkeyCommand(event, platform);

  if (command === 'save_project') {
    if (policy.saveProject === false) {
      return undefined;
    }

    return policy.saveProject === true || policy.legacyShortcutsEnabled ? command : undefined;
  }

  return policy.legacyShortcutsEnabled ? command : undefined;
}

export function shouldRegisterInAppMenuHotkeys(policy: InAppMenuHotkeyPolicy): boolean {
  return policy.saveProject === true || policy.legacyShortcutsEnabled;
}

function shouldSkipInAppMenuHotkey(event: KeyboardEvent, command: MenuIds): boolean {
  if (command !== 'run' || typeof Element === 'undefined' || !(event.target instanceof Element)) {
    return false;
  }

  return event.target.closest('[data-rivet-consume-run-hotkey="true"]') != null;
}

export function handleInAppMenuHotkeyEvent(
  event: KeyboardEvent,
  runtimeConfig: InAppMenuHotkeyRuntimeConfig,
  runMenuCommand: InAppMenuHotkeyCommandRunner,
): void {
  const command = getInAppMenuHotkeyCommandForPolicy(event, runtimeConfig.platform, runtimeConfig.policy);

  if (!command || shouldSkipInAppMenuHotkey(event, command)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  if (!event.repeat) {
    runMenuCommand(
      command,
      command === 'save_project' && runtimeConfig.policy.saveProject === true
        ? { source: 'host-save-shortcut' }
        : undefined,
    );
  }
}

/**
 * Installs one stable capture listener. Callers provide getters so changing
 * React callbacks or policy can be reflected without listener replacement.
 */
export function installInAppMenuHotkeyListener(
  target: InAppMenuHotkeyEventTarget,
  getRuntimeConfig: () => InAppMenuHotkeyRuntimeConfig,
  getRunMenuCommand: () => InAppMenuHotkeyCommandRunner,
): () => void {
  const onKeyDown = (event: Event) => {
    handleInAppMenuHotkeyEvent(event as KeyboardEvent, getRuntimeConfig(), getRunMenuCommand());
  };
  const options = { capture: true };

  target.addEventListener('keydown', onKeyDown, options);
  return () => target.removeEventListener('keydown', onKeyDown, options);
}
