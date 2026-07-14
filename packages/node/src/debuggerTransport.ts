import WebSocket from 'ws';
import { WarningsPort, getError } from '@valerypopoff/rivet2-core';
import { stringifyDebuggerPayloadForTransport } from './debuggerPayloadSanitizer.js';

export type DebuggerErrorEmitter = {
  emit(eventName: 'error', eventData: Error): Promise<void>;
};

export type DebuggerSocketActivity = {
  markActivity: () => void;
};

const DEBUGGER_TRANSPORT_FALLBACK_WARNING =
  'Remote Debugger could not serialize the original event payload. Rivet sent a display-safe placeholder so the editor lifecycle state can finish.';

const FALLBACK_DEBUGGER_MESSAGES = new Set([
  'start',
  'nodeStart',
  'nodeFinish',
  'nodeError',
  'nodeExcluded',
  'partialOutput',
  'progress',
  'graphStart',
  'graphFinish',
  'graphError',
  'graphAbort',
  'done',
  'abort',
]);

export function stringifyDebuggerMessage(message: unknown, emitter: DebuggerErrorEmitter): string | undefined {
  try {
    return stringifyDebuggerPayloadForTransport(message);
  } catch (err) {
    emitDebuggerError(emitter, err);
    return stringifyDebuggerFallbackMessage(message, err, emitter);
  }
}

function stringifyDebuggerFallbackMessage(
  message: unknown,
  error: unknown,
  emitter: DebuggerErrorEmitter,
): string | undefined {
  const fallbackMessage = createDebuggerFallbackMessage(message, error);
  if (!fallbackMessage) {
    return undefined;
  }

  try {
    return stringifyDebuggerPayloadForTransport(fallbackMessage);
  } catch (fallbackError) {
    emitDebuggerError(emitter, fallbackError);
    return undefined;
  }
}

function createDebuggerFallbackMessage(message: unknown, error: unknown): unknown | undefined {
  const envelope = asRecord(message);
  if (!envelope) {
    return undefined;
  }

  const messageName = readStringProperty(envelope, 'message');
  if (!messageName || !FALLBACK_DEBUGGER_MESSAGES.has(messageName)) {
    return undefined;
  }

  const data = asRecord(readProperty(envelope, 'data'));
  return {
    message: messageName,
    requestId: readProperty(envelope, 'requestId'),
    data: createDebuggerFallbackData(messageName, data, error),
  };
}

function createDebuggerFallbackData(
  messageName: string,
  data: Record<string, unknown> | undefined,
  error: unknown,
): Record<string, unknown> {
  const warning = `${DEBUGGER_TRANSPORT_FALLBACK_WARNING} ${formatFallbackReason(error)}`;

  if (messageName === 'done') {
    return {
      results: createWarningOutputs(warning),
    };
  }

  if (messageName === 'abort') {
    return {
      successful: false,
      error: warning,
    };
  }

  if (messageName === 'start') {
    return {
      contextValues: {},
      execution: data ? readProperty(data, 'execution') : undefined,
      inputs: {},
      project: data ? readProperty(data, 'project') : undefined,
      startGraph: data ? readProperty(data, 'startGraph') : undefined,
    };
  }

  const fallbackData: Record<string, unknown> = {
    execution: data ? readProperty(data, 'execution') : undefined,
  };

  if (messageName.startsWith('node') || messageName === 'partialOutput' || messageName === 'progress') {
    fallbackData.node = data ? readProperty(data, 'node') : undefined;
    fallbackData.processId = data ? readProperty(data, 'processId') : undefined;
  }

  if (messageName.startsWith('graph')) {
    fallbackData.graph = data ? readProperty(data, 'graph') : undefined;
  }

  if (messageName === 'nodeStart' || messageName === 'graphStart') {
    fallbackData.inputs = {};
  } else if (messageName === 'nodeError' || messageName === 'graphError') {
    fallbackData.error = warning;
  } else if (messageName === 'graphAbort') {
    fallbackData.successful = false;
    fallbackData.error = warning;
  } else if (messageName !== 'progress') {
    fallbackData.outputs = createWarningOutputs(warning);
  }

  if (messageName === 'nodeExcluded') {
    fallbackData.inputs = {};
    fallbackData.reason = warning;
  }

  if (messageName === 'partialOutput') {
    fallbackData.index = data ? readProperty(data, 'index') : undefined;
  }

  if (messageName === 'progress') {
    fallbackData.progress = { message: warning };
  }

  return fallbackData;
}

function createWarningOutputs(warning: string): Record<string, unknown> {
  return {
    [WarningsPort]: {
      type: 'string[]',
      value: [warning],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value != null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch (error) {
    return `[Unserializable property: ${formatFallbackReason(error)}]`;
  }
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = readProperty(record, key);
  return typeof value === 'string' ? value : undefined;
}

function formatFallbackReason(error: unknown): string {
  const formattedError = getError(error);
  return `Reason: ${formattedError.message}`;
}

export function sendDebuggerMessage(
  socket: WebSocket,
  payload: string,
  emitter: DebuggerErrorEmitter,
  heartbeat?: DebuggerSocketActivity,
) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(payload, (err) => {
      if (err) {
        emitDebuggerError(emitter, err);
        terminateDebuggerSocket(socket);
        return;
      }

      heartbeat?.markActivity();
    });
    heartbeat?.markActivity();
    return true;
  } catch (err) {
    emitDebuggerError(emitter, err);
    terminateDebuggerSocket(socket);
    return false;
  }
}

export function emitDebuggerError(emitter: DebuggerErrorEmitter, error: unknown) {
  void emitter.emit('error', getError(error)).catch(() => {
    // noop, just prevent unhandled rejection
  });
}

export function terminateDebuggerSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  try {
    socket.terminate();
  } catch {
    // noop; send failures should not escape debugger transport cleanup
  }
}
