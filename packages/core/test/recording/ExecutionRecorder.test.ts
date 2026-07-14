import Emittery from 'emittery';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { GraphId, NodeGraph } from '../../src/model/NodeGraph.js';
import type { GraphProcessor, ProcessEvents } from '../../src/model/GraphProcessor.js';
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
