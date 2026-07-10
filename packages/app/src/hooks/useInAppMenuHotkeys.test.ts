import { strict as assert } from 'node:assert';
import test from 'node:test';

import { getInAppMenuHotkeyCommand } from '../utils/inAppMenuHotkeys';

function keyEvent(
  input: Partial<Parameters<typeof getInAppMenuHotkeyCommand>[0]>,
): Parameters<typeof getInAppMenuHotkeyCommand>[0] {
  return {
    altKey: input.altKey ?? false,
    code: input.code ?? input.key ?? '',
    ctrlKey: input.ctrlKey ?? false,
    key: input.key ?? '',
    metaKey: input.metaKey ?? false,
    shiftKey: input.shiftKey ?? false,
  };
}

test('in-app menu hotkeys use the physical letter key when the active keyboard layout is non-Latin', () => {
  assert.equal(
    getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', ctrlKey: true, key: '\u044B' }), 'windows'),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', key: '\u044B', metaKey: true }), 'macos'),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', ctrlKey: true, key: '\u044B', shiftKey: true }), 'windows'),
    'save_project_as',
  );
});

test('in-app menu hotkeys keep platform-specific command modifiers', () => {
  assert.equal(getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', key: 's', metaKey: true }), 'windows'), undefined);
  assert.equal(getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' }), 'macos'), undefined);
  assert.equal(
    getInAppMenuHotkeyCommand(keyEvent({ code: 'KeyS', ctrlKey: true, key: 's', metaKey: true }), 'windows'),
    undefined,
  );
  assert.equal(
    getInAppMenuHotkeyCommand(keyEvent({ altKey: true, code: 'KeyS', ctrlKey: true, key: 's' }), 'windows'),
    undefined,
  );
});

test('in-app menu hotkeys keep existing semantic non-letter shortcuts', () => {
  assert.equal(getInAppMenuHotkeyCommand(keyEvent({ code: 'F5', key: 'F5' }), 'windows'), 'remote_debugger');
  assert.equal(getInAppMenuHotkeyCommand(keyEvent({ code: 'Enter', ctrlKey: true, key: 'Enter' }), 'windows'), 'run');
});
