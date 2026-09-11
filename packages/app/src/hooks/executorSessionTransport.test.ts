import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDebuggerTransportEscapedSentinelEnvelope,
  createDebuggerTransportUndefinedSentinel,
  type GraphExecutionMetadata,
  type GraphId,
  type GraphRunId,
  type PortId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import {
  parseExecutorSessionIncomingMessage,
  safeSendExecutorSocket,
  serializeExecutorSessionMessage,
} from './executorSessionTransport.js';
import { createExternalDebuggerTarget } from './executorSessionTarget.js';

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url = 'ws://debugger.example/latest';
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }
}

const originalWebSocket = globalThis.WebSocket;

test.afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

test('executor transport serializes outgoing protocol messages without changing shape', () => {
  assert.equal(serializeExecutorSessionMessage('abort', undefined), '{"type":"abort"}');
});

test('executor transport classifies upload, dataset, and process event messages', () => {
  const target = createExternalDebuggerTarget('ws://debugger.example/latest');

  assert.deepEqual(
    parseExecutorSessionIncomingMessage({
      rawMessage: JSON.stringify({ message: 'graph-upload-allowed' }),
      socketUrl: target.url,
      target,
    }),
    { kind: 'upload-allowed' },
  );

  assert.deepEqual(
    parseExecutorSessionIncomingMessage({
      rawMessage: JSON.stringify({
        data: { payload: { id: 'dataset-1' }, requestId: 'dataset-request-1' },
        message: 'datasets:get-data',
      }),
      socketUrl: target.url,
      target,
    }),
    {
      data: { payload: { id: 'dataset-1' }, requestId: 'dataset-request-1' },
      kind: 'dataset-request',
      message: 'datasets:get-data',
    },
  );

  assert.deepEqual(
    parseExecutorSessionIncomingMessage({
      rawMessage: JSON.stringify({
        data: { trace: 'hello' },
        message: 'trace',
        requestId: 'request-1',
      }),
      socketUrl: target.url,
      target,
    }),
    {
      incoming: {
        data: { trace: 'hello' },
        message: 'trace',
        requestId: 'request-1',
      },
      kind: 'process-event',
    },
  );
});

test('executor transport decodes debugger sentinels in process event messages', () => {
  const target = createExternalDebuggerTarget('ws://debugger.example/latest');
  const parsed = parseExecutorSessionIncomingMessage({
    rawMessage: JSON.stringify({
      data: {
        node: { id: 'expression-1', type: 'expression' },
        outputs: {
          output: {
            type: 'any',
            value: createDebuggerTransportUndefinedSentinel(),
          },
        },
        processId: 'process-1',
      },
      message: 'nodeFinish',
    }),
    socketUrl: target.url,
    target,
  });

  assert.equal(parsed?.kind, 'process-event');
  if (parsed?.kind !== 'process-event' || parsed.incoming.message !== 'nodeFinish') {
    assert.fail('Expected a nodeFinish process event');
  }

  assert.equal(parsed.incoming.data.outputs['output' as PortId]?.value, undefined);
});

test('executor transport preserves retained Watch child execution lineage', () => {
  const target = createExternalDebuggerTarget('ws://debugger.example/latest');
  const execution: GraphExecutionMetadata = {
    graphId: 'main-graph' as GraphId,
    graphRunId: 'watch-child-run' as GraphRunId,
    parentGraphRunId: 'root-graph-run' as GraphRunId,
    rootRunId: 'root-run' as RootRunId,
  };
  const parsed = parseExecutorSessionIncomingMessage({
    rawMessage: JSON.stringify({
      data: {
        execution,
      node: { id: 'watch-branch-node', type: 'text' },
      outputs: { output: { type: 'string', value: 'final retained value' } },
      processId: 'watch-branch-process',
      streamingWatchTerminal: true,
      },
      message: 'nodeFinish',
    }),
    socketUrl: target.url,
    target,
  });

  assert.equal(parsed?.kind, 'process-event');
  if (parsed?.kind !== 'process-event' || parsed.incoming.message !== 'nodeFinish') {
    assert.fail('Expected a nodeFinish process event');
  }

  assert.deepEqual(parsed.incoming.data.execution, execution);
  assert.equal(parsed.incoming.data.streamingWatchTerminal, true);
});

test('executor transport preserves user objects that only resemble debugger sentinels', () => {
  const target = createExternalDebuggerTarget('ws://debugger.example/latest');
  const userValue = {
    __rivetDebuggerTransportSentinel: {
      type: 'undefined',
      version: 1,
    },
    userData: true,
  };
  const parsed = parseExecutorSessionIncomingMessage({
    rawMessage: JSON.stringify({
      data: {
        outputs: {
          output: {
            type: 'any',
            value: userValue,
          },
        },
      },
      message: 'nodeFinish',
    }),
    socketUrl: target.url,
    target,
  });

  assert.equal(parsed?.kind, 'process-event');
  if (parsed?.kind !== 'process-event' || parsed.incoming.message !== 'nodeFinish') {
    assert.fail('Expected a nodeFinish process event');
  }

  assert.deepEqual(parsed.incoming.data.outputs['output' as PortId]?.value, userValue);
});

test('executor transport restores escaped debugger sentinel-shaped user objects', () => {
  const target = createExternalDebuggerTarget('ws://debugger.example/latest');
  const userValue = {
    __rivetDebuggerTransportSentinel: {
      type: 'undefined',
      version: 1,
    },
  };
  const parsed = parseExecutorSessionIncomingMessage({
    rawMessage: JSON.stringify({
      data: {
        outputs: {
          output: {
            type: 'any',
            value: createDebuggerTransportEscapedSentinelEnvelope(userValue),
          },
        },
      },
      message: 'nodeFinish',
    }),
    socketUrl: target.url,
    target,
  });

  assert.equal(parsed?.kind, 'process-event');
  if (parsed?.kind !== 'process-event' || parsed.incoming.message !== 'nodeFinish') {
    assert.fail('Expected a nodeFinish process event');
  }

  assert.deepEqual(parsed.incoming.data.outputs['output' as PortId]?.value, userValue);
});

test('executor transport drops malformed JSON envelopes without throwing', () => {
  const logged: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    assert.equal(
      parseExecutorSessionIncomingMessage({
        rawMessage: JSON.stringify({ data: 'missing message' }),
        socketUrl: 'ws://debugger.example/latest',
        target: createExternalDebuggerTarget('ws://debugger.example/latest'),
      }),
      undefined,
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal((logged[0] as unknown[])[0], '[Failed to parse executor message]');
});

test('executor transport reports whether websocket sends reached an open socket', () => {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const socket = new FakeWebSocket();

  assert.equal(safeSendExecutorSocket(socket as unknown as WebSocket, 'payload', 'send failed', {}), true);
  assert.deepEqual(socket.sent, ['payload']);

  socket.readyState = FakeWebSocket.CLOSED;
  assert.equal(safeSendExecutorSocket(socket as unknown as WebSocket, 'ignored', 'send failed', {}), false);
  assert.deepEqual(socket.sent, ['payload']);
});
