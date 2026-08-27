import Emittery from 'emittery';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { GraphId, NodeGraph } from '../../src/model/NodeGraph.js';
import type { GraphProcessor, NodeResultOrigin, ProcessEvents } from '../../src/model/GraphProcessor.js';
import type { SerializedProcessEventMap } from '../../src/model/ExecutorProtocol.js';
import { replayExecutionRecording } from '../../src/model/RecordingPlayer.js';
import type { GraphExecutionMetadata, GraphRunId, ProcessId, RootRunId } from '../../src/model/ProcessContext.js';
import { ExecutionRecorder } from '../../src/recording/ExecutionRecorder.js';
import type { ChartNode, NodeId, PortId } from '../../src/model/NodeBase.js';
import type { UserInputNode } from '../../src/model/nodes/UserInputNode.js';
import { text } from 'node:stream/consumers';
import { Readable } from 'node:stream';

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

class FakeSocket {
  #listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(type: 'message', listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.#listeners.add(listener);
    }
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent) => void) {
    if (type === 'message') {
      this.#listeners.delete(listener);
    }
  }

  emit(message: unknown) {
    const event = { data: JSON.stringify(message) } as MessageEvent;
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

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
      outputs: { output: { type: 'string', value: 'partial' } },
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
      outputs: { output: { type: 'string', value: 'final' } },
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

  await replayExecutionRecording({
    emitter: replayEmitter,
    erroredNodes: new Map(),
    graphInputs: {},
    graphOutputs: {},
    isAborted: () => false,
    nodeResults: new Map(),
    project: {
      metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
      graphs: { [graph.metadata!.id!]: graph },
    } as any,
    recorder,
    recordingPlaybackChatLatency: 0,
    setContextValues: () => {},
    setGraphInputs: () => {},
    setGraphOutputs: () => {},
    setRunning: () => {},
    visitedNodes: new Set(),
    waitUntilUnpaused: async () => {},
  });

  return { durationMs, splitRunDurationMs };
}

async function replayNodeResultOrigins(
  recorder: ExecutionRecorder,
): Promise<Array<{ type: string; resultOrigin: NodeResultOrigin | undefined }>> {
  const replayEmitter = new Emittery<ProcessEvents>();
  const replayed: Array<{ type: string; resultOrigin: NodeResultOrigin | undefined }> = [];

  for (const type of ['nodeStart', 'partialOutput', 'nodeFinish', 'nodeError', 'nodeExcluded'] as const) {
    replayEmitter.on(type, (data) => replayed.push({ type, resultOrigin: data.resultOrigin }));
  }

  await replayExecutionRecording({
    emitter: replayEmitter,
    erroredNodes: new Map(),
    graphInputs: {},
    graphOutputs: {},
    isAborted: () => false,
    nodeResults: new Map(),
    project: {
      metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
      graphs: { [graph.metadata!.id!]: graph },
    } as any,
    recorder,
    recordingPlaybackChatLatency: 0,
    setContextValues: () => {},
    setGraphInputs: () => {},
    setGraphOutputs: () => {},
    setRunning: () => {},
    visitedNodes: new Set(),
    waitUntilUnpaused: async () => {},
  });

  return replayed;
}

void describe('ExecutionRecorder', () => {
  void it('should serialize an instance of ExecutionRecorder', async () => {
    // Simulate storage in string form
    const recordingToString = (recorder: ExecutionRecorder) => recorder.serialize();
    const recordingStreamToString = async (recorder: ExecutionRecorder) =>
      text(Readable.fromWeb(recorder.serializeStream() as any)); // cast needed due to incompatible Readable version types

    const stringToRecording = ExecutionRecorder.deserializeFromString;
    const streamToRecording = (str: string) =>
      ExecutionRecorder.deserializeFromStream(Readable.toWeb(Readable.from([str]))); // ReadableStream.from is only added in Node v20.6.0

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

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
      outputs: { response: { type: 'string', value: 'I will call a tool.' } },
      execution,
    });
    await sourceEmitter.emit('nodeFinish', {
      node,
      outputs: { response: { type: 'string', value: 'final answer' } },
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
    replayEmitter.on('llmChatOutputSnapshot', (data) => replayedSnapshots.push(data));
    replayEmitter.on('nodeStart', () => {
      replayedNodeStarts += 1;
    });
    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder: ExecutionRecorder.deserializeFromString(recorder.serialize()),
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
          outputs: { response: { type: 'string', value: 'I will call a tool.' } },
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
      replayEmitter.on('graphStart', (data) => replayedGraphExecutions.push(data.execution));
      replayEmitter.on('nodeFinish', (data) => replayedNodeExecutions.push(data.execution));
      await replayExecutionRecording({
        emitter: replayEmitter,
        erroredNodes: new Map(),
        graphInputs: {},
        graphOutputs: {},
        isAborted: () => false,
        nodeResults: new Map(),
        project: {
          metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: rootGraph.metadata!.id! },
          graphs: { [rootGraph.metadata!.id!]: rootGraph, [subgraphId]: subgraph },
        } as any,
        recorder,
        recordingPlaybackChatLatency: 0,
        setContextValues: () => {},
        setGraphInputs: () => {},
        setGraphOutputs: () => {},
        setRunning: () => {},
        visitedNodes: new Set(),
        waitUntilUnpaused: async () => {},
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
    replayEmitter.on('graphStart', (data) => replayedExecutions.push(data.execution));
    replayEmitter.on('nodeFinish', (data) => replayedExecutions.push(data.execution));

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      initialReplayExecution,
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
          resultOrigin: 'editor-cache',
          execution,
        } satisfies SerializedProcessEventMap['nodeStart'],
      },
      {
        message: 'partialOutput',
        data: {
          node,
          outputs: { output: { type: 'string', value: 'partial' } },
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
          outputs: { output: { type: 'string', value: 'finished' } },
          processId,
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
        .filter((event) => events.some((expected) => expected.message === event.type))
        .map((event) => ({ type: event.type, resultOrigin: event.data.resultOrigin })),
      [
        { type: 'nodeStart', resultOrigin: 'editor-cache' },
        { type: 'partialOutput', resultOrigin: 'executed' },
        { type: 'nodeFinish', resultOrigin: 'frozen' },
        { type: 'nodeError', resultOrigin: 'preloaded' },
        { type: 'nodeExcluded', resultOrigin: 'unknown' },
      ],
    );

    const roundTripped = ExecutionRecorder.deserializeFromString(recorder.serialize());
    assert.deepEqual(await replayNodeResultOrigins(roundTripped), [
      { type: 'nodeStart', resultOrigin: 'editor-cache' },
      { type: 'partialOutput', resultOrigin: 'executed' },
      { type: 'nodeFinish', resultOrigin: 'frozen' },
      { type: 'nodeError', resultOrigin: 'preloaded' },
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
      events.map((event) => ({ type: event.message, resultOrigin: undefined })),
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
    replayEmitter.on('llmCallFinished', (event) => replayed.push(event));
    replayEmitter.on('llmProfileAttempt', (event) => replayed.push(event));
    replayEmitter.on('toolCallFinished', (event) => replayed.push(event));

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
    });

    assert.equal(replayed.length, 3);
    const [replayedModelEvent, replayedProfileAttemptEvent, replayedToolEvent] = replayed as [
      ProcessEvents['llmCallFinished'],
      ProcessEvents['llmProfileAttempt'],
      ProcessEvents['toolCallFinished'],
    ];
    assert.deepEqual({ ...replayedModelEvent, execution: undefined }, { ...modelEvent, execution: undefined });
    assert.deepEqual(
      { ...replayedProfileAttemptEvent, execution: undefined },
      { ...profileAttemptEvent, execution: undefined },
    );
    assert.deepEqual({ ...replayedToolEvent, execution: undefined }, { ...toolEvent, execution: undefined });
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
      replayEmitter.on(type, (data) => replayed.push({ type, replayRecordedAt: data.replayRecordedAt }));
    }

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
    });

    assert.deepEqual(
      replayed,
      ['graphStart', 'nodeStart', 'nodeFinish', 'graphFinish', 'done'].map((type) => ({
        type,
        replayRecordedAt: timestamps.get(type),
      })),
    );
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

    assert.equal('replayRecordedAt' in (recorder.events[0]?.data ?? {}), false);
    assert.equal('replayRecordedAt' in (recorder.events[1]?.data ?? {}), false);
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
    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
    replayEmitter.on('graphStart', () => replayedLifecycle.push('graphStart'));
    replayEmitter.on('pause', (data) => {
      replayedLifecycle.push('pause');
      replayedPauseData.push(data);
    });
    replayEmitter.on('resume', (data) => {
      replayedLifecycle.push('resume');
      replayedResumeData.push(data);
    });
    replayEmitter.on('done', () => replayedLifecycle.push('done'));

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
      outputs: { output: { type: 'string', value: 'late' } },
      processId,
      execution,
    });
    await Promise.resolve();

    assert.equal(finished, false);
    await emitter.emit('done', { results: { output: { type: 'string', value: 'final' } } });
    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort', 'nodeFinish', 'done'],
    );
  });

  void it('finishes processor recordings on unsuccessful abort', async () => {
    const recorder = new ExecutionRecorder();
    const emitter = new Emittery<ProcessEvents>();
    recorder.record(emitter as unknown as GraphProcessor);

    const recordingFinished = recorder.once('finish');

    await emitter.emit('abort', { successful: false, error: 'stopped' });
    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort'],
    );
  });

  void it('ignores app-executor Code console messages when recording remote sockets', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({
      message: 'codeConsole',
      data: {
        level: 'log',
        args: ['debug-only'],
      },
    });
    socket.emit({
      message: 'done',
      data: {
        results: {
          output: { type: 'string', value: 'output' },
        },
      },
    });

    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['done'],
    );
  });

  void it('records only replayable events from its scoped remote request', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket, { requestId: 'evaluation-request' });

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
    assert.deepEqual(recorder.events.map((event) => event.type), ['done']);
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
    assert.deepEqual(recorder.events.map((event) => event.type), ['nodeStart']);
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
        outputs: { output: { type: 'string', value: 'late' } },
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

  void it('finishes remote socket recordings on unsuccessful abort', async () => {
    const recorder = new ExecutionRecorder();
    const socket = new FakeSocket();
    const recordingFinished = recorder.recordSocket(socket as unknown as WebSocket);

    socket.emit({
      message: 'abort',
      data: { successful: false, error: 'stopped' },
    });

    await recordingFinished;

    assert.deepEqual(
      recorder.events.map((event) => event.type),
      ['abort'],
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
    replayEmitter.on('graphError', (data) => graphErrors.push(data));
    replayEmitter.on('error', (data) => errors.push(data));
    let running = true;

    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: {
        metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
        graphs: { [graph.metadata!.id!]: graph },
      } as any,
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: (nextRunning) => {
        running = nextRunning;
      },
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
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
      replayEmitter.on('done', () => lifecycleEvents.push('done'));
      replayEmitter.on('error', () => lifecycleEvents.push('error'));
      replayEmitter.on('abort', () => lifecycleEvents.push('abort'));

      await replayExecutionRecording({
        emitter: replayEmitter,
        erroredNodes: new Map(),
        graphInputs: {},
        graphOutputs: {},
        fallbackGraphId: replayTargetGraph.metadata!.id!,
        isAborted: () => false,
        nodeResults: new Map(),
        project: {
          metadata: { id: 'project-id', title: 'Project', description: '', mainGraphId: graph.metadata!.id! },
          graphs: { [graph.metadata!.id!]: graph, [replayTargetGraph.metadata!.id!]: replayTargetGraph },
        } as any,
        recorder,
        recordingPlaybackChatLatency: 0,
        setContextValues: () => {},
        setGraphInputs: () => {},
        setGraphOutputs: () => {},
        setRunning: (nextRunning) => {
          running = nextRunning;
        },
        visitedNodes: new Set(),
        waitUntilUnpaused: async () => {},
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
