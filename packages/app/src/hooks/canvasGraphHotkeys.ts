import {
  matchesKeyboardShortcut,
  type KeyboardShortcutDefinition,
  type KeyboardShortcutEvent,
} from '../utils/keyboardShortcutMatcher.js';

export type CanvasGraphHotkey =
  | 'editHoveredNode'
  | 'goTo'
  | 'openAiGraphCreator'
  | 'redo'
  | 'redoWithShift'
  | 'search'
  | 'selectAll'
  | 'undo'
  | 'zoomIn'
  | 'zoomOut';

const CANVAS_GRAPH_HOTKEYS: Readonly<Record<CanvasGraphHotkey, KeyboardShortcutDefinition>> = {
  editHoveredNode: { altKey: false, codes: ['KeyE'], keys: ['e'], shiftKey: false },
  goTo: { altKey: false, codes: ['KeyP'], commandModifier: 'any-command', keys: ['p'], shiftKey: false },
  openAiGraphCreator: {
    altKey: false,
    codes: ['KeyI'],
    commandModifier: 'any-command',
    keys: ['i'],
    shiftKey: false,
  },
  redo: { altKey: false, codes: ['KeyY'], commandModifier: 'any-command', keys: ['y'], shiftKey: false },
  redoWithShift: { altKey: false, codes: ['KeyZ'], commandModifier: 'any-command', keys: ['z'], shiftKey: true },
  search: { altKey: false, codes: ['KeyF'], commandModifier: 'any-command', keys: ['f'], shiftKey: false },
  selectAll: { altKey: false, codes: ['KeyA'], commandModifier: 'any-command', keys: ['a'], shiftKey: false },
  undo: { altKey: false, codes: ['KeyZ'], commandModifier: 'any-command', keys: ['z'], shiftKey: false },
  zoomIn: { altKey: false, codes: ['Equal'], commandModifier: 'any-command', keys: ['='], shiftKey: false },
  zoomOut: { altKey: false, codes: ['Minus'], commandModifier: 'any-command', keys: ['-'], shiftKey: false },
};

export function getCanvasGraphHotkey(event: KeyboardShortcutEvent): CanvasGraphHotkey | undefined {
  return (Object.keys(CANVAS_GRAPH_HOTKEYS) as CanvasGraphHotkey[]).find((hotkey) =>
    matchesKeyboardShortcut(event, CANVAS_GRAPH_HOTKEYS[hotkey]),
  );
}
