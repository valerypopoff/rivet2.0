import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, Provider } from 'jotai';
import { HostUiConfigProvider, type RivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import {
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  memoryStorage,
  MemoryAsyncStorage,
} from '../state/storage.js';
import { debuggerDefaultUrlState } from '../state/settings.js';
import { useDebuggerConnectionSettings } from './useDebuggerConnectionSettings.js';
import { useCheckForUpdate } from './useCheckForUpdate.js';
import { resolveDebuggerConnectionUrl, resolveDebuggerPreference } from '../utils/debuggerConnectionSettings.js';

async function mount(t: TestContext, stored?: unknown) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
  const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
  keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  const previousGroup = memoryStorage.get('recoil-persist');
  memoryStorage.set('recoil-persist', stored === undefined ? {} : { debuggerDefaultUrl: stored });
  const oldStorage = configureHybridStorageBackend(new MemoryAsyncStorage());
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    try {
      await act(async () => root.unmount());
      await flushHybridStorageGroup('recoil-persist');
    } finally {
      configureHybridStorageBackend(oldStorage);
      if (previousGroup === undefined) memoryStorage.delete('recoil-persist');
      else memoryStorage.set('recoil-persist', previousGroup);
      keys.forEach((key, index) => {
        if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    }
  });
  const stores = [createStore(), createStore()];
  const settings: Array<ReturnType<typeof useDebuggerConnectionSettings>> = [];
  const updates: Array<ReturnType<typeof useCheckForUpdate>> = [];
  function Harness({ index }: { index: number }) {
    settings[index] = useDebuggerConnectionSettings();
    updates[index] = useCheckForUpdate({ force: true });
    return null;
  }
  const render = (configs: RivetAppHostUiConfig[]) =>
    act(async () =>
      root.render(
        <>
          {configs.map((config, index) => (
            <Provider store={stores[index]} key={index}>
              <HostUiConfigProvider config={config}>
                <Harness index={index} />
              </HostUiConfigProvider>
            </Provider>
          ))}
        </>,
      ),
    );
  return { dom, stores, settings, updates, render };
}

test('defaults are host-scoped, live and never saved merely by reading them', async (t) => {
  const { stores, settings, render } = await mount(t);
  let defaultUrl = 'wss://host.example/ws/latest-debugger';
  const hosted = { debuggerConnection: { getDefaultUrl: () => defaultUrl } };
  await render([hosted, {}]);
  assert.equal(settings[0]!.defaultUrl, defaultUrl);
  assert.equal(settings[1]!.defaultUrl, 'ws://localhost:21888');
  assert.equal(stores[0]!.get(debuggerDefaultUrlState), undefined);
  assert.deepEqual(memoryStorage.get('recoil-persist'), {});
  defaultUrl = 'wss://host.example/new-debugger';
  await render([hosted, {}]);
  assert.equal(settings[0]!.defaultUrl, defaultUrl);
  assert.equal(settings[0]!.resolveConnectionUrl(''), defaultUrl);
  assert.equal(settings[1]!.resolveConnectionUrl(''), 'ws://localhost:21888');
  act(() => settings[0]!.setDefaultUrl('ws://custom.example/debugger'));
  await render([{ debuggerConnection: { getDefaultUrl: () => 'wss://another-default/' } }, {}]);
  assert.equal(settings[0]!.defaultUrl, 'ws://custom.example/debugger');
  assert.equal(settings[1]!.defaultUrl, 'ws://localhost:21888');
  assert.equal(memoryStorage.get('recoil-persist')!.debuggerDefaultUrl, 'ws://custom.example/debugger');
});

test('legacy stored preferences are normalized consistently for display, connection and persistence', async (t) => {
  const { settings, stores, render } = await mount(t, 'ws://rivet.test/custom');
  const policy = {
    getDefaultUrl: () => 'wss://rivet.test/ws/latest-debugger',
    normalizeUrl: (url: string) => url.replace(/^ws:\/\/rivet\.test\//, 'wss://rivet.test/'),
  };
  await render([{ debuggerConnection: policy }]);
  assert.equal(settings[0]!.defaultUrl, 'wss://rivet.test/custom');
  assert.equal(settings[0]!.resolveConnectionUrl('ws://rivet.test/typed'), 'wss://rivet.test/typed');
  act(() => settings[0]!.setDefaultUrl('ws://rivet.test/typed'));
  assert.equal(stores[0]!.get(debuggerDefaultUrlState), 'wss://rivet.test/typed');
  assert.equal(settings[0]!.resolveConnectionUrl('ws://external.example/custom'), 'ws://external.example/custom');
  act(() => settings[0]!.setDefaultUrl(''));
  assert.equal(settings[0]!.defaultUrl, '');
  assert.equal(settings[0]!.resolveConnectionUrl(''), policy.getDefaultUrl());
  for (const badValue of [null, 12, false, {}])
    assert.equal(resolveDebuggerPreference(badValue, policy), policy.getDefaultUrl());
  assert.equal(resolveDebuggerConnectionUrl('ws://external.example/custom', policy), 'ws://external.example/custom');
});

test('an explicit host update opt-out wins even for forced checks in a native window', async (t) => {
  const { dom, updates, render } = await mount(t);
  Object.defineProperty(dom.window, '__TAURI__', { value: {} });
  // Any native updater invocation would fail against this empty Tauri stand-in.
  // The host policy must stop it before platform/network access.
  await render([{ checkForUpdates: false }]);
  await updates[0]!();
});
