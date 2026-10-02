import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { Provider, createStore } from 'jotai';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  configureHybridStorageBackend,
  getWorkspaceRecoveryStorage,
  MemoryAsyncStorage,
  memoryStorage,
} from '../state/storage.js';
import { projectUnsavedChangesState } from '../state/savedGraphs.js';

// Node sees Atlaskit's CommonJS default wrapper; Vite unwraps it for the
// browser. Adapt only that packaging seam while testing the real component.
const buttonAdapter = `data:text/javascript,${encodeURIComponent(
  `import button from ${JSON.stringify(import.meta.resolve('@atlaskit/button'))}; export default button.default ?? button;`,
)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@atlaskit/button'
      ? { url: buttonAdapter, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { WorkspaceRecoveryStatus } = await import('./WorkspaceRecoveryStatus.js').finally(() => hooks.deregister());

class PersistentTestStorage extends MemoryAsyncStorage {
  override readonly persistsAcrossReload: boolean = true;
}

function fixture(backend = new PersistentTestStorage()) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalMemory = new Map(memoryStorage);
  memoryStorage.clear();
  const previous = configureHybridStorageBackend(backend);
  const recovery = getWorkspaceRecoveryStorage();
  const root = createRoot(document.getElementById('root')!);
  const store = createStore();
  return {
    dom,
    recovery,
    store,
    render: (initialError?: string, onRetryInitialization?: () => void, allowWorkspaceSelection?: boolean) =>
      root.render(
        <Provider store={store}>
          <WorkspaceRecoveryStatus
            initialError={initialError}
            onRetryInitialization={onRetryInitialization}
            allowWorkspaceSelection={allowWorkspaceSelection}
          />
        </Provider>,
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      configureHybridStorageBackend(previous);
      memoryStorage.clear();
      for (const [key, value] of originalMemory) memoryStorage.set(key, value);
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('healthy saved and pending recovery render no status panel or recovery buttons', async () => {
  const f = fixture();
  try {
    await act(async () => f.render());
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    await act(async () => f.recovery.changed());
    assert.equal(f.recovery.getHealth().status, 'pending');
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    await act(async () => f.recovery.setItem('project', '{}'));
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(document.getElementById('root')!.childElementCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('unrelated bootstrap failure offers retry, not destructive workspace replacement', async () => {
  const f = fixture();
  try {
    await act(async () => f.render('Evaluation service unavailable', () => {}, false));
    assert.match(document.body.textContent!, /Could not load the editor/);
    assert.match(document.body.textContent!, /Retry loading/);
    assert.doesNotMatch(document.body.textContent!, /Recover workspace|Start empty/);
  } finally {
    await f.cleanup();
  }
});

test('hidden background recovery retains the unload guard until unsaved work is checkpointed', async () => {
  const f = fixture();
  try {
    await act(async () => f.render());
    await act(async () => f.store.set(projectUnsavedChangesState, { project: true }));
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    const pending = new f.dom.window.Event('beforeunload', { cancelable: true });
    f.dom.window.dispatchEvent(pending);
    assert.equal(pending.defaultPrevented, true);
    await act(async () => f.recovery.setItem('project', '{}'));
    const saved = new f.dom.window.Event('beforeunload', { cancelable: true });
    f.dom.window.dispatchEvent(saved);
    assert.equal(saved.defaultPrevented, false);
    assert.equal(document.getElementById('root')!.childElementCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('a temporary failure retries silently using the latest workspace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = new PersistentTestStorage();
  const write = backend.setItem.bind(backend);
  backend.setItem = async () => {
    throw new Error('Transient checkpoint failure');
  };
  const f = fixture(backend);
  try {
    await act(async () => f.render());
    await act(async () => f.store.set(projectUnsavedChangesState, { project: true }));
    await act(async () => f.recovery.failed());
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    memoryStorage.set('project', { latest: true });
    backend.setItem = write;
    await act(async () => t.mock.timers.tick(250));
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(JSON.parse((await backend.getItem(f.recovery.key))!).groups.project.latest, true);
    assert.equal(document.getElementById('root')!.childElementCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('persistent recovery failure warns only about unsaved work and has no destructive live chooser', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = new PersistentTestStorage();
  const write = backend.setItem.bind(backend);
  backend.setItem = async () => {
    throw new Error('Persistent checkpoint failure');
  };
  const f = fixture(backend);
  try {
    await act(async () => f.render());
    await act(async () => f.recovery.failed());
    for (const delay of [250, 1_000, 2_500]) await act(async () => t.mock.timers.tick(delay));
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    await act(async () => f.store.set(projectUnsavedChangesState, { project: true }));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save your projects before closing/);
    assert.doesNotMatch(document.body.textContent!, /Recover workspace/);
    const retry = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry recovery'),
    )!;
    assert.equal(retry.disabled, false);
    backend.setItem = write;
    await act(async () => retry.click());
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(document.getElementById('root')!.childElementCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('reload-reference failure retries automatically and hides its warning after projects are saved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await act(async () => f.render());
    await act(async () => f.store.set(projectUnsavedChangesState, { project: true }));
    const write = f.dom.window.Storage.prototype.setItem;
    f.dom.window.Storage.prototype.setItem = function () {
      throw new Error('Session reference write failed');
    };
    await act(async () => f.recovery.setItem('project', '{}'));
    assert.equal(f.recovery.getHealth().status, 'saved');
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    for (const delay of [250, 1_000, 2_500]) await act(async () => t.mock.timers.tick(delay));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save your projects before closing/);
    await act(async () => f.store.set(projectUnsavedChangesState, {}));
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    f.dom.window.Storage.prototype.setItem = write;
    await act(async () => f.dom.window.dispatchEvent(new f.dom.window.Event('focus')));
    assert.equal(f.recovery.getHealth().reloadAvailable, true);
    assert.equal(document.getElementById('root')!.childElementCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('memory-only recovery has no useless controls and bootstrap can retry loading without writing defaults', async () => {
  const f = fixture(new MemoryAsyncStorage());
  try {
    await act(async () => f.render());
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    await act(async () => f.store.set(projectUnsavedChangesState, { project: true }));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Save your projects before closing/);
    assert.equal(document.querySelectorAll('button').length, 0);
    let retries = 0;
    const hadCheckpoint = f.recovery.hasSelectedCheckpoint;
    await act(async () =>
      f.render('The selected checkpoint is missing.', () => {
        retries++;
      }),
    );
    assert.match(document.body.textContent!, /The selected checkpoint is missing/);
    await act(async () => document.querySelector('button')!.click());
    assert.equal(retries, 1);
    assert.equal(f.recovery.hasSelectedCheckpoint, hadCheckpoint);
  } finally {
    await f.cleanup();
  }
});
