import { isMacOSPlatform } from './platform/os';

export type PrimaryKeyboardModifierLabel = 'Cmd' | 'Ctrl';

export function getPrimaryKeyboardModifierLabel(): PrimaryKeyboardModifierLabel {
  return isMacOSPlatform() ? 'Cmd' : 'Ctrl';
}

export function formatShortcutTextForPlatform(
  text: string,
  modifierLabel: PrimaryKeyboardModifierLabel = getPrimaryKeyboardModifierLabel(),
): string {
  return text
    .replace(/\bCtrl((?:\s*\+\s*[\w+-]+)+)\s*\/\s*Cmd\1\b/g, `${modifierLabel}$1`)
    .replace(/\bCmd((?:\s*\+\s*[\w+-]+)+)\s*\/\s*Ctrl\1\b/g, `${modifierLabel}$1`)
    .replace(/\bCtrl\/Cmd\b/g, modifierLabel)
    .replace(/\bCmd\/Ctrl\b/g, modifierLabel);
}
