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
  lastRunDataByNodeState,
  createEmptyProjectExecutionSnapshot,
  projectExecutionSnapshotsState,
} from '../state/dataFlow.js';
import { projectState } from '../state/savedGraphs.js';
import { userInputModalQuestionsState } from '../state/userInput.js';
import {
  useGraphExecutionEvents,
  type GraphExecutionEventsApi,
  type GraphExecutionEventsOptions,
} from './useGraphExecutionEvents.js';

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
    nodeData: store.get(lastRunDataByNodeState),
    snapshots: store.get(projectExecutionSnapshotsState),
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
  let missingTerminal: GraphExecutionEventsOptions['onMissingDebuggerTerminalEvent'];
  const Harness = () => {
    events = useGraphExecutionEvents(
      {
        clearNodeRunDataPreservationForNextStart: () => preservationCleared++,
        consumeNodeRunDataPreservationForNextStart: () => undefined,
        evaluationRunningLatest: { current: false },
      },
      { onMissingDebuggerTerminalEvent: (event) => missingTerminal?.(event) },
    );
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

    // An identified terminal must not consume another root's FIFO confirmation.
    // This happens when completion order differs from graph-finish arrival order.
    await act(async () => {
      events!.onStart({ startGraph: first.graph } as never);
      for (const root of ['root-a', 'root-b'])
        events!.onGraphFinish({ ...first, execution: { ...first.execution, rootRunId: root } } as never);
      store.set(lastRunDataByNodeState, {
        node: ['root-a', 'root-b'].map((root) => ({
          processId: root,
          rootRunId: root,
          data: { status: { type: 'running' } },
        })),
      } as never);
      events!.onDone({ results: {}, execution: { ...first.execution, rootRunId: 'root-b' } } as never);
    });
    const processes = Object.values(store.get(lastRunDataByNodeState))[0]!;
    assert.equal(processes[0]!.data.status?.type, 'running');
    assert.notEqual(processes[1]!.data.status?.type, 'running');

    for (const action of ['replace', 'throw'] as const) {
      const id = store.get(projectState).metadata.id;
      const replacement = { ...createEmptyProjectExecutionSnapshot(), lastRecording: 'new-content' };
      let notified = 0;
      missingTerminal = () => {
        notified++;
        if (action === 'throw') throw new Error('diagnostic listener failed');
        store.set(projectExecutionSnapshotsState, { [id]: replacement });
      };
      await act(async () => {
        store.set(graphRunningState, true);
        store.set(lastRunDataByNodeState, {
          node: [{ processId: 'orphan', rootRunId: 'root-a', data: { status: { type: 'running' } } }],
        } as never);
        assert.doesNotThrow(() =>
          events!.onDone({ results: {}, execution: { ...first.execution, rootRunId: 'root-a' } } as never),
        );
      });
      assert.equal(notified, 1);
      if (action === 'replace')
        assert.equal(
          store.get(projectExecutionSnapshotsState)[id],
          replacement,
          'diagnostics cannot overwrite replacement state',
        );
      else {
        assert.equal(store.get(graphRunningState), false, 'diagnostics cannot prevent terminal cleanup');
        assert.equal(Object.values(store.get(lastRunDataByNodeState))[0]![0]!.data.status?.type, 'ok');
      }
    }
    assert.equal(toasted.length, 3, 'a diagnostic listener failure is not a graph execution failure');
  } finally {
    await act(async () => root.unmount());
    store.set(graphRunningState, previous.running);
    store.set(graphPausedState, previous.paused);
    store.set(runningGraphsState, previous.graphs);
    store.set(userInputModalQuestionsState, previous.questions);
    store.set(graphRunHistoryByViewState, previous.history);
    store.set(selectedGraphRunByViewState, previous.selections);
    store.set(lastRunDataByNodeState, previous.nodeData);
    store.set(projectExecutionSnapshotsState, previous.snapshots);
    toast.error = originalToastError;
    console.error = originalConsoleError;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
