export type KeyboardShortcutPlatform = 'macos' | 'windows';

export type KeyboardShortcutEvent = Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey'> & {
  shiftKey?: boolean;
};

export type KeyboardShortcutCommandModifier = 'any-command' | 'none' | 'platform-command';

export type KeyboardShortcutDefinition = {
  keys?: readonly string[];
  codes?: readonly string[];
  commandModifier?: KeyboardShortcutCommandModifier;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type KeyboardShortcutMatchOptions = {
  platform?: KeyboardShortcutPlatform;
};

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

function matchesCommandModifier(
  event: KeyboardShortcutEvent,
  commandModifier: KeyboardShortcutCommandModifier,
  platform: KeyboardShortcutPlatform | undefined,
): boolean {
  if (commandModifier === 'none') {
    return !event.ctrlKey && !event.metaKey;
  }

  if (commandModifier === 'any-command') {
    return event.ctrlKey || event.metaKey;
  }

  if (!platform) {
    return false;
  }

  return platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Matches both the semantic key reported by the active keyboard layout and the
 * physical browser key code. Letter shortcuts must provide both forms so a
 * command such as Ctrl+F still works after switching to a non-Latin layout.
 */
export function matchesKeyboardShortcut(
  event: KeyboardShortcutEvent,
  definition: KeyboardShortcutDefinition,
  options: KeyboardShortcutMatchOptions = {},
): boolean {
  const commandModifier = definition.commandModifier ?? 'none';

  if (!matchesCommandModifier(event, commandModifier, options.platform)) {
    return false;
  }

  if (definition.altKey != null && event.altKey !== definition.altKey) {
    return false;
  }

  if (definition.shiftKey != null && event.shiftKey !== definition.shiftKey) {
    return false;
  }

  const keys = definition.keys ?? [];
  const codes = definition.codes ?? [];
  const semanticKey = normalizeKey(event.key);

  return keys.some((key) => normalizeKey(key) === semanticKey) || codes.includes(event.code);
}
