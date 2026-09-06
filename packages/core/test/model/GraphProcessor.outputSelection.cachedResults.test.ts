import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  ExecutionRecorder,
  createBuiltInRegistry,
  textNode,
  graphOutputNode,
  type NodeId,
  type GraphId,
  type Project,
  type ProjectId,
  type PortId,
  type DataValue,
  type GraphExecutionMetadata,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function fixture(outputIds = ['left', 'right']) {
  const sources = ['left', 'right'].map((id) => ({
    ...textNode.impl.create(),
    id: `${id}-source` as NodeId,
    data: { text: `${id} value` },
  }));
  const boundaryNodes = outputIds.map((id, index) => ({
    ...graphOutputNode.impl.create(),
    id: `${index}-output` as NodeId,
    data: { id, dataType: 'string' as const },
  }));
  const graphId = 'live-preload-selection' as GraphId;
  const project: Project = {
    metadata: { id: 'selection-project' as ProjectId, title: 'Selection', description: '', mainGraphId: graphId },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: 'Selection' },
        nodes: [...sources, ...boundaryNodes],
        connections: boundaryNodes.map((output, index) => ({
          outputNodeId: sources[index]!.id,
          outputId: 'output' as PortId,
          inputNodeId: output.id,
          inputId: 'value' as PortId,
        })),
      },
    },
    plugins: [],
  };
  const processor = new GraphProcessor(project, graphId, createBuiltInRegistry());
  const started: NodeId[] = [];
  const finished: NodeId[] = [];
  processor.on('nodeStart', ({ node }) => {
    started.push(node.id);
  });
  processor.on('nodeFinish', ({ node }) => {
    finished.push(node.id);
  });
  return { processor, started, finished };
}

void describe('Selected output cached-result participation', { timeout: 5_000 }, () => {
  for (const concurrentEntry of ['processGraph', 'replayRecording'] as const) {
    void it(`rejects overlapping ${concurrentEntry} without relabeling the active invocation`, async (t) => {
      const recorder = new ExecutionRecorder();
      const recordedProcessor = fixture().processor;
      recorder.record(recordedProcessor);
      await recordedProcessor.processGraph(testProcessContext());

      const { processor } = fixture();
      const executions: GraphExecutionMetadata[] = [];
      let release!: () => void;
      let notifyStarted!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      t.after(() => {
        release();
      });
      processor.on('graphStart', ({ execution }) => {
        executions.push(execution);
      });
      processor.on('nodeStart', async ({ node, execution }) => {
        executions.push(execution);
        if (node.id === 'right-source') {
          notifyStarted();
          await released;
        }
      });
      processor.on('nodeFinish', ({ execution }) => {
        executions.push(execution);
      });
      processor.on('graphFinish', ({ execution }) => {
        executions.push(execution);
      });

      const running = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['right'] });
      await started;
      await assert.rejects(
        concurrentEntry === 'replayRecording'
          ? processor.replayRecording(recorder)
          : processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] }),
        /Cannot process graph while already processing/,
      );
      release();
      const outputs = await running;
      assert.deepEqual(outputs.right, { type: 'string', value: 'right value' });
      assert.equal(outputs.left, undefined);
      assert.ok(executions.length > 2);
      for (const execution of executions) assert.deepEqual(execution, executions[0]);

      const nextOutputs = await processor.processGraph(testProcessContext());
      assert.deepEqual(nextOutputs.left, { type: 'string', value: 'left value' });
      assert.deepEqual(nextOutputs.right, { type: 'string', value: 'right value' });
    });
  }

  void it('rejects duplicate playback without changing the active replay abort identity', async (t) => {
    const recorder = new ExecutionRecorder();
    const recordedProcessor = fixture().processor;
    recorder.record(recordedProcessor);
    await recordedProcessor.processGraph(testProcessContext());

    const { processor } = fixture();
    let notifyStarted!: (execution: GraphExecutionMetadata) => void;
    const started = new Promise<GraphExecutionMetadata>((resolve) => {
      notifyStarted = resolve;
    });
    const unsubscribe = processor.on('graphStart', ({ execution }) => {
      processor.pause();
      notifyStarted(execution);
    });
    t.after(() => {
      unsubscribe();
      processor.resume();
    });
    const replay = processor.replayRecording(recorder);
    const execution = await started;
    await assert.rejects(processor.replayRecording(recorder), /Cannot process graph while already processing/);

    const aborted = processor.once('graphAbort');
    await processor.abort();
    const abortExecution = (await aborted).execution;
    for (const key of ['rootRunId', 'graphRunId', 'graphId', 'parentGraphRunId'] as const) {
      assert.equal(abortExecution[key], execution[key]);
    }
    await replay;
    assert.equal(processor.isRunning, false);
    unsubscribe();
    processor.resume();
    const outputs = await processor.processGraph(testProcessContext());
    assert.deepEqual(outputs.left, { type: 'string', value: 'left value' });
    assert.deepEqual(outputs.right, { type: 'string', value: 'right value' });
  });

  for (const completionEvent of ['done', 'finish'] as const) {
    void it(`preserves rerun cancellation and identity at replay's ${completionEvent} boundary`, async (t) => {
      const recorder = new ExecutionRecorder();
      const recordedProcessor = fixture().processor;
      recorder.record(recordedProcessor);
      await recordedProcessor.processGraph(testProcessContext());

      const { processor } = fixture();
      let liveRun: ReturnType<GraphProcessor['processGraph']> | undefined;
      let rejectedDoneAttempt: Promise<void> | undefined;
      let attempted = false;
      const liveExecutions: GraphExecutionMetadata[] = [];
      let release!: () => void;
      let notifyStarted!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      t.after(() => {
        release();
      });
      processor.on(completionEvent, () => {
        if (attempted) return;
        attempted = true;
        const next = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['right'] });
        if (completionEvent === 'done') {
          rejectedDoneAttempt = assert.rejects(next, /Cannot process graph while already processing/);
        } else {
          liveRun = next;
        }
      });
      processor.on('graphStart', ({ execution }) => {
        if (liveRun) liveExecutions.push(execution);
      });
      processor.on('nodeStart', async ({ node, execution }) => {
        if (liveRun && node.id === 'right-source') {
          liveExecutions.push(execution);
          notifyStarted();
          await released;
        }
      });

      await processor.replayRecording(recorder);
      if (completionEvent === 'done') {
        assert.ok(rejectedDoneAttempt, 'the done listener attempted and observed a rejected overlapping run');
        await rejectedDoneAttempt;
        liveRun = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['right'] });
      }
      await started;
      const wasRunning = processor.isRunning;
      const aborted = processor.once('graphAbort');
      const rejected = assert.rejects(liveRun!);
      const stop = processor.abort();
      release();
      await Promise.all([stop, rejected]);
      assert.equal(wasRunning, true);
      liveExecutions.push((await aborted).execution);
      assert.equal(liveExecutions.length, 3);
      for (const execution of liveExecutions) assert.deepEqual(execution, liveExecutions[0]);
    });
  }

  void it('returns the recorded result without leaking it into a finish-triggered selected rerun', async () => {
    const recorder = new ExecutionRecorder();
    const recordedProcessor = fixture().processor;
    recorder.record(recordedProcessor);
    const recordedOutputs = await recordedProcessor.processGraph(testProcessContext());
    const standalone = fixture().processor;
    const standaloneOutputs = await standalone.replayRecording(recorder);

    const { processor } = fixture();
    let liveRun: ReturnType<GraphProcessor['processGraph']> | undefined;
    processor.on('finish', () => {
      liveRun ??= processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['right'] });
    });
    const replayedOutputs = await processor.replayRecording(recorder);
    assert.ok(liveRun, 'The finish listener started a new selected invocation');
    const liveOutputs = await liveRun;

    assert.deepEqual(standaloneOutputs, recordedOutputs);
    assert.deepEqual(replayedOutputs, recordedOutputs);
    assert.deepEqual(liveOutputs.right, { type: 'string', value: 'right value' });
    assert.equal(Object.hasOwn(liveOutputs, 'left'), false);
    assert.notEqual(liveOutputs, replayedOutputs);
    assert.deepEqual(replayedOutputs, recordedOutputs, 'Completing the new run did not mutate the replay result');

    const abortedRecorder = new ExecutionRecorder();
    const abortedProcessor = fixture().processor;
    abortedRecorder.record(abortedProcessor);
    abortedProcessor.on('graphStart', () => {
      void abortedProcessor.abort();
    });
    await assert.rejects(abortedProcessor.processGraph(testProcessContext()));
    assert.equal(
      abortedRecorder.events.some((event) => event.type === 'done'),
      false,
    );
    assert.deepEqual(
      await standalone.replayRecording(abortedRecorder),
      {},
      'A no-done replay cannot retain old results',
    );
  });

  void it('scopes live preload injection to this invocation without discarding preloads for later runs', async () => {
    const { processor, started, finished } = fixture();
    let inject = true;
    processor.on('graphStart', () => {
      if (!inject) return;
      inject = false;
      processor.preloadNodeData('left-source' as NodeId, { output: { type: 'string', value: 'selected preload' } });
      processor.preloadNodeData('right-source' as NodeId, { output: { type: 'string', value: 'omitted preload' } });
    });

    const results = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    assert.deepEqual(results.left, { type: 'string', value: 'selected preload' });
    assert.equal(results.right, undefined);
    assert.deepEqual(started.sort(), ['0-output', 'left-source']);
    assert.deepEqual(finished.sort(), ['0-output', 'left-source']);

    started.length = 0;
    finished.length = 0;
    const nextResults = await processor.processGraph(testProcessContext());
    assert.deepEqual(nextResults.left, { type: 'string', value: 'selected preload' });
    assert.deepEqual(nextResults.right, { type: 'string', value: 'omitted preload' });
    assert.deepEqual(started.sort(), ['0-output', '1-output', 'left-source', 'right-source']);
    assert.deepEqual(finished.sort(), started);
  });

  for (const { title, firstFrozenValue, laterFrozenValue, expected } of [
    {
      title: 'keeps the first completed value when a later duplicate is frozen to excluded',
      laterFrozenValue: { type: 'control-flow-excluded', value: undefined },
      expected: { type: 'string', value: 'left value' },
    },
    {
      title: 'keeps the first completed value when a later duplicate is frozen to a different value',
      laterFrozenValue: { type: 'string', value: 'later frozen value' },
      expected: { type: 'string', value: 'left value' },
    },
    {
      title: 'replaces an excluded first producer with a later frozen valid value',
      firstFrozenValue: { type: 'control-flow-excluded', value: undefined },
      laterFrozenValue: { type: 'string', value: 'later frozen value' },
      expected: { type: 'string', value: 'later frozen value' },
    },
  ] satisfies { title: string; firstFrozenValue?: DataValue; laterFrozenValue: DataValue; expected: DataValue }[]) {
    void it(title, async () => {
      const { processor, finished } = fixture(['result', 'result']);
      let releaseLater!: () => void;
      const earlierFinished = new Promise<void>((resolve) => {
        releaseLater = resolve;
      });
      processor.on('nodeStart', async ({ node }) => {
        if (node.id === 'right-source') await earlierFinished;
      });
      processor.on('nodeFinish', ({ node }) => {
        if (node.id === '0-output') releaseLater();
      });
      processor.setFrozenNodeOutputResolver(({ node }) => {
        if (node.id === '0-output' && firstFrozenValue) return { valueOutput: firstFrozenValue };
        if (node.id === '1-output') return { valueOutput: laterFrozenValue };
        return undefined;
      });

      const results = await processor.processGraph(
        testProcessContext(),
        {},
        {},
        { requestedGraphOutputIds: ['result'] },
      );
      assert.ok(finished.indexOf('0-output' as NodeId) < finished.indexOf('1-output' as NodeId));
      assert.deepEqual(results.result, expected);
    });
  }
});
