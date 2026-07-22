import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';
import { StatusBar } from './StatusBar.js';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import { graphRunningState, graphStartTimeState } from '../state/dataFlow.js';

test('cancels the runtime animation frame when the status bar unmounts', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installStatusBarGlobals(dom);
  const store = getDefaultStore();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const previousGraphRunning = store.get(graphRunningState);
  const previousGraphStartTime = store.get(graphStartTimeState);

  try {
    store.set(graphRunningState, true);
    store.set(graphStartTimeState, Date.now());

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
    restoreGlobals();
    dom.window.close();
  }
});

let nextAnimationFrameId = 0;
const requestAnimationFrameCallbacks = new Map<number, FrameRequestCallback>();

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
