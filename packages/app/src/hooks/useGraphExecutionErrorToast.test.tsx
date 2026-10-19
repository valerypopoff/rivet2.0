import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';
import { toast } from 'react-toastify';
import { ProvidersProvider } from '../providers/ProvidersContext.js';
import {
  graphPausedState,
  graphRunningState,
  runningGraphsState,
  graphRunHistoryByViewState,
  selectedGraphRunByViewState,
} from '../state/dataFlow.js';
import { userInputModalQuestionsState } from '../state/userInput.js';
import { useGraphExecutionEvents, type GraphExecutionEventsApi } from './useGraphExecutionEvents.js';

test('graph lifecycle keeps exact running slots and errors toast before node output without duplicates', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['document', 'Element', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previous = {
    running: store.get(graphRunningState),
    paused: store.get(graphPausedState),
    graphs: store.get(runningGraphsState),
    questions: store.get(userInputModalQuestionsState),
    history: store.get(graphRunHistoryByViewState),
    selections: store.get(selectedGraphRunByViewState),
  };
  const originalToastError = toast.error;
  const originalConsoleError = console.error;
  const toasted: unknown[] = [];
  toast.error = ((message) => {
    toasted.push(message);
    return 'graph-failure-test';
  }) as typeof toast.error;
  console.error = () => {};
  let events: GraphExecutionEventsApi | undefined;
  let preservationCleared = 0;
  const Harness = () => {
    events = useGraphExecutionEvents({
      clearNodeRunDataPreservationForNextStart: () => preservationCleared++,
      consumeNodeRunDataPreservationForNextStart: () => undefined,
      evaluationRunningLatest: { current: false },
    });
    return null;
  };
  try {
    await act(async () => {
      root.render(React.createElement(ProvidersProvider, { providers: {} }, React.createElement(Harness)));
    });
    const first = {
      graph: { metadata: { id: 'shared' }, nodes: [], connections: [] },
      execution: { graphId: 'shared', graphRunId: 'first', rootRunId: 'root' },
      inputs: {},
      outputs: {},
      error: 'cancelled',
    };
    const sibling = { ...first, execution: { ...first.execution, graphRunId: 'sibling' } };
    await act(async () => {
      store.set(graphRunHistoryByViewState, {});
      store.set(runningGraphsState, []);
      events!.onGraphStart(first as never);
      events!.onGraphStart(sibling as never);
      events!.onGraphStart(first as never);
    });
    assert.deepEqual(store.get(runningGraphsState), ['shared', 'shared']);
    await act(async () => {
      events!.onGraphAbort(first as never);
      events!.onGraphError(first as never);
      events!.onGraphStart(first as never);
    });
    assert.deepEqual(store.get(runningGraphsState), ['shared']);
    await act(async () => {
      events!.onGraphFinish(sibling as never);
    });
    assert.deepEqual(store.get(runningGraphsState), []);
    const loaderMessage =
      'Subgraph calls to another project require a subgraphProjectLoader. Use a project bundle locally or run through Rivet Studio Server.';
    for (const error of [
      new Error(loaderMessage),
      `Error: Error: ${loaderMessage}`,
      'Ordinary root execution failure',
    ]) {
      await act(async () => {
        store.set(graphRunningState, true);
        store.set(graphPausedState, true);
        events!.onError({ error } as never);
        events!.onError({ error } as never);
      });
      assert.equal(store.get(graphRunningState), false);
      assert.equal(store.get(graphPausedState), false);
      assert.deepEqual(store.get(runningGraphsState), []);
      assert.deepEqual(store.get(userInputModalQuestionsState), {});
    }
    assert.deepEqual(toasted, [
      `Graph execution error: ${loaderMessage}`,
      `Graph execution error: Error: Error: ${loaderMessage}`,
      'Graph execution error: Ordinary root execution failure',
    ]);
    assert.equal(preservationCleared, 6);

    // A caught child failure or user cancellation is not a root run failure.
    await act(async () => {
      events!.onGraphError({ graph: { metadata: { id: 'caught-child' } }, error: 'Caught child failure' } as never);
      events!.onAbort({} as never);
    });
    assert.equal(toasted.length, 3);
  } finally {
    await act(async () => root.unmount());
    store.set(graphRunningState, previous.running);
    store.set(graphPausedState, previous.paused);
    store.set(runningGraphsState, previous.graphs);
    store.set(userInputModalQuestionsState, previous.questions);
    store.set(graphRunHistoryByViewState, previous.history);
    store.set(selectedGraphRunByViewState, previous.selections);
    toast.error = originalToastError;
    console.error = originalConsoleError;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
