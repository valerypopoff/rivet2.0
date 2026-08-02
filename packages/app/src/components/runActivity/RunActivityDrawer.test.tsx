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
  const diagnosticsCopied: boolean[] = [];
  const columnWidths: Array<{ nodeName: number; graphName: number; nodeType: number }> = [];
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
          onCopyDiagnostics={() => diagnosticsCopied.push(true)}
          onColumnWidthsChange={(widths) => columnWidths.push(widths)}
        />,
      );
    });

    const document = dom.window.document;
    assert.match(document.body.textContent ?? '', /Outputs ready; async work still running/);
    assert.match(document.body.textContent ?? '', /Partial activity: This legacy recording/);
    assert.match(document.body.textContent ?? '', /2 older activities are omitted/);
    assert.match(document.body.textContent ?? '', /Node name/);
    assert.match(document.body.textContent ?? '', /Graph name/);
    assert.match(document.body.textContent ?? '', /Node type/);
    assert.match(document.body.textContent ?? '', /Result/);
    assert.match(document.body.textContent ?? '', /Started/);
    assert.match(document.body.textContent ?? '', /Duration/);
    assert.ok(document.querySelector('#react-select-run-activity-graph-filter-input'));
    assert.ok(document.querySelector('.run-activity-header-controls'));
    assert.equal(document.querySelector('.run-activity-toolbar'), null);

    const copyDiagnosticsButton = document.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics"]')!;
    assert.equal(copyDiagnosticsButton.textContent, '');
    await act(async () => copyDiagnosticsButton.click());
    assert.deepEqual(diagnosticsCopied, [true]);

    const searchInput = document.querySelector<HTMLInputElement>('[aria-label^="Search Run Activity"]')!;
    const searchControl = searchInput.closest<HTMLElement>('.run-activity-search')!;
    await act(async () => {
      dispatchPrimaryPointerDown(dom, searchInput);
      searchInput.focus();
    });
    assert.equal(searchControl.classList.contains('is-pointer-focused'), true);
    await act(async () => {
      searchInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    assert.equal(searchControl.classList.contains('is-pointer-focused'), false);

    const graphFilterInput = document.querySelector<HTMLInputElement>('#react-select-run-activity-graph-filter-input')!;
    const graphFilter = graphFilterInput.closest<HTMLElement>('.run-activity-graph-filter')!;
    await act(async () => {
      dispatchPrimaryPointerDown(dom, graphFilterInput);
      graphFilterInput.focus();
    });
    assert.equal(graphFilter.classList.contains('is-pointer-focused'), true);
    await act(async () => {
      graphFilterInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    assert.equal(graphFilter.classList.contains('is-pointer-focused'), false);

    const modelRow = document.querySelector<HTMLElement>('[data-activity-key="root:graph:model:process"]')!;
    assert.equal(modelRow.querySelector('.run-activity-graph-name')?.textContent, 'Main graph');
    assert.equal(modelRow.querySelector('.run-activity-node-type')?.textContent, 'LLM Chat');
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

    const errorsFilter = [...document.querySelectorAll<HTMLButtonElement>('.segmented-choice-option')].find(
      (button) => button.textContent === 'Errors',
    )!;
    await act(async () => errorsFilter.click());
    assert.equal(document.querySelectorAll('[data-activity-key]').length, 1);
    assert.match(document.body.textContent ?? '', /Fetch URL/);

    const resizeNodeName = document.querySelector<HTMLButtonElement>('[aria-label="Resize Node name column"]')!;
    await act(async () => {
      resizeNodeName.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    assert.equal(columnWidths.at(-1)?.nodeName, 246);
    // A callback alone is observational. The drawer must remain usable unless
    // its caller explicitly supplies the controlled `columnWidths` value.
    assert.equal(resizeNodeName.getAttribute('aria-valuenow'), '246');
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

test('cancels active desktop resizes when the drawer closes or becomes narrow', async () => {
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
  const widths: Array<{ nodeName: number; graphName: number; nodeType: number }> = [];
  const renderDrawer = async (open: boolean) => {
    await act(async () => {
      root.render(
        <RunActivityDrawer
          open={open}
          viewModel={{ status: 'completed', items: ITEMS }}
          onClose={() => undefined}
          onHeightChange={(height) => heights.push(height)}
          onColumnWidthsChange={(width) => widths.push(width)}
        />,
      );
    });
  };

  try {
    await renderDrawer(true);
    const drawerResize = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Resize Run Activity"]')!;
    await act(async () => dispatchPrimaryPointerDown(dom, drawerResize, { clientY: 300 }));

    narrow = true;
    await act(async () => mediaListeners.forEach((listener) => listener()));
    await act(async () => dispatchPointerMove(dom, dom.window, { clientY: 120 }));
    assert.deepEqual(heights, []);

    narrow = false;
    await act(async () => mediaListeners.forEach((listener) => listener()));
    const columnResize = dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Resize Node name column"]',
    )!;
    await act(async () => dispatchPrimaryPointerDown(dom, columnResize, { clientX: 300 }));
    assert.equal(dom.window.document.body.style.cursor, 'col-resize');

    await renderDrawer(false);
    assert.equal(dom.window.document.body.style.cursor, '');
    await act(async () => dispatchPointerMove(dom, dom.window, { clientX: 460 }));
    assert.deepEqual(widths, []);
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
    const handledEscape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handledEscape.preventDefault();
    dom.window.dispatchEvent(handledEscape);
    assert.equal(closeCount, 0);

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
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    ResizeObserver: {
      configurable: true,
      value: class ResizeObserver {
        observe() {
          // JSDOM has no layout observer; the segmented control only needs a
          // no-op implementation for this rendering-level test.
        }
        disconnect() {
          // No-op.
        }
      },
    },
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
      ResizeObserver: { configurable: true, value: previous.ResizeObserver },
      requestAnimationFrame: { configurable: true, value: previous.requestAnimationFrame },
      cancelAnimationFrame: { configurable: true, value: previous.cancelAnimationFrame },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: previous.IS_REACT_ACT_ENVIRONMENT },
    });
  };
}

function dispatchPrimaryPointerDown(
  dom: JSDOM,
  element: HTMLElement,
  position: { clientX?: number; clientY?: number } = {},
): void {
  const event = new dom.window.Event('pointerdown', { bubbles: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    isPrimary: { value: true },
    clientX: { value: position.clientX ?? 0 },
    clientY: { value: position.clientY ?? 0 },
  });
  element.dispatchEvent(event);
}

function dispatchPointerMove(dom: JSDOM, target: EventTarget, position: { clientX?: number; clientY?: number }): void {
  const event = new dom.window.Event('pointermove');
  Object.defineProperties(event, {
    clientX: { value: position.clientX ?? 0 },
    clientY: { value: position.clientY ?? 0 },
  });
  target.dispatchEvent(event);
}
