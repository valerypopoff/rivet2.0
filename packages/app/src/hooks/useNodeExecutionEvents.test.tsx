import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DataValue,
  GraphId,
  GraphRunId,
  NodeId,
  PortId,
  ProcessEvents,
  ProcessEventMessageMap,
  ProcessId,
  RootRunId,
} from '@valerypopoff/rivet2-core';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createStore, getDefaultStore, Provider } from 'jotai';
import { ProvidersProvider, type DataRefStore } from '../providers/ProvidersContext.js';
import {
  createEmptyProjectExecutionSnapshot,
  lastRunDataByNodeState,
  selectedProcessPageNodesState,
  selectedLLMChatOutputPageByInvocationState,
} from '../state/dataFlow.js';
import { projectState } from '../state/savedGraphs.js';
import { previousDataPerNodeToKeepState } from '../state/settings.js';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';
import { useExecutionDataFlow, type ExecutionDataFlowApi } from './useExecutionDataFlow.js';
import { graphNavigationStackState } from '../state/graphBuilder.js';
import { userInputModalQuestionsState } from '../state/userInput.js';
import { createRootGraphViewContext } from '../domain/graphEditing/navigationActions.js';
import { useNodeExecutionEvents, type NodeExecutionEventsApi } from './useNodeExecutionEvents.js';

test('active and inactive adapters agree on streamed, terminal and redelivered history evidence and release only obsolete refs', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = createStore();
  const activeValues = new Map<string, DataValue>();
  const inactiveValues = new Map<string, DataValue>();
  const activeDeletes: string[] = [];
  const inactiveDeletes: string[] = [];
  const makeRefs = (values: Map<string, DataValue>, deletes: string[]): DataRefStore => ({
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => {
      deletes.push(key);
      values.delete(key);
    },
  });
  const activeRefs = makeRefs(activeValues, activeDeletes);
  const inactiveRefs = makeRefs(inactiveValues, inactiveDeletes);
  let events: NodeExecutionEventsApi | undefined;
  const Harness = () => {
    const dataFlow = useExecutionDataFlow();
    events = useNodeExecutionEvents({ ...dataFlow, setSelectedNodePageLatest: () => {} });
    return null;
  };
  let snapshot = createEmptyProjectExecutionSnapshot();
  const execution = { graphId: 'graph' as GraphId, graphRunId: 'run' as GraphRunId, rootRunId: 'root' as RootRunId };
  const node = { id: 'history-node' as NodeId, type: 'text', data: {}, isSplitRun: true };
  const processId = 'history-process' as ProcessId;
  const long = (text: string): DataValue => ({ type: 'string', value: text.repeat(10000) });
  const apply = async <
    K extends
      | 'nodeStart'
      | 'partialOutput'
      | 'nodeError'
      | 'llmChatOutputSnapshot'
      | 'nodeOutputsCleared'
      | 'llmCallFinished'
      | 'llmProfileAttempt'
      | 'toolCallFinished',
  >(
    message: K,
    data: ProcessEvents[K],
  ) => {
    await act(async () => {
      const handlers = {
        nodeStart: events!.onNodeStart,
        partialOutput: events!.onPartialOutput,
        nodeError: events!.onNodeError,
        llmChatOutputSnapshot: events!.onLlmChatOutputSnapshot,
        nodeOutputsCleared: events!.onNodeOutputsCleared,
        llmCallFinished: events!.onLlmCallFinished,
        llmProfileAttempt: events!.onLlmProfileAttempt,
        toolCallFinished: events!.onToolCallFinished,
      };
      // The keyed event union preserves the runtime message/data pairing.
      (handlers[message] as (event: ProcessEvents[K]) => void)(data);
    });
    snapshot = applyProcessEventToProjectExecutionSnapshot({
      message,
      data: data as unknown as ProcessEventMessageMap[K],
      snapshot,
      projectId: store.get(projectState).metadata.id,
      refStore: inactiveRefs,
      previousDataPerNodeToKeep: store.get(previousDataPerNodeToKeepState),
    }).snapshot;
    assert.deepEqual(store.get(lastRunDataByNodeState), snapshot.lastRunDataByNode, message);
    assert.deepEqual(activeValues, inactiveValues, `${message} references`);
    assert.deepEqual(activeDeletes, inactiveDeletes, `${message} deletions`);
    assert.deepEqual(
      store.get(selectedLLMChatOutputPageByInvocationState),
      snapshot.selectedLLMChatOutputPageByInvocation,
      `${message} history selections`,
    );
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(ProvidersProvider, { providers: { dataRefs: activeRefs } }, React.createElement(Harness)),
        ),
      ),
    );
    await apply('nodeStart', { execution, node, processId, inputs: {} } as never);
    for (const [index, value] of [
      [0, 'first'],
      [1, 'sibling'],
      [0, 'replacement'],
    ] as const) {
      await apply('partialOutput', { execution, node, processId, index, outputs: { response: long(value) } } as never);
    }
    const history = {
      execution,
      nodeId: node.id,
      processId,
      entryId: 'round',
      kind: 'model-round',
      outcome: 'final-answer',
      roundIndex: 0,
      splitIndex: 0,
      outputs: { response: long('round'), reasoning: long('reasoning') },
    } as ProcessEvents['llmChatOutputSnapshot'];
    await apply('llmChatOutputSnapshot', history);
    await apply('llmChatOutputSnapshot', { ...history, outputs: { ['response' as PortId]: long('updated-round') } });
    assert.equal(activeValues.size, 3, 'two split outputs and one history page remain');
    await apply('nodeError', {
      execution,
      node,
      processId,
      error: 'failed',
      durationMs: 4,
      outputs: { diagnostic: long('diagnostic') },
    } as never);
    const beforeLate = new Map(activeValues);
    await apply('partialOutput', {
      execution,
      node,
      processId,
      index: 0,
      outputs: { response: long('late') },
    } as never);
    assert.deepEqual(activeValues, beforeLate, 'late partial must not allocate or overwrite refs');
    await apply('llmChatOutputSnapshot', { ...history, entryId: 'late-round', roundIndex: 1 });
    assert.equal(store.get(lastRunDataByNodeState)[node.id]![0]!.data.status?.type, 'error');
    await apply('nodeOutputsCleared', { execution, node, processId } as never);
    assert.equal(activeValues.size, 0, 'clearing the invocation releases every retained page');
    for (const keep of [0, 1, -1]) {
      await act(async () => {
        store.set(previousDataPerNodeToKeepState, keep);
      });
      for (let index = 0; index < 3; index++) {
        const id = `retention-${keep}-${index}` as ProcessId;
        await apply('nodeStart', {
          execution,
          node,
          processId: id,
          inputs: { input: long(`input-${index}`) },
        } as never);
        await apply('llmChatOutputSnapshot', { ...history, processId: id });
        const selectionKey = `${node.id}:${id}:0`;
        const selections = { ...snapshot.selectedLLMChatOutputPageByInvocation, [selectionKey]: 'round' };
        snapshot = { ...snapshot, selectedLLMChatOutputPageByInvocation: selections };
        store.set(selectedLLMChatOutputPageByInvocationState, selections);
        await apply('nodeError', {
          execution,
          node,
          processId: id,
          error: 'failed',
          outputs: { diagnostic: long(`diagnostic-${index}`) },
        } as never);
      }
      const retained = keep < 0 ? 3 : keep + 1;
      assert.equal(
        activeValues.size,
        retained * 4,
        `retention ${keep}: input, both history outputs and diagnostics remain only for retained invocations`,
      );
      assert.equal(Object.keys(snapshot.selectedLLMChatOutputPageByInvocation).length, retained);
      if (keep >= 0) {
        const beforeLate = new Map(activeValues);
        const oldProcessId = `retention-${keep}-0` as ProcessId;
        await apply('llmChatOutputSnapshot', { ...history, processId: oldProcessId, entryId: 'late-evicted' });
        assert.deepEqual(activeValues, beforeLate, 'late round history cannot resurrect evicted payloads');
        await apply('nodeError', {
          execution,
          node,
          processId: oldProcessId,
          error: 'late failure',
          outputs: { diagnostic: long('late-evicted') },
        } as never);
        assert.deepEqual(activeValues, beforeLate, 'late terminal metadata cannot resurrect evicted payloads');
        assert.equal(snapshot.lastRunDataByNode[node.id]![0]!.data.status?.type, 'error');
        await apply('llmChatOutputSnapshot', { ...history, processId: `history-first-${keep}` as ProcessId });
        assert.equal(activeValues.size, keep * 4 + 2, 'history-first invocation uses the same retention window');
        assert.equal(Object.keys(snapshot.selectedLLMChatOutputPageByInvocation).length, keep);
      }
      await apply('nodeOutputsCleared', { execution, node } as never);
      assert.equal(activeValues.size, 0);
      for (const message of ['llmCallFinished', 'llmProfileAttempt', 'toolCallFinished'] as const) {
        for (let index = 0; index < 2; index++) {
          const id = `before-trace-${message}-${index}` as ProcessId;
          await apply('nodeStart', {
            execution,
            node,
            processId: id,
            inputs: { input: long('before-trace') },
          } as never);
          await apply('llmChatOutputSnapshot', { ...history, processId: id });
          await apply('nodeError', {
            execution,
            node,
            processId: id,
            error: 'failed',
            outputs: { diagnostic: long('before-trace') },
          } as never);
          const selections = {
            ...snapshot.selectedLLMChatOutputPageByInvocation,
            [`${node.id}:${id}:0`]: 'round',
          };
          snapshot = { ...snapshot, selectedLLMChatOutputPageByInvocation: selections };
          store.set(selectedLLMChatOutputPageByInvocationState, selections);
        }
        const traceId = `trace-first-${message}` as ProcessId;
        const trace = {
          execution,
          nodeId: message === 'toolCallFinished' ? ('not-the-tool-source' as NodeId) : node.id,
          processId: message === 'toolCallFinished' ? ('not-the-tool-source' as ProcessId) : traceId,
          sourceNodeId: node.id,
          sourceProcessId: traceId,
          callId: 'call',
          eventId: 'profile-attempt',
          toolCallId: 'tool-call',
          toolName: 'lookup',
          handlerKind: 'external',
          provider: 'custom',
          model: 'fixture',
          attemptIndex: 0,
          roundIndex: 0,
          profileIndex: 0,
          outcome: 'success',
          durationMs: 1,
          pricing: { status: 'unknown' },
        };
        await apply(message, trace as never);
        const retainedOlder = keep < 0 ? 2 : keep;
        assert.equal(activeValues.size, retainedOlder * 4, `${message}: diagnostic-first creation evicts old payloads`);
        assert.equal(Object.keys(snapshot.selectedLLMChatOutputPageByInvocation).length, retainedOlder);
        await apply('nodeStart', {
          execution,
          node,
          processId: traceId,
          inputs: { input: long('trace-first') },
        } as never);
        await apply('nodeError', {
          execution,
          node,
          processId: traceId,
          error: 'failed',
          outputs: { diagnostic: long('trace-first') },
        } as never);
        await apply(message, trace as never);
        assert.equal(activeValues.size, retainedOlder * 4 + 2, `${message}: redelivery preserves the retained window`);
        const invocation = snapshot.lastRunDataByNode[node.id]!.find((entry) => entry.processId === traceId)!;
        assert.equal(invocation.data.status?.type, 'error');
        assert.equal(invocation.data.agentTraceEvents?.length, 1, 'identified redelivery replaces, not appends');
        const retainedValues = new Map(activeValues);
        await apply(message, {
          ...trace,
          processId: `before-trace-${message}-0` as ProcessId,
          sourceProcessId: `before-trace-${message}-0` as ProcessId,
        } as never);
        assert.deepEqual(
          activeValues,
          retainedValues,
          'late diagnostics do not resurrect old payloads or evict newer ones',
        );
        await apply('nodeOutputsCleared', { execution, node } as never);
        assert.equal(activeValues.size, 0);
      }
    }
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test('active node events retain stable split refs and terminal evidence after more than 512 unrelated terminal invocations', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousLastRunData = store.get(lastRunDataByNodeState);
  const values = new Map<string, DataValue>();
  const dataRefs: DataRefStore = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  };
  let events: NodeExecutionEventsApi | undefined;
  const nodeId = 'terminal-evidence-node' as NodeId;
  const processId = 'terminal-evidence-process' as ProcessId;
  const execution = {
    graphId: 'graph-a' as GraphId,
    graphRunId: 'graph-run-a' as GraphRunId,
    rootRunId: 'root-run-a' as RootRunId,
  };
  const splitNodeId = 'stable-ref-split-node' as NodeId;
  const splitProcessId = 'stable-ref-split-process' as ProcessId;
  const firstSplitValue = 'first active split output '.repeat(1_000);
  const secondSplitValue = 'second active split output '.repeat(1_000);

  const Harness = () => {
    const dataFlow = useExecutionDataFlow();
    events = useNodeExecutionEvents({
      setDataForNode: dataFlow.setDataForNode,
      setSelectedNodePageLatest: () => {},
      shouldSuppressPreloadedNodeEvent: () => false,
    });
    return null;
  };

  try {
    await act(async () => {
      root.render(React.createElement(ProvidersProvider, { providers: { dataRefs } }, React.createElement(Harness)));
    });
    assert.ok(events);

    await act(async () => {
      events!.onPartialOutput({
        execution,
        index: 0,
        node: { id: splitNodeId, isSplitRun: true },
        outputs: { output: { type: 'string', value: firstSplitValue } },
        processId: splitProcessId,
      } as never);
      events!.onPartialOutput({
        execution,
        index: 0,
        node: { id: splitNodeId, isSplitRun: true },
        outputs: { output: { type: 'string', value: secondSplitValue } },
        processId: splitProcessId,
      } as never);

      events!.onNodeError({
        error: 'provider failed',
        execution,
        node: { id: nodeId },
        outputs: { llmRequestBody: { type: 'string', value: '{"prompt":"keep"}' } },
        processId,
      } as never);

      for (let index = 0; index <= 512; index++) {
        events!.onNodeError({
          error: 'unrelated failure',
          execution,
          node: { id: `unrelated-${index}` as NodeId },
          processId: `unrelated-process-${index}` as ProcessId,
        } as never);
      }

      events!.onPartialOutput({
        execution,
        index: 0,
        node: { id: nodeId },
        outputs: { response: { type: 'string', value: 'late response must not replace evidence' } },
        processId,
      } as never);
    });

    const terminalData = store.get(lastRunDataByNodeState)[nodeId]?.[0]?.data;
    assert.equal(terminalData?.status?.type, 'error');
    assert.deepEqual(terminalData?.outputData, {
      llmRequestBody: { storage: 'inline', type: 'string', value: '{"prompt":"keep"}' },
    });
    const splitStoredOutput =
      store.get(lastRunDataByNodeState)[splitNodeId]?.[0]?.data.splitOutputData?.[0]?.['output' as PortId];
    assert.equal(splitStoredOutput?.storage, 'ref');
    assert.equal(
      splitStoredOutput?.storage === 'ref' ? values.get(splitStoredOutput.refId)?.value : undefined,
      secondSplitValue,
    );
  } finally {
    await act(async () => {
      store.set(lastRunDataByNodeState, previousLastRunData);
      root.unmount();
    });
    restoreGlobals();
    dom.window.close();
  }
});

test("node history keeps a deferred Watch event's occurrence timing instead of its later delivery timing", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousLastRunData = store.get(lastRunDataByNodeState);
  const dataRefs: DataRefStore = {
    get: () => undefined,
    set: () => {},
    delete: () => {},
  };
  let events: NodeExecutionEventsApi | undefined;
  const nodeId = 'deferred-watch-node' as NodeId;
  const processId = 'deferred-watch-process' as ProcessId;
  const execution = {
    graphId: 'graph-a' as GraphId,
    graphRunId: 'graph-run-a' as GraphRunId,
    rootRunId: 'root-run-a' as RootRunId,
  };

  const Harness = () => {
    const dataFlow = useExecutionDataFlow();
    events = useNodeExecutionEvents({
      setDataForNode: dataFlow.setDataForNode,
      setSelectedNodePageLatest: () => {},
      shouldSuppressPreloadedNodeEvent: () => false,
    });
    return null;
  };

  try {
    await act(async () => {
      root.render(React.createElement(ProvidersProvider, { providers: { dataRefs } }, React.createElement(Harness)));
    });
    assert.ok(events);

    await act(async () => {
      events!.onNodeStart({
        eventOccurredAt: 10_000,
        execution,
        inputs: {},
        node: { id: nodeId },
        processId,
        replayRecordedAt: 90_000,
      } as never);
      events!.onNodeFinish({
        eventOccurredAt: 10_250,
        execution,
        node: { id: nodeId },
        outputs: {},
        processId,
        replayRecordedAt: 90_250,
      } as never);
    });

    assert.deepEqual(store.get(lastRunDataByNodeState)[nodeId]?.[0]?.data.recordedTiming, {
      finishedAt: 10_250,
      startedAt: 10_000,
    });
  } finally {
    await act(async () => {
      store.set(lastRunDataByNodeState, previousLastRunData);
      root.unmount();
    });
    restoreGlobals();
    dom.window.close();
  }
});

test('a live child prompt remains answerable without resetting caller output history', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const store = getDefaultStore();
  const previousNavigation = store.get(graphNavigationStackState);
  const previousPages = store.get(selectedProcessPageNodesState);
  const previousQuestions = store.get(userInputModalQuestionsState);
  const graphId = 'shared-graph' as GraphId;
  const nodeId = 'shared-node' as NodeId;
  const processId = 'child-prompt' as ProcessId;
  let dataFlow: ExecutionDataFlowApi | undefined;
  const Harness = () => {
    dataFlow = useExecutionDataFlow();
    return null;
  };
  try {
    await act(async () => {
      store.set(graphNavigationStackState, { stack: [createRootGraphViewContext(graphId)], index: 0 });
      store.set(selectedProcessPageNodesState, { [nodeId]: 2 });
      store.set(userInputModalQuestionsState, {});
      root.render(React.createElement(ProvidersProvider, { providers: {} }, React.createElement(Harness)));
    });
    await act(async () => {
      dataFlow!.onUserInput({
        node: { id: nodeId },
        processId,
        inputStrings: ['Child?'],
        execution: { graphId, projectScope: 'called-project' },
      } as never);
    });
    assert.equal(store.get(selectedProcessPageNodesState)[nodeId], 2);
    assert.equal(store.get(userInputModalQuestionsState)[nodeId]?.[0]?.questions[0], 'Child?');
    await act(async () => dataFlow!.onCalledProjectNodeTerminal({ node: { id: nodeId }, processId } as never));
    assert.equal(store.get(userInputModalQuestionsState)[nodeId], undefined);
  } finally {
    await act(async () => {
      root.unmount();
      store.set(graphNavigationStackState, previousNavigation);
      store.set(selectedProcessPageNodesState, previousPages);
      store.set(userInputModalQuestionsState, previousQuestions);
    });
    restoreGlobals();
    dom.window.close();
  }
});

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
