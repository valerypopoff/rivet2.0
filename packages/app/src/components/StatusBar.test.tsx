import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';
import { StatusBar } from './StatusBar.js';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import { graphRunningState, graphStartTimeState, runActivityJournalState } from '../state/dataFlow.js';
import { runActivityDrawerOpenState } from '../state/ui.js';
import { createRunActivityJournal } from '../features/runActivity/runActivityJournal.js';
import type { RootRunId } from '@valerypopoff/rivet2-core';

test('cancels the runtime animation frame when the status bar unmounts', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installStatusBarGlobals(dom);
  const store = getDefaultStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const previousGraphRunning = store.get(graphRunningState);
  const previousGraphStartTime = store.get(graphStartTimeState);
  const previousRunActivityJournal = store.get(runActivityJournalState);

  try {
    store.set(graphRunningState, true);
    store.set(graphStartTimeState, Date.now());
    store.set(runActivityJournalState, createRunActivityJournal());

    await act(async () =>
      root.render(
        <ProvidersProvider>
          <StatusBar />
        </ProvidersProvider>,
      ),
    );
    assert.equal(requestAnimationFrameCallbacks.size, 1);

    await act(async () => root.unmount());
    assert.equal(requestAnimationFrameCallbacks.size, 0);
  } finally {
    store.set(graphRunningState, previousGraphRunning);
    store.set(graphStartTimeState, previousGraphStartTime);
    store.set(runActivityJournalState, previousRunActivityJournal);
    restoreGlobals();
    dom.window.close();
  }
});

test('the always-present Runtime control toggles Run Activity', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installStatusBarGlobals(dom);
  const store = getDefaultStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const previousRunActivityOpen = store.get(runActivityDrawerOpenState);
  const previousRunActivityJournal = store.get(runActivityJournalState);
  const previousGraphRunning = store.get(graphRunningState);
  const previousGraphStartTime = store.get(graphStartTimeState);

  try {
    store.set(runActivityDrawerOpenState, false);
    store.set(runActivityJournalState, createRunActivityJournal());
    store.set(graphRunningState, false);
    store.set(graphStartTimeState, undefined);
    await act(async () =>
      root.render(
        <ProvidersProvider>
          <StatusBar />
        </ProvidersProvider>,
      ),
    );

    const runtime = dom.window.document.querySelector<HTMLButtonElement>('.runtime')!;
    assert.equal(runtime.textContent?.trim(), 'Runtime: —');
    assert.equal(runtime.getAttribute('aria-pressed'), 'false');

    await act(async () => runtime.click());
    assert.equal(store.get(runActivityDrawerOpenState), true);
    assert.equal(runtime.getAttribute('aria-pressed'), 'true');
  } finally {
    await act(async () => root.unmount());
    store.set(runActivityDrawerOpenState, previousRunActivityOpen);
    store.set(runActivityJournalState, previousRunActivityJournal);
    store.set(graphRunningState, previousGraphRunning);
    store.set(graphStartTimeState, previousGraphStartTime);
    restoreGlobals();
    dom.window.close();
  }
});

test('renders the retained completed runtime immediately after a status-bar remount', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installStatusBarGlobals(dom);
  const store = getDefaultStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const previousGraphRunning = store.get(graphRunningState);
  const previousGraphStartTime = store.get(graphStartTimeState);
  const previousJournal = store.get(runActivityJournalState);
  const journal = createRunActivityJournal();
  const rootRunId = 'completed-runtime-root' as RootRunId;
  journal.rootsById[rootRunId] = {
    sequence: 1,
    rootRunId,
    status: 'completed',
    startedAt: 1_000,
    finishedAt: 3_750,
    paused: false,
    isPartial: false,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: {},
    nodeInvocationOrder: [],
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
  journal.rootOrder = [rootRunId];
  journal.latestCompletedRootRunId = rootRunId;

  try {
    store.set(graphRunningState, false);
    store.set(graphStartTimeState, 1_000);
    store.set(runActivityJournalState, journal);

    await act(async () =>
      root.render(
        <ProvidersProvider>
          <StatusBar />
        </ProvidersProvider>,
      ),
    );

    const runtime = dom.window.document.querySelector<HTMLButtonElement>('.runtime')!;
    assert.equal(runtime.textContent?.trim(), 'Runtime: 2.75s');
    assert.equal(requestAnimationFrameCallbacks.size, 0);
  } finally {
    await act(async () => root.unmount());
    store.set(graphRunningState, previousGraphRunning);
    store.set(graphStartTimeState, previousGraphStartTime);
    store.set(runActivityJournalState, previousJournal);
    restoreGlobals();
    dom.window.close();
  }
});

test('replaces the last live frame with the exact terminal duration', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installStatusBarGlobals(dom);
  const store = getDefaultStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const previousGraphRunning = store.get(graphRunningState);
  const previousGraphStartTime = store.get(graphStartTimeState);
  const previousJournal = store.get(runActivityJournalState);
  const previousDateNow = Date.now;
  let now = 3_750;
  Date.now = () => now;

  try {
    store.set(graphRunningState, true);
    store.set(graphStartTimeState, 1_000);
    store.set(runActivityJournalState, createRunActivityJournal());

    await act(async () =>
      root.render(
        <ProvidersProvider>
          <StatusBar />
        </ProvidersProvider>,
      ),
    );

    const runtime = dom.window.document.querySelector<HTMLButtonElement>('.runtime')!;
    assert.equal(runtime.textContent?.trim(), 'Runtime: 2.75s');

    now = 3_760;
    await runNextAnimationFrame();
    assert.equal(runtime.textContent?.trim(), 'Runtime: 2.76s');

    const journal = createRunActivityJournal();
    const rootRunId = 'just-completed-runtime-root' as RootRunId;
    journal.rootsById[rootRunId] = {
      sequence: 1,
      rootRunId,
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 3_750,
      paused: false,
      isPartial: false,
      graphRunsById: {},
      graphRunOrder: [],
      nodeInvocationsByKey: {},
      nodeInvocationOrder: [],
      omittedNodeInvocationCount: 0,
      omittedLegacyEventCount: 0,
    };
    journal.rootOrder = [rootRunId];
    journal.latestCompletedRootRunId = rootRunId;

    await act(async () => {
      store.set(runActivityJournalState, journal);
      store.set(graphRunningState, false);
    });

    assert.equal(runtime.textContent?.trim(), 'Runtime: 2.75s');
    assert.equal(requestAnimationFrameCallbacks.size, 0);
  } finally {
    Date.now = previousDateNow;
    await act(async () => root.unmount());
    store.set(graphRunningState, previousGraphRunning);
    store.set(graphStartTimeState, previousGraphStartTime);
    store.set(runActivityJournalState, previousJournal);
    restoreGlobals();
    dom.window.close();
  }
});

let nextAnimationFrameId = 0;
const requestAnimationFrameCallbacks = new Map<number, FrameRequestCallback>();

async function runNextAnimationFrame(): Promise<void> {
  const next = requestAnimationFrameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
  assert.ok(next, 'expected a scheduled animation frame');
  const [animationFrameId, callback] = next;
  requestAnimationFrameCallbacks.delete(animationFrameId);
  await act(async () => callback(Date.now()));
}

function installStatusBarGlobals(dom: JSDOM): () => void {
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
  };
  requestAnimationFrameCallbacks.clear();
  Object.defineProperties(globalThis, {
    cancelAnimationFrame: {
      configurable: true,
      value: (animationFrameId: number) => requestAnimationFrameCallbacks.delete(animationFrameId),
    },
    document: { configurable: true, value: dom.window.document },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        const animationFrameId = ++nextAnimationFrameId;
        requestAnimationFrameCallbacks.set(animationFrameId, callback);
        return animationFrameId;
      },
    },
    window: { configurable: true, value: dom.window },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    Object.defineProperties(globalThis, {
      cancelAnimationFrame: { configurable: true, value: previous.cancelAnimationFrame },
      document: { configurable: true, value: previous.document },
      requestAnimationFrame: { configurable: true, value: previous.requestAnimationFrame },
      window: { configurable: true, value: previous.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}
