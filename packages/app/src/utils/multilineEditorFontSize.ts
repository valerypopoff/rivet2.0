import { matchesKeyboardShortcut } from './keyboardShortcutMatcher.js';

export const DEFAULT_MULTILINE_EDITOR_FONT_SIZE = 14;
export const MIN_MULTILINE_EDITOR_FONT_SIZE = 10;
export const MAX_MULTILINE_EDITOR_FONT_SIZE = 28;
export const MULTILINE_EDITOR_FONT_SIZE_STEP = 1;

export type MultilineEditorFontSizeCommand = 'increase' | 'decrease' | 'reset';

type MultilineEditorFontSizeModifierEvent = {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

export type MultilineEditorFontSizeKeyEvent = Pick<KeyboardEvent, 'key' | 'code'> &
  MultilineEditorFontSizeModifierEvent;
export type MultilineEditorFontSizeWheelEvent = Pick<WheelEvent, 'deltaY'> & MultilineEditorFontSizeModifierEvent;

const MULTILINE_EDITOR_FONT_SIZE_SHORTCUTS: Record<
  MultilineEditorFontSizeCommand,
  {
    keys: ReadonlySet<string>;
    codes: ReadonlySet<string>;
  }
> = {
  increase: {
    keys: new Set(['+', '=', 'Add']),
    codes: new Set(['Equal', 'NumpadAdd']),
  },
  decrease: {
    keys: new Set(['-', '_', 'Subtract']),
    codes: new Set(['Minus', 'NumpadSubtract']),
  },
  reset: {
    keys: new Set(['0']),
    codes: new Set(['Digit0', 'Numpad0']),
  },
};

function matchesMultilineEditorFontSizeShortcut(
  event: MultilineEditorFontSizeKeyEvent,
  command: MultilineEditorFontSizeCommand,
): boolean {
  const shortcut = MULTILINE_EDITOR_FONT_SIZE_SHORTCUTS[command];
  return matchesKeyboardShortcut(event, {
    altKey: false,
    codes: [...shortcut.codes],
    commandModifier: 'any-command',
    keys: [...shortcut.keys],
  });
}

export function clampMultilineEditorFontSize(fontSize: number): number {
  if (!Number.isFinite(fontSize)) {
    return DEFAULT_MULTILINE_EDITOR_FONT_SIZE;
  }

  return Math.min(MAX_MULTILINE_EDITOR_FONT_SIZE, Math.max(MIN_MULTILINE_EDITOR_FONT_SIZE, Math.round(fontSize)));
}

export function adjustMultilineEditorFontSize(
  currentFontSize: number,
  command: MultilineEditorFontSizeCommand,
): number {
  if (command === 'reset') {
    return DEFAULT_MULTILINE_EDITOR_FONT_SIZE;
  }

  const delta = command === 'increase' ? MULTILINE_EDITOR_FONT_SIZE_STEP : -MULTILINE_EDITOR_FONT_SIZE_STEP;
  return clampMultilineEditorFontSize(currentFontSize + delta);
}

export function getMultilineEditorFontSizeCommand(
  event: MultilineEditorFontSizeKeyEvent,
): MultilineEditorFontSizeCommand | undefined {
  return (['increase', 'decrease', 'reset'] as const).find((command) =>
    matchesMultilineEditorFontSizeShortcut(event, command),
  );
}

export function getMultilineEditorFontSizeWheelCommand(
  event: MultilineEditorFontSizeWheelEvent,
): MultilineEditorFontSizeCommand | undefined {
  if (!((event.ctrlKey || event.metaKey) && !event.altKey) || event.deltaY === 0) {
    return undefined;
  }

  return event.deltaY < 0 ? 'increase' : 'decrease';
}
