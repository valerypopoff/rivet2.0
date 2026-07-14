import assert from 'node:assert/strict';
import test from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { marked, Renderer } from 'marked';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import {
  getUiGraphInitialState,
  getUiGraphChatMessagesStateKey,
  RIVET_MARKDOWN_SANITIZER_POLICY,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { RivetWebAppRenderer, type RivetWebAppActionResult } from './RivetWebAppRenderer.js';

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

    assert.deepEqual(reactActionState, { prompt: 'Edited' });
    assert.deepEqual(hostedActionState, reactActionState);
    assert.deepEqual(readRenderedComponents(reactRootElement), readRenderedComponents(hostedDom.window.document));
    assert.deepEqual(readButtonStates(reactRootElement), [
      { disabled: true, text: 'Running...' },
      { disabled: false, text: 'Second' },
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
      { disabled: false, text: 'First' },
      { disabled: false, text: 'Second' },
    ]);
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

    await act(async () => {
      const textarea = reactRootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!;
      Object.getOwnPropertyDescriptor(reactDom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Hello',
      );
      Simulate.change(textarea);
    });
    setTextareaValue(hostedDom.window.document, 'Hello', hostedDom);
    focusReactControl(reactRootElement.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')!);
    hostedDom.window.document.querySelector<HTMLTextAreaElement>('.rivet-web-app-chat-composer textarea')?.focus();
    await act(async () => reactRootElement.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click());
    hostedDom.window.document.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.click();

    const messagesKey = getUiGraphChatMessagesStateKey('chat' as UiComponentId);
    assert.deepEqual(reactActionState, {
      [messagesKey]: [{ role: 'user', content: 'Hello' }],
      tone: 'Friendly',
    });
    assert.deepEqual(hostedActionState, reactActionState);
    assert.deepEqual(readChatState(reactRootElement), readChatState(hostedDom.window.document));
    assert.deepEqual(readChatState(reactRootElement), {
      disabled: true,
      messages: ['Hello', ''],
      status: 'Responding',
    });
    assert.equal(isChatComposerFocused(reactDom.window.document), true);
    assert.equal(isChatComposerFocused(hostedDom.window.document), true);

    const statePatch = {
      [messagesKey]: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
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
      messages: ['Hello', 'Hi!'],
      status: 'Ready',
    });
    assert.equal(isChatComposerFocused(reactDom.window.document), true);
    assert.equal(isChatComposerFocused(hostedDom.window.document), true);
  } finally {
    await act(async () => reactRoot.unmount());
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
    initialState: getUiGraphInitialState(uiGraph),
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
    const markdown = content.matches('.rivet-web-app-markdown, .rivet-web-app-output-markdown')
      ? content
      : content.querySelector<HTMLElement>('.rivet-web-app-output-markdown');
    const button = content.matches('button') ? (content as HTMLButtonElement) : undefined;

    return {
      ariaHidden: content.getAttribute('aria-hidden'),
      className: content.className,
      componentType: frame.dataset.rivetWebAppComponentType,
      control: control
        ? { placeholder: control.placeholder, tagName: control.tagName.toLowerCase(), value: control.value }
        : undefined,
      disabled: button?.disabled,
      markdownHtml: markdown?.innerHTML,
      image: readRenderedImage(content),
      outputActions: [...content.querySelectorAll<HTMLButtonElement>('.rivet-web-app-output-action-button')].map(
        (action) => ({ ariaLabel: action.ariaLabel, className: action.className, title: action.title }),
      ),
      tagName: content.tagName.toLowerCase(),
      text: content.textContent,
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

function readChatState(root: ParentNode): { disabled: boolean; messages: string[]; status: string | null } {
  return {
    disabled: root.querySelector<HTMLButtonElement>('.rivet-web-app-chat-send')?.disabled ?? false,
    messages: [...root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-message')].map(
      (message) => message.textContent ?? '',
    ),
    status: root.querySelector('.rivet-web-app-chat-status')?.textContent ?? null,
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

function readButtonStates(root: ParentNode): Array<{ disabled: boolean; text: string | null }> {
  return [...root.querySelectorAll<HTMLButtonElement>('.rivet-web-app-component-frame > .rivet-web-app-button')].map(
    (button) => ({ disabled: button.disabled, text: button.textContent }),
  );
}

function makeParityUiGraph(): UiGraph {
  const action = {
    inputMappings: [{ inputKey: 'prompt', stateKey: 'prompt' }],
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
        defaultValue: 'Hello',
        id: 'input' as UiComponentId,
        label: 'Prompt',
        placeholder: 'Type here',
        stateKey: 'prompt',
        type: 'input',
      },
      { id: 'textarea' as UiComponentId, label: 'Notes', stateKey: 'notes', type: 'textarea' },
      { action, id: 'first-button' as UiComponentId, label: 'First', type: 'button' },
      { action, id: 'second-button' as UiComponentId, label: 'Second', type: 'button' },
      { id: 'output' as UiComponentId, label: 'Result', renderAs: 'json', stateKey: 'result', type: 'output' },
      { id: 'image' as UiComponentId, label: 'Image', renderAs: 'image', stateKey: 'image', type: 'output' },
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
