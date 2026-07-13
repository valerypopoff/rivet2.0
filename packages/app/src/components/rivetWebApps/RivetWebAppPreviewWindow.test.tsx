import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { UiComponentId, UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';
import {
  RIVET_WEB_APP_PREVIEW_PARAM,
  RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX,
  RivetWebAppPreviewWindow,
  type PreviewActionRequest,
  type PreviewActionResponse,
} from './RivetWebAppPreviewWindow.js';

test('detached preview loads its payload, runs actions, and cancels pending work on close', async () => {
  const token = 'preview-token';
  const dom = new JSDOM(`<div id="root"></div>`, {
    url: `https://example.test/?${RIVET_WEB_APP_PREVIEW_PARAM}=${token}`,
  });
  const restoreGlobals = installPreviewGlobals(dom);
  const uiGraph = makeUiGraph();
  dom.window.localStorage.setItem(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify({ uiGraph }));
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);
  let unmounted = false;

  try {
    await act(async () => root.render(<RivetWebAppPreviewWindow />));
    assert.equal(dom.window.document.title, 'Preview app');

    await act(async () => rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click());
    const channel = MockBroadcastChannel.instances[0]!;
    const runRequest = channel.messages.find(
      (message): message is Extract<PreviewActionRequest, { type: 'runAction' }> => message.type === 'runAction',
    )!;
    assert.deepEqual(runRequest.state, { prompt: 'Hello' });

    await act(async () => {
      channel.emit({
        requestId: runRequest.requestId,
        result: { outputs: {}, statePatch: { result: 'Done' } },
        type: 'actionResult',
      });
    });
    assert.equal(rootElement.querySelector('.rivet-web-app-output pre')?.textContent, 'Done');

    await act(async () => rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click());
    const pendingRequest = channel.messages.findLast(
      (message): message is Extract<PreviewActionRequest, { type: 'runAction' }> => message.type === 'runAction',
    )!;
    await act(async () => root.unmount());
    unmounted = true;
    assert.equal(
      channel.messages.some(
        (message) => message.type === 'cancelAction' && message.requestId === pendingRequest.requestId,
      ),
      true,
    );
    assert.equal(channel.closed, true);
  } finally {
    if (!unmounted) {
      await act(async () => root.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  readonly messages: PreviewActionRequest[] = [];
  closed = false;
  private readonly listeners = new Set<(event: MessageEvent<PreviewActionResponse>) => void>();

  constructor(readonly name: string) {
    MockBroadcastChannel.instances.push(this);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<PreviewActionResponse>) => void): void {
    this.listeners.add(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(data: PreviewActionResponse): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<PreviewActionResponse>);
    }
  }

  postMessage(message: PreviewActionRequest): void {
    this.messages.push(message);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<PreviewActionResponse>) => void): void {
    this.listeners.delete(listener);
  }
}

function makeUiGraph(): UiGraph {
  return {
    components: [
      {
        defaultValue: 'Hello',
        id: 'input' as UiComponentId,
        label: 'Prompt',
        stateKey: 'prompt',
        type: 'input',
      },
      {
        action: {
          inputMappings: [{ inputKey: 'prompt', stateKey: 'prompt' }],
          outputs: [{ outputKey: 'result', stateKey: 'result' }],
          type: 'runGraph',
        },
        id: 'button' as UiComponentId,
        label: 'Run',
        type: 'button',
      },
      { id: 'output' as UiComponentId, stateKey: 'result', type: 'output' },
    ],
    id: 'preview-app' as UiGraphId,
    name: 'Preview app',
  };
}

function installPreviewGlobals(dom: JSDOM): () => void {
  const previous = {
    BroadcastChannel: globalThis.BroadcastChannel,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    navigator: globalThis.navigator,
    window: globalThis.window,
  };
  MockBroadcastChannel.instances = [];
  Object.defineProperties(globalThis, {
    BroadcastChannel: { configurable: true, value: MockBroadcastChannel },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return () => {
    Object.defineProperties(globalThis, {
      BroadcastChannel: { configurable: true, value: previous.BroadcastChannel },
      document: { configurable: true, value: previous.document },
      localStorage: { configurable: true, value: previous.localStorage },
      navigator: { configurable: true, value: previous.navigator },
      window: { configurable: true, value: previous.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}
