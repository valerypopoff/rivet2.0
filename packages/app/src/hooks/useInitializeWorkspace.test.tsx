import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { Provider, createStore } from 'jotai';
import { InMemoryEvaluationRunStore } from '@valerypopoff/rivet2-evaluations';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { HostCallbacksProvider } from '../providers/HostCallbacksContext.js';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import {
  configureHybridStorageBackend,
  MemoryAsyncStorage,
  memoryStorage,
  type AsyncStorageBackend,
} from '../state/storage.js';
import { useInitializeWorkspace } from './useInitializeWorkspace.js';
import { WorkspaceRecoveryDataError } from '../state/storage/workspaceRecovery.js';

function fixture() {
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
  const previous = configureHybridStorageBackend(new MemoryAsyncStorage());
  const root = createRoot(document.getElementById('root')!);
  const store = createStore();
  const providers = { evaluationStore: new InMemoryEvaluationRunStore() };
  function Harness({ backend }: { backend: AsyncStorageBackend }) {
    const state = useInitializeWorkspace(backend);
    return (
      <>
        <div data-recovery-choice={state.canChooseRecovery}>{state.loading ? 'Loading' : state.error ?? 'Ready'}</div>
        {state.error && <button onClick={state.retry}>Retry loading</button>}
      </>
    );
  }
  return {
    render: (backend: AsyncStorageBackend, onError: (error: unknown) => void = () => {}) =>
      root.render(
        <Provider store={store}>
          <HostCallbacksProvider callbacks={{ onInitializationError: onError }}>
            <ProvidersProvider providers={providers}>
              <Harness backend={backend} />
            </ProvidersProvider>
          </HostCallbacksProvider>
        </Provider>,
      ),
    unmount: () => root.unmount(),
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

test('changing only the error callback does not restart pending bootstrap and the current callback receives failure', async () => {
  const f = fixture();
  const backend = new MemoryAsyncStorage();
  let reads = 0;
  let rejectRead!: (error: Error) => void;
  backend.getItem = async () => {
    reads++;
    return new Promise<string>((_resolve, reject) => {
      rejectRead = reject;
    });
  };
  const firstErrors: unknown[] = [];
  const currentErrors: unknown[] = [];
  try {
    await act(async () => f.render(backend, (error) => firstErrors.push(error)));
    assert.equal(reads, 1);
    await act(async () => f.render(backend, (error) => currentErrors.push(error)));
    assert.equal(reads, 1);
    const error = new WorkspaceRecoveryDataError('Test startup read failed');
    await act(async () => rejectRead(error));
    assert.deepEqual(firstErrors, []);
    assert.deepEqual(currentErrors, [error]);
    assert.equal(document.querySelector('div#root > div')!.textContent, error.message);
  } finally {
    await f.cleanup();
  }
});

test('a late previous-backend read cannot replace the new workspace or readiness', async () => {
  const f = fixture();
  const first = new MemoryAsyncStorage();
  const second = new MemoryAsyncStorage();
  await second.setItem(
    'project',
    JSON.stringify({ projectState: { metadata: { id: 'new', title: 'New' }, graphs: {} } }),
  );
  let finishRead!: (value: string) => void;
  first.getItem = async () =>
    new Promise<string>((resolve) => {
      finishRead = resolve;
    });
  const errors: unknown[] = [];
  try {
    await act(async () => f.render(first, (error) => errors.push(error)));
    await act(async () => f.render(second, (error) => errors.push(error)));
    assert.equal(document.body.textContent, 'Ready');
    const groups = structuredClone([...memoryStorage]);
    await act(async () => finishRead('{"obsolete":true}'));
    assert.deepEqual([...memoryStorage], groups);
    assert.equal(document.body.textContent, 'Ready');
    assert.deepEqual(errors, []);
  } finally {
    await f.cleanup();
  }
});

test('unmounting during initialization ignores a late error without erasing current memory', async () => {
  const f = fixture();
  const backend = new MemoryAsyncStorage();
  let failRead!: (error: Error) => void;
  backend.getItem = async () =>
    new Promise<string>((_resolve, reject) => {
      failRead = reject;
    });
  const errors: unknown[] = [];
  try {
    await act(async () => f.render(backend, (error) => errors.push(error)));
    await act(async () => f.unmount());
    memoryStorage.set('project', { retained: 'newer owner' });
    await act(async () => failRead(new Error('Obsolete failure')));
    assert.deepEqual(memoryStorage.get('project'), { retained: 'newer owner' });
    assert.deepEqual(errors, []);
  } finally {
    await f.cleanup();
  }
});

test('an error-notification callback cannot replace the actual bootstrap error or reject initialization', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture();
    const backend = new MemoryAsyncStorage();
    const failure = new WorkspaceRecoveryDataError('Authoritative storage unavailable');
    backend.getItem = async () => {
      throw failure;
    };
    let notifications = 0;
    try {
      await act(async () =>
        f.render(backend, () => {
          notifications++;
          // A host can return a Promise through the public void notification seam.
          if (asynchronous) return Promise.reject(new Error('Notification rejected')) as unknown as void;
          throw new Error('Notification threw');
        }),
      );
      assert.equal(notifications, 1);
      assert.equal(document.querySelector('div#root > div')!.textContent, failure.message);
    } finally {
      await f.cleanup();
    }
  }
});

test('temporary bootstrap failure automatically retries the same authority without notifying the user', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const backend = new MemoryAsyncStorage();
  const read = backend.getItem.bind(backend);
  let failures = 2;
  backend.getItem = async (key) => {
    if (failures-- > 0) throw new Error('Temporary read failure');
    return read(key);
  };
  const errors: unknown[] = [];
  try {
    await act(async () => f.render(backend, (error) => errors.push(error)));
    assert.equal(document.body.textContent, 'Loading');
    await act(async () => t.mock.timers.tick(250));
    await act(async () => t.mock.timers.tick(1_000));
    assert.equal(document.body.textContent, 'Ready');
    assert.deepEqual(errors, []);
  } finally {
    await f.cleanup();
  }
});

test('persistent bootstrap failure offers an in-place retry without requiring an empty reset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const backend = new MemoryAsyncStorage();
  const read = backend.getItem.bind(backend);
  backend.getItem = async () => {
    throw new Error('Unavailable');
  };
  const errors: unknown[] = [];
  try {
    await act(async () => f.render(backend, (error) => errors.push(error)));
    await act(async () => t.mock.timers.tick(250));
    await act(async () => t.mock.timers.tick(1_000));
    assert.equal(errors.length, 1);
    assert.match(document.body.textContent!, /Unavailable/);
    assert.equal(document.querySelector('[data-recovery-choice]')!.getAttribute('data-recovery-choice'), 'false');
    backend.getItem = read;
    await act(async () => document.querySelector('button')!.click());
    assert.equal(document.body.textContent, 'Ready');
    assert.equal(errors.length, 1);
  } finally {
    await f.cleanup();
  }
});
