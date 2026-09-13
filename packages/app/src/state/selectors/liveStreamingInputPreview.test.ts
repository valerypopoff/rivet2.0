import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai';
import {
  ExecutionRecorder,
  type GraphId,
  type GraphRunId,
  type NodeGraph,
  type NodeId,
  type PortId,
  type ProcessId,
  type ProjectId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import { graphState } from '../graph.js';
import {
  graphRunningState,
  lastRunDataByNodeState,
  graphRunHistoryByViewState,
  selectedGraphRunByViewState,
} from '../dataFlow.js';
import { graphNavigationStackState } from '../graphBuilder.js';
import { createLiveStreamingInputPreviewAtom } from './liveStreamingInputPreview.js';
import { loadedRecordingState } from '../execution.js';
import { loadedProjectState, projectState } from '../savedGraphs.js';

const sourceId = 'source' as NodeId;
const targetId = 'target' as NodeId;
const watchId = 'watch' as NodeId;
const graphId = 'graph' as GraphId;
const port = 'input' as PortId;
const response = 'response' as PortId;
const graph: NodeGraph = {
  metadata: { id: graphId },
  nodes: [
    {
      id: sourceId,
      type: 'llmChatV2',
      title: 'LLM',
      data: { useAsGraphPartialOutput: true },
      visualData: { x: 0, y: 0 },
    },
    { id: targetId, type: 'text', title: 'Text', data: {}, visualData: { x: 300, y: 0 } },
    { id: watchId, type: 'watchStreamingOutput', title: 'Watch', data: {}, visualData: { x: 300, y: 300 } },
  ],
  connections: [targetId, watchId].map((inputNodeId) => ({
    inputNodeId,
    inputId: port,
    outputNodeId: sourceId,
    outputId: response,
  })),
};

function fixture() {
  const store = createStore();
  store.set(graphState, graph);
  store.set(graphRunningState, true);
  const value = {
    storage: 'ref' as const,
    type: 'string' as const,
    refId: 'existing-response',
    preview: {
      kind: 'text' as const,
      excerpt: 'hello',
      totalChars: 100_000,
      lineCount: 1,
    },
  };
  const process = {
    graphId,
    processId: 'process' as ProcessId,
    data: { status: { type: 'running' as const }, outputData: { [response]: value } },
  };
  store.set(lastRunDataByNodeState, { [sourceId]: [process] });
  return { store, process, value, preview: createLiveStreamingInputPreviewAtom(targetId) };
}

test('live input uses the original bounded output and never creates a consumer invocation', () => {
  const { store, preview, value } = fixture();
  assert.equal(store.get(preview)?.[port], value);
  assert.equal(store.get(lastRunDataByNodeState)[targetId], undefined);
  assert.equal(store.get(createLiveStreamingInputPreviewAtom(watchId)), undefined);
});

test('cancellation removes a preview even if the producer never sends a terminal event', () => {
  const { store, preview } = fixture();
  assert.ok(store.get(preview));
  store.set(graphRunningState, false);
  assert.equal(store.get(preview), undefined);
});

test('terminal producer output removes the preview immediately', () => {
  const { store, preview, process } = fixture();
  store.set(lastRunDataByNodeState, {
    [sourceId]: [{ ...process, data: { ...process.data, status: { type: 'ok' } } }],
  });
  assert.equal(store.get(preview), undefined);
});

test('parallel source invocations do not paint an arbitrary Watch iteration as the consumer input', () => {
  const { store, preview, process } = fixture();
  store.set(lastRunDataByNodeState, {
    [sourceId]: [
      process,
      {
        ...process,
        processId: 'parallel' as ProcessId,
      },
    ],
  });
  assert.equal(store.get(preview), undefined);
});

test('Stop always displays its actual accepted output, never a speculative input preview', () => {
  const { store, preview } = fixture();
  store.set(graphState, {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === targetId ? { ...node, type: 'stopWatchingStreamingOutput' } : node)),
  });
  assert.equal(store.get(preview), undefined);
});

test('a loaded recording suppresses only its owning tab preview', () => {
  const { store, preview } = fixture();
  const project = store.get(projectState);
  store.set(loadedRecordingState, {
    path: '/recording',
    recorder: new ExecutionRecorder(),
    projectId: project.metadata.id as ProjectId,
    projectPath: store.get(loadedProjectState).path,
  });
  assert.equal(store.get(preview), undefined);
  store.set(projectState, { ...project, metadata: { ...project.metadata, id: 'another-project' as ProjectId } });
  assert.ok(store.get(preview));
});

test('removing one connection clears that preview while the Watch connection remains', () => {
  const { store, preview } = fixture();
  store.set(graphState, {
    ...graph,
    connections: graph.connections.filter((connection) => connection.inputNodeId === watchId),
  });
  assert.equal(store.get(preview), undefined);
});

test('switching graphs cannot reuse another graphs matching node ids', () => {
  const { store, preview } = fixture();
  store.set(graphState, { ...graph, metadata: { id: 'other' as GraphId } });
  assert.equal(store.get(preview), undefined);
});

test('terminal latest invocation does not expose an older unfinished invocation', () => {
  const { store, preview, process } = fixture();
  store.set(lastRunDataByNodeState, {
    [sourceId]: [
      process,
      {
        ...process,
        processId: 'newer' as ProcessId,
        data: { status: { type: 'ok' } },
      },
    ],
  });
  assert.equal(store.get(preview), undefined);
});

test('selected historical runs never display a different live invocation', () => {
  const { store, preview, process } = fixture();
  const oldRun = 'old' as GraphRunId;
  const liveRun = 'live' as GraphRunId;
  store.set(graphNavigationStackState, { index: 0, stack: [{ graphId, key: 'view' }] });
  store.set(graphRunHistoryByViewState, {
    view: [
      { graphId, graphRunId: oldRun, rootRunId: 'root' as RootRunId, startedAt: 1, status: 'ok' },
      { graphId, graphRunId: liveRun, rootRunId: 'root' as RootRunId, startedAt: 2, status: 'running' },
    ],
  });
  store.set(lastRunDataByNodeState, { [sourceId]: [{ ...process, graphRunId: liveRun }] });
  assert.ok(store.get(preview));
  store.set(selectedGraphRunByViewState, { view: oldRun });
  assert.equal(store.get(preview), undefined);
  store.set(selectedGraphRunByViewState, { view: liveRun });
  assert.ok(store.get(preview));
});
