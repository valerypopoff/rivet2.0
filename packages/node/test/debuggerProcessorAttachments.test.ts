import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Emittery from 'emittery';
import type {
  ChartNode,
  GraphExecutionMetadata,
  GraphId,
  GraphProcessor,
  GraphRunId,
  NodeId,
  ProcessEvents,
  ProcessId,
  RootRunId,
} from '../src/index.js';
import { createDebuggerProcessorAttachments } from '../src/debuggerProcessorAttachments.js';

void describe('debugger processor attachments', () => {
  void it('preserves result provenance while normalizing remote node errors', async () => {
    const emitter = new Emittery<ProcessEvents>();
    const processor = {
      id: 'processor-with-error',
      on: emitter.on.bind(emitter),
    } as unknown as GraphProcessor;
    const broadcasts: Array<{ message: string; data: unknown }> = [];
    const attachments = createDebuggerProcessorAttachments({
      broadcast: (_processor, message, data) => broadcasts.push({ message, data }),
      emitError: (error) => assert.fail(String(error)),
      throttlePartialOutputs: 0,
    });
    const node = {
      data: {},
      id: 'failing-node' as NodeId,
      title: 'Failing Node',
      type: 'test',
      visualData: { x: 0, y: 0 },
    } as ChartNode;
    const execution: GraphExecutionMetadata = {
      graphId: 'graph' as GraphId,
      graphRunId: 'graph-run' as GraphRunId,
      rootRunId: 'root-run' as RootRunId,
    };

    attachments.attach(processor);
    await emitter.emit('nodeError', {
      node,
      error: new Error('expected failure'),
      processId: 'node-process' as ProcessId,
      execution,
      resultOrigin: 'executed',
      durationMs: 42,
      outputs: { requestBody: { type: 'string', value: 'preserved request' } },
    });

    const nodeError = broadcasts.find((broadcast) => broadcast.message === 'nodeError');
    assert.deepEqual(nodeError?.data, {
      node,
      error: 'Error: expected failure',
      processId: 'node-process',
      execution,
      resultOrigin: 'executed',
      durationMs: 42,
      outputs: { requestBody: { type: 'string', value: 'preserved request' } },
    });
  });

  void it('forwards a JSON-safe abort outcome instead of replacing it with null', async () => {
    const emitter = new Emittery<ProcessEvents>();
    const processor = {
      id: 'processor-with-abort',
      on: emitter.on.bind(emitter),
    } as unknown as GraphProcessor;
    const broadcasts: Array<{ message: string; data: unknown }> = [];
    const attachments = createDebuggerProcessorAttachments({
      broadcast: (_processor, message, data) => broadcasts.push({ message, data }),
      emitError: (error) => assert.fail(String(error)),
      throttlePartialOutputs: 0,
    });

    attachments.attach(processor);
    await emitter.emit('abort', { successful: false, error: new Error('expected abort') });

    assert.deepEqual(broadcasts.find((broadcast) => broadcast.message === 'abort')?.data, {
      successful: false,
      error: 'Error: expected abort',
    });
  });
});
