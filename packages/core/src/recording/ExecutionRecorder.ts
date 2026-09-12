import { nanoid } from 'nanoid/non-secure';
import {
  type GraphExecutionMetadata,
  type GraphProcessor,
  type ProcessEvents,
  type RecordedEvent,
  type RecordedEvents,
  type Recording,
  type RecordingId,
  type SerializedRecording,
} from '../index.js';
import Emittery from 'emittery';
import { uint8ArrayToBase64Sync, base64ToUint8Array } from '../utils/base64.js';
import { isPlainObject } from 'lodash-es';
import { stringifyJsonStream, type SerializableJsonValue, parseJsonStream, streamToIterable } from 'json-stream-es';
import fnv1a from '../vendor/fnv1a.js';
import { emitDetached } from '../utils/emitDetached.js';

export type ExecutionRecorderEvents = {
  finish: { recording: Recording };
};

function withExecution<T extends object>(
  base: T,
  execution: GraphExecutionMetadata | undefined,
): T & { execution?: GraphExecutionMetadata } {
  return (execution == null ? base : { ...base, execution }) as T & { execution?: GraphExecutionMetadata };
}

function withDuration<T extends object>(
  base: T,
  durationMs: number | undefined,
  splitRunDurationMs?: Record<number, number>,
): T & { durationMs?: number; splitRunDurationMs?: Record<number, number> } {
  return {
    ...base,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(splitRunDurationMs === undefined ? {} : { splitRunDurationMs }),
  } as T & { durationMs?: number; splitRunDurationMs?: Record<number, number> };
}

const toRecordedEventMap: {
  [P in keyof ProcessEvents]: (data: ProcessEvents[P]) => RecordedEvent<P>['data'];
} = {
  graphStart: ({ graph, inputs, execution }) => withExecution({ graphId: graph.metadata!.id!, inputs }, execution),
  graphFinish: ({ graph, outputs, execution }) => withExecution({ graphId: graph.metadata!.id!, outputs }, execution),
  graphOutputsReady: ({ graph, outputs, execution }) =>
    withExecution({ graphId: graph.metadata!.id!, outputs }, execution),
  graphError: ({ graph, error, execution }) =>
    withExecution(
      {
        graphId: graph.metadata!.id!,
        error: typeof error === 'string' ? error : error.stack!,
      },
      execution,
    ),
  nodeStart: ({ node, inputs, inputConnections, processId, resultOrigin, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        inputs,
        ...(inputConnections == null ? {} : { inputConnections }),
        processId,
        ...(resultOrigin === undefined ? {} : { resultOrigin }),
      },
      execution,
    ),
  nodeFinish: ({ node, outputs, processId, resultOrigin, durationMs, splitRunDurationMs, streamingWatchTerminal, execution }) =>
    withExecution(
      withDuration(
        {
          nodeId: node.id,
          outputs,
          processId,
          ...(resultOrigin === undefined ? {} : { resultOrigin }),
          ...(streamingWatchTerminal ? { streamingWatchTerminal: true } : {}),
        },
        durationMs,
        splitRunDurationMs,
      ),
      execution,
    ),
  nodeError: ({ node, error, processId, outputs, splitOutputs, resultOrigin, durationMs, splitRunDurationMs, execution }) =>
    withExecution(
      withDuration(
        {
          nodeId: node.id,
          error: typeof error === 'string' ? error : error.stack!,
          processId,
          ...(outputs === undefined ? {} : { outputs }),
          ...(splitOutputs === undefined ? {} : { splitOutputs }),
          ...(resultOrigin === undefined ? {} : { resultOrigin }),
        },
        durationMs,
        splitRunDurationMs,
      ),
      execution,
    ),
  // Older debugger servers sent a null abort payload. Preserve that evidence
  // instead of letting a malformed legacy transport message abort the whole
  // recording. An unknown payload is deliberately treated as unsuccessful;
  // it must never be mistaken for a completed graph run during replay.
  abort: (data) => {
    const { successful, error } = data ?? {};
    return { successful: successful === true, error: typeof error === 'string' ? error : error?.stack };
  },
  graphAbort: ({ successful, error, graph, execution }) =>
    withExecution(
      {
        successful,
        error: typeof error === 'string' ? error : error?.stack,
        graphId: graph.metadata!.id!,
      },
      execution,
    ),
  nodeExcluded: ({ node, processId, inputs, outputs, reason, resultOrigin, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        processId,
        inputs,
        outputs,
        reason,
        ...(resultOrigin === undefined ? {} : { resultOrigin }),
      },
      execution,
    ),
  userInput: ({ node, inputs, callback, processId, inputStrings, renderingType, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        inputs,
        callback,
        processId,
        inputStrings,
        renderingType,
      },
      execution,
    ),
  partialOutput: ({ node, outputs, index, processId, resultOrigin, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        outputs,
        index,
        processId,
        ...(resultOrigin === undefined ? {} : { resultOrigin }),
      },
      execution,
    ),
  progress: ({ node, processId, progress, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        processId,
        progress,
      },
      execution,
    ),
  llmCallFinished: ({ execution, ...event }) => ({ ...event, execution }),
  llmChatOutputSnapshot: ({ execution, ...event }) => withExecution(event, execution),
  llmProfileAttempt: ({ execution, ...event }) => ({ ...event, execution }),
  toolCallFinished: ({ execution, ...event }) => ({ ...event, execution }),
  nodeOutputsCleared: ({ node, processId, execution }) =>
    withExecution(
      {
        nodeId: node.id,
        processId,
      },
      execution,
    ),
  streamingOutputWatchSummary: ({ watchNode, summary, execution }) =>
    withExecution({ watchNodeId: watchNode.id, summary }, execution),
  error: ({ error }) => ({
    error: typeof error === 'string' ? error : error.stack!,
  }),
  done: ({ results }) => ({ results }),
  globalSet: ({ id, processId, value, execution }) => withExecution({ id, processId, value }, execution),
  pause: () => void 0,
  resume: () => void 0,
  start: ({ contextValues, inputs, project, startGraph, execution }) =>
    withExecution(
      {
        contextValues,
        inputs,
        projectId: project.metadata!.id!,
        startGraph: startGraph.metadata!.id!,
      },
      execution,
    ),
  trace: (message) => message,
  newAbortController: () => {},
  finish: () => void 0,
};

const isPrefix = <const T extends string>(s: string, prefix: T): s is `${T}${string}` => s.startsWith(prefix);

function toRecordedEvent<T extends keyof ProcessEvents>(event: T, data: ProcessEvents[T]): RecordedEvents {
  if (isPrefix(event, 'globalSet:')) {
    return {
      type: event,
      data: data as ProcessEvents[`globalSet:${string}`],
      ts: Date.now(),
    };
  }

  if (isPrefix(event, 'userEvent:')) {
    return {
      type: event,
      data: data as ProcessEvents[`userEvent:${string}`],
      ts: Date.now(),
    };
  }

  const { recordableData, occurredAt } = omitTransientEventTiming(data);
  const recordedEvent: RecordedEvent<T> = {
    type: event,
    data: toRecordedEventMap[event](recordableData) as unknown as RecordedEvent<T>['data'],
    ts: Date.now(),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };

  return recordedEvent as RecordedEvents;
}

/**
 * Replay provenance belongs to the current delivery, not the historical event
 * itself. A deferred Watch event additionally carries the moment it occurred;
 * persist that separately while retaining the append-time `ts` so recording
 * order remains monotonic and replayable.
 */
function omitTransientEventTiming<T>(data: T): { recordableData: T; occurredAt: number | undefined } {
  if (data == null || typeof data !== 'object') return { recordableData: data, occurredAt: undefined };
  const {
    replayRecordedAt: _replayRecordedAt,
    eventOccurredAt,
    ...recordableData
  } = data as T & { replayRecordedAt?: number; eventOccurredAt?: unknown };
  return {
    recordableData: recordableData as T,
    occurredAt: isRecordedTimestamp(eventOccurredAt) ? eventOccurredAt : undefined,
  };
}

function isRecordedTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export type ExecutionRecorderOptions = {
  includePartialOutputs?: boolean;
  includeTrace?: boolean;
};

export type SocketRecordingOptions = {
  /** Record only the protocol messages belonging to one remote graph run. */
  requestId?: string;
  /**
   * Stop listening when the capture owner is disposed (for example, a socket
   * disconnect or a run that could not be sent). This is not a graph-abort
   * signal: graph cancellation keeps the recorder attached until the remote
   * run emits its final done/error message.
   */
  signal?: AbortSignal;
};

function isRecordableProcessEvent(message: string): message is keyof ProcessEvents {
  return message in toRecordedEventMap || isPrefix(message, 'globalSet:') || isPrefix(message, 'userEvent:');
}

// WebSocket.OPEN/CLOSED are static browser constants. Core is also used by
// Node transports that can supply a compatible socket without installing that
// browser global, so compare the standardized ready-state value directly.
const CLOSED_WEBSOCKET_READY_STATE = 3;

function mapValuesDeep(obj: any, fn: (value: any) => any): any {
  if (Array.isArray(obj)) {
    return obj.map((value) => {
      if (isPlainObject(value) || Array.isArray(value)) {
        return mapValuesDeep(value, fn);
      }
      return fn(value);
    });
  }

  if (isPlainObject(obj)) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        if (isPlainObject(value) || Array.isArray(value)) {
          return [key, mapValuesDeep(value, fn)];
        }
        return [key, fn(value)];
      }),
    );
  }

  return fn(obj);
}

function serializeToObject(recording: Recording) {
  const serialized: SerializedRecording = {
    version: 1,
    recording,
    assets: {},
    strings: {},
  };

  serialized.recording = mapValuesDeep(serialized.recording, (val) => {
    if (val instanceof Uint8Array) {
      const asString = uint8ArrayToBase64Sync(val);
      const existingAsset = Object.entries(serialized.assets).find(([, asset]) => asset === asString);

      if (!existingAsset) {
        const id = nanoid();
        serialized.assets[id] = asString;
        return `$ASSET:${id}`;
      } else {
        const [id] = existingAsset;
        return `$ASSET:${id}`;
      }
    }

    if (typeof val === 'string' && !val.startsWith('$ASSET:') && val.length > 30) {
      const hash = fnv1a(val, { size: 32 });
      serialized.strings[`${hash}`] = val;
      return `$STRING:${hash}`;
    }

    return val;
  }) as SerializedRecording['recording'];

  return serialized as SerializableJsonValue;
}

function deserializeFromObject(serializedRecording: SerializedRecording) {
  if (serializedRecording.version !== 1) {
    throw new Error('Unsupported serialized events version');
  }

  return mapValuesDeep(serializedRecording.recording, (val) => {
    if (typeof val === 'string' && val.startsWith('$ASSET:')) {
      const id = val.slice('$ASSET:'.length);
      const asset = serializedRecording.assets?.[id];
      if (asset) {
        return new Uint8Array(base64ToUint8Array(asset));
      } else {
        return val;
      }
    }

    if (typeof val === 'string' && val.startsWith('$STRING:')) {
      const hash = val.slice('$STRING:'.length);
      const string = serializedRecording.strings?.[hash];
      if (string) {
        return string;
      }
    }

    return val;
  }) as Recording;
}

export class ExecutionRecorder {
  #events: RecordedEvents[] = [];
  recordingId: RecordingId | undefined;
  readonly #emitter: Emittery<ExecutionRecorderEvents>;

  readonly #includePartialOutputs: boolean;
  readonly #includeTrace: boolean;

  constructor(options: ExecutionRecorderOptions = {}) {
    this.#emitter = new Emittery();
    this.#emitter.bindMethods(this as unknown as Record<string, unknown>, ['on', 'off', 'once']);
    this.#includePartialOutputs = options.includePartialOutputs ?? false;
    this.#includeTrace = options.includeTrace ?? false;
  }

  on: Emittery<ExecutionRecorderEvents>['on'] = undefined!;
  off: Emittery<ExecutionRecorderEvents>['off'] = undefined!;
  once: Emittery<ExecutionRecorderEvents>['once'] = undefined!;

  recordSocket(channel: WebSocket, options: SocketRecordingOptions = {}) {
    return new Promise<void>((resolve) => {
      this.recordingId = nanoid() as RecordingId;

      let settled = false;
      const finish = (emitFinishedRecording: boolean) => {
        if (settled) return;
        settled = true;
        channel.removeEventListener('message', listener);
        channel.removeEventListener('close', onClose);
        options.signal?.removeEventListener('abort', onOwnerDisposed);
        if (emitFinishedRecording) {
          emitDetached(this.#emitter, 'finish', {
            recording: this.getRecording(),
          });
        }
        resolve();
      };

      const onClose = () => finish(false);
      const onOwnerDisposed = () => finish(false);

      const listener = (event: MessageEvent) => {
        let payload: { message?: unknown; data?: unknown; requestId?: unknown };
        try {
          payload = JSON.parse(event.data) as { message?: unknown; data?: unknown; requestId?: unknown };
        } catch {
          // A debugger socket can carry control-plane payloads alongside graph
          // events. They are not part of a replayable graph recording.
          return;
        }

        const { message, data, requestId } = payload;
        if (typeof message !== 'string' || !isRecordableProcessEvent(message)) {
          return;
        }

        if (options.requestId !== undefined && requestId !== options.requestId) {
          return;
        }

        if (this.#includePartialOutputs === false && message === 'partialOutput') {
          return;
        }

        if (this.#includeTrace === false && message === 'trace') {
          return;
        }

        this.#events.push(toRecordedEvent(message, data as never) as RecordedEvents);

        if (isSocketRecordingTerminalEvent(message)) {
          finish(true);
        }
      };

      if (options.signal?.aborted) {
        onOwnerDisposed();
        return;
      }
      channel.addEventListener('message', listener);
      channel.addEventListener('close', onClose, { once: true });
      options.signal?.addEventListener('abort', onOwnerDisposed, { once: true });

      if (channel.readyState === CLOSED_WEBSOCKET_READY_STATE) {
        onClose();
      }
    });
  }

  record(processor: GraphProcessor) {
    this.recordingId = nanoid() as RecordingId;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribeAny();
      unsubscribeFinish();
      emitDetached(this.#emitter, 'finish', {
        recording: this.getRecording(),
      });
    };

    const unsubscribeAny = processor.onAny((event: keyof ProcessEvents, data: ProcessEvents[keyof ProcessEvents]) => {
      if (settled || event === 'finish') {
        return;
      }
      if (this.#includePartialOutputs === false && event === 'partialOutput') {
        return;
      }

      if (this.#includeTrace === false && event === 'trace') {
        return;
      }

      this.#events.push(toRecordedEvent(event, data as never) as RecordedEvents);
    });
    const unsubscribeFinish = processor.on('finish', finish);
  }

  getRecording(): Recording {
    return {
      recordingId: this.recordingId!,
      // Callers persist and replay recordings asynchronously. Returning the
      // live backing array would let a later event mutate an already-finished
      // recording snapshot.
      events: [...this.#events],
      startTs: this.#events[0]?.ts ?? 0,
      finishTs: this.#events[this.#events.length - 1]?.ts ?? 0,
    };
  }

  get events() {
    return this.#events;
  }

  static deserializeFromString(serialized: string) {
    const recorder = new ExecutionRecorder();
    const recording = deserializeFromObject(JSON.parse(serialized) as SerializedRecording);

    recorder.recordingId = recording.recordingId;
    recorder.#events = recording.events;
    return recorder;
  }

  static async deserializeFromStream(serialized: ReadableStream) {
    const recorder = new ExecutionRecorder();

    let serializedRecording!: SerializedRecording;
    for await (const value of streamToIterable(serialized.pipeThrough(parseJsonStream(undefined)))) {
      serializedRecording = value as SerializedRecording;
      break;
    }

    const recording = deserializeFromObject(serializedRecording);

    recorder.recordingId = recording.recordingId;
    recorder.#events = recording.events;
    return recorder;
  }

  serialize() {
    return JSON.stringify(serializeToObject(this.getRecording()));
  }

  serializeStream() {
    return stringifyJsonStream(serializeToObject(this.getRecording()));
  }
}

function isSocketRecordingTerminalEvent(event: keyof ProcessEvents): boolean {
  return event === 'done' || event === 'error';
}
