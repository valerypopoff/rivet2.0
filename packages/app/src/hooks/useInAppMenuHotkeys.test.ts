import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  getInAppMenuHotkeyCommand,
  getInAppMenuHotkeyCommandForPolicy,
  handleInAppMenuHotkeyEvent,
  installInAppMenuHotkeyListener,
  shouldRegisterInAppMenuHotkeys,
} from '../utils/inAppMenuHotkeys';

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
  assert.equal(getInAppMenuHotkeyCommand(keyEvent({ code: 'F5', key: 'F5', shiftKey: true }), 'windows'), undefined);
});

test('omitting the hosted save policy preserves legacy platform ownership', () => {
  const saveEvent = keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' });
  const openEvent = keyEvent({ code: 'KeyO', ctrlKey: true, key: 'o' });

  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(saveEvent, 'windows', {
      legacyShortcutsEnabled: true,
    }),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(openEvent, 'windows', {
      legacyShortcutsEnabled: true,
    }),
    'open_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(saveEvent, 'linux', {
      legacyShortcutsEnabled: false,
    }),
    undefined,
  );
});

test('hosted save policy enables the platform save shortcut without enabling unrelated browser shortcuts', () => {
  const savePolicy = { legacyShortcutsEnabled: false, saveProject: true };

  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' }), 'windows', savePolicy),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' }), 'linux', savePolicy),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyS', key: 's', metaKey: true }), 'macos', savePolicy),
    'save_project',
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyO', ctrlKey: true, key: 'o' }), 'windows', savePolicy),
    undefined,
  );
  assert.equal(shouldRegisterInAppMenuHotkeys(savePolicy), true);

  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyO', ctrlKey: true, key: 'o' }), 'windows', {
      legacyShortcutsEnabled: true,
      saveProject: true,
    }),
    'open_project',
  );
});

test('disabled hosted save policy leaves the save event unintercepted', () => {
  const disabledPolicy = { legacyShortcutsEnabled: true, saveProject: false };

  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' }), 'windows', disabledPolicy),
    undefined,
  );
  assert.equal(
    getInAppMenuHotkeyCommandForPolicy(keyEvent({ code: 'KeyO', ctrlKey: true, key: 'o' }), 'windows', disabledPolicy),
    'open_project',
  );
});

test('repeat save keydowns are consumed without dispatching another save', () => {
  const calls: Array<{ command: string; source?: string }> = [];
  const preventDefaultCalls: boolean[] = [];
  const stopPropagationCalls: boolean[] = [];
  const stopImmediatePropagationCalls: boolean[] = [];
  const runtimeConfig = {
    platform: 'linux' as const,
    policy: { legacyShortcutsEnabled: false, saveProject: true },
  };

  const event = (repeat: boolean) =>
    ({
      ...keyEvent({ code: 'KeyS', ctrlKey: true, key: 's' }),
      preventDefault: () => preventDefaultCalls.push(true),
      repeat,
      stopImmediatePropagation: () => stopImmediatePropagationCalls.push(true),
      stopPropagation: () => stopPropagationCalls.push(true),
      target: null,
    }) as unknown as KeyboardEvent;

  handleInAppMenuHotkeyEvent(event(false), runtimeConfig, (command, options) =>
    calls.push({ command, source: options?.source }),
  );
  handleInAppMenuHotkeyEvent(event(true), runtimeConfig, (command, options) =>
    calls.push({ command, source: options?.source }),
  );

  assert.deepEqual(calls, [{ command: 'save_project', source: 'host-save-shortcut' }]);
  assert.equal(preventDefaultCalls.length, 2);
  assert.equal(stopPropagationCalls.length, 2);
  assert.equal(stopImmediatePropagationCalls.length, 2);
});

test('save shortcut remains active for canvas and editable focus targets', () => {
  const dom = new JSDOM(`
    <canvas id="canvas"></canvas>
    <input id="input" />
    <textarea id="textarea"></textarea>
    <div id="monaco" class="monaco-editor"></div>
  `);
  const previousElement = globalThis.Element;
  const calls: string[] = [];

  Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
  const cleanup = installInAppMenuHotkeyListener(
    dom.window,
    () => ({
      platform: 'windows',
      policy: { legacyShortcutsEnabled: false, saveProject: true },
    }),
    () => (command) => calls.push(command),
  );

  try {
    for (const id of ['canvas', 'input', 'textarea', 'monaco']) {
      const event = new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'KeyS',
        ctrlKey: true,
        key: 's',
      });
      dom.window.document.getElementById(id)!.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, id);
    }

    assert.deepEqual(calls, ['save_project', 'save_project', 'save_project', 'save_project']);
  } finally {
    cleanup();
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: previousElement });
    dom.window.close();
  }
});

test('rerendered policy and callbacks are observed without replacing the capture listener', () => {
  let keydownListener: EventListener | undefined;
  let addCount = 0;
  let removeCount = 0;
  let runtimeConfig = {
    platform: 'linux' as const,
    policy: { legacyShortcutsEnabled: false, saveProject: true },
  };
  const calls: string[] = [];
  let runMenuCommand = (command: string) => calls.push(`first:${command}`);
  const target = {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      assert.equal(type, 'keydown');
      assert.deepEqual(options, { capture: true });
      addCount += 1;
      keydownListener = listener as EventListener;
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      assert.equal(type, 'keydown');
      assert.deepEqual(options, { capture: true });
      assert.equal(listener, keydownListener);
      removeCount += 1;
    },
  } as Pick<Window, 'addEventListener' | 'removeEventListener'>;

  const cleanup = installInAppMenuHotkeyListener(
    target,
    () => runtimeConfig,
    () => runMenuCommand,
  );
  keydownListener?.(listenerEvent({ code: 'KeyS', ctrlKey: true, key: 's' }));

  runtimeConfig = {
    platform: 'linux',
    policy: { legacyShortcutsEnabled: false, saveProject: false },
  };
  runMenuCommand = (command) => calls.push(`second:${command}`);
  keydownListener?.(listenerEvent({ code: 'KeyS', ctrlKey: true, key: 's' }));

  runtimeConfig = {
    platform: 'linux',
    policy: { legacyShortcutsEnabled: false, saveProject: true },
  };
  keydownListener?.(listenerEvent({ code: 'KeyS', ctrlKey: true, key: 's' }));

  assert.equal(addCount, 1);
  assert.deepEqual(calls, ['first:save_project', 'second:save_project']);
  cleanup();
  assert.equal(removeCount, 1);
});

function listenerEvent(input: Partial<KeyboardEvent>): Event {
  return {
    ...keyEvent(input),
    preventDefault() {},
    repeat: input.repeat ?? false,
    stopImmediatePropagation() {},
    stopPropagation() {},
    target: null,
  } as unknown as Event;
}
