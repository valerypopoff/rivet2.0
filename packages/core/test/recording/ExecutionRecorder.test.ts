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
      replayedEvents.map((event) => ({
        ...event,
        execution: event.execution
          ? {
              graphId: event.execution.graphId,
              graphRunId: event.execution.graphRunId,
              rootRunId: event.execution.rootRunId,
            }
          : undefined,
      })),
      [
        { type: 'graphStart', execution: execution },
        { type: 'partialOutput', execution: execution, index: 0, processId },
        { type: 'progress', execution: execution, processId },
        { type: 'nodeOutputsCleared', execution: execution, processId },
        { type: 'graphFinish', execution: execution },
      ],
    );
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

  void it('records and replays privacy-bounded model and tool trace events', async () => {
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
      handlerKind: 'graph',
      handlerGraphId: graph.metadata!.id,
      handlerName: 'Lookup',
      outcome: 'success',
      startedAt: 130,
      durationMs: 15,
    };

    await emitter.emit('llmCallFinished', modelEvent);
    await emitter.emit('toolCallFinished', toolEvent);
    await emitter.emit('done', { results: {} });

    const replayEmitter = new Emittery<ProcessEvents>();
    const replayed: unknown[] = [];
    replayEmitter.on('llmCallFinished', (event) => replayed.push(event));
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

    assert.deepEqual(replayed, [modelEvent, toolEvent]);
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
