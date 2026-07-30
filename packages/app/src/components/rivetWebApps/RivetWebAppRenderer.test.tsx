import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  createUiGraphInteractionController,
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagesStateKey,
  getUiGraphChatPinsStateKey,
  type GraphProgress,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { getUiGraphChatStorageKey } from '@valerypopoff/rivet2-core/web-app-runtime';
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
    {
      abortSignal: AbortSignal;
      reportProgress(progress: GraphProgress): void;
      resolve(result: RivetWebAppActionResult): void;
    }
  >();
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(
        <RivetWebAppRenderer
          uiGraph={uiGraph}
          onRunAction={(componentId, _state, abortSignal, reportProgress) =>
            new Promise((resolve) => pendingActions.set(componentId, { abortSignal, reportProgress, resolve }))
          }
        />,
      );
    });

    await act(async () => {
      const buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
      buttons[0]?.click();
      buttons[1]?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    let buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
    assert.equal(buttons[0]?.textContent, 'First');
    assert.equal(buttons[1]?.textContent, 'Second');
    assert.equal(buttons[0]?.querySelector('.rivet-web-app-running-indicator') != null, true);
    assert.equal(buttons[1]?.querySelector('.rivet-web-app-running-indicator') != null, true);
    assert.equal(rootElement.querySelectorAll('.rivet-web-app-abort-button').length, 2);
    assert.equal(buttons[0]?.type, 'button');

    await act(async () => {
      pendingActions.get('first-button' as UiComponentId)?.reportProgress({ message: 'Preparing response' });
    });
    const firstActionStack = buttons[0]?.closest('.rivet-web-app-action-stack');
    assert.equal(firstActionStack?.querySelector('.rivet-web-app-progress')?.textContent, 'Preparing response');
    assert.deepEqual(
      [...(firstActionStack?.children ?? [])].map((child) => child.className),
      ['rivet-web-app-button', 'rivet-web-app-abort-button', 'rivet-web-app-progress'],
    );

    await act(async () => {
      pendingActions.get('first-button' as UiComponentId)?.resolve({ outputs: {}, statePatch: { result: 'stale' } });
    });

    buttons = rootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button');
    assert.equal(buttons[0]?.textContent, 'First');
    assert.equal(buttons[1]?.textContent, 'Second');
    assert.equal(rootElement.querySelector('.rivet-web-app-output-content'), null);

    await act(async () => {
      pendingActions.get('second-button' as UiComponentId)?.resolve({
        outputs: {},
        statePatch: { result: 'current' },
      });
    });
    assert.equal(rootElement.querySelector('.rivet-web-app-output pre')?.textContent, 'current');

    await act(async () => {
      rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-reset-button')?.click();
    });
    assert.equal(rootElement.querySelector('.rivet-web-app-output-content'), null);

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

test('persistent editor previews keep an in-flight action through unmount and reattach its result', async () => {
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

  const button = {
    action: { outputs: [{ outputKey: 'value', stateKey: 'result' }], type: 'runGraph' as const },
    id: 'run-button' as UiComponentId,
    label: 'Run',
    type: 'button' as const,
  };
  const uiGraph = {
    components: [
      button,
      { id: 'result-output' as UiComponentId, label: 'Result', stateKey: 'result', type: 'output' as const },
    ],
    id: 'persistent-preview' as UiGraphId,
    name: 'Persistent preview',
  } satisfies UiGraph;
  const interactionController = createUiGraphInteractionController(uiGraph);
  let abortSignal: AbortSignal | undefined;
  let resolveAction!: (result: RivetWebAppActionResult) => void;
  const actionResult = new Promise<RivetWebAppActionResult>((resolve) => {
    resolveAction = resolve;
  });
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);
  let initialRootUnmounted = false;
  let resumedRoot: ReturnType<typeof createRoot> | undefined;
  let resumedStorage: Record<string, unknown> | undefined;

  try {
    await act(async () => {
      root.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          preserveActionsOnUnmount
          uiGraph={uiGraph}
          onRunAction={(_componentId, _state, signal) => {
            abortSignal = signal;
            return actionResult;
          }}
        />,
      );
    });

    await act(async () => {
      rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    });
    assert.equal(abortSignal?.aborted, false);

    await act(async () => root.unmount());
    initialRootUnmounted = true;
    assert.equal(abortSignal?.aborted, false);
    assert.equal(interactionController.getSnapshot().runningComponentIds.has(button.id), true);

    const resumedElement = dom.window.document.createElement('div');
    dom.window.document.body.append(resumedElement);
    resumedRoot = createRoot(resumedElement);
    await act(async () => {
      resumedRoot?.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          preserveActionsOnUnmount
          uiGraph={uiGraph}
          onRunAction={async (_componentId, _state, _signal, _onProgress, storage) => {
            resumedStorage = storage;
            return { outputs: {} };
          }}
        />,
      );
    });

    const actionCompleted = new Promise<void>((resolve) => {
      const unsubscribe = interactionController.subscribe(() => {
        if (interactionController.getSnapshot().state.result === 'finished') {
          unsubscribe();
          resolve();
        }
      });
    });
    await act(async () => {
      resolveAction({
        outputs: {},
        statePatch: { result: 'finished' },
        storagePatch: { analysis: { summary: 'finished' } },
      });
      await actionCompleted;
    });
    assert.equal(interactionController.getSnapshot().state.result, 'finished');
    assert.equal(interactionController.getSnapshot().runningComponentIds.size, 0);

    await act(async () => {
      resumedElement.querySelector<HTMLButtonElement>('.rivet-web-app-button')?.click();
    });
    assert.equal(resumedElement.querySelector('.rivet-web-app-output pre')?.textContent, 'finished');
    assert.deepEqual(resumedStorage, { analysis: { summary: 'finished' } });
  } finally {
    if (!initialRootUnmounted) {
      await act(async () => root.unmount());
    }
    await act(async () => resumedRoot?.unmount());
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

test('editor component frames expose multi-selection modifier clicks without changing hosted behavior', async () => {
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

  const firstComponentId = 'first' as UiComponentId;
  const secondComponentId = 'second' as UiComponentId;
  const uiGraph: UiGraph = {
    components: [
      { id: firstComponentId, text: 'First', type: 'text' },
      { id: secondComponentId, text: 'Second', type: 'text' },
    ],
    id: 'ui-graph' as UiGraphId,
    name: 'Test app',
  };
  const interactionController = createUiGraphInteractionController(uiGraph);
  const displayUiGraph: UiGraph = {
    ...uiGraph,
    components: [
      ...uiGraph.components,
      { defaultValue: 'unsaved', id: 'unsaved' as UiComponentId, label: 'Unsaved', stateKey: 'unsaved', type: 'input' },
    ],
  };
  const selectionChanges: Array<[UiComponentId, 'replace' | 'toggle']> = [];
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          interactionUiGraph={uiGraph}
          uiGraph={displayUiGraph}
          selectedComponentIds={new Set([firstComponentId])}
          onComponentSelectionChange={(componentId, mode) => selectionChanges.push([componentId, mode])}
          onRunAction={async () => ({ outputs: {} })}
        />,
      );
    });

    const frames = rootElement.querySelectorAll<HTMLElement>('.rivet-web-app-component-frame');
    assert.equal(frames[0]?.classList.contains('active'), true);
    assert.equal(frames[1]?.classList.contains('active'), false);
    assert.equal(Object.hasOwn(interactionController.getSnapshot().state, 'unsaved'), false);

    await act(async () => {
      frames[1]?.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, shiftKey: true }));
    });
    assert.deepEqual(selectionChanges, [[secondComponentId, 'toggle']]);

    selectionChanges.length = 0;
    await act(async () => {
      frames[1]?.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    });
    assert.deepEqual(selectionChanges, [[secondComponentId, 'replace']]);
  } finally {
    await act(async () => root.unmount());
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

test('Chat restores browser state, preserves it through Reset, and flushes only its history from the options menu', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/apps/chat' });
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

  const chatId = 'chat' as UiComponentId;
  const uiGraph: UiGraph = {
    components: [
      {
        defaultValue: 'ordinary state',
        id: 'input' as UiComponentId,
        label: 'Input',
        stateKey: 'input',
        type: 'input',
      },
      { action: { type: 'runGraph' }, id: chatId, type: 'chat' },
    ],
    id: 'chat-app' as UiGraphId,
    name: 'Chat app',
  };
  const draftKey = getUiGraphChatDraftStateKey(chatId);
  const messagesKey = getUiGraphChatMessagesStateKey(chatId);
  const pinsKey = getUiGraphChatPinsStateKey(chatId);
  const storageKey = getUiGraphChatStorageKey(uiGraph, dom.window.location)!;
  dom.window.localStorage.setItem(
    storageKey,
    JSON.stringify({
      [draftKey]: 'Unsaved draft',
      [messagesKey]: [
        { content: 'Question', role: 'user' },
        { content: 'Response', role: 'assistant' },
      ],
      [pinsKey]: [1],
    }),
  );
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(<RivetWebAppRenderer uiGraph={uiGraph} onRunAction={async () => ({ outputs: {} })} />);
    });

    assert.equal(rootElement.querySelectorAll('.rivet-web-app-chat-message').length, 2);
    assert.equal(
      rootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')?.value,
      'Unsaved draft',
    );

    await act(async () => rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-reset-button')?.click());
    assert.equal(rootElement.querySelectorAll('.rivet-web-app-chat-message').length, 2);
    assert.equal(rootElement.querySelector<HTMLInputElement>('.rivet-web-app-control')?.value, 'ordinary state');

    const secondUiGraph: UiGraph = { ...uiGraph, id: 'second-chat-app' as UiGraphId, name: 'Second chat app' };
    await act(async () => {
      root.render(<RivetWebAppRenderer uiGraph={secondUiGraph} onRunAction={async () => ({ outputs: {} })} />);
    });
    assert.equal(JSON.parse(dom.window.localStorage.getItem(storageKey)!)[messagesKey].length, 2);
    await act(async () => {
      root.render(<RivetWebAppRenderer uiGraph={uiGraph} onRunAction={async () => ({ outputs: {} })} />);
    });
    assert.equal(rootElement.querySelectorAll('.rivet-web-app-chat-message').length, 2);

    await act(async () => rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')?.click());
    assert.equal(rootElement.querySelector('.rivet-web-app-chat-menu')?.textContent, 'Flush chat history');
    await act(async () => rootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu button')?.click());
    assert.equal(rootElement.querySelectorAll('.rivet-web-app-chat-message').length, 0);
    assert.equal(
      rootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')?.value,
      'Unsaved draft',
    );
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(storageKey)!), { [draftKey]: 'Unsaved draft' });
  } finally {
    await act(async () => root.unmount());
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

test('Chat renders browser-local timestamps and date separators only across multiple dates', async () => {
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

  const chatId = 'chat' as UiComponentId;
  const messagesKey = getUiGraphChatMessagesStateKey(chatId);
  const uiGraph: UiGraph = {
    components: [{ action: { type: 'runGraph' }, id: chatId, type: 'chat' }],
    id: 'timestamped-chat-app' as UiGraphId,
    name: 'Timestamped chat app',
  };
  const interactionController = createUiGraphInteractionController(uiGraph);
  interactionController.updateStatePatch({
    [messagesKey]: [
      { content: 'First', role: 'user', timestamp: '2026-07-20T12:00:00.000Z' },
      { content: 'Second', role: 'assistant', timestamp: '2026-07-21T12:00:00.000Z' },
      { content: 'Third', role: 'user', timestamp: '2026-07-22T12:00:00.000Z' },
    ],
  });
  const rootElement = dom.window.document.getElementById('root')!;
  const root = createRoot(rootElement);

  try {
    await act(async () => {
      root.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          uiGraph={uiGraph}
          onRunAction={async () => ({ outputs: {} })}
        />,
      );
    });

    const messageTimes = rootElement.querySelectorAll<HTMLTimeElement>('.rivet-web-app-chat-message-time');
    assert.equal(messageTimes.length, 3);
    for (const messageTime of messageTimes) {
      assert.match(messageTime.textContent ?? '', /^\d{2}:\d{2}$/);
      assert.match(messageTime.dateTime, /^2026-07-2[0-2]T12:00:00\.000Z$/);
    }
    assert.equal(messageTimes[0]?.title, '2026-07-20T12:00:00.000Z');
    assert.equal(messageTimes[1]?.title, '2026-07-21T12:00:00.000Z\n86400 seconds after previous user message');
    assert.equal(messageTimes[2]?.title, '2026-07-22T12:00:00.000Z');
    assert.equal(rootElement.querySelectorAll('.rivet-web-app-chat-date-separator').length, 2);
  } finally {
    await act(async () => root.unmount());
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
