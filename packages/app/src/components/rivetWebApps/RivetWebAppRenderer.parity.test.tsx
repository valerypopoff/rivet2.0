import assert from 'node:assert/strict';
import test from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { marked, Renderer } from 'marked';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import {
  createUiGraphInteractionController,
  getUiGraphInitialState,
  getUiGraphChatMessagesStateKey,
  RIVET_MARKDOWN_SANITIZER_POLICY,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { enhanceUiGraphChatJsonCodeBlocks } from '@valerypopoff/rivet2-core/web-app-runtime';
import { RivetWebAppRenderer, type RivetWebAppActionResult } from './RivetWebAppRenderer.js';

test('fenced JSON controls reserve a scrollbar inset only for vertically overflowing code', () => {
  const dom = new JSDOM(
    [
      '<div id="short"><pre><code class="language-json">{}</code></pre></div>',
      '<div id="long"><pre><code class="language-json">{}</code></pre></div>',
    ].join(''),
  );

  try {
    const shortRoot = dom.window.document.getElementById('short')!;
    const longRoot = dom.window.document.getElementById('long')!;
    const shortPre = shortRoot.querySelector('pre')!;
    const longPre = longRoot.querySelector('pre')!;
    Object.defineProperties(shortPre, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 40 },
    });
    Object.defineProperties(longPre, {
      clientHeight: { configurable: true, value: 40 },
      scrollHeight: { configurable: true, value: 80 },
    });

    enhanceUiGraphChatJsonCodeBlocks(shortRoot, 'Chat app');
    enhanceUiGraphChatJsonCodeBlocks(longRoot, 'Chat app');

    assert.equal(shortRoot.querySelector('.rivet-web-app-chat-json-block-scrollable'), null);
    assert.equal(longRoot.querySelector('.rivet-web-app-chat-json-block-scrollable')?.tagName, 'DIV');
  } finally {
    dom.window.close();
  }
});

test('React and hosted renderers keep the same component and action behavior', async () => {
  const hostedClientScript = await loadGeneratedHostedClient();
  const reactDom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/preview' });
  const hostedDom = new JSDOM('<div id="app"></div>', {
    runScripts: 'outside-only',
    url: 'https://example.test/app',
  });
  const restoreGlobals = installDomGlobals(reactDom);
  const uiGraph = makeParityUiGraph();
  const reactAction = deferred<RivetWebAppActionResult>();
  const hostedAction = deferred<Response>();
  let reactActionState: Record<string, unknown> | undefined;
  let hostedActionState: Record<string, unknown> | undefined;
  const reactRootElement = reactDom.window.document.getElementById('root')!;
  const reactRoot = createRoot(reactRootElement);

  try {
    await act(async () => {
      reactRoot.render(
        <RivetWebAppRenderer
          uiGraph={uiGraph}
          onRunAction={(_componentId, state) => {
            reactActionState = state;
            return reactAction.promise;
          }}
        />,
      );
    });

    configureHostedRenderer(hostedDom, hostedClientScript, uiGraph, (state) => {
      hostedActionState = state;
      return hostedAction.promise;
    });

    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.equal(reactRootElement.querySelectorAll('.rivet-web-app-output-toggle').length, 0);
    assert.equal(hostedDom.window.document.querySelectorAll('.rivet-web-app-output-toggle').length, 0);

    await act(async () => {
      const input = reactRootElement.querySelector<HTMLInputElement>('.rivet-web-app-control')!;
      Object.getOwnPropertyDescriptor(reactDom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'Edited');
      Simulate.change(input);
    });
    setInputValue(
      hostedDom.window.document.querySelector<HTMLInputElement>('.rivet-web-app-control')!,
      'Edited',
      hostedDom,
    );
    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));

    await act(async () => {
      reactRootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button')[0]?.click();
    });
    hostedDom.window.document.querySelectorAll<HTMLButtonElement>('.rivet-web-app-button')[0]?.click();

    assert.deepEqual(reactActionState, { prompt: 'Edited', tone: '' });
    assert.deepEqual(hostedActionState, reactActionState);
    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.deepEqual(readButtonStates(reactRootElement), [
      { disabled: false, hasSpinner: false, text: 'First' },
      { disabled: false, hasSpinner: false, text: 'Second' },
    ]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.deepEqual(readButtonStates(reactRootElement), [
      { disabled: true, hasSpinner: true, text: 'First' },
      { disabled: false, hasSpinner: false, text: 'Second' },
    ]);

    const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    const statePatch = { image, result: { answer: 'Done' } };
    await act(async () => {
      reactAction.resolve({ outputs: {}, statePatch });
      await reactAction.promise;
    });
    hostedAction.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ outputs: {}, statePatch }),
    } as Response);
    await hostedAction.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.deepEqual(readRenderedImage(reactRootElement), {
      alt: 'Image',
      referrerPolicy: 'no-referrer',
      src: image,
    });
    assert.deepEqual(readRenderedImage(hostedDom.window.document), readRenderedImage(reactRootElement));
    assert.deepEqual(readButtonStates(reactRootElement), [
      { disabled: false, hasSpinner: false, text: 'First' },
      { disabled: false, hasSpinner: false, text: 'Second' },
    ]);
    assert.equal(
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-output-toggle')?.ariaExpanded,
      'true',
    );
    assert.equal(
      reactRootElement.querySelector('.rivet-web-app-output-content pre')?.textContent,
      '{\n  "answer": "Done"\n}',
    );
    assert.equal(
      reactRootElement
        .querySelector('.rivet-web-app-output-content pre')
        ?.classList.contains('rivet-web-app-output-json'),
      true,
    );
    assert.equal(
      hostedDom.window.document
        .querySelector('.rivet-web-app-output-content pre')
        ?.classList.contains('rivet-web-app-output-json'),
      true,
    );
    const firstExpandedOutput = reactRootElement.querySelector<HTMLElement>('.rivet-web-app-output');
    const outputHeader = firstExpandedOutput?.querySelector<HTMLElement>('.rivet-web-app-output-header');
    assert.equal(outputHeader?.tagName, 'BUTTON');
    assert.equal(outputHeader?.lastElementChild?.classList.contains('rivet-web-app-output-toggle-icon'), true);
    assert.equal(outputHeader?.querySelector('.rivet-web-app-output-action-button'), null);
    assert.equal(firstExpandedOutput?.querySelectorAll('.rivet-web-app-output-content-actions button').length, 2);

    await act(async () => {
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-output-toggle')?.click();
    });
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-output-toggle')?.click();
    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.equal(
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-output-toggle')?.ariaExpanded,
      'false',
    );
    const firstReactOutput = reactRootElement.querySelector<HTMLElement>('.rivet-web-app-output');
    assert.equal(firstReactOutput?.querySelector('.rivet-web-app-output-content'), null);
    assert.equal(firstReactOutput?.querySelectorAll('.rivet-web-app-output-action-button').length, 0);

    await act(async () => {
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-reset-button')?.click();
    });
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-reset-button')?.click();
    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.equal(reactRootElement.querySelector('.rivet-web-app-output-content'), null);
    assert.equal(hostedDom.window.document.querySelector('.rivet-web-app-output-content'), null);
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    reactDom.window.close();
    hostedDom.window.close();
  }
});

test('React and hosted Chat renderers submit scoped conversation and mapped page state', async () => {
  const hostedClientScript = await loadGeneratedHostedClient();
  const reactDom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/preview' });
  const hostedDom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only', url: 'https://example.test/app' });
  const restoreGlobals = installDomGlobals(reactDom);
  enableLegacyReactInputFocus(reactDom);
  const uiGraph = makeChatUiGraph();
  const reactAction = deferred<RivetWebAppActionResult>();
  const hostedAction = deferred<Response>();
  let reactActionState: Record<string, unknown> | undefined;
  let hostedActionState: Record<string, unknown> | undefined;
  const reactRootElement = reactDom.window.document.getElementById('root')!;
  const reactRoot = createRoot(reactRootElement);

  try {
    await act(async () => {
      reactRoot.render(
        <RivetWebAppRenderer
          uiGraph={uiGraph}
          onRunAction={(_componentId, state) => {
            reactActionState = state;
            return reactAction.promise;
          }}
        />,
      );
    });
    configureHostedRenderer(hostedDom, hostedClientScript, uiGraph, (state) => {
      hostedActionState = state;
      return hostedAction.promise;
    });

    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.equal(root.querySelector('.rivet-web-app-chat-empty')?.textContent, 'Start a conversation');
      assert.equal(root.querySelector('.rivet-web-app-chat-search-button'), null);
      assert.equal(root.querySelector('.rivet-web-app-chat-send svg')?.getAttribute('viewBox'), '0 0 24 24');
    }

    await act(async () => {
      const textarea = reactRootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!;
      Object.getOwnPropertyDescriptor(reactDom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        '**Hello**',
      );
      Simulate.change(textarea);
    });
    setTextareaValue(hostedDom.window.document, '**Hello**', hostedDom);
    focusReactControl(reactRootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!);
    hostedDom.window.document.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')?.focus();
    await act(async () => reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click());
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click();

    const messagesKey = getUiGraphChatMessagesStateKey('chat' as UiComponentId);
    assert.deepEqual(removeChatMessageTimestamps(reactActionState), {
      [messagesKey]: [{ role: 'user', content: '**Hello**' }],
      tone: 'Friendly',
    });
    assert.deepEqual(removeChatMessageTimestamps(hostedActionState), removeChatMessageTimestamps(reactActionState));
    for (const actionState of [reactActionState, hostedActionState]) {
      const timestamp = (actionState?.[messagesKey] as Array<{ timestamp?: unknown }> | undefined)?.[0]?.timestamp;
      assert.equal(typeof timestamp, 'string');
      assert.equal(Number.isNaN(new Date(timestamp as string).getTime()), false);
    }
    assert.deepEqual(readChatState(reactRootElement), readChatState(hostedDom.window.document));
    assert.deepEqual(readChatState(reactRootElement), {
      disabled: false,
      isStopControl: true,
      messages: ['Hello', ''],
    });
    assert.equal(isChatComposerFocused(reactDom.window.document), true);
    assert.equal(isChatComposerFocused(hostedDom.window.document), true);

    const statePatch = {
      [messagesKey]: [
        { role: 'user', content: '**Hello**' },
        { role: 'assistant', content: '**Hi!** <script>blocked()</script>' },
      ],
    };
    await act(async () => {
      reactAction.resolve({ outputs: {}, statePatch });
      await reactAction.promise;
    });
    hostedAction.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ outputs: {}, statePatch }),
    } as Response);
    await hostedAction.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(readChatState(reactRootElement), readChatState(hostedDom.window.document));
    assert.deepEqual(readChatState(reactRootElement), {
      disabled: true,
      isStopControl: false,
      messages: ['Hello', 'Hi! <script>blocked()</script>'],
    });
    for (const root of [reactRootElement, hostedDom.window.document]) {
      const messages = root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-message');
      assert.equal(messages[0]?.querySelector('strong')?.textContent, 'Hello');
      assert.equal(messages[1]?.querySelector('strong')?.textContent, 'Hi!');
      assert.equal(messages[1]?.querySelector('script'), null);
      assert.equal(messages[0]?.querySelector('time')?.textContent?.match(/^\d{2}:\d{2}$/) != null, true);
      assert.equal(messages[1]?.querySelector('time')?.textContent?.match(/^\d{2}:\d{2}$/) != null, true);
    }
    assert.equal(isChatComposerFocused(reactDom.window.document), true);
    assert.equal(isChatComposerFocused(hostedDom.window.document), true);

    await act(async () => reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click());
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click();
    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.equal(root.querySelector('.rivet-web-app-chat-pins-button')?.textContent, '1');
      assert.equal(root.querySelector('.rivet-web-app-chat-pin-button')?.getAttribute('aria-pressed'), 'true');
    }

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click();
    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.equal(root.querySelector('.rivet-web-app-chat-pin-exchange:first-child strong')?.textContent, 'You asked');
      assert.equal(root.querySelector('.rivet-web-app-chat-pins')?.textContent?.includes('Hello'), true);
      assert.equal(root.querySelector('.rivet-web-app-chat-pins')?.textContent?.includes('Hi!'), true);
    }

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')?.click();
    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.ok(root.querySelector('.rivet-web-app-chat-pins'));
      assert.ok(root.querySelector('.rivet-web-app-chat-menu'));
    }

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')?.click();

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click();

    await act(async () => reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click());
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click();
    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.equal(root.querySelector('.rivet-web-app-chat-pins-button'), null);
      assert.equal(root.querySelector('.rivet-web-app-chat-pins'), null);
      assert.equal(root.querySelector('.rivet-web-app-chat-pin-button')?.getAttribute('aria-label'), 'Pin response');
      assert.equal(root.querySelector('.rivet-web-app-chat-pin-button')?.classList.contains('active'), false);
    }

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-search-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-search-button')?.click();
    await act(async () => {
      const input = reactRootElement.querySelector<HTMLInputElement>('.rivet-web-app-chat-search-input')!;
      Object.getOwnPropertyDescriptor(reactDom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'h');
      Simulate.change(input);
    });
    setInputValue(
      hostedDom.window.document.querySelector<HTMLInputElement>('.rivet-web-app-chat-search-input')!,
      'h',
      hostedDom,
    );
    assert.deepEqual(readChatSearchState(reactRootElement), readChatSearchState(hostedDom.window.document));
    assert.deepEqual(readChatSearchState(reactRootElement), {
      activeCount: 1,
      count: '1\u2009/\u20092',
      matchCount: 2,
    });

    await act(async () =>
      reactRootElement.querySelectorAll<HTMLButtonElement>('.rivet-web-app-chat-search-navigation-button')[1]?.click(),
    );
    hostedDom.window.document
      .querySelectorAll<HTMLButtonElement>('.rivet-web-app-chat-search-navigation-button')[1]
      ?.click();
    assert.deepEqual(readChatSearchState(reactRootElement), readChatSearchState(hostedDom.window.document));
    assert.deepEqual(readChatSearchState(reactRootElement), {
      activeCount: 1,
      count: '2\u2009/\u20092',
      matchCount: 2,
    });

    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-search-close-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-search-close-button')?.click();
    assert.equal(reactRootElement.querySelector('.rivet-web-app-chat-search'), null);
    assert.equal(hostedDom.window.document.querySelector('.rivet-web-app-chat-search'), null);

    const reactSearchShortcut = new reactDom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyF',
      ctrlKey: true,
      key: '\u0430',
    });
    await act(async () => {
      reactRootElement
        .querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')
        ?.dispatchEvent(reactSearchShortcut);
    });
    const hostedSearchShortcut = new hostedDom.window.KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyF',
      ctrlKey: true,
      key: '\u0430',
    });
    hostedDom.window.document
      .querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')
      ?.dispatchEvent(hostedSearchShortcut);
    assert.equal(reactSearchShortcut.defaultPrevented, true);
    assert.equal(hostedSearchShortcut.defaultPrevented, true);
    assert.ok(reactRootElement.querySelector('.rivet-web-app-chat-search'));
    assert.ok(hostedDom.window.document.querySelector('.rivet-web-app-chat-search'));
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    reactDom.window.close();
    hostedDom.window.close();
  }
});

test('React and hosted Chat renderers keep timestamp and date-separator presentation in parity', async () => {
  const hostedClientScript = await loadGeneratedHostedClient();
  const reactDom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/preview' });
  const hostedDom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only', url: 'https://example.test/app' });
  const restoreGlobals = installDomGlobals(reactDom);
  const uiGraph = makeChatUiGraph();
  const messagesKey = getUiGraphChatMessagesStateKey('chat' as UiComponentId);
  const initialState = {
    ...getUiGraphInitialState(uiGraph),
    [messagesKey]: [
      { content: 'First', role: 'user', timestamp: '2026-07-20T12:00:00.000Z' },
      { content: 'Second', role: 'assistant', timestamp: '2026-07-21T12:00:00.000Z' },
      { content: 'Third', role: 'user', timestamp: '2026-07-22T12:00:00.000Z' },
    ],
  };
  const interactionController = createUiGraphInteractionController(uiGraph, { initialState });
  const reactRootElement = reactDom.window.document.getElementById('root')!;
  const reactRoot = createRoot(reactRootElement);

  try {
    await act(async () => {
      reactRoot.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          uiGraph={uiGraph}
          onRunAction={async () => {
            throw new Error('Timestamp presentation does not run a graph action.');
          }}
        />,
      );
    });
    configureHostedRenderer(
      hostedDom,
      hostedClientScript,
      uiGraph,
      async () => {
        throw new Error('Timestamp presentation does not run a graph action.');
      },
      initialState,
    );

    for (const root of [reactRootElement, hostedDom.window.document]) {
      assert.equal(root.querySelectorAll('.rivet-web-app-chat-message-time').length, 3);
      assert.equal(root.querySelectorAll('.rivet-web-app-chat-date-separator').length, 2);
    }
    assert.deepEqual(
      readChatTimestampPresentation(reactRootElement),
      readChatTimestampPresentation(hostedDom.window.document),
    );
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    reactDom.window.close();
    hostedDom.window.close();
  }
});

test('React and hosted Chat renderers add safe independent controls to every fenced JSON block', async () => {
  const hostedClientScript = await loadGeneratedHostedClient();
  const reactDom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/preview' });
  const hostedDom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only', url: 'https://example.test/app' });
  const reactCopies: string[] = [];
  const hostedCopies: string[] = [];
  const reactDownloads: Array<{ download: string; href: string }> = [];
  const hostedDownloads: Array<{ download: string; href: string }> = [];
  let reactActionState: Record<string, unknown> | undefined;
  let hostedActionState: Record<string, unknown> | undefined;
  Object.defineProperty(reactDom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => reactCopies.push(value) },
  });
  Object.defineProperty(hostedDom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => hostedCopies.push(value) },
  });
  const originalGlobalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalGlobalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  const originalHostedCreateObjectUrl = hostedDom.window.URL.createObjectURL;
  const originalHostedRevokeObjectUrl = hostedDom.window.URL.revokeObjectURL;
  const originalReactAnchorClick = reactDom.window.HTMLAnchorElement.prototype.click;
  const originalHostedAnchorClick = hostedDom.window.HTMLAnchorElement.prototype.click;
  globalThis.URL.createObjectURL = () => 'blob:react-json';
  globalThis.URL.revokeObjectURL = () => undefined;
  hostedDom.window.URL.createObjectURL = () => 'blob:hosted-json';
  hostedDom.window.URL.revokeObjectURL = () => undefined;
  reactDom.window.HTMLAnchorElement.prototype.click = function () {
    reactDownloads.push({ download: this.download, href: this.href });
  };
  hostedDom.window.HTMLAnchorElement.prototype.click = function () {
    hostedDownloads.push({ download: this.download, href: this.href });
  };
  const restoreGlobals = installDomGlobals(reactDom);
  const uiGraph = makeChatUiGraph();
  const messagesKey = getUiGraphChatMessagesStateKey('chat' as UiComponentId);
  const unicodeName = '\u0416\u0435\u043d\u044f';
  const userJson = ['User data:', '', '```json', '{', `  "name": "${unicodeName}"`, '}', '```'].join('\n');
  const assistantJson = [
    'Generated files:',
    '',
    '```json',
    '{',
    '  "html": "<button onclick=\\"bad()\\">not interactive</button>"',
    '}',
    '```',
    '',
    '```javascript',
    'console.log("ordinary code");',
    '```',
    '',
    '```json',
    '[1, 2, 3]',
    '```',
    '',
    '<button onclick="bad()">author button</button>',
  ].join('\n');
  const initialState = {
    ...getUiGraphInitialState(uiGraph),
    [messagesKey]: [
      { content: userJson, role: 'user' },
      { content: assistantJson, role: 'assistant' },
    ],
  };
  const interactionController = createUiGraphInteractionController(uiGraph, { initialState });
  const reactRootElement = reactDom.window.document.getElementById('root')!;
  const reactRoot = createRoot(reactRootElement);

  try {
    await act(async () => {
      reactRoot.render(
        <RivetWebAppRenderer
          interactionController={interactionController}
          uiGraph={uiGraph}
          onRunAction={async (_componentId, state) => {
            reactActionState = state;
            return { outputs: {} };
          }}
        />,
      );
    });
    configureHostedRenderer(
      hostedDom,
      hostedClientScript,
      uiGraph,
      async (state) => {
        hostedActionState = state;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ outputs: {} }),
        } as Response;
      },
      initialState,
    );

    for (const root of [reactRootElement, hostedDom.window.document]) {
      const messages = root.querySelectorAll('.rivet-web-app-chat-message-markdown');
      assert.equal(messages[0]?.querySelectorAll('.rivet-web-app-chat-json-block').length, 1);
      assert.equal(messages[1]?.querySelectorAll('.rivet-web-app-chat-json-block').length, 2);
      assert.equal(messages[1]?.querySelectorAll('pre > code.language-javascript').length, 1);
      assert.equal(messages[1]?.querySelectorAll('.rivet-web-app-chat-json-actions button').length, 4);
      assert.equal(messages[1]?.querySelector('button:not(.rivet-web-app-output-action-button)'), null);
      assert.deepEqual(
        [...messages[1]!.querySelectorAll('.rivet-web-app-chat-json-actions button')].map((button) =>
          button.getAttribute('aria-label'),
        ),
        ['Copy JSON', 'Download JSON', 'Copy JSON', 'Download JSON'],
      );
      assert.equal(
        messages[1]?.querySelector('pre > code.language-json')?.textContent,
        '{\n  "html": "<button onclick=\\"bad()\\">not interactive</button>"\n}\n',
      );
    }

    await act(async () => {
      reactRootElement.querySelector<HTMLButtonElement>('[aria-label="Copy JSON"]')?.click();
      await Promise.resolve();
    });
    hostedDom.window.document.querySelector<HTMLButtonElement>('[aria-label="Copy JSON"]')?.click();
    await Promise.resolve();
    assert.deepEqual(reactCopies, [`{\n  "name": "${unicodeName}"\n}\n`]);
    assert.deepEqual(hostedCopies, reactCopies);

    reactRootElement.querySelector<HTMLButtonElement>('[aria-label="Download JSON"]')?.click();
    hostedDom.window.document.querySelector<HTMLButtonElement>('[aria-label="Download JSON"]')?.click();
    assert.equal(reactDownloads.length, 1);
    assert.equal(hostedDownloads.length, 1);
    assert.match(reactDownloads[0]!.download, /^Chat app \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.json$/);
    assert.match(hostedDownloads[0]!.download, /^Chat app \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.json$/);
    assert.equal(reactDownloads[0]!.href, 'blob:react-json');
    assert.equal(hostedDownloads[0]!.href, 'blob:hosted-json');

    await act(async () => reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click());
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pin-button')?.click();
    await act(async () =>
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click(),
    );
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-pins-button')?.click();

    for (const root of [reactRootElement, hostedDom.window.document]) {
      const pin = root.querySelector('.rivet-web-app-chat-pin');
      assert.equal(pin?.querySelectorAll('.rivet-web-app-chat-json-block').length, 0);
      assert.equal(pin?.querySelectorAll('pre > code.language-json').length, 3);
      assert.equal(pin?.querySelectorAll('.rivet-web-app-chat-json-actions').length, 0);
      assert.equal(pin?.querySelector(':scope > .rivet-web-app-chat-pin-reveal')?.tagName, 'BUTTON');
    }

    await act(async () => {
      const textarea = reactRootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!;
      Object.getOwnPropertyDescriptor(reactDom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Please revise it',
      );
      Simulate.change(textarea);
    });
    await act(async () => {
      reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click();
      await Promise.resolve();
    });
    setTextareaValue(hostedDom.window.document, 'Please revise it', hostedDom);
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click();
    await Promise.resolve();

    const expectedHistory = [
      { content: userJson, role: 'user' },
      { content: assistantJson, role: 'assistant' },
      { content: 'Please revise it', role: 'user' },
    ];
    assert.deepEqual(removeChatMessageTimestamps(reactActionState)?.[messagesKey], expectedHistory);
    assert.deepEqual(removeChatMessageTimestamps(hostedActionState)?.[messagesKey], expectedHistory);
  } finally {
    await act(async () => reactRoot.unmount());
    globalThis.URL.createObjectURL = originalGlobalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalGlobalRevokeObjectUrl;
    hostedDom.window.URL.createObjectURL = originalHostedCreateObjectUrl;
    hostedDom.window.URL.revokeObjectURL = originalHostedRevokeObjectUrl;
    reactDom.window.HTMLAnchorElement.prototype.click = originalReactAnchorClick;
    hostedDom.window.HTMLAnchorElement.prototype.click = originalHostedAnchorClick;
    restoreGlobals();
    reactDom.window.close();
    hostedDom.window.close();
  }
});

function configureHostedRenderer(
  dom: JSDOM,
  clientScript: string,
  uiGraph: UiGraph,
  runAction: (state: Record<string, unknown>) => Promise<Response>,
  initialState: Record<string, unknown> = getUiGraphInitialState(uiGraph),
): void {
  const hostedWindow = dom.window as typeof dom.window & {
    DOMPurify?: ReturnType<typeof createDOMPurify>;
    __RIVET_WEB_APP__?: unknown;
    marked?: { Renderer: typeof Renderer; parse: typeof marked };
  };
  hostedWindow.DOMPurify = createDOMPurify(hostedWindow);
  hostedWindow.marked = { Renderer, parse: marked };
  hostedWindow.__RIVET_WEB_APP__ = {
    actionPath: '/actions/run',
    initialState,
    markdownSanitizerPolicy: RIVET_MARKDOWN_SANITIZER_POLICY,
    uiGraph,
  };
  hostedWindow.fetch = async (_input, init) => {
    const body = JSON.parse(`${init?.body ?? '{}'}`) as { state: Record<string, unknown> };
    return runAction(body.state);
  };
  hostedWindow.eval(clientScript);
}

function readRenderedComponents(root: ParentNode): unknown[] {
  return [...root.querySelectorAll<HTMLElement>('.rivet-web-app-component-frame')].map((frame) => {
    const content = frame.firstElementChild as HTMLElement;
    const control = content.querySelector<HTMLInputElement | HTMLTextAreaElement>('.rivet-web-app-control');
    const dropdown = content.querySelector<HTMLElement>('[data-rivet-dropdown-value]');
    const markdown = content.matches('.rivet-web-app-markdown, .rivet-web-app-output-markdown')
      ? content
      : content.querySelector<HTMLElement>('.rivet-web-app-output-markdown');
    const button = content.matches('button') ? (content as HTMLButtonElement) : undefined;

    return {
      ariaHidden: content.getAttribute('aria-hidden'),
      className: content.className,
      componentType: frame.dataset.rivetWebAppComponentType,
      control: control
        ? {
            placeholder: 'placeholder' in control ? control.placeholder : undefined,
            tagName: control.tagName.toLowerCase(),
            value: control.value,
          }
        : dropdown
          ? { tagName: 'dropdown', value: dropdown.dataset.rivetDropdownValue }
          : undefined,
      disabled: button?.disabled,
      markdownHtml: markdown?.innerHTML,
      image: readRenderedImage(content),
      outputActions: [...content.querySelectorAll<HTMLButtonElement>('.rivet-web-app-output-action-button')].map(
        (action) => ({ ariaLabel: action.ariaLabel, className: action.className, title: action.title }),
      ),
      tagName: content.tagName.toLowerCase(),
      text: dropdown ? `Dropdown:${dropdown.dataset.rivetDropdownValue ?? ''}` : content.textContent,
    };
  });
}

function readRenderedImage(
  root: ParentNode,
): { alt: string; referrerPolicy: string | null; src: string | null } | undefined {
  const image = root.querySelector<HTMLImageElement>('.rivet-web-app-output-image');
  return image
    ? {
        alt: image.alt,
        referrerPolicy: image.getAttribute('referrerpolicy'),
        src: image.getAttribute('src'),
      }
    : undefined;
}

function setInputValue(input: HTMLInputElement, value: string, dom: JSDOM): void {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function setTextareaValue(root: ParentNode, value: string, dom: JSDOM): void {
  const textarea = root.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function readChatState(root: ParentNode): { disabled: boolean; isStopControl: boolean; messages: string[] } {
  const sendButton = root.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send');
  return {
    disabled: sendButton?.disabled ?? false,
    isStopControl: sendButton?.classList.contains('rivet-web-app-chat-stop') ?? false,
    messages: [...root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-message')].map((message) =>
      (message.querySelector('.rivet-web-app-chat-message-markdown')?.textContent ?? '').trimEnd(),
    ),
  };
}

function readChatTimestampPresentation(root: ParentNode): { dateSeparators: string[]; times: string[] } {
  return {
    dateSeparators: [...root.querySelectorAll('.rivet-web-app-chat-date-separator')].map(
      (separator) => separator.textContent ?? '',
    ),
    times: [...root.querySelectorAll('.rivet-web-app-chat-message-time')].map((time) => time.textContent ?? ''),
  };
}

function removeChatMessageTimestamps(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!state) return state;

  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((message) => {
            if (!message || typeof message !== 'object') return message;
            const { timestamp: _timestamp, ...rest } = message as Record<string, unknown>;
            return rest;
          })
        : value,
    ]),
  );
}

function readChatSearchState(root: ParentNode): { activeCount: number; count: string | null; matchCount: number } {
  return {
    activeCount: root.querySelectorAll('.rivet-web-app-chat-search-match-active').length,
    count: root.querySelector('.rivet-web-app-chat-search-count')?.textContent ?? null,
    matchCount: root.querySelectorAll('.rivet-web-app-chat-search-match').length,
  };
}

function isChatComposerFocused(document: Document): boolean {
  return document.activeElement?.matches('.rivet-web-app-chat-composer textarea') ?? false;
}

function focusReactControl(element: HTMLElement): void {
  const legacyFocusElement = element as HTMLElement & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };
  legacyFocusElement.attachEvent ??= () => undefined;
  legacyFocusElement.detachEvent ??= () => undefined;
  element.focus();
}

function enableLegacyReactInputFocus(dom: JSDOM): void {
  const prototype = dom.window.HTMLInputElement.prototype as HTMLInputElement & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };
  prototype.attachEvent ??= () => undefined;
  prototype.detachEvent ??= () => undefined;
}

function readButtonStates(root: ParentNode): Array<{ disabled: boolean; hasSpinner: boolean; text: string | null }> {
  return [...root.querySelectorAll<HTMLButtonElement>('.rivet-web-app-component-frame .rivet-web-app-button')].map(
    (button) => ({
      disabled: button.disabled,
      hasSpinner: button.querySelector('.rivet-web-app-running-indicator') != null,
      text: button.textContent,
    }),
  );
}

function makeParityUiGraph(): UiGraph {
  const action = {
    inputMappings: [
      { inputKey: 'prompt', stateKey: 'prompt' },
      { inputKey: 'tone', stateKey: 'tone' },
    ],
    outputs: [
      { outputKey: 'result', stateKey: 'result' },
      { outputKey: 'image', stateKey: 'image' },
    ],
    type: 'runGraph' as const,
  };
  return {
    components: [
      { id: 'text' as UiComponentId, text: 'Plain text', type: 'text' },
      { id: 'markdown' as UiComponentId, markdown: '## Markdown\n\n**Safe**', type: 'markdown' },
      { id: 'gap' as UiComponentId, size: 'small', type: 'gap' },
      {
        defaultValue: '',
        id: 'input' as UiComponentId,
        label: 'Prompt',
        placeholder: 'Type here',
        stateKey: 'prompt',
        type: 'input',
      },
      { id: 'textarea' as UiComponentId, label: 'Notes', stateKey: 'notes', type: 'textarea' },
      {
        id: 'dropdown' as UiComponentId,
        items: [
          { label: 'Friendly', value: 'friendly' },
          { label: 'Direct', value: 'direct' },
        ],
        label: 'Tone',
        stateKey: 'tone',
        type: 'dropdown',
      },
      { action, id: 'first-button' as UiComponentId, label: 'First', type: 'button' },
      { action, id: 'second-button' as UiComponentId, label: 'Second', type: 'button' },
      { id: 'output' as UiComponentId, label: 'Result', renderAs: 'json', stateKey: 'result', type: 'output' },
      { id: 'image' as UiComponentId, label: 'Image', renderAs: 'image', stateKey: 'image', type: 'output' },
      { id: 'prompt-output' as UiComponentId, label: 'Prompt output', stateKey: 'prompt', type: 'output' },
    ],
    id: 'parity-app' as UiGraphId,
    name: 'Parity app',
  };
}

function makeChatUiGraph(): UiGraph {
  return {
    components: [
      {
        defaultValue: 'Friendly',
        id: 'tone' as UiComponentId,
        label: 'Tone',
        stateKey: 'tone',
        type: 'input',
      },
      {
        action: {
          graphId: 'graph' as never,
          historyInputId: 'history',
          inputMappings: [{ inputKey: 'tone', stateKey: 'tone' }],
          responseOutputId: 'response',
          type: 'runGraph',
          userInputId: 'message',
        },
        id: 'chat' as UiComponentId,
        type: 'chat',
      },
    ],
    id: 'chat-app' as UiGraphId,
    name: 'Chat app',
  };
}

function installDomGlobals(dom: JSDOM): () => void {
  const previous = {
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

  return () => {
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previous.document },
      HTMLElement: { configurable: true, value: previous.HTMLElement },
      navigator: { configurable: true, value: previous.navigator },
      window: { configurable: true, value: previous.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

async function loadGeneratedHostedClient(): Promise<string> {
  const moduleUrl = new URL('../../../../node/src/generated/webAppClient.generated.ts', import.meta.url).href;
  const generatedModule = (await import(moduleUrl)) as { RIVET_WEB_APP_CLIENT_JS?: unknown };
  if (typeof generatedModule.RIVET_WEB_APP_CLIENT_JS !== 'string') {
    throw new Error('Generated hosted web-app client does not export RIVET_WEB_APP_CLIENT_JS.');
  }
  return generatedModule.RIVET_WEB_APP_CLIENT_JS;
}
