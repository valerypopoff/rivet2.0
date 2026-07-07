import type { MenuIds } from './menuCommandIds.js';

export type InAppMenuHotkeyPlatform = 'macos' | 'windows';

export type InAppMenuHotkeyEvent = Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>;

const shortcutToMenuId: Record<string, MenuIds> = {
  F5: 'remote_debugger',
  'CmdOrCtrl+Shift+O': 'load_recording',
  'CmdOrCtrl+N': 'new_project',
  'CmdOrCtrl+O': 'open_project',
  'CmdOrCtrl+S': 'save_project',
  'CmdOrCtrl+Shift+E': 'export_graph',
  'CmdOrCtrl+Shift+S': 'save_project_as',
  'CmdOrCtrl+ENTER': 'run',
};

function usesPlatformCommandModifier(event: InAppMenuHotkeyEvent, platform: InAppMenuHotkeyPlatform) {
  return platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function getKeyCandidates(event: InAppMenuHotkeyEvent) {
  const candidates = [event.key.toUpperCase()];
  const physicalLetter = /^Key([A-Z])$/.exec(event.code)?.[1];

  if (physicalLetter && !candidates.includes(physicalLetter)) {
    candidates.push(physicalLetter);
  }

  return candidates;
}

export function getInAppMenuHotkeyCommand(
  event: InAppMenuHotkeyEvent,
  platform: InAppMenuHotkeyPlatform,
): MenuIds | undefined {
  if (event.altKey) {
    return undefined;
  }

  const hasCommandModifier = event.ctrlKey || event.metaKey;

  if (hasCommandModifier && !usesPlatformCommandModifier(event, platform)) {
    return undefined;
  }

  const modifierPrefix = hasCommandModifier ? 'CmdOrCtrl+' : '';
  const shiftPrefix = event.shiftKey ? 'Shift+' : '';

  for (const key of getKeyCandidates(event)) {
    const command = shortcutToMenuId[`${modifierPrefix}${shiftPrefix}${key}`];

    if (command) {
      return command;
    }
  }

  return undefined;
}
