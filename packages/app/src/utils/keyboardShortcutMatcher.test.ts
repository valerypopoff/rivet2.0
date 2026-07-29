import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesKeyboardShortcut, type KeyboardShortcutEvent } from './keyboardShortcutMatcher.js';

function keyEvent(input: Partial<KeyboardShortcutEvent>): KeyboardShortcutEvent {
  return {
    altKey: input.altKey ?? false,
    code: input.code ?? '',
    ctrlKey: input.ctrlKey ?? false,
    key: input.key ?? '',
    metaKey: input.metaKey ?? false,
    shiftKey: input.shiftKey ?? false,
  };
}

const FIND_SHORTCUT = {
  altKey: false,
  codes: ['KeyF'],
  commandModifier: 'any-command' as const,
  keys: ['f'],
  shiftKey: false,
};

test('keyboard shortcuts match physical codes when the active layout is non-Latin', () => {
  assert.equal(matchesKeyboardShortcut(keyEvent({ code: 'KeyF', ctrlKey: true, key: '\u0430' }), FIND_SHORTCUT), true);
});

test('keyboard shortcuts retain semantic-key fallback for alternative layouts and synthetic events', () => {
  assert.equal(matchesKeyboardShortcut(keyEvent({ code: 'KeyY', ctrlKey: true, key: 'f' }), FIND_SHORTCUT), true);
  assert.equal(matchesKeyboardShortcut(keyEvent({ ctrlKey: true, key: 'F' }), FIND_SHORTCUT), true);
});

test('keyboard shortcuts keep exact modifier requirements and reject AltGr-style events', () => {
  assert.equal(
    matchesKeyboardShortcut(keyEvent({ code: 'KeyF', ctrlKey: true, key: '\u0430', altKey: true }), FIND_SHORTCUT),
    false,
  );
  assert.equal(
    matchesKeyboardShortcut(keyEvent({ code: 'KeyF', ctrlKey: true, key: 'f', shiftKey: true }), FIND_SHORTCUT),
    false,
  );
});

test('keyboard shortcuts can require the platform command modifier', () => {
  const saveShortcut = {
    altKey: false,
    codes: ['KeyS'],
    commandModifier: 'platform-command' as const,
    keys: ['s'],
    shiftKey: false,
  };

  assert.equal(
    matchesKeyboardShortcut(keyEvent({ code: 'KeyS', ctrlKey: true, key: '\u044b' }), saveShortcut, {
      platform: 'windows',
    }),
    true,
  );
  assert.equal(
    matchesKeyboardShortcut(keyEvent({ code: 'KeyS', metaKey: true, key: '\u044b' }), saveShortcut, {
      platform: 'macos',
    }),
    true,
  );
  assert.equal(
    matchesKeyboardShortcut(keyEvent({ code: 'KeyS', metaKey: true, key: 's' }), saveShortcut, { platform: 'windows' }),
    false,
  );
});
