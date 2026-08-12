import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { InAppMenuHotkeyCommandRunner, InAppMenuHotkeyRuntimeConfig } from '../utils/inAppMenuHotkeys.js';
import { useStableInAppMenuHotkeyListener } from './useStableInAppMenuHotkeyListener.js';

function Harness({
  runMenuCommand,
  runtimeConfig,
}: {
  runMenuCommand: InAppMenuHotkeyCommandRunner;
  runtimeConfig: InAppMenuHotkeyRuntimeConfig;
}) {
  useStableInAppMenuHotkeyListener({ enabled: true, runMenuCommand, runtimeConfig });
  return null;
}

test('React rerenders update committed policy and callback without replacing the capture listener', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const originalAddEventListener = dom.window.addEventListener.bind(dom.window);
  const originalRemoveEventListener = dom.window.removeEventListener.bind(dom.window);
  let keydownAdds = 0;
  let keydownRemoves = 0;
  const calls: string[] = [];

  dom.window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === 'keydown') {
      keydownAdds += 1;
      assert.deepEqual(options, { capture: true });
    }
    originalAddEventListener(type, listener, options as AddEventListenerOptions);
  }) as typeof dom.window.addEventListener;
  dom.window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    if (type === 'keydown') {
      keydownRemoves += 1;
    }
    originalRemoveEventListener(type, listener, options as EventListenerOptions);
  }) as typeof dom.window.removeEventListener;

  try {
    await act(async () =>
      root.render(
        <Harness
          runtimeConfig={{
            platform: 'windows',
            policy: { legacyShortcutsEnabled: true, saveProject: true },
          }}
          runMenuCommand={(command) => calls.push(`first:${command}`)}
        />,
      ),
    );

    dom.window.dispatchEvent(saveKeydown(dom));

    await act(async () =>
      root.render(
        <Harness
          runtimeConfig={{
            platform: 'windows',
            policy: { legacyShortcutsEnabled: true, saveProject: false },
          }}
          runMenuCommand={(command) => calls.push(`second:${command}`)}
        />,
      ),
    );

    dom.window.dispatchEvent(saveKeydown(dom));
    assert.equal(keydownAdds, 1);
    assert.equal(keydownRemoves, 0);
    assert.deepEqual(calls, ['first:save_project']);

    await act(async () =>
      root.render(
        <Harness
          runtimeConfig={{
            platform: 'windows',
            policy: { legacyShortcutsEnabled: true, saveProject: true },
          }}
          runMenuCommand={(command) => calls.push(`second:${command}`)}
        />,
      ),
    );

    dom.window.dispatchEvent(saveKeydown(dom));
    assert.equal(keydownAdds, 1);
    assert.equal(keydownRemoves, 0);
    assert.deepEqual(calls, ['first:save_project', 'second:save_project']);

    await act(async () => root.unmount());
    assert.equal(keydownRemoves, 1);
  } finally {
    restoreGlobals();
    dom.window.close();
  }
});

function saveKeydown(dom: JSDOM): KeyboardEvent {
  return new dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyS',
    ctrlKey: true,
    key: 's',
  }) as unknown as KeyboardEvent;
}

function installDomGlobals(dom: JSDOM): () => void {
  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    navigator: globalThis.navigator,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previous.document },
      Element: { configurable: true, value: previous.Element },
      navigator: { configurable: true, value: previous.navigator },
      window: { configurable: true, value: previous.window },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: previous.IS_REACT_ACT_ENVIRONMENT },
    });
  };
}
