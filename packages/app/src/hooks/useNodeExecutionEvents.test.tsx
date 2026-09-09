import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataValue, GraphId, GraphRunId, NodeId, PortId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getDefaultStore } from 'jotai';
import { ProvidersProvider, type DataRefStore } from '../providers/ProvidersContext.js';
import { lastRunDataByNodeState } from '../state/dataFlow.js';
import { useExecutionDataFlow } from './useExecutionDataFlow.js';
import { useNodeExecutionEvents, type NodeExecutionEventsApi } from './useNodeExecutionEvents.js';

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
