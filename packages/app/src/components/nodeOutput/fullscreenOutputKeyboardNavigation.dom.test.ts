import assert from 'node:assert/strict';
import test from 'node:test';
import { type DOMWindow, JSDOM } from 'jsdom';
import { createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { OUTPUT_NAVIGATION_ITEM_ATTRIBUTE } from '../renderDataValue/outputNavigationItems.js';
import {
  getFullscreenOutputNavigationItemTopOffsets,
  installFullscreenOutputKeyboardNavigation,
  useFullscreenOutputKeyboardNavigation,
} from './fullscreenOutputKeyboardNavigation.js';

test('fullscreen output navigation captures keys from a focused pager outside the scroll surface', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const document = window.document;
  const root = document.createElement('div');
  const scrollContainer = document.createElement('div');
  scrollContainer.style.overflowY = 'auto';
  setMetric(scrollContainer, 'clientHeight', 300);
  setMetric(scrollContainer, 'scrollHeight', 1_000);
  setRect(scrollContainer, 10, 300);

  const header = document.createElement('header');
  header.className = 'fullscreen-header';
  const pagerButton = document.createElement('button');
  header.append(pagerButton);
  setRect(header, 10, 50);

  const outputBody = document.createElement('div');
  outputBody.className = 'fullscreen-output-body';
  const response = document.createElement('div');
  response.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(response, 210, 80);
  const nestedResponse = document.createElement('div');
  nestedResponse.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(nestedResponse, 410, 80);
  response.append(nestedResponse);
  outputBody.append(response);
  scrollContainer.append(outputBody);
  root.append(header, scrollContainer);
  document.body.append(root);

  const cleanup = installFullscreenOutputKeyboardNavigation(outputBody, root);
  pagerButton.focus();
  assert.equal(document.activeElement, pagerButton);
  const pageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  pagerButton.dispatchEvent(pageDown);

  assert.equal(pageDown.defaultPrevented, true);
  assert.equal(scrollContainer.scrollTop, 400);

  scrollContainer.scrollTop = 0;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  header.append(checkbox);
  checkbox.focus();
  assert.equal(document.activeElement, checkbox);
  const checkboxPageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  checkbox.dispatchEvent(checkboxPageDown);
  assert.equal(checkboxPageDown.defaultPrevented, true);
  assert.equal(scrollContainer.scrollTop, 400);

  scrollContainer.scrollTop = 0;
  const input = document.createElement('input');
  header.append(input);
  input.focus();
  assert.equal(document.activeElement, input);
  const editablePageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  input.dispatchEvent(editablePageDown);
  assert.equal(editablePageDown.defaultPrevented, false);
  assert.equal(scrollContainer.scrollTop, 0);

  const unrelatedButton = document.createElement('button');
  document.body.append(unrelatedButton);
  const unrelatedPageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  unrelatedButton.dispatchEvent(unrelatedPageDown);
  assert.equal(unrelatedPageDown.defaultPrevented, false);
  assert.equal(scrollContainer.scrollTop, 0);

  cleanup();
});

test('fullscreen output navigation animates repeated keyboard steps to their intended response items', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const animationClock = installAnimationFrameClock(window);
  const document = window.document;
  const root = document.createElement('div');
  const scrollContainer = document.createElement('div');
  scrollContainer.style.overflowY = 'auto';
  setMetric(scrollContainer, 'clientHeight', 300);
  setMetric(scrollContainer, 'scrollHeight', 1_000);
  setRect(scrollContainer, 10, 300);

  const pagerButton = document.createElement('button');
  const outputBody = document.createElement('div');
  outputBody.className = 'fullscreen-output-body';
  const firstResponse = document.createElement('div');
  firstResponse.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(firstResponse, 210, 80);
  const secondResponse = document.createElement('div');
  secondResponse.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(secondResponse, 410, 80);
  outputBody.append(firstResponse, secondResponse);
  scrollContainer.append(outputBody);
  root.append(pagerButton, scrollContainer);
  document.body.append(root);

  const cleanup = installFullscreenOutputKeyboardNavigation(outputBody, root);
  pagerButton.focus();
  const firstPageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  const secondPageDown = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' });
  pagerButton.dispatchEvent(firstPageDown);
  pagerButton.dispatchEvent(secondPageDown);

  assert.equal(firstPageDown.defaultPrevented, true);
  assert.equal(secondPageDown.defaultPrevented, true);
  assert.equal(scrollContainer.scrollTop, 0);

  animationClock.runNext(0);
  animationClock.runNext(90);
  assert.ok(scrollContainer.scrollTop > 0 && scrollContainer.scrollTop < 400);
  animationClock.runNext(180);
  assert.equal(scrollContainer.scrollTop, 400);

  cleanup();
});

test('fullscreen output navigation still animates when the browser prefers reduced motion', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const animationClock = installAnimationFrameClock(window);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  });
  const document = window.document;
  const root = document.createElement('div');
  const scrollContainer = document.createElement('div');
  scrollContainer.style.overflowY = 'auto';
  setMetric(scrollContainer, 'clientHeight', 300);
  setMetric(scrollContainer, 'scrollHeight', 1_000);
  setRect(scrollContainer, 10, 300);

  const pagerButton = document.createElement('button');
  const outputBody = document.createElement('div');
  outputBody.className = 'fullscreen-output-body';
  const response = document.createElement('div');
  response.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(response, 410, 80);
  outputBody.append(response);
  scrollContainer.append(outputBody);
  root.append(pagerButton, scrollContainer);
  document.body.append(root);

  const cleanup = installFullscreenOutputKeyboardNavigation(outputBody, root);
  pagerButton.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' }));

  assert.equal(scrollContainer.scrollTop, 0);
  animationClock.runNext(0);
  animationClock.runNext(180);
  assert.equal(scrollContainer.scrollTop, 400);

  cleanup();
});

test('fullscreen output navigation keeps an in-flight keyboard animation through an ordinary render', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { pretendToBeVisual: true });
  const animationClock = installAnimationFrameClock(dom.window);
  const restoreGlobals = installDomGlobals(dom);
  const reactRoot = createRoot(dom.window.document.getElementById('app')!);

  try {
    await renderKeyboardNavigationHarness(reactRoot, true);
    animationClock.runNext(0);
    const controls = configureKeyboardNavigationHarness(dom.window.document);
    controls.pagerButton.dispatchEvent(pageDown(dom));

    await renderKeyboardNavigationHarness(reactRoot, true);
    animationClock.runNext(0);
    animationClock.runNext(180);

    assert.equal(controls.scrollContainer.scrollTop, 400);
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test('fullscreen output navigation rebinds when an empty output temporarily remounts its DOM', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { pretendToBeVisual: true });
  const restoreGlobals = installDomGlobals(dom);
  const reactRoot = createRoot(dom.window.document.getElementById('app')!);

  try {
    await renderKeyboardNavigationHarness(reactRoot, true);
    const firstControls = configureKeyboardNavigationHarness(dom.window.document);
    firstControls.pagerButton.dispatchEvent(pageDown(dom));
    await waitForScrollTop(firstControls.scrollContainer, 400, dom.window);
    assert.equal(firstControls.scrollContainer.scrollTop, 400);

    await renderKeyboardNavigationHarness(reactRoot, false);
    await renderKeyboardNavigationHarness(reactRoot, true);
    const secondControls = configureKeyboardNavigationHarness(dom.window.document);
    const afterRemount = pageDown(dom);
    secondControls.pagerButton.dispatchEvent(afterRemount);

    assert.equal(afterRemount.defaultPrevented, true);
    await waitForScrollTop(secondControls.scrollContainer, 400, dom.window);
    assert.equal(secondControls.scrollContainer.scrollTop, 400);
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test('fullscreen output navigation does not retake focus after an ordinary render', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { pretendToBeVisual: true });
  const restoreGlobals = installDomGlobals(dom);
  const reactRoot = createRoot(dom.window.document.getElementById('app')!);

  try {
    await renderKeyboardNavigationHarness(reactRoot, true);
    await nextAnimationFrame(dom.window);
    const navigationRoot = dom.window.document.querySelector<HTMLElement>('#app > div')!;
    assert.equal(dom.window.document.activeElement, navigationRoot);

    const outsideInput = dom.window.document.createElement('input');
    dom.window.document.body.append(outsideInput);
    outsideInput.focus();
    assert.equal(dom.window.document.activeElement, outsideInput);

    await renderKeyboardNavigationHarness(reactRoot, true);
    await nextAnimationFrame(dom.window);

    assert.equal(dom.window.document.activeElement, outsideInput);
  } finally {
    await act(async () => reactRoot.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test('navigation items prefer visible leaf markers and fall back to visible direct output children', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const outputBody = window.document.createElement('div');
  const parent = window.document.createElement('div');
  parent.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(parent, 100, 100);
  const leaf = window.document.createElement('div');
  leaf.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(leaf, 250, 100);
  parent.append(leaf);
  outputBody.append(parent);

  assert.deepEqual(getFullscreenOutputNavigationItemTopOffsets(outputBody, { scrollTop: 20, top: 10 }), [260]);

  leaf.remove();
  parent.removeAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE);
  assert.deepEqual(getFullscreenOutputNavigationItemTopOffsets(outputBody, { scrollTop: 20, top: 10 }), [110]);
});

test('navigation ignores items clipped inside a collapsed output section', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const outputBody = window.document.createElement('div');
  const visibleResponse = window.document.createElement('div');
  visibleResponse.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(visibleResponse, 100, 80);

  const collapsedSection = window.document.createElement('div');
  collapsedSection.style.overflowY = 'hidden';
  setRect(collapsedSection, 200, 0);
  const hiddenResponse = window.document.createElement('div');
  hiddenResponse.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(hiddenResponse, 200, 80);
  collapsedSection.append(hiddenResponse);
  outputBody.append(visibleResponse, collapsedSection);

  assert.deepEqual(getFullscreenOutputNavigationItemTopOffsets(outputBody, { scrollTop: 0, top: 0 }), [100]);
});

test('navigation keeps expanded output items below the app viewport as PageUp and PageDown targets', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const applicationViewport = window.document.createElement('div');
  applicationViewport.style.overflowY = 'hidden';
  setRect(applicationViewport, 0, 300);

  const outputBody = window.document.createElement('div');
  const section = window.document.createElement('div');
  section.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(section, 100, 1_000);

  const expandedContent = window.document.createElement('div');
  expandedContent.style.overflowY = 'hidden';
  setRect(expandedContent, 150, 900);
  const firstMessage = window.document.createElement('div');
  firstMessage.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(firstMessage, 200, 80);
  const laterMessage = window.document.createElement('div');
  laterMessage.setAttribute(OUTPUT_NAVIGATION_ITEM_ATTRIBUTE, '');
  setRect(laterMessage, 500, 80);

  expandedContent.append(firstMessage, laterMessage);
  section.append(expandedContent);
  outputBody.append(section);
  applicationViewport.append(outputBody);
  window.document.body.append(applicationViewport);

  assert.deepEqual(getFullscreenOutputNavigationItemTopOffsets(outputBody, { scrollTop: 0, top: 0 }), [200, 500]);
});

function setMetric(element: HTMLElement, property: 'clientHeight' | 'scrollHeight', value: number): void {
  Object.defineProperty(element, property, { configurable: true, value });
}

function setRect(element: HTMLElement, top: number, height: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left: 0,
      right: 100,
      top,
      width: 100,
    }),
  });
}

function KeyboardNavigationHarness({ visible }: { visible: boolean }) {
  const outputBodyRef = useRef<HTMLDivElement>(null);
  const navigationRootRef = useRef<HTMLDivElement>(null);
  useFullscreenOutputKeyboardNavigation(outputBodyRef, navigationRootRef);

  if (!visible) {
    return null;
  }

  return createElement(
    'div',
    { ref: navigationRootRef, tabIndex: -1 },
    createElement('header', null, createElement('button', { type: 'button' }, 'Pager')),
    createElement(
      'div',
      { style: { overflowY: 'auto' } },
      createElement(
        'div',
        { ref: outputBodyRef, className: 'fullscreen-output-body' },
        createElement('div', { [OUTPUT_NAVIGATION_ITEM_ATTRIBUTE]: '' }, 'Response'),
      ),
    ),
  );
}

async function renderKeyboardNavigationHarness(reactRoot: ReturnType<typeof createRoot>, visible: boolean): Promise<void> {
  await act(async () => reactRoot.render(createElement(KeyboardNavigationHarness, { visible })));
}

function configureKeyboardNavigationHarness(document: Document): {
  pagerButton: HTMLButtonElement;
  scrollContainer: HTMLDivElement;
} {
  const pagerButton = document.querySelector<HTMLButtonElement>('button')!;
  const scrollContainer = document.querySelector<HTMLDivElement>('div[style]')!;
  const response = document.querySelector<HTMLElement>(`[${OUTPUT_NAVIGATION_ITEM_ATTRIBUTE}]`)!;
  setMetric(scrollContainer, 'clientHeight', 300);
  setMetric(scrollContainer, 'scrollHeight', 1_000);
  setRect(scrollContainer, 10, 300);
  setRect(response, 410, 80);
  return { pagerButton, scrollContainer };
}

function pageDown(dom: JSDOM): KeyboardEvent {
  return new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'PageDown' }) as unknown as KeyboardEvent;
}

function installAnimationFrameClock(window: DOMWindow): { runNext: (timestamp: number) => void } {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  Object.defineProperties(window, {
    cancelAnimationFrame: {
      configurable: true,
      value: (frameId: number) => frames.delete(frameId),
    },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        const frameId = nextFrameId + 1;
        nextFrameId = frameId;
        frames.set(frameId, callback);
        return frameId;
      },
    },
  });

  return {
    runNext: (timestamp) => {
      const nextFrame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      assert.ok(nextFrame, 'expected a pending animation frame');
      frames.delete(nextFrame[0]);
      nextFrame[1](timestamp);
    },
  };
}

function nextAnimationFrame(window: DOMWindow): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitForScrollTop(element: HTMLElement, expectedScrollTop: number, window: DOMWindow): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (element.scrollTop === expectedScrollTop) {
      return;
    }

    await nextAnimationFrame(window);
  }

  assert.equal(element.scrollTop, expectedScrollTop);
}

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ['document', 'Element', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previousDescriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
