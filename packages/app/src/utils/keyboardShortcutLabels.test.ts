import assert from 'node:assert/strict';
import test from 'node:test';
import { formatShortcutTextForPlatform } from './keyboardShortcutLabels.js';

test('formats Ctrl/Cmd shortcut placeholders for macOS', () => {
  assert.equal(formatShortcutTextForPlatform('Search (Ctrl/Cmd+F)', 'Cmd'), 'Search (Cmd+F)');
  assert.equal(formatShortcutTextForPlatform('Hold Ctrl/Cmd while dragging', 'Cmd'), 'Hold Cmd while dragging');
});

test('formats Ctrl/Cmd shortcut placeholders for Windows and Linux', () => {
  assert.equal(formatShortcutTextForPlatform('Search (Ctrl/Cmd+F)', 'Ctrl'), 'Search (Ctrl+F)');
  assert.equal(formatShortcutTextForPlatform('Hold Cmd/Ctrl while dragging', 'Ctrl'), 'Hold Ctrl while dragging');
});

test('collapses equivalent Ctrl and Cmd shortcut alternatives', () => {
  assert.equal(formatShortcutTextForPlatform('Collapse graph tree (Ctrl+Q / Cmd+Q)', 'Cmd'), 'Collapse graph tree (Cmd+Q)');
  assert.equal(formatShortcutTextForPlatform('Collapse graph tree (Ctrl+Q / Cmd+Q)', 'Ctrl'), 'Collapse graph tree (Ctrl+Q)');
  assert.equal(formatShortcutTextForPlatform('Load recording (Cmd+Shift+O / Ctrl+Shift+O)', 'Ctrl'), 'Load recording (Ctrl+Shift+O)');
  assert.equal(formatShortcutTextForPlatform('Search (Ctrl + F / Cmd + F)', 'Cmd'), 'Search (Cmd + F)');
});
