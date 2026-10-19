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
  ProjectId,
} from '../src/index.js';
import { createDebuggerProcessorAttachments } from '../src/debuggerProcessorAttachments.js';

void describe('debugger processor attachments', () => {
  void it('identifies terminal frames and throttles cloned node IDs independently per invocation', async () => {
    const emitter = new Emittery<ProcessEvents>();
    const processor = { id: 'bundle', on: emitter.on.bind(emitter) } as unknown as GraphProcessor;
    const broadcasts: Array<{ message: string; data: unknown }> = [];
    const attachments = createDebuggerProcessorAttachments({
      broadcast: (_processor, message, data) => broadcasts.push({ message, data }),
      emitError: (error) => assert.fail(String(error)),
      throttlePartialOutputs: 60_000,
    });
    attachments.attach(processor);
    const root: GraphExecutionMetadata = {
      projectId: 'a' as ProjectId,
      graphId: 'shared' as GraphId,
      graphRunId: 'a-run' as GraphRunId,
      rootRunId: 'root' as RootRunId,
    };
    await emitter.emit('start', { execution: root } as ProcessEvents['start']);
    const node = { id: 'cloned' as NodeId } as ChartNode;
    const partial = (projectId: string) => ({
      execution: { ...root, projectId: projectId as ProjectId, graphRunId: `${projectId}-run` as GraphRunId },
      node,
      processId: `${projectId}-process` as ProcessId,
      outputs: {},
      index: 0,
    });
    await emitter.emit('partialOutput', partial('a'));
    await emitter.emit('partialOutput', partial('b'));
    await emitter.emit('partialOutput', partial('c'));
    await emitter.emit('partialOutput', partial('a'));
    assert.equal(broadcasts.filter((event) => event.message === 'partialOutput').length, 3);
    await emitter.emit('pause', undefined);
    await emitter.emit('resume', undefined);
    await emitter.emit('abort', { successful: false });
    await emitter.emit('done', { results: {} });
    await emitter.emit('start', { execution: root } as ProcessEvents['start']);
    await emitter.emit('error', { error: 'failure' });
    for (const message of ['abort', 'done', 'error', 'pause', 'resume'])
      assert.deepEqual(
        (broadcasts.find((event) => event.message === message)!.data as { execution: GraphExecutionMetadata })
          .execution,
        root,
      );
    attachments.detach(processor);
    assert.equal(attachments.getAttachedProcessors().length, 0);
  });

  void it('uses the new root identity for reused-processor preflight failures and drops stale terminal identity', async () => {
    const emitter = new Emittery<ProcessEvents>();
    const processor = { id: 'reused', on: emitter.on.bind(emitter) } as unknown as GraphProcessor;
    const frames: Array<{ message: string; data: unknown }> = [];
    const attachments = createDebuggerProcessorAttachments({
      broadcast: (_processor, message, data) => frames.push({ message, data }),
      emitError: (error) => assert.fail(String(error)),
      throttlePartialOutputs: 0,
    });
    attachments.attach(processor);
    const execution: GraphExecutionMetadata = {
      graphId: 'graph' as GraphId,
      graphRunId: 'old' as GraphRunId,
      rootRunId: 'old' as RootRunId,
    };
    await emitter.emit('start', { execution } as ProcessEvents['start']);
    await emitter.emit('done', { results: {} });
    await emitter.emit('error', { error: 'unidentified' });
    assert.deepEqual(frames.at(-1)!.data, { error: 'unidentified' });
    const next = { ...execution, graphRunId: 'new' as GraphRunId, rootRunId: 'new' as RootRunId };
    await emitter.emit('graphError', {
      graph: { metadata: { id: execution.graphId } },
      execution: next,
      error: new Error('preflight'),
    } as ProcessEvents['graphError']);
    await emitter.emit('error', { error: 'preflight' });
    assert.deepEqual(frames.at(-1)!.data, { execution: next, error: 'preflight' });
    attachments.detach(processor);
  });
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
      eventOccurredAt: 1_700_000_000_042,
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
      eventOccurredAt: 1_700_000_000_042,
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

  void it('forwards the compact Watch Streaming Output summary', async () => {
    const emitter = new Emittery<ProcessEvents>();
    const processor = {
      id: 'processor-with-watch-summary',
      on: emitter.on.bind(emitter),
    } as unknown as GraphProcessor;
    const broadcasts: Array<{ message: string; data: unknown }> = [];
    const attachments = createDebuggerProcessorAttachments({
      broadcast: (_processor, message, data) => broadcasts.push({ message, data }),
      emitError: (error) => assert.fail(String(error)),
      throttlePartialOutputs: 0,
    });
    const watchNode = {
      data: {},
      id: 'watch-node' as NodeId,
      title: 'Watch output',
      type: 'watchStreamingOutput',
      visualData: { x: 0, y: 0 },
    } as ChartNode;
    const execution: GraphExecutionMetadata = {
      graphId: 'graph' as GraphId,
      graphRunId: 'graph-run' as GraphRunId,
      rootRunId: 'root-run' as RootRunId,
    };
    const summary: ProcessEvents['streamingOutputWatchSummary']['summary'] = {
      receivedUpdates: 6,
      coalescedUpdates: 1,
      droppedUpdates: 2,
      maximumQueuedUpdates: 3,
      completedIterations: 4,
      failedIterations: 0,
      cancelledIterations: 0,
      omittedIterations: 2,
      retainedIterationUpdateIndexes: [1, 2, 3, 6],
      selectedIteration: { graphRunId: 'watch-child-run' as GraphRunId, updateIndex: 6, reason: 'latest' },
    };

    attachments.attach(processor);
    await emitter.emit('streamingOutputWatchSummary', { watchNode, summary, execution });

    assert.deepEqual(broadcasts.find((broadcast) => broadcast.message === 'streamingOutputWatchSummary')?.data, {
      watchNode,
      summary,
      execution,
    });
  });
});
