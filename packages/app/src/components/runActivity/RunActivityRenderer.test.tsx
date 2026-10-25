import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, Provider } from 'jotai';
import {
  coreCreateProcessor,
  createBuiltInRegistry,
  type GraphId,
  type Project,
  type ProjectId,
  type PortId,
  type ProcessEventMessageMap,
} from '@valerypopoff/rivet2-core';
import { ProvidersProvider } from '../../providers/ProvidersContext.js';
import { ExecutorSessionProvider } from '../../providers/ExecutorSessionContext.js';
import { projectState } from '../../state/savedGraphs.js';
import { graphState } from '../../state/graph.js';
import { projectNodeRegistryState } from '../../state/plugins.js';
import { lastRunDataByNodeState, runActivityJournalState } from '../../state/dataFlow.js';
import { fullscreenOutputNodeState } from '../../state/graphBuilder.js';
import { runActivityDrawerOpenState } from '../../state/ui.js';
import { createRunActivityJournal } from '../../features/runActivity/runActivityJournal.js';
import { applyProcessEventToRunActivityJournal } from '../../features/runActivity/runActivityProcessEvents.js';
import { RunActivityRenderer } from './RunActivityRenderer.js';

test('closed activity retains real events without resolving rows; reopening uses the latest journal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const store = createStore(),
    root = createRoot(dom.window.document.getElementById('root')!);
  const registry = createBuiltInRegistry(),
    text = registry.create('text');
  text.title = 'Retained activity';
  text.data.text = 'done';
  const graph = { metadata: { id: 'drawer-main' as GraphId, name: 'Drawer fixture' }, nodes: [text], connections: [] };
  const project: Project = {
    metadata: {
      id: 'drawer-project' as ProjectId,
      title: 'Drawer fixture',
      description: '',
      mainGraphId: graph.metadata.id,
    },
    graphs: { [graph.metadata.id]: graph },
  };
  let resolutions = 0;
  const getName = registry.getDynamicDisplayName.bind(registry);
  registry.getDynamicDisplayName = (type) => {
    resolutions++;
    return getName(type);
  };
  try {
    store.set(projectState, project);
    store.set(graphState, graph);
    store.set(projectNodeRegistryState, registry);
    store.set(runActivityDrawerOpenState, false);
    store.set(runActivityJournalState, createRunActivityJournal());
    await act(async () =>
      root.render(
        <Provider store={store}>
          <ProvidersProvider>
            <ExecutorSessionProvider>
              <RunActivityRenderer />
            </ExecutorSessionProvider>
          </ProvidersProvider>
        </Provider>,
      ),
    );
    const runner = coreCreateProcessor(project, {});
    const collect = <K extends keyof ProcessEventMessageMap>(message: K, data: ProcessEventMessageMap[K]) =>
      store.set(
        runActivityJournalState,
        applyProcessEventToRunActivityJournal({
          journal: store.get(runActivityJournalState),
          message,
          data,
          occurredAt: Date.now(),
        }),
      );
    runner.processor.on('start', (data) => collect('start', data));
    runner.processor.on('graphStart', (data) => collect('graphStart', data));
    runner.processor.on('nodeStart', (data) => collect('nodeStart', data));
    runner.processor.on('nodeFinish', (data) => collect('nodeFinish', data));
    runner.processor.on('graphFinish', (data) => collect('graphFinish', data));
    runner.processor.on('done', (data) => collect('done', data));
    await act(async () => {
      try {
        await runner.run();
        await runner.processor.waitForRunCompletion();
      } finally {
        runner.dispose();
      }
    });
    assert.equal(resolutions, 0);
    const completed = store.get(runActivityJournalState);
    assert.notEqual(completed.latestCompletedRootRunId, undefined);
    await act(async () => store.set(runActivityDrawerOpenState, true));
    assert.ok(resolutions > 0);
    assert.equal(dom.window.document.querySelectorAll('.run-activity-row').length, 1);
    assert.match(dom.window.document.body.textContent!, /Retained activity/);
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Show Run Activity filters"]')!.click(),
    );
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.run-activity-row-toggle')!.click());
    await act(async () => dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    assert.equal(dom.window.document.querySelectorAll('.run-activity-row-detail').length, 1);
    await act(async () => store.set(runActivityDrawerOpenState, false));
    const before = resolutions;
    await act(async () => store.set(runActivityJournalState, { ...completed }));
    assert.equal(resolutions, before);
    await act(async () => store.set(runActivityDrawerOpenState, true));
    assert.equal(dom.window.document.querySelectorAll('.run-activity-row').length, 1);
    assert.ok(dom.window.document.querySelector('[aria-label="Hide Run Activity filters"]'));
    assert.equal(dom.window.document.querySelectorAll('.run-activity-row-detail').length, 1);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
    assert.strictEqual(store.get(runActivityJournalState).rootsById, completed.rootsById);

    const invocation = Object.values(
      completed.rootsById[completed.latestCompletedRootRunId!]!.nodeInvocationsByKey,
    )[0]!;
    await act(async () => {
      store.set(lastRunDataByNodeState, {
        [text.id]: [
          {
            ...invocation,
            data: {
              status: { type: 'ok' },
              outputData: { ['output' as PortId]: { type: 'string', storage: 'inline', value: 'done' } },
            },
          },
        ],
      });
      store.set(fullscreenOutputNodeState, null);
    });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    dom.window.requestAnimationFrame = (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    };
    dom.window.cancelAnimationFrame = (id) => {
      frames.delete(id);
    };
    const openOutput = () => {
      const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === 'Open full output',
      );
      assert.ok(button, 'retained invocation offers its actual output action');
      button.click();
    };
    await act(async () => openOutput());
    assert.equal(frames.size, 1);
    // A different tab can legitimately contain the same graph and node IDs.
    await act(async () =>
      store.set(projectState, {
        ...project,
        metadata: { ...project.metadata, id: 'cloned-project' as ProjectId },
      }),
    );
    await act(async () => {
      for (const callback of frames.values()) callback(0);
      frames.clear();
    });
    assert.equal(store.get(fullscreenOutputNodeState), null, 'deferred output must not open in another project');
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!);
      else delete (globalThis as any)[key];
    }
    dom.window.close();
  }
});
