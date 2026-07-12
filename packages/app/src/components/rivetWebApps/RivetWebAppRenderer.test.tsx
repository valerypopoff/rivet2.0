import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import type { UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import { RivetWebAppRenderer, type RivetWebAppActionResult } from './RivetWebAppRenderer.js';

test('React web app actions keep independent loading, reject stale patches, and reset after cancellation', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/app' });
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    navigator: globalThis.navigator,
    window: globalThis.window,
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const action = {
    outputs: [{ outputKey: 'value', stateKey: 'result' }],
    type: 'runGraph' as const,
  };
  const uiGraph: UiGraph = {
    components: [
      { action, id: 'first-button' as UiComponentId, label: 'First', type: 'button' },
      { action, id: 'second-button' as UiComponentId, label: 'Second', type: 'button' },
      { id: 'result-output' as UiComponentId, label: 'Result', stateKey: 'result', type: 'output' },
    ],
    id: 'ui-graph' as UiGraphId,
    name: 'Test app',
  };
  const pendingActions = new Map<
    UiComponentId,
    { abortSignal: AbortSignal; resolve(result: RivetWebAppActionResult): void }
  >();
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(
        <RivetWebAppRenderer
          uiGraph={uiGraph}
          onRunAction={(componentId, _state, abortSignal) =>
            new Promise((resolve) => pendingActions.set(componentId, { abortSignal, resolve }))
          }
        />,
      );
    });

    await act(async () => {
      const buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
      buttons[0]?.click();
      buttons[1]?.click();
    });

    let buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
    assert.equal(buttons[0]?.textContent, 'Running...');
    assert.equal(buttons[1]?.textContent, 'Running...');

    await act(async () => {
      pendingActions.get('first-button' as UiComponentId)?.resolve({ outputs: {}, statePatch: { result: 'stale' } });
    });

    buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
    assert.equal(buttons[0]?.textContent, 'First');
    assert.equal(buttons[1]?.textContent, 'Running...');
    assert.equal(rootElement.querySelector('.rivet-web-app-output pre')?.textContent, '');

    await act(async () => {
      pendingActions.get('second-button' as UiComponentId)?.resolve({
        outputs: {},
        statePatch: { result: 'current' },
      });
    });
    assert.equal(rootElement.querySelector('.rivet-web-app-output pre')?.textContent, 'current');

    await act(async () => {
      rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    });
    const pagehideSignal = pendingActions.get('first-button' as UiComponentId)?.abortSignal;

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    });
    assert.equal(pagehideSignal?.aborted, true);
    assert.equal(rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.textContent, 'First');

    await act(async () => {
      rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    });
    const unmountSignal = pendingActions.get('first-button' as UiComponentId)?.abortSignal;

    await act(async () => root.unmount());
    assert.equal(unmountSignal?.aborted, true);
  } finally {
    dom.window.close();
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previousGlobals.document },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      navigator: { configurable: true, value: previousGlobals.navigator },
      window: { configurable: true, value: previousGlobals.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
