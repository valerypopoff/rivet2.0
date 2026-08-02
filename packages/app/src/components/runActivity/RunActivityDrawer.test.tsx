import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { GraphId, GraphRunId, NodeId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import {
  MAX_RUN_ACTIVITY_DRAWER_VIEWPORT_RATIO,
  MIN_RUN_ACTIVITY_DRAWER_HEIGHT,
  RunActivityDrawer,
  clampRunActivityDrawerHeight,
} from './RunActivityDrawer.js';
import type { RunActivityItemViewModel, RunActivityViewModel } from './types.js';

const ITEMS: RunActivityItemViewModel[] = [
  {
    activityKey: 'root:graph:model:process',
    identity: identity('main', 'model', 'model-process'),
    sequence: 1,
    graphId: 'main' as GraphId,
    graphName: 'Main graph',
    nodeTitle: 'Answer user',
    nodeType: 'LLM Chat',
    status: 'success',
    category: 'model',
    provider: 'OpenAI',
    model: 'gpt-test',
    preview: 'A large response that is deliberately not searchable.',
    navigable: true,
    fullOutputAvailable: true,
    inspectable: true,
    resultOrigin: 'executed',
  },
  {
    activityKey: 'root:graph:tool:process',
    identity: identity('tools', 'tool', 'tool-process'),
    sequence: 2,
    graphId: 'tools' as GraphId,
    graphName: 'Tool handlers',
    nodeTitle: 'Search docs',
    nodeType: 'Delegate Tool Call',
    status: 'running',
    category: 'tool',
    toolName: 'searchKnowledge',
    resultOrigin: 'executed',
  },
  {
    activityKey: 'root:graph:error:process',
    identity: identity('tools', 'error', 'error-process'),
    sequence: 3,
    graphId: 'tools' as GraphId,
    graphName: 'Tool handlers',
    nodeTitle: 'Fetch URL',
    nodeType: 'HTTP Call',
    status: 'error',
    category: 'generic',
    error: 'Request failed',
    resultOrigin: 'executed',
  },
];

function identity(graphId: string, nodeId: string, processId: string) {
  return {
    rootRunId: 'root' as RootRunId,
    graphRunId: `${graphId}-run` as GraphRunId,
    graphId: graphId as GraphId,
    nodeId: nodeId as NodeId,
    processId: processId as ProcessId,
  };
}

test('drawer height is bounded against the current viewport', () => {
  const maximum = Math.round(1_000 * MAX_RUN_ACTIVITY_DRAWER_VIEWPORT_RATIO);
  assert.equal(clampRunActivityDrawerHeight(1, 1_000), MIN_RUN_ACTIVITY_DRAWER_HEIGHT);
  assert.equal(clampRunActivityDrawerHeight(350.4, 1_000), 350);
  assert.equal(clampRunActivityDrawerHeight(Number.POSITIVE_INFINITY, 1_000), maximum);
  assert.equal(clampRunActivityDrawerHeight(5_000, 1_000), maximum);
});

test('renders semantic run state, filters, partial-data notice, and invocation actions', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  const restore = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const located: string[] = [];
  const fullOutputs: string[] = [];
  const inspected: string[] = [];
  const viewModel: RunActivityViewModel = {
    status: 'outputs-ready',
    durationMs: 1_234,
    backgroundWorkPending: true,
    partialReason: 'This legacy recording does not include result provenance.',
    omittedItemCount: 2,
    items: ITEMS,
  };

  try {
    await act(async () => {
      root.render(
        <RunActivityDrawer
          open
          viewModel={viewModel}
          onClose={() => undefined}
          onLocate={(item) => located.push(item.activityKey)}
          onOpenFullOutput={(item) => fullOutputs.push(item.activityKey)}
          onInspectResponse={(item) => inspected.push(item.activityKey)}
        />,
      );
    });

    const document = dom.window.document;
    assert.match(document.body.textContent ?? '', /Outputs ready; async work still running/);
    assert.match(document.body.textContent ?? '', /Partial activity: This legacy recording/);
    assert.match(document.body.textContent ?? '', /2 older activities are omitted/);

    const modelRow = document.querySelector<HTMLElement>('[data-activity-key="root:graph:model:process"]')!;
    await act(async () => modelRow.querySelector<HTMLButtonElement>('.run-activity-row-toggle')!.click());
    const buttons = [...modelRow.querySelectorAll<HTMLButtonElement>('.run-activity-row-actions button')];
    assert.deepEqual(
      buttons.map((button) => button.textContent?.trim()),
      ['Locate on canvas', 'Open full output', 'Inspect response'],
    );
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    await act(async () => buttons[2]!.click());
    assert.deepEqual(located, ['root:graph:model:process']);
    assert.deepEqual(fullOutputs, ['root:graph:model:process']);
    assert.deepEqual(inspected, ['root:graph:model:process']);

    const errorsFilter = [...document.querySelectorAll<HTMLButtonElement>('.run-activity-filter')].find(
      (button) => button.textContent === 'Errors',
    )!;
    await act(async () => errorsFilter.click());
    assert.equal(document.querySelectorAll('[data-activity-key]').length, 1);
    assert.match(document.body.textContent ?? '', /Fetch URL/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('narrow viewport exposes the drawer as a modal dialog', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: true,
      media: '(max-width: 720px)',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  const restore = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(<RunActivityDrawer open viewModel={{ status: 'idle', items: [] }} onClose={() => undefined} />);
    });
    const drawer = dom.window.document.querySelector('[aria-label="Run Activity"]');
    assert.equal(drawer?.getAttribute('role'), 'dialog');
    assert.equal(drawer?.getAttribute('aria-modal'), 'true');
    assert.match(drawer?.textContent ?? '', /Run a graph to see its activity/);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('synchronizes an oversized desktop height and leaves narrow persisted height unchanged', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  let narrow = false;
  const mediaListeners = new Set<() => void>();
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      get matches() {
        return narrow;
      },
      media: '(max-width: 720px)',
      onchange: null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'change') mediaListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'change') mediaListeners.delete(listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  const restore = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const heights: number[] = [];
  try {
    await act(async () => {
      root.render(
        <RunActivityDrawer
          open
          height={5_000}
          viewModel={{ status: 'idle', items: [] }}
          onClose={() => undefined}
          onHeightChange={(height) => heights.push(height)}
        />,
      );
    });
    assert.deepEqual(heights, [clampRunActivityDrawerHeight(5_000, dom.window.innerHeight)]);

    narrow = true;
    await act(async () => mediaListeners.forEach((listener) => listener()));
    assert.equal(heights.length, 1);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('Escape closes a modal opened from the drawer before it closes the drawer', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  const restore = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  let closeCount = 0;
  try {
    await act(async () => {
      root.render(
        <RunActivityDrawer
          open
          viewModel={{ status: 'idle', items: [] }}
          onClose={() => {
            closeCount += 1;
          }}
        />,
      );
    });

    const nestedModal = dom.window.document.createElement('div');
    nestedModal.setAttribute('aria-modal', 'true');
    dom.window.document.body.append(nestedModal);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(closeCount, 0);

    nestedModal.remove();
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(closeCount, 1);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

function installDomGlobals(dom: JSDOM): () => void {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
    },
    cancelAnimationFrame: { configurable: true, value: (id: number) => dom.window.clearTimeout(id) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(options: ScrollToOptions) {
      if (typeof options.top === 'number') this.scrollTop = options.top;
    },
  });
  return () => {
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previous.window },
      document: { configurable: true, value: previous.document },
      navigator: { configurable: true, value: previous.navigator },
      HTMLElement: { configurable: true, value: previous.HTMLElement },
      requestAnimationFrame: { configurable: true, value: previous.requestAnimationFrame },
      cancelAnimationFrame: { configurable: true, value: previous.cancelAnimationFrame },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: previous.IS_REACT_ACT_ENVIRONMENT },
    });
  };
}
