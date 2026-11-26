import Emittery from 'emittery';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { GraphId, NodeGraph } from '../../src/model/NodeGraph.js';
import type { GraphProcessor, NodeResultOrigin, Outputs, ProcessEvents } from '../../src/model/GraphProcessor.js';
import type { ProjectId } from '../../src/model/Project.js';
import type { DataValue } from '../../src/model/DataValue.js';
import type { RecordedEvents } from '../../src/recording/RecordedEvents.js';
import type { SerializedProcessEventMap } from '../../src/model/ExecutorProtocol.js';
import { replayExecutionRecording } from '../../src/model/RecordingPlayer.js';
import type { GraphExecutionMetadata, GraphRunId, ProcessId, RootRunId } from '../../src/model/ProcessContext.js';
import { ExecutionRecorder } from '../../src/recording/ExecutionRecorder.js';
import type { ChartNode, NodeId, PortId } from '../../src/model/NodeBase.js';
import type { UserInputNode } from '../../src/model/nodes/UserInputNode.js';

const userInputPort = 'user-input-a' as PortId;
const nodeId = 'node-id' as NodeId;
const processId = 'process-id' as ProcessId;

const node = {
  id: nodeId,
  type: 'test',
} as ChartNode;

const execution: GraphExecutionMetadata = {
  graphId: 'graph-id' as GraphId,
  graphRunId: 'graph-run-id' as GraphRunId,
  rootRunId: 'root-run-id' as RootRunId,
};

const graph: NodeGraph = {
  metadata: { id: 'graph-id' as GraphId },
  nodes: [node],
  connections: [],
};

type ReplayOptions = Parameters<typeof replayExecutionRecording>[0];

// Each replay gets fresh mutable state. Tests keep their meaningful overrides
// (event observers, graph topology, identity and running-state assertions) local.
function replayFixture(
  recorder: ExecutionRecorder,
  options: Pick<ReplayOptions, 'emitter'> & Partial<Omit<ReplayOptions, 'emitter' | 'recorder'>>,
) {
  return replayExecutionRecording({
    erroredNodes: new Map(),
    graphInputs: {},
    graphOutputs: {},
    isAborted: () => false,
    nodeResults: new Map(),
    project: {
      metadata: { id: 'project-id' as ProjectId, title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
      graphs: { [graph.metadata!.id!]: graph },
    },
    recordingPlaybackChatLatency: 0,
    setContextValues: () => {},
    setGraphInputs: () => {},
    setGraphOutputs: () => {},
    setRunning: () => {},
    visitedNodes: new Set(),
    waitUntilUnpaused: async () => {},
    ...options,
    recorder,
  });
}

void it('direct and socket recorders retain detached target labels within the existing request and project scope', async () => {
  const snapshots = [
    {
      nodeId,
      targetProjectId: 'target-project' as ProjectId,
      targetGraphId: 'target-graph' as GraphId,
      targetVersion: 'published' as const,
      projectName: 'Original project',
      graphName: 'folder/Original graph',
    },
  ];
  const emitter = new Emittery<ProcessEvents>();
  const direct = new ExecutionRecorder();
  direct.record(emitter as unknown as GraphProcessor);
  const source = { graph, inputs: {}, execution, subgraphTargets: snapshots };
  await emitter.emit('graphStart', source as ProcessEvents['graphStart']);
  await emitter.emit('done', { results: {} });
  snapshots[0]!.projectName = 'Changed after emission';
  const saved = direct.events.find((event) => event.type === 'graphStart')!.data.subgraphTargets;
  assert.equal(saved?.[0]?.projectName, 'Original project');

  const socket = new FakeSocket();
  const remote = new ExecutionRecorder();
  const done = remote.recordSocket(socket as unknown as WebSocket, { requestId: 'owned' });
  socket.emit({ message: 'graphStart', requestId: 'other', data: source });
  socket.emit({
    message: 'graphStart',
    requestId: 'owned',
    data: { ...source, execution: { ...execution, projectScope: 'child' } },
  });
  socket.emit({ message: 'graphStart', requestId: 'owned', data: { ...source, subgraphTargets: saved } });
  socket.emit({ message: 'done', requestId: 'owned', data: { results: {} } });
  await done;
  assert.equal(remote.events.filter((event) => event.type === 'graphStart').length, 1);
  assert.deepEqual(remote.events.find((event) => event.type === 'graphStart')!.data.subgraphTargets, saved);
  assert.equal(socket.listenerCount, 0);
});

class FakeSocket {
  #closeListeners = new Set<() => void>();
  #messageListeners = new Set<(event: MessageEvent) => void>();
  readyState = 1;

  get listenerCount() {
    return this.#messageListeners.size + this.#closeListeners.size;
  }

  addEventListener(type: 'message' | 'close', listener: ((event: MessageEvent) => void) | (() => void)) {
    if (type === 'message') {
      this.#messageListeners.add(listener as (event: MessageEvent) => void);
    } else if (type === 'close') {
      this.#closeListeners.add(listener as () => void);
    }
  }

  removeEventListener(type: 'message' | 'close', listener: ((event: MessageEvent) => void) | (() => void)) {
    if (type === 'message') {
      this.#messageListeners.delete(listener as (event: MessageEvent) => void);
    } else if (type === 'close') {
      this.#closeListeners.delete(listener as () => void);
    }
  }

  emit(message: unknown) {
    this.emitRaw(JSON.stringify(message));
  }

  emitRaw(data: string) {
    const event = { data } as MessageEvent;
    for (const listener of this.#messageListeners) {
      listener(event);
    }
  }

  close() {
    this.readyState = 3;
    for (const listener of this.#closeListeners) {
      listener();
    }
  }
}

void it('releases capture ownership and partial listeners when processor setup fails', () => {
  for (const phase of ['events', 'finish']) {
    let releases = 0;
    let listeners = 0;
    const error = new Error('Processor listener setup failed');
    const recorder = new ExecutionRecorder({
      createCapturePolicy: () => ({
        retain: () => true,
        release: () => {
          releases++;
        },
      }),
    });
    const processor = {
      onAny() {
        if (phase === 'events') throw error;
        listeners++;
        return () => {
          listeners--;
        };
      },
      on() {
        throw error;
      },
    } as unknown as GraphProcessor;
    assert.throws(
      () => recorder.record(processor),
      (actual) => actual === error,
    );
    assert.equal(listeners, 0);
    assert.equal(recorder.captureDiscarded, true);
    recorder.discard();
    assert.equal(releases, 1);
  }
});

void it('releases capture ownership and partial listeners when socket setup fails', async () => {
  for (const phase of ['message', 'close']) {
    let releases = 0;
    const error = new Error('Socket listener setup failed');
    const recorder = new ExecutionRecorder({
      createCapturePolicy: () => ({
        retain: () => true,
        release: () => {
          releases++;
        },
      }),
    });
    const socket = new FakeSocket();
    const add = socket.addEventListener.bind(socket);
    socket.addEventListener = (type, listener) => {
      add(type, listener);
      if (type === phase) throw error;
    };
    await assert.rejects(recorder.recordSocket(socket as unknown as WebSocket), (actual) => actual === error);
    assert.equal(socket.listenerCount, 0);
    assert.equal(recorder.captureDiscarded, true);
    recorder.discard();
    assert.equal(releases, 1);
  }
});

async function addEvents(recorder: ExecutionRecorder, options: { includeIntermediateEvents?: boolean } = {}) {
  const { includeIntermediateEvents = false } = options;
  const emitter = new Emittery<ProcessEvents>();
  recorder.record(emitter as unknown as GraphProcessor);
  await emitter.emit('graphStart', {
    graph,
    inputs: { [userInputPort]: { type: 'string', value: 'asdf' } },
    execution,
  });

  await emitter.emit('nodeStart', {
    node,
    inputs: { [userInputPort]: { type: 'string', value: 'asdf' } },
    processId,
    execution,
  });

  if (includeIntermediateEvents) {
    await emitter.emit('userInput', {
      node: node as UserInputNode,
      inputs: { [userInputPort]: { type: 'string', value: 'asdf' } },
      callback: () => {},
      processId,
      inputStrings: ['Continue?'],
      renderingType: 'markdown',
      execution,
    });

    await emitter.emit('partialOutput', {
      node,
      outputs: { ['output' as PortId]: { type: 'string', value: 'partial' } },
      index: 0,
      processId,
      execution,
    });

    await emitter.emit('progress', {
      node,
      processId,
      progress: { message: 'Working', percent: 25 },
      execution,
    });

    await emitter.emit('nodeOutputsCleared', {
      node,
      processId,
      execution,
    });

    await emitter.emit('graphFinish', {
      graph,
      outputs: { ['output' as PortId]: { type: 'string', value: 'final' } },
      execution,
    });
  }

  await emitter.emit('done', {
    results: {
      output: { type: 'string', value: 'output' },
    },
  });
}

async function replayNodeFinishTiming(
  recorder: ExecutionRecorder,
): Promise<{ durationMs: number | undefined; splitRunDurationMs: Record<number, number> | undefined }> {
  const replayEmitter = new Emittery<ProcessEvents>();
  let durationMs: number | undefined;
  let splitRunDurationMs: Record<number, number> | undefined;

  replayEmitter.on('nodeFinish', (data: ProcessEvents['nodeFinish']) => {
    durationMs = data.durationMs;
    splitRunDurationMs = data.splitRunDurationMs;
  });

  await replayFixture(recorder, {
    emitter: replayEmitter,
  });

  return { durationMs, splitRunDurationMs };
}

async function replayNodeResultOrigins(recorder: ExecutionRecorder): Promise<
  Array<{
    type: string;
    resultOrigin: NodeResultOrigin | undefined;
    outputs?: Outputs;
    splitOutputs?: Record<number, Outputs>;
  }>
> {
  const replayEmitter = new Emittery<ProcessEvents>();
  const replayed: Array<{
    type: string;
    resultOrigin: NodeResultOrigin | undefined;
    outputs?: Outputs;
    splitOutputs?: Record<number, Outputs>;
  }> = [];

  for (const type of ['nodeStart', 'partialOutput', 'nodeFinish', 'nodeError', 'nodeExcluded'] as const) {
    replayEmitter.on(
      type,
      (data) =>
        void replayed.push({
          type,
          resultOrigin: data.resultOrigin,
          ...(type === 'nodeError' && 'outputs' in data && data.outputs !== undefined ? { outputs: data.outputs } : {}),
          ...(type === 'nodeError' && 'splitOutputs' in data && data.splitOutputs !== undefined
            ? { splitOutputs: data.splitOutputs }
            : {}),
        }),
    );
  }

  await replayFixture(recorder, {
    emitter: replayEmitter,
  });

  return replayed;
}

void describe('ExecutionRecorder', () => {
  void it('should serialize an instance of ExecutionRecorder', async () => {
    // Simulate storage in string form
    const recordingToString = (recorder: ExecutionRecorder) => recorder.serialize();
    const recordingStreamToString = async (recorder: ExecutionRecorder) => {
      const reader = recorder.serializeStream().getReader();
      let result = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return result;
        result += value;
      }
    };

    const stringToRecording = ExecutionRecorder.deserializeFromString;
    const streamToRecording = (str: string) =>
      ExecutionRecorder.deserializeFromStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue(str);
            controller.close();
          },
        }),
      );

    // Test each pair of string/stream serializer and deserializer
    for (const [serialize, deserialize] of [
      [recordingToString, stringToRecording],
      [recordingToString, streamToRecording],
      [recordingStreamToString, stringToRecording],
      [recordingStreamToString, streamToRecording],
    ] as const) {
      const recorder = new ExecutionRecorder();
      await addEvents(recorder);

      const originalEvents = recorder.events;
      assert.notEqual(originalEvents.length, 0);
      const serialized = await serialize(recorder);
      const deserialized = await deserialize(serialized);
      assert.deepEqual(deserialized.events, originalEvents);
    }
  });

  void it('keeps serialized long-string recording keys stable', async () => {
    const value = 'stable recording string over thirty characters';
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    await emitter.emit('done', {
      results: {
        output: { type: 'string', value },
      },
    });

    const serialized = JSON.parse(recorder.serialize()) as {
      recording: unknown;
      strings: Record<string, string>;
    };

    assert.equal(serialized.strings['2085944468'], value);
    assert.match(JSON.stringify(serialized.recording), /\$STRING:2085944468/);
  });

  void it('persists execution metadata and replays partialOutput/nodeOutputsCleared with parity', async () => {
    const recorder = new ExecutionRecorder({ includePartialOutputs: true });
    await addEvents(recorder, { includeIntermediateEvents: true });

    const partialOutputEvent = recorder.events.find((event) => event.type === 'partialOutput');
    const progressEvent = recorder.events.find((event) => event.type === 'progress');
    const nodeOutputsClearedEvent = recorder.events.find((event) => event.type === 'nodeOutputsCleared');

    assert.equal(partialOutputEvent?.data.execution?.graphRunId, execution.graphRunId);
    assert.equal(progressEvent?.data.execution?.graphRunId, execution.graphRunId);
    assert.deepEqual(progressEvent?.data.progress, { message: 'Working', percent: 25 });
    assert.equal(nodeOutputsClearedEvent?.data.execution?.rootRunId, execution.rootRunId);

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayedEvents: Array<{
      type: string;
      execution?: GraphExecutionMetadata;
      processId?: ProcessId;
      index?: number;
      inputStrings?: string[];
      renderingType?: 'text' | 'markdown';
      isReplay?: true;
    }> = [];

    replayEmitter.on('graphStart', (data: ProcessEvents['graphStart']) => {
      replayedEvents.push({ type: 'graphStart', execution: data.execution });
    });
    replayEmitter.on('partialOutput', (data: ProcessEvents['partialOutput']) => {
      replayedEvents.push({
        type: 'partialOutput',
        execution: data.execution,
        index: data.index,
        processId: data.processId,
      });
    });
    replayEmitter.on('userInput', (data: ProcessEvents['userInput']) => {
      replayedEvents.push({
        type: 'userInput',
        execution: data.execution,
        processId: data.processId,
        inputStrings: data.inputStrings,
        renderingType: data.renderingType,
        isReplay: data.isReplay,
      });
    });
    replayEmitter.on('progress', (data: ProcessEvents['progress']) => {
      replayedEvents.push({ type: 'progress', execution: data.execution, processId: data.processId });
    });
    replayEmitter.on('nodeOutputsCleared', (data: ProcessEvents['nodeOutputsCleared']) => {
      replayedEvents.push({ type: 'nodeOutputsCleared', execution: data.execution, processId: data.processId });
    });
    replayEmitter.on('graphFinish', (data: ProcessEvents['graphFinish']) => {
      replayedEvents.push({ type: 'graphFinish', execution: data.execution });
    });

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    assert.deepEqual(
      replayedEvents.map(({ execution: _execution, ...event }) => event),
      [
        { type: 'graphStart' },
        { type: 'userInput', processId, inputStrings: ['Continue?'], renderingType: 'markdown', isReplay: true },
        { type: 'partialOutput', index: 0, processId },
        { type: 'progress', processId },
        { type: 'nodeOutputsCleared', processId },
        { type: 'graphFinish' },
      ],
    );

    const replayedExecutions = replayedEvents
      .map((event) => event.execution)
      .filter((replayedExecution): replayedExecution is GraphExecutionMetadata => replayedExecution !== undefined);
    assert.equal(replayedExecutions.length, 6);
    assert.ok(replayedExecutions.every((replayedExecution) => replayedExecution.graphId === execution.graphId));
    assert.ok(
      replayedExecutions.every(
        (replayedExecution) =>
          replayedExecution.rootRunId === replayedExecutions[0]!.rootRunId &&
          replayedExecution.graphRunId === replayedExecutions[0]!.graphRunId,
      ),
    );
    assert.notEqual(replayedExecutions[0]!.rootRunId, execution.rootRunId);
    assert.notEqual(replayedExecutions[0]!.graphRunId, execution.graphRunId);
  });

  void it('records and replays compact Watch Streaming Output summaries with timing provenance', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    const watchNode = { ...node, type: 'watchStreamingOutput' } as ChartNode;
    const selectedIterationExecution: GraphExecutionMetadata = {
      ...execution,
      graphRunId: 'watch-selected-child-run' as GraphRunId,
      parentGraphRunId: execution.graphRunId,
    };
    const summary: ProcessEvents['streamingOutputWatchSummary']['summary'] = {
      receivedUpdates: 9,
      coalescedUpdates: 2,
      droppedUpdates: 1,
      maximumQueuedUpdates: 3,
      completedIterations: 6,
      failedIterations: 0,
      cancelledIterations: 0,
      omittedIterations: 2,
      retainedIterationUpdateIndexes: [1, 2, 3, 9],
      selectedIteration: {
        graphRunId: selectedIterationExecution.graphRunId,
        updateIndex: 9,
        reason: 'latest',
      },
    };

    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: { ['output' as PortId]: { type: 'string', value: 'selected watch output' } },
      processId,
      execution: selectedIterationExecution,
    });
    await sourceEmitter.emit('streamingOutputWatchSummary', { watchNode, summary, execution });
    await sourceEmitter.emit('done', { results: {} });

    const recordedSummary = recorder.events.find((event) => event.type === 'streamingOutputWatchSummary');
    if (!recordedSummary || recordedSummary.type !== 'streamingOutputWatchSummary') {
      assert.fail('Expected the Watch summary to be recorded.');
    }
    assert.deepEqual(recordedSummary.data.summary, summary);
    assert.equal(recordedSummary.data.watchNodeId, watchNode.id);

    const replayEmitter = new Emittery<ProcessEvents>();
    let replayed: ProcessEvents['streamingOutputWatchSummary'] | undefined;
    let replayedSelectedIterationExecution: GraphExecutionMetadata | undefined;
    replayEmitter.on('streamingOutputWatchSummary', (event) => {
      replayed = event;
    });
    replayEmitter.on('nodeFinish', (event) => {
      replayedSelectedIterationExecution = event.execution;
    });

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(replayed?.summary, {
      ...summary,
      selectedIteration: {
        ...summary.selectedIteration,
        graphRunId: replayedSelectedIterationExecution?.graphRunId,
      },
    });
    assert.equal(replayed?.watchNode.id, watchNode.id);
    assert.equal(replayed?.replayRecordedAt, recordedSummary?.ts);
    assert.notEqual(replayed?.execution.rootRunId, execution.rootRunId);
    assert.notEqual(replayed?.summary.selectedIteration?.graphRunId, selectedIterationExecution.graphRunId);
  });

  void it('records and replays the accepted Watch Stop terminal marker', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: { ['value' as PortId]: { type: 'string', value: 'accepted result' } },
      processId,
      streamingWatchTerminal: true,
      execution,
    });
    await sourceEmitter.emit('done', { results: {} });

    const recordedFinish = recorder.events.find((event) => event.type === 'nodeFinish');
    if (!recordedFinish || recordedFinish.type !== 'nodeFinish') {
      assert.fail('Expected the accepted Stop terminal to be recorded.');
    }
    assert.equal(recordedFinish.data.streamingWatchTerminal, true);

    const replayEmitter = new Emittery<ProcessEvents>();
    let replayedTerminal = false;
    replayEmitter.on('nodeFinish', (event) => {
      replayedTerminal = event.streamingWatchTerminal === true;
    });
    await replayFixture(ExecutionRecorder.deserializeFromString(recorder.serialize()), {
      emitter: replayEmitter,
    });

    assert.equal(replayedTerminal, true);
  });

  void it('records and replays LLM Chat output snapshots without creating node lifecycle events', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('nodeStart', { node, inputs: {}, processId, execution });
    await sourceEmitter.emit('llmChatOutputSnapshot', {
      nodeId,
      processId,
      entryId: 'model-round:0',
      roundIndex: 0,
      splitIndex: 0,
      kind: 'model-round',
      outcome: 'tool-calls',
      outputs: { ['response' as PortId]: { type: 'string', value: 'I will call a tool.' } },
      execution,
    });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: { ['response' as PortId]: { type: 'string', value: 'final answer' } },
      processId,
      execution,
    });
    await sourceEmitter.emit('done', { results: {} });

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['graphStart', 'nodeStart', 'llmChatOutputSnapshot', 'nodeFinish', 'done'],
    );

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayedSnapshots: ProcessEvents['llmChatOutputSnapshot'][] = [];
    let replayedNodeStarts = 0;
    replayEmitter.on('llmChatOutputSnapshot', (data) => void replayedSnapshots.push(data));
    replayEmitter.on('nodeStart', () => {
      replayedNodeStarts += 1;
    });
    await replayFixture(ExecutionRecorder.deserializeFromString(recorder.serialize()), {
      emitter: replayEmitter,
    });

    assert.equal(replayedNodeStarts, 1);
    assert.deepEqual(
      replayedSnapshots.map(({ entryId, roundIndex, splitIndex, kind, outcome, outputs }) => ({
        entryId,
        roundIndex,
        splitIndex,
        kind,
        outcome,
        outputs,
      })),
      [
        {
          entryId: 'model-round:0',
          roundIndex: 0,
          splitIndex: 0,
          kind: 'model-round',
          outcome: 'tool-calls',
          outputs: { ['response' as PortId]: { type: 'string', value: 'I will call a tool.' } },
        },
      ],
    );
  });

  void it('creates fresh replay identities per playback while preserving nested execution lineage', async () => {
    const subgraphId = 'subgraph-id' as GraphId;
    const rootNode = { id: 'root-node' as NodeId, type: 'test' } as ChartNode;
    const subgraphNode = { id: 'subgraph-node' as NodeId, type: 'test' } as ChartNode;
    const rootGraph: NodeGraph = {
      metadata: { id: graph.metadata!.id! },
      nodes: [rootNode],
      connections: [],
    };
    const subgraph: NodeGraph = {
      metadata: { id: subgraphId },
      nodes: [subgraphNode],
      connections: [],
    };
    const rootExecution: GraphExecutionMetadata = {
      graphId: rootGraph.metadata!.id!,
      graphRunId: 'recorded-root-graph-run' as GraphRunId,
      rootRunId: 'recorded-root-run' as RootRunId,
    };
    const subgraphExecution: GraphExecutionMetadata = {
      graphId: subgraphId,
      graphRunId: 'recorded-subgraph-run' as GraphRunId,
      rootRunId: rootExecution.rootRunId,
      parentGraphRunId: rootExecution.graphRunId,
      executor: {
        nodeId: rootNode.id,
        parentGraphId: rootExecution.graphId,
        processId: 'parent-process' as ProcessId,
      },
    };
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph: rootGraph, inputs: {}, execution: rootExecution });
    await sourceEmitter.emit('graphStart', { graph: subgraph, inputs: {}, execution: subgraphExecution });
    await sourceEmitter.emit('nodeStart', {
      node: subgraphNode,
      inputs: {},
      processId,
      execution: subgraphExecution,
    });
    await sourceEmitter.emit('nodeFinish', {
      node: subgraphNode,
      outputs: {},
      processId,
      execution: subgraphExecution,
    });
    await sourceEmitter.emit('graphFinish', { graph: subgraph, outputs: {}, execution: subgraphExecution });
    await sourceEmitter.emit('graphFinish', { graph: rootGraph, outputs: {}, execution: rootExecution });
    await sourceEmitter.emit('done', { results: {} });

    const replay = async () => {
      const replayEmitter = new Emittery<ProcessEvents>();
      const replayedGraphExecutions: GraphExecutionMetadata[] = [];
      const replayedNodeExecutions: GraphExecutionMetadata[] = [];
      replayEmitter.on('graphStart', (data) => void replayedGraphExecutions.push(data.execution));
      replayEmitter.on('nodeFinish', (data) => void replayedNodeExecutions.push(data.execution));
      await replayFixture(recorder, {
        emitter: replayEmitter,
        project: {
          metadata: {
            id: 'project-id' as ProjectId,
            title: 'Project',
            description: '',
            mainGraphId: rootGraph.metadata!.id!,
          },
          graphs: { [rootGraph.metadata!.id!]: rootGraph, [subgraphId]: subgraph },
        },
      });
      return { replayedGraphExecutions, replayedNodeExecutions };
    };

    const firstPlayback = await replay();
    const secondPlayback = await replay();
    const [firstRoot, firstSubgraph] = firstPlayback.replayedGraphExecutions;
    const [secondRoot, secondSubgraph] = secondPlayback.replayedGraphExecutions;

    assert.equal(firstPlayback.replayedGraphExecutions.length, 2);
    assert.equal(firstPlayback.replayedNodeExecutions.length, 1);
    assert.equal(firstRoot!.graphId, rootExecution.graphId);
    assert.equal(firstSubgraph!.graphId, subgraphExecution.graphId);
    assert.equal(firstSubgraph!.rootRunId, firstRoot!.rootRunId);
    assert.equal(firstSubgraph!.parentGraphRunId, firstRoot!.graphRunId);
    assert.deepEqual(firstSubgraph!.executor, subgraphExecution.executor);
    assert.equal(firstPlayback.replayedNodeExecutions[0]!.graphRunId, firstSubgraph!.graphRunId);
    assert.notEqual(firstRoot!.rootRunId, rootExecution.rootRunId);
    assert.notEqual(firstRoot!.graphRunId, rootExecution.graphRunId);
    assert.notEqual(firstSubgraph!.graphRunId, subgraphExecution.graphRunId);
    assert.notEqual(secondRoot!.rootRunId, firstRoot!.rootRunId);
    assert.notEqual(secondRoot!.graphRunId, firstRoot!.graphRunId);
    assert.notEqual(secondSubgraph!.graphRunId, firstSubgraph!.graphRunId);
    assert.equal(secondSubgraph!.parentGraphRunId, secondRoot!.graphRunId);
  });

  void it('replays retained same-graph Watch branch history under its replayed parent run', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    const rootExecution: GraphExecutionMetadata = {
      graphId: graph.metadata!.id!,
      graphRunId: 'recorded-root-run' as GraphRunId,
      rootRunId: 'recorded-root' as RootRunId,
    };
    const retainedWatchExecution: GraphExecutionMetadata = {
      graphId: graph.metadata!.id!,
      graphRunId: 'recorded-watch-child' as GraphRunId,
      parentGraphRunId: rootExecution.graphRunId,
      rootRunId: rootExecution.rootRunId,
    };
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution: rootExecution });
    // Watch iterations intentionally suppress graph lifecycle events: only the
    // retained node events are present in the recording.
    await sourceEmitter.emit('nodeStart', {
      node,
      inputs: {},
      processId: 'retained-watch-process' as ProcessId,
      execution: retainedWatchExecution,
    });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: {},
      processId: 'retained-watch-process' as ProcessId,
      execution: retainedWatchExecution,
    });
    await sourceEmitter.emit('done', { results: {} });

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayedExecutions: GraphExecutionMetadata[] = [];
    replayEmitter.on('graphStart', (data) => void replayedExecutions.push(data.execution));
    replayEmitter.on('nodeFinish', (data) => void replayedExecutions.push(data.execution));
    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    const [replayedRoot, replayedWatchChild] = replayedExecutions;
    assert.equal(replayedExecutions.length, 2);
    assert.equal(replayedWatchChild!.graphId, replayedRoot!.graphId);
    assert.equal(replayedWatchChild!.rootRunId, replayedRoot!.rootRunId);
    assert.equal(replayedWatchChild!.parentGraphRunId, replayedRoot!.graphRunId);
    assert.notEqual(replayedWatchChild!.graphRunId, replayedRoot!.graphRunId);
  });

  void it('adopts the playback processor identity for the first recorded root', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('nodeStart', { node, inputs: {}, processId, execution });
    await sourceEmitter.emit('nodeFinish', { node, outputs: {}, processId, execution });
    await sourceEmitter.emit('done', { results: {} });

    const initialReplayExecution: GraphExecutionMetadata = {
      graphId: graph.metadata!.id!,
      graphRunId: 'playback-graph-run' as GraphRunId,
      rootRunId: 'playback-root-run' as RootRunId,
    };
    const replayEmitter = new Emittery<ProcessEvents>();
    const replayedExecutions: GraphExecutionMetadata[] = [];
    replayEmitter.on('graphStart', (data) => void replayedExecutions.push(data.execution));
    replayEmitter.on('nodeFinish', (data) => void replayedExecutions.push(data.execution));

    await replayFixture(recorder, {
      emitter: replayEmitter,
      initialReplayExecution,
    });

    assert.deepEqual(replayedExecutions, [initialReplayExecution, initialReplayExecution]);
  });

  void it('preserves result origins through serialized executor events, recording, and replay', async () => {
    const recorder = new ExecutionRecorder({ includePartialOutputs: true });
    const socket = new FakeSocket();
    const finished = recorder.recordSocket(socket as unknown as WebSocket);

    const events = [
      {
        message: 'nodeStart',
        data: {
          node,
          inputs: {},
          processId,
          eventOccurredAt: 10_000,
          resultOrigin: 'editor-cache',
          execution,
        } satisfies SerializedProcessEventMap['nodeStart'],
      },
      {
        message: 'partialOutput',
        data: {
          node,
          outputs: { ['output' as PortId]: { type: 'string', value: 'partial' } },
          index: 0,
          processId,
          resultOrigin: 'executed',
          execution,
        } satisfies SerializedProcessEventMap['partialOutput'],
      },
      {
        message: 'nodeFinish',
        data: {
          node,
          outputs: { ['output' as PortId]: { type: 'string', value: 'finished' } },
          processId,
          eventOccurredAt: 10_070,
          resultOrigin: 'frozen',
          execution,
        } satisfies SerializedProcessEventMap['nodeFinish'],
      },
      {
        message: 'nodeError',
        data: {
          node,
          error: 'failed',
          processId,
          outputs: { ['requestBody' as PortId]: { type: 'string', value: 'preserved request' } },
          splitOutputs: { 1: { ['response' as PortId]: { type: 'string', value: 'preserved split response' } } },
          resultOrigin: 'preloaded',
          execution,
        } satisfies SerializedProcessEventMap['nodeError'],
      },
      {
        message: 'nodeExcluded',
        data: {
          node,
          inputs: {},
          outputs: {},
          reason: 'excluded',
          processId,
          resultOrigin: 'unknown',
          execution,
        } satisfies SerializedProcessEventMap['nodeExcluded'],
      },
    ] as const;

    for (const event of events) {
      socket.emit(event);
    }
    socket.emit({ message: 'done', data: { results: {} } satisfies SerializedProcessEventMap['done'] });
    await finished;

    assert.deepEqual(
      recorder.events
        .filter((event): event is Extract<RecordedEvents, { type: (typeof events)[number]['message'] }> =>
          events.some((expected) => expected.message === event.type),
        )
        .map((event) => ({
          type: event.type,
          resultOrigin: event.data.resultOrigin,
          ...(event.type === 'nodeStart' || event.type === 'nodeFinish' ? { occurredAt: event.occurredAt } : {}),
          ...(event.type === 'nodeError' ? { outputs: event.data.outputs, splitOutputs: event.data.splitOutputs } : {}),
        })),
      [
        { type: 'nodeStart', resultOrigin: 'editor-cache', occurredAt: 10_000 },
        { type: 'partialOutput', resultOrigin: 'executed' },
        { type: 'nodeFinish', resultOrigin: 'frozen', occurredAt: 10_070 },
        {
          type: 'nodeError',
          resultOrigin: 'preloaded',
          outputs: { ['requestBody' as PortId]: { type: 'string', value: 'preserved request' } },
          splitOutputs: { 1: { ['response' as PortId]: { type: 'string', value: 'preserved split response' } } },
        },
        { type: 'nodeExcluded', resultOrigin: 'unknown' },
      ],
    );

    const roundTripped = ExecutionRecorder.deserializeFromString(recorder.serialize());
    assert.deepEqual(
      roundTripped.events
        .filter((event) => event.type === 'nodeStart' || event.type === 'nodeFinish')
        .map((event) => ({ type: event.type, occurredAt: event.occurredAt })),
      [
        { type: 'nodeStart', occurredAt: 10_000 },
        { type: 'nodeFinish', occurredAt: 10_070 },
      ],
    );
    assert.deepEqual(await replayNodeResultOrigins(roundTripped), [
      { type: 'nodeStart', resultOrigin: 'editor-cache' },
      { type: 'partialOutput', resultOrigin: 'executed' },
      { type: 'nodeFinish', resultOrigin: 'frozen' },
      {
        type: 'nodeError',
        resultOrigin: 'preloaded',
        outputs: { ['requestBody' as PortId]: { type: 'string', value: 'preserved request' } },
        splitOutputs: { 1: { ['response' as PortId]: { type: 'string', value: 'preserved split response' } } },
      },
      { type: 'nodeExcluded', resultOrigin: 'unknown' },
    ]);

    const legacySerialized = JSON.parse(recorder.serialize()) as {
      recording: { events: Array<{ type: string; data: { resultOrigin?: NodeResultOrigin } }> };
    };
    for (const event of legacySerialized.recording.events) {
      delete event.data.resultOrigin;
    }
    const legacyRecorder = ExecutionRecorder.deserializeFromString(JSON.stringify(legacySerialized));
    assert.deepEqual(
      await replayNodeResultOrigins(legacyRecorder),
      events.map((event) => ({
        type: event.message,
        resultOrigin: undefined,
        ...(event.message === 'nodeError' ? { outputs: event.data.outputs } : {}),
        ...(event.message === 'nodeError' ? { splitOutputs: event.data.splitOutputs } : {}),
      })),
    );
  });

  void it('records and replays privacy-bounded model, profile, and tool trace events', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);
    const modelEvent: ProcessEvents['llmCallFinished'] = {
      execution,
      callId: 'call-1' as never,
      nodeId,
      processId,
      provider: 'openai',
      model: 'gpt-5',
      outcome: 'success',
      attemptIndex: 0,
      startedAt: 100,
      durationMs: 25,
      normalizedUsage: { promptTokens: 10, completionTokens: 4 },
      pricing: { status: 'unknown' },
    };
    const toolEvent: ProcessEvents['toolCallFinished'] = {
      execution,
      toolCallId: 'tool-1',
      toolName: 'lookup',
      sourceNodeId: nodeId,
      sourceProcessId: processId,
      resultOwner: {
        nodeId: 'delegate-node' as NodeId,
        processId: 'delegate-process' as ProcessId,
        outputPortId: 'output' as PortId,
      },
      handlerKind: 'graph',
      handlerGraphId: graph.metadata!.id,
      handlerName: 'Lookup',
      outcome: 'success',
      startedAt: 130,
      durationMs: 15,
    };
    const profileAttemptEvent: ProcessEvents['llmProfileAttempt'] = {
      execution,
      eventId: 'profile-attempt-1',
      roundIndex: 0,
      profileIndex: 0,
      nodeId,
      processId,
      provider: 'openai',
      model: 'gpt-5',
      stage: 'health-gate',
      outcome: 'skipped',
      profileHealthKey: 'llm-profile:sha256:primary',
      healthState: 'open',
      healthDisposition: 'deny',
      retryAt: 1_000,
    };

    await emitter.emit('llmCallFinished', modelEvent);
    await emitter.emit('llmProfileAttempt', profileAttemptEvent);
    await emitter.emit('toolCallFinished', toolEvent);
    await emitter.emit('done', { results: {} });

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayed: unknown[] = [];
    replayEmitter.on('llmCallFinished', (event) => void replayed.push(event));
    replayEmitter.on('llmProfileAttempt', (event) => void replayed.push(event));
    replayEmitter.on('toolCallFinished', (event) => void replayed.push(event));

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    assert.equal(replayed.length, 3);
    const [replayedModelEvent, replayedProfileAttemptEvent, replayedToolEvent] = replayed as [
      ProcessEvents['llmCallFinished'],
      ProcessEvents['llmProfileAttempt'],
      ProcessEvents['toolCallFinished'],
    ];
    const recordedTimestamps = new Map(recorder.events.map((event) => [event.type, event.ts]));
    const withoutReplayProvenance = <T extends { execution: unknown; replayRecordedAt?: number }>(event: T) => {
      const { execution: _execution, replayRecordedAt: _replayRecordedAt, ...rest } = event;
      return rest;
    };
    assert.deepEqual(withoutReplayProvenance(replayedModelEvent), withoutReplayProvenance(modelEvent));
    assert.deepEqual(
      withoutReplayProvenance(replayedProfileAttemptEvent),
      withoutReplayProvenance(profileAttemptEvent),
    );
    assert.deepEqual(withoutReplayProvenance(replayedToolEvent), withoutReplayProvenance(toolEvent));
    assert.equal(replayedModelEvent.replayRecordedAt, recordedTimestamps.get('llmCallFinished'));
    assert.equal(replayedProfileAttemptEvent.replayRecordedAt, recordedTimestamps.get('llmProfileAttempt'));
    assert.equal(replayedToolEvent.replayRecordedAt, recordedTimestamps.get('toolCallFinished'));
    assert.equal(replayedModelEvent.execution.graphId, execution.graphId);
    assert.equal(replayedProfileAttemptEvent.execution.graphId, execution.graphId);
    assert.equal(replayedToolEvent.execution.graphId, execution.graphId);
    assert.equal(replayedModelEvent.execution.rootRunId, replayedToolEvent.execution.rootRunId);
    assert.equal(replayedModelEvent.execution.graphRunId, replayedToolEvent.execution.graphRunId);
    assert.notEqual(replayedModelEvent.execution.rootRunId, execution.rootRunId);
    assert.notEqual(replayedModelEvent.execution.graphRunId, execution.graphRunId);
    assert.equal('rawUsage' in (replayed[0] as object), false);
    assert.equal('arguments' in (replayed[1] as object), false);
    assert.equal('result' in (replayed[1] as object), false);
  });

  void it('preserves recorded node finish duration during replay', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    await emitter.emit('nodeStart', {
      node,
      inputs: {},
      processId,
      execution,
    });
    await emitter.emit('nodeFinish', {
      node,
      outputs: {},
      processId,
      durationMs: 123,
      splitRunDurationMs: { 0: 40, 1: 83 },
      execution,
    });
    await emitter.emit('done', { results: {} });

    const nodeFinishEvent = recorder.events.find((event) => event.type === 'nodeFinish');
    assert.equal(nodeFinishEvent?.data.durationMs, 123);
    assert.deepEqual(nodeFinishEvent?.data.splitRunDurationMs, { 0: 40, 1: 83 });
    assert.deepEqual(await replayNodeFinishTiming(recorder), {
      durationMs: 123,
      splitRunDurationMs: { 0: 40, 1: 83 },
    });
  });

  void it('attaches the original recording timestamp to replayed lifecycle events', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('nodeStart', { node, inputs: {}, processId, execution });
    await sourceEmitter.emit('nodeFinish', { node, outputs: {}, processId, execution });
    await sourceEmitter.emit('graphFinish', { graph, outputs: {}, execution });
    await sourceEmitter.emit('done', { results: {} });

    const timestamps = new Map(recorder.events.map((event) => [event.type, event.ts]));
    const replayEmitter = new Emittery<ProcessEvents>();
    const replayed: Array<{ type: string; replayRecordedAt?: number }> = [];
    for (const type of ['graphStart', 'nodeStart', 'nodeFinish', 'graphFinish', 'done'] as const) {
      replayEmitter.on(type, (data) => void replayed.push({ type, replayRecordedAt: data.replayRecordedAt }));
    }

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    assert.deepEqual(
      replayed,
      (['graphStart', 'nodeStart', 'nodeFinish', 'graphFinish', 'done'] as const).map((type) => ({
        type,
        replayRecordedAt: timestamps.get(type),
      })),
    );
  });

  void it('preserves deferred Watch event occurrence time separately from append order', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('nodeStart', {
      node,
      inputs: {},
      processId,
      execution,
      eventOccurredAt: 10_000,
    });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: {},
      processId,
      execution,
      eventOccurredAt: 10_070,
    });
    await sourceEmitter.emit('done', { results: {} });

    const recordedStart = recorder.events.find((event) => event.type === 'nodeStart');
    const recordedFinish = recorder.events.find((event) => event.type === 'nodeFinish');
    assert.equal(recordedStart?.occurredAt, 10_000);
    assert.equal(recordedFinish?.occurredAt, 10_070);
    assert.equal('eventOccurredAt' in (recordedStart?.data ?? {}), false);
    assert.equal('eventOccurredAt' in (recordedFinish?.data ?? {}), false);

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayed: Array<{ type: string; replayRecordedAt?: number }> = [];
    replayEmitter.on(
      'nodeStart',
      (data) => void replayed.push({ type: 'nodeStart', replayRecordedAt: data.replayRecordedAt }),
    );
    replayEmitter.on(
      'nodeFinish',
      (data) => void replayed.push({ type: 'nodeFinish', replayRecordedAt: data.replayRecordedAt }),
    );

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    assert.deepEqual(replayed, [
      { type: 'nodeStart', replayRecordedAt: 10_000 },
      { type: 'nodeFinish', replayRecordedAt: 10_070 },
    ]);
  });

  void it('does not persist transient replay timing when replay is recorded again', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    await emitter.emit('nodeStart', {
      node,
      inputs: {},
      processId,
      execution,
      replayRecordedAt: 12_345,
    });
    await emitter.emit('done', { results: {}, replayRecordedAt: 12_678 });

    assert.equal(
      'replayRecordedAt' in (recorder.events.find((event) => event.type === 'nodeStart')?.data ?? {}),
      false,
    );
    assert.equal('replayRecordedAt' in (recorder.events.find((event) => event.type === 'done')?.data ?? {}), false);
  });

  void it('preserves value-free node-start wiring snapshots during replay', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);
    const inputConnections = [
      {
        outputNodeId: 'source-node' as NodeId,
        outputId: 'output' as PortId,
        inputNodeId: nodeId,
        inputId: 'input' as PortId,
      },
    ];

    await emitter.emit('nodeStart', { node, inputs: {}, inputConnections, processId, execution });
    await emitter.emit('done', { results: {} });
    assert.deepEqual(
      recorder.events.find((event) => event.type === 'nodeStart')?.data.inputConnections,
      inputConnections,
    );

    const replayEmitter = new Emittery<ProcessEvents>();
    let replayedConnections: ProcessEvents['nodeStart']['inputConnections'];
    replayEmitter.on('nodeStart', (data) => {
      replayedConnections = data.inputConnections;
    });
    await replayFixture(recorder, {
      emitter: replayEmitter,
    });
    assert.deepEqual(replayedConnections, inputConnections);
  });

  void it('re-emits recorded pause and resume events without pausing playback itself', async () => {
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', { graph, inputs: {}, execution });
    await sourceEmitter.emit('pause', undefined);
    await sourceEmitter.emit('resume', undefined);
    await sourceEmitter.emit('done', { results: {} });

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayedLifecycle: string[] = [];
    const replayedPauseData: ProcessEvents['pause'][] = [];
    const replayedResumeData: ProcessEvents['resume'][] = [];
    replayEmitter.on('graphStart', () => void replayedLifecycle.push('graphStart'));
    replayEmitter.on('pause', (data) => {
      replayedLifecycle.push('pause');
      replayedPauseData.push(data);
    });
    replayEmitter.on('resume', (data) => {
      replayedLifecycle.push('resume');
      replayedResumeData.push(data);
    });
    replayEmitter.on('done', () => void replayedLifecycle.push('done'));

    await replayFixture(recorder, {
      emitter: replayEmitter,
    });

    assert.deepEqual(replayedLifecycle, ['graphStart', 'pause', 'resume', 'done']);
    assert.deepEqual(replayedPauseData, [{ isReplay: true }]);
    assert.deepEqual(replayedResumeData, [{ isReplay: true }]);
  });

  void it('derives legacy node finish duration from recorded timestamps when missing', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    await emitter.emit('nodeStart', {
      node,
      inputs: {},
      processId,
      execution,
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await emitter.emit('nodeFinish', {
      node,
      outputs: {},
      processId,
      execution,
    });
    await emitter.emit('done', { results: {} });

    const nodeFinishEvent = recorder.events.find((event) => event.type === 'nodeFinish');
    assert.equal(Object.prototype.hasOwnProperty.call(nodeFinishEvent!.data, 'durationMs'), false);
    assert.ok((await replayNodeFinishTiming(recorder)).durationMs! >= 0);
  });

  void it('keeps processor recordings open after successful abort until done', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    let finished = false;
    const recordingFinished = recorder.once('finish').then(() => {
      finished = true;
    });

    await emitter.emit('abort', { successful: true });
    await emitter.emit('nodeFinish', {
      node,
      outputs: { ['output' as PortId]: { type: 'string', value: 'late' } },
      processId,
      execution,
    });
    await Promise.resolve();

    assert.equal(finished, false);
    await emitter.emit('done', { results: { output: { type: 'string', value: 'final' } } });
    await emitter.emit('finish', undefined);
    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort', 'nodeFinish', 'done'],
    );
  });

  void it('keeps processor recordings open through unsuccessful abort cleanup', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    let finished = false;
    const recordingFinished = recorder.once('finish').then(() => {
      finished = true;
    });

    await emitter.emit('abort', { successful: false, error: 'stopped' });
    await emitter.emit('nodeError', {
      node,
      error: new Error('cleanup failure'),
      outputs: { ['requestBody' as PortId]: { type: 'string', value: 'preserved request' } },
      processId,
      execution,
    });
    await Promise.resolve();

    assert.equal(finished, false);
    await emitter.emit('error', { error: new Error('stopped') });
    await emitter.emit('finish', undefined);
    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort', 'nodeError', 'error'],
    );
    const nodeError = recorder.events.find((event) => event.type === 'nodeError');
    assert.deepEqual(nodeError?.data.outputs, { requestBody: { type: 'string', value: 'preserved request' } });
  });

  void it('ignores non-event frames and prototype names while recording remote sockets', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    try {
      assert.doesNotThrow(() => socket.emitRaw('{invalid JSON'));
      for (const frame of [
        null,
        42,
        'control frame',
        [],
        {},
        { message: 42 },
        { message: '__proto__', data: {} },
        { message: 'constructor', data: {} },
        { message: 'toString', data: {} },
        { message: 'codeConsole', data: { level: 'log', args: ['debug-only'] } },
      ]) {
        assert.doesNotThrow(() => socket.emit(frame), `Rejected frame: ${JSON.stringify(frame)}`);
      }
      const value = { type: 'string', value: 'preserved named event' };
      socket.emit({ message: 'globalSet:counter', data: value });
      socket.emit({ message: 'userEvent:constructor', data: value });
      socket.emit({ message: 'done', data: { results: { output: value } } });
      await recordingFinished;

      assert.deepEqual(
        recorder.events.map(({ type, data }) => ({ type, data })),
        [
          { type: 'globalSet:counter', data: value },
          { type: 'userEvent:constructor', data: value },
          { type: 'done', data: { results: { output: value } } },
        ],
      );
      assert.equal(socket.listenerCount, 0);
    } finally {
      socket.close();
      await recordingFinished;
    }
  });

  void it('records only replayable events from its scoped remote request', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket, {
      requestId: 'evaluation-request',
    });

    socket.emit({
      message: 'webAppStoragePatch',
      data: { storagePatch: {} },
      requestId: 'evaluation-request',
    });
    socket.emit({
      message: 'nodeFinish',
      data: { node, outputs: {}, processId, execution },
      requestId: 'another-request',
    });
    socket.emit({
      message: 'done',
      data: { results: { output: { type: 'string', value: 'kept' } } },
      requestId: 'evaluation-request',
    });

    await recordingFinished;
    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['done'],
    );
  });

  void it('stops a scoped remote recorder when its owning evaluation request is abandoned', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const abortController = new AbortController();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket, {
      requestId: 'evaluation-request',
      signal: abortController.signal,
    });

    socket.emit({
      message: 'nodeStart',
      data: { node, inputs: {}, processId, execution },
      requestId: 'evaluation-request',
    });
    abortController.abort();
    await recordingFinished;

    // A late event from the now-unowned request cannot leak into a later
    // evaluation recording through the shared debugger socket.
    socket.emit({
      message: 'done',
      data: { results: {} },
      requestId: 'evaluation-request',
    });
    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['nodeStart'],
    );
  });

  void it('keeps remote socket recordings open after successful abort until done', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    let finished = false;
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket).then(() => {
      finished = true;
    });

    socket.emit({
      message: 'abort',
      data: { successful: true },
    });
    socket.emit({
      message: 'nodeFinish',
      data: {
        node,
        outputs: { ['output' as PortId]: { type: 'string', value: 'late' } },
        processId,
        execution,
      },
    });
    await Promise.resolve();

    assert.equal(finished, false);

    socket.emit({
      message: 'done',
      data: {
        results: {
          output: { type: 'string', value: 'final' },
        },
      },
    });

    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort', 'nodeFinish', 'done'],
    );
  });

  void it('keeps remote socket recordings open through unsuccessful abort cleanup', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({
      message: 'abort',
      data: { successful: false, error: 'stopped' },
    });
    socket.emit({
      message: 'nodeError',
      data: {
        node,
        error: 'Error: cleanup failure',
        outputs: { ['requestBody' as PortId]: { type: 'string', value: 'preserved request' } },
        processId,
        execution,
      },
    });
    socket.emit({
      message: 'error',
      data: { error: 'Error: stopped' },
    });

    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort', 'nodeError', 'error'],
    );
  });

  void it('settles socket capture without fabricating a completed recording when its owner disconnects', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    let emittedFinishedRecording = false;
    recorder.on('finish', () => {
      emittedFinishedRecording = true;
    });
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({
      message: 'graphStart',
      data: { graph, inputs: {}, execution },
    });
    socket.close();
    await recordingFinished;
    await Promise.resolve();

    assert.equal(emittedFinishedRecording, false);
    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['graphStart'],
    );
  });

  void it('normalizes legacy null socket abort payloads without marking them successful', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({ message: 'abort', data: null });
    socket.emit({ message: 'error', data: { error: 'Error: stopped' } });
    await recordingFinished;

    const abort = recorder.events.find((event) => event.type === 'abort');
    assert.equal(abort?.data.successful, false);
  });

  void it('returns recording snapshots whose event array cannot be mutated by later capture', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    await emitter.emit('start', {
      project: { metadata: { id: 'project-id' as any } } as any,
      contextValues: {},
      inputs: {},
      startGraph: graph,
      execution,
    });
    const snapshot = recorder.getRecording();
    await emitter.emit('nodeStart', {
      node,
      inputs: {},
      processId,
      execution,
    });

    assert.deepEqual(
      snapshot.events.map((event) => event.type),
      ['start'],
    );
    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['start', 'nodeStart'],
    );
  });

  void it('emits a scoped failed replay lifecycle when the recording cannot resolve its first graph', async () => {
    const missingGraphId = 'missing-recorded-graph' as GraphId;
    const missingExecution: GraphExecutionMetadata = {
      graphId: missingGraphId,
      graphRunId: 'missing-recorded-graph-run' as GraphRunId,
      rootRunId: 'missing-recorded-root-run' as RootRunId,
    };
    const recorder = new ExecutionRecorder();
    const sourceEmitter = new Emittery<ProcessEvents>();
    recorder.record(sourceEmitter as unknown as GraphProcessor);
    await sourceEmitter.emit('graphStart', {
      graph: { metadata: { id: missingGraphId }, nodes: [], connections: [] },
      inputs: {},
      execution: missingExecution,
    });

    const replayEmitter = new Emittery<ProcessEvents>();
    const graphErrors: ProcessEvents['graphError'][] = [];
    const errors: ProcessEvents['error'][] = [];
    replayEmitter.on('graphError', (data) => void graphErrors.push(data));
    replayEmitter.on('error', (data) => void errors.push(data));
    let running = true;

    await replayFixture(recorder, {
      emitter: replayEmitter,
      setRunning: (nextRunning) => {
        running = nextRunning;
      },
    });
    await Promise.resolve();

    assert.equal(graphErrors.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(graphErrors[0]!.graph.metadata!.id, graph.metadata!.id);
    assert.notEqual(graphErrors[0]!.execution.rootRunId, missingExecution.rootRunId);
    assert.match(String(graphErrors[0]!.error), /missing-recorded-graph/);
    assert.equal(running, false);
  });

  void it('materializes scoped replay lifecycles for terminal-only recordings', async () => {
    const replayTargetGraph: NodeGraph = {
      ...graph,
      metadata: { id: 'selected-replay-graph' as GraphId },
    };
    const results = { output: { type: 'string' as const, value: 'terminal output' } };

    const scenarios = [
      {
        name: 'completed',
        expectedEvents: ['graphFinish', 'done'],
        expectedGraphEvent: 'graphFinish',
        record: async (emitter: Emittery<ProcessEvents>) => {
          await emitter.emit('done', { results });
        },
      },
      {
        name: 'failed',
        expectedEvents: ['graphError', 'error'],
        expectedGraphEvent: 'graphError',
        record: async (emitter: Emittery<ProcessEvents>) => {
          await emitter.emit('error', { error: new Error('preflight validation failed') });
        },
      },
      {
        name: 'aborted',
        expectedEvents: ['graphAbort', 'abort'],
        expectedGraphEvent: 'graphAbort',
        record: async (emitter: Emittery<ProcessEvents>) => {
          await emitter.emit('abort', { successful: false, error: 'stopped before graph start' });
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const recorder = new ExecutionRecorder();
      const sourceEmitter = new Emittery<ProcessEvents>();
      recorder.record(sourceEmitter as unknown as GraphProcessor);
      await scenario.record(sourceEmitter);

      const replayEmitter = new Emittery<ProcessEvents>();
      const lifecycleEvents: string[] = [];
      let terminalGraphId: GraphId | undefined;
      let terminalError: Error | string | undefined;
      let terminalOutputs: Record<string, DataValue> | undefined;
      let running = true;

      replayEmitter.on('graphFinish', (event) => {
        lifecycleEvents.push('graphFinish');
        terminalGraphId = event.graph.metadata?.id;
        terminalOutputs = event.outputs;
      });
      replayEmitter.on('graphError', (event) => {
        lifecycleEvents.push('graphError');
        terminalGraphId = event.graph.metadata?.id;
        terminalError = event.error;
      });
      replayEmitter.on('graphAbort', (event) => {
        lifecycleEvents.push('graphAbort');
        terminalGraphId = event.graph.metadata?.id;
        terminalError = event.error;
      });
      replayEmitter.on('done', () => void lifecycleEvents.push('done'));
      replayEmitter.on('error', () => void lifecycleEvents.push('error'));
      replayEmitter.on('abort', () => void lifecycleEvents.push('abort'));

      await replayFixture(recorder, {
        emitter: replayEmitter,
        fallbackGraphId: replayTargetGraph.metadata!.id!,
        project: {
          metadata: {
            id: 'project-id' as ProjectId,
            title: 'Project',
            description: '',
            mainGraphId: graph.metadata!.id!,
          },
          graphs: { [graph.metadata!.id!]: graph, [replayTargetGraph.metadata!.id!]: replayTargetGraph },
        },
        setRunning: (nextRunning) => {
          running = nextRunning;
        },
      });
      await Promise.resolve();

      assert.deepEqual(lifecycleEvents, scenario.expectedEvents, scenario.name);
      assert.equal(terminalGraphId, replayTargetGraph.metadata?.id, scenario.name);
      if (scenario.name === 'completed') {
        assert.deepEqual(terminalOutputs, results);
      } else if (scenario.name === 'failed') {
        assert.match(String(terminalError), /preflight validation failed/);
      } else {
        assert.match(String(terminalError), /stopped before graph start/);
      }
      assert.equal(running, false, scenario.name);
    }
  });

  void it('preserves accessor order, custom JSON values and sparse arrays in the v1 codec', () => {
    const calls: string[] = [];
    const value = {
      ['__proto__']: 'ordinary own key',
      get first() {
        calls.push('first');
        return {
          get nested() {
            calls.push('nested');
            return 1;
          },
        };
      },
      get second() {
        calls.push('second');
        return [undefined, , NaN];
      },
      custom: new (class {
        toJSON() {
          calls.push('custom');
          return 'custom value';
        }
      })(),
    };
    const recorder = new ExecutionRecorder();
    recorder.recordingId = 'codec' as never;
    recorder.events.push({ type: 'done', ts: 1, data: { results: { output: { type: 'any', value } } } });
    const decoded = ExecutionRecorder.deserializeFromString(recorder.serialize());
    assert.deepEqual(calls, ['first', 'second', 'nested', 'custom']);
    assert.deepEqual(decoded.events[0]?.data, {
      results: {
        output: {
          type: 'any',
          value: {
            ['__proto__']: 'ordinary own key',
            first: { nested: 1 },
            second: [null, null, null],
            custom: 'custom value',
          },
        },
      },
    });
  });

  void it('preserves v1 collision-table order when the same object appears again', () => {
    const first = 'costarring-recording-hash-collision-fixture';
    const second = 'liquid-recording-hash-collision-fixture';
    const shared = { value: first };
    const recorder = new ExecutionRecorder();
    recorder.recordingId = 'collision-order' as never;
    recorder.events.push({
      type: 'done',
      ts: 1,
      data: {
        results: {
          output: { type: 'any', value: [shared, { value: second }, shared] },
        },
      },
    });
    assert.equal(JSON.parse(recorder.serialize()).strings['1910960879'], first);
    assert.equal(shared.value, first, 'Serialization cannot replace the source value with an encoded reference.');
  });

  void it('preserves remote socket node finish duration', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({
      message: 'nodeFinish',
      data: {
        node,
        outputs: {},
        processId,
        durationMs: 42,
        splitRunDurationMs: { 0: 20, 1: 22 },
        execution,
      },
    });
    socket.emit({
      message: 'done',
      data: {
        results: {},
      },
    });

    await recordingFinished;

    const nodeFinishEvent = recorder.events.find((event) => event.type === 'nodeFinish');
    assert.equal(nodeFinishEvent?.data.durationMs, 42);
    assert.deepEqual(nodeFinishEvent?.data.splitRunDurationMs, { 0: 20, 1: 22 });
  });
});
