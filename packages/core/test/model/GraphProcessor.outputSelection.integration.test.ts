import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ExecutionRecorder,
  GraphProcessor,
  NodeImpl,
  NodeRegistration,
  dataBusNode,
  delegateFunctionCallNode,
  graphInputNode,
  graphOutputNode,
  loopControllerNode,
  nodeDefinition,
  raceInputsNode,
  startBackgroundBranchNode,
  subGraphNode,
  type ChartNode,
  type DataValue,
  type GraphId,
  type GraphProcessorRuntimeCache,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodePrefabId,
  type Outputs,
  type PortId,
  type ProcessEvents,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

type ProbeNode = ChartNode<'outputSelectionProbe', { value?: DataValue }>;
type Handler = (inputs: Inputs, context: InternalProcessContext) => Outputs | Promise<Outputs>;

function node(type: string, id: string, data: Record<string, unknown> = {}): ChartNode {
  return { type, id: id as NodeId, title: id, data, visualData: { x: 0, y: 0, width: 180 } };
}

function probe(id: string, value?: DataValue): ProbeNode {
  return node('outputSelectionProbe', id, value ? { value } : {}) as ProbeNode;
}

function output(id: string): ChartNode {
  return node('graphOutput', `${id}-output`, { id, dataType: 'any' });
}

function connect(from: string, to: string, inputId = 'input', outputId = 'output'): NodeConnection {
  return {
    outputNodeId: from as NodeId,
    outputId: outputId as PortId,
    inputNodeId: to as NodeId,
    inputId: inputId as PortId,
  };
}

function graph(id: string, nodes: ChartNode[], connections: NodeConnection[]): NodeGraph {
  return { metadata: { id: id as GraphId, name: id }, nodes, connections };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture(main: NodeGraph, children: NodeGraph[] = []) {
  const runs = new Map<NodeId, Inputs[]>();
  const handlers = new Map<NodeId, Handler>();
  class Probe extends NodeImpl<ProbeNode> {
    static create() {
      return probe('default-probe');
    }
    static getUIData() {
      return {};
    }
    getInputDefinitions(): NodeInputDefinition[] {
      return [
        { id: 'input' as PortId, title: 'Input', dataType: 'any' },
        { id: 'other' as PortId, title: 'Other', dataType: 'any' },
      ];
    }
    getOutputDefinitions(): NodeOutputDefinition[] {
      return [
        { id: 'output' as PortId, title: 'Output', dataType: 'any' },
        { id: 'cost' as PortId, title: 'Cost', dataType: 'number' },
      ];
    }
    async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
      runs.set(this.id, [...(runs.get(this.id) ?? []), inputs]);
      const handler = handlers.get(this.id);
      return handler
        ? await handler(inputs, context)
        : { output: this.data.value ?? inputs['input' as PortId] ?? { type: 'string', value: this.id } };
    }
  }

  class FakeLLM extends NodeImpl<ChartNode<'llmChatV2'>> {
    static create() {
      return node('llmChatV2', 'llm', {
        autoContinueToolCalls: true,
        useToolCalling: true,
      }) as ChartNode<'llmChatV2'>;
    }
    static getUIData() {
      return {};
    }
    getInputDefinitions(): NodeInputDefinition[] {
      return [];
    }
    getOutputDefinitions(): NodeOutputDefinition[] {
      return [
        { id: 'response' as PortId, title: 'Response', dataType: 'string' },
        { id: 'function-calls' as PortId, title: 'Calls', dataType: 'object[]' },
      ];
    }
    async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
      assert.ok(context.toolCallContinuation, 'a retained LLM must keep its connected tool handler');
      const results = await context.toolCallContinuation.run(
        [{ type: 'function', id: 'call-1', name: 'lookup', arguments: '{}', lastParsedArguments: {} }],
        'Looking up the answer',
      );
      return {
        response: { type: 'string', value: results[0]!.record.output },
        'function-calls': { type: 'object[]', value: results.map((result) => result.record) },
      };
    }
  }

  const registry = new NodeRegistration()
    .register(nodeDefinition(Probe, 'Output Selection Probe'))
    .register(nodeDefinition(FakeLLM, 'Fake LLM'))
    .register(graphInputNode)
    .register(graphOutputNode)
    .register(subGraphNode)
    .register(dataBusNode)
    .register(loopControllerNode)
    .register(raceInputsNode)
    .register(startBackgroundBranchNode)
    .register(delegateFunctionCallNode);
  const project: Project = {
    metadata: {
      id: 'output-selection-project' as ProjectId,
      title: 'Output selection',
      description: '',
      mainGraphId: main.metadata!.id,
    },
    graphs: Object.fromEntries([main, ...children].map((value) => [value.metadata!.id, value])),
    plugins: [],
  };

  return {
    project,
    runs,
    handlers,
    createProcessor: (options: ConstructorParameters<typeof GraphProcessor>[4] = {}) =>
      new GraphProcessor(project, main.metadata!.id, registry, false, options),
  };
}

function independentBranches() {
  return graph(
    'branches',
    [probe('left'), output('left'), probe('right'), output('right')],
    [connect('left', 'left-output', 'value'), connect('right', 'right-output', 'value')],
  );
}

void describe('GraphProcessor selected-output integration', { timeout: 10_000 }, () => {
  void it('uses compiled Data Bus channels and library node definitions without executing unrelated channels', async () => {
    const busPrefabId = 'bus-prefab' as NodePrefabId;
    const relayPrefabId = 'relay-prefab' as NodePrefabId;
    const main = graph(
      'compiled-selection',
      [
        probe('wanted'),
        probe('unwanted'),
        node('nodePrefabInstance', 'bus', { prefabId: busPrefabId }),
        node('nodePrefabInstance', 'relay', { prefabId: relayPrefabId }),
        output('wanted'),
        output('unwanted'),
      ],
      [
        connect('wanted', 'bus', 'input1'),
        connect('unwanted', 'bus', 'input2'),
        connect('bus', 'relay', 'input', 'output1'),
        connect('relay', 'wanted-output', 'value'),
        connect('bus', 'unwanted-output', 'value', 'output2'),
      ],
    );
    const f = fixture(main);
    f.project.nodePrefabs = {
      [busPrefabId]: { id: busPrefabId, sourceNode: node('dataBus', 'bus-source') },
      [relayPrefabId]: { id: relayPrefabId, sourceNode: probe('relay-source') },
    };
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['wanted'],
      },
    );

    assert.deepEqual(outputs.wanted, { type: 'string', value: 'wanted' });
    assert.deepEqual([...f.runs.keys()].sort(), ['relay', 'wanted']);
    assert.equal(outputs.unwanted, undefined);
  });

  void it('retains every provider the scheduler waits for on duplicate input connections', async () => {
    const main = graph(
      'duplicate-providers',
      [probe('first'), probe('second'), probe('consumer'), output('result')],
      [connect('first', 'consumer'), connect('second', 'consumer'), connect('consumer', 'result-output', 'value')],
    );
    const f = fixture(main);
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['result'],
      },
    );

    assert.deepEqual(outputs.result, { type: 'string', value: 'first' });
    assert.deepEqual([...f.runs.keys()].sort(), ['consumer', 'first', 'second']);
  });

  void it('clears selection between processor runs and shares only topology between differently selected calls', async () => {
    const main = independentBranches();
    const f = fixture(main);
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = f.createProcessor({ runtimeCache, scheduler: 'fast-acyclic' });
    const left = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    const cachedPlan = runtimeCache.executionPlans?.get(main);
    assert.ok(cachedPlan);
    assert.equal(left.right, undefined);
    assert.equal(f.runs.has('right' as NodeId), false);

    const right = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['right'] });
    assert.equal(right.left, undefined);
    assert.deepEqual(right.right, { type: 'string', value: 'right' });
    const full = await processor.processGraph(testProcessContext());
    assert.deepEqual(full.left, left.left);
    assert.deepEqual(full.right, right.right);
    assert.equal(runtimeCache.executionPlans?.get(main), cachedPlan);
    assert.equal(cachedPlan.graphNodes.length, 4);

    const [concurrentLeft, concurrentRight] = await Promise.all([
      f.createProcessor({ runtimeCache }).processGraph(
        testProcessContext(),
        {},
        {},
        {
          requestedGraphOutputIds: ['left'],
        },
      ),
      f.createProcessor({ runtimeCache }).processGraph(
        testProcessContext(),
        {},
        {},
        {
          requestedGraphOutputIds: ['right'],
        },
      ),
    ]);
    assert.equal(concurrentLeft.right, undefined);
    assert.equal(concurrentRight.left, undefined);
    assert.equal(f.runs.get('left' as NodeId)?.length, 3);
    assert.equal(f.runs.get('right' as NodeId)?.length, 3);
  });

  void it('preserves loop feedback across iterations while excluding its unused sibling branch', async () => {
    const main = graph(
      'selected-loop',
      [
        probe('seed', { type: 'number', value: 0 }),
        node('loopController', 'loop', { maxIterations: 3, atMaxIterationsAction: 'break' }),
        probe('increment'),
        probe('unused'),
        output('result'),
      ],
      [
        connect('seed', 'loop', 'input1Default'),
        connect('loop', 'increment', 'input', 'output1'),
        connect('increment', 'loop', 'input1'),
        connect('loop', 'unused', 'input', 'iteration'),
        connect('loop', 'result-output', 'value', 'break'),
      ],
    );
    const f = fixture(main);
    f.handlers.set('increment' as NodeId, (inputs) => ({
      output: { type: 'number', value: Number(inputs['input' as PortId]?.value) + 1 },
    }));
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['result'],
      },
    );

    assert.deepEqual(outputs.result, { type: 'any[]', value: [3] });
    assert.equal(f.runs.get('increment' as NodeId)?.length, 3);
    assert.equal(f.runs.has('unused' as NodeId), false);
  });

  void it('keeps both race competitors and aborts the loser without starting unrelated work', async () => {
    const main = graph(
      'selected-race',
      [probe('slow'), probe('fast'), node('raceInputs', 'race'), output('winner'), probe('unused')],
      [
        connect('slow', 'race', 'input1'),
        connect('fast', 'race', 'input2'),
        connect('race', 'winner-output', 'value', 'result'),
      ],
    );
    const f = fixture(main);
    const slowStarted = deferred();
    const slowAborted = deferred();
    f.handlers.set('slow' as NodeId, async (_inputs, context) => {
      slowStarted.resolve();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      slowAborted.resolve();
      return { output: { type: 'string', value: 'slow' } };
    });
    f.handlers.set('fast' as NodeId, async () => {
      await slowStarted.promise;
      return { output: { type: 'string', value: 'fast' } };
    });
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['winner'],
      },
    );
    await slowAborted.promise;

    assert.deepEqual(outputs.winner, { type: 'string', value: 'fast' });
    assert.deepEqual([...f.runs.keys()].sort(), ['fast', 'slow']);
  });

  void it('executes every selected split item but never schedules an unused split consumer', async () => {
    const split = probe('split');
    split.isSplitRun = true;
    split.splitRunConcurrency = 2;
    const main = graph(
      'selected-split',
      [probe('items', { type: 'number[]', value: [1, 2, 3] }), split, probe('unused'), output('result')],
      [connect('items', 'split'), connect('items', 'unused'), connect('split', 'result-output', 'value')],
    );
    const f = fixture(main);
    f.handlers.set(split.id, (inputs) => ({
      output: { type: 'number', value: Number(inputs['input' as PortId]?.value) * 2 },
      cost: { type: 'number', value: 1 },
    }));
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['result'],
      },
    );

    assert.deepEqual(outputs.result, { type: 'number[]', value: [2, 4, 6] });
    assert.equal(f.runs.get(split.id)?.length, 3);
    assert.equal(f.runs.has('unused' as NodeId), false);
    assert.deepEqual(outputs.cost, { type: 'number', value: 3 });
  });

  void it('omits independent async work and still rejects an async branch feeding a requested output', async () => {
    const main = graph(
      'selected-async',
      [probe('source'), node('startBackgroundBranch', 'async'), probe('effect'), output('result')],
      [
        connect('source', 'async', 'input1'),
        connect('async', 'effect', 'input', 'output1'),
        connect('source', 'result-output', 'value'),
      ],
    );
    const f = fixture(main);
    f.handlers.set('effect' as NodeId, () => {
      throw new Error('unrequested async side effect ran');
    });
    const outputs = await f.createProcessor().processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['result'],
      },
    );
    assert.deepEqual(outputs.result, { type: 'string', value: 'source' });
    assert.equal(f.runs.has('effect' as NodeId), false);

    main.connections = [connect('source', 'async', 'input1'), connect('async', 'result-output', 'value', 'output1')];
    await assert.rejects(
      f.createProcessor().processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['result'] }),
      /cannot contain Graph Output/,
    );
  });

  void it('honors selected frozen and preloaded values without replaying unrelated preloads', async () => {
    const f = fixture(independentBranches());
    const processor = f.createProcessor();
    processor.preloadNodeData('left' as NodeId, { output: { type: 'string', value: 'preloaded left' } });
    processor.preloadNodeData('right' as NodeId, { output: { type: 'string', value: 'preloaded right' } });
    const starts: NodeId[] = [];
    processor.on('nodeStart', ({ node: startedNode }) => starts.push(startedNode.id));
    const outputs = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    assert.deepEqual(outputs.left, { type: 'string', value: 'preloaded left' });
    assert.equal(outputs.right, undefined);
    assert.deepEqual(starts.sort(), ['left', 'left-output']);
    assert.equal(f.runs.size, 0);

    const frozenProcessor = f.createProcessor();
    const resolverNodes: NodeId[] = [];
    frozenProcessor.setFrozenNodeOutputResolver(({ node: current }) => {
      resolverNodes.push(current.id);
      return current.id === 'left' ? { output: { type: 'string', value: 'frozen left' } } : undefined;
    });
    const frozenOutputs = await frozenProcessor.processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['left'],
      },
    );
    assert.deepEqual(frozenOutputs.left, { type: 'string', value: 'frozen left' });
    assert.equal(resolverNodes.includes('right' as NodeId), false);
    assert.equal(f.runs.size, 0);
  });

  void it('preserves pause and abort lifecycle while a selected invocation is running', async () => {
    const f = fixture(independentBranches());
    const processor = f.createProcessor();
    const graphStarted = deferred();
    processor.on('graphStart', async () => {
      await processor.pause();
      graphStarted.resolve();
    });
    const workStarted = deferred();
    const workAborted = deferred();
    f.handlers.set('left' as NodeId, async (_inputs, context) => {
      workStarted.resolve();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      workAborted.resolve();
      return { output: { type: 'string', value: 'interrupted' } };
    });
    const run = processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    const rejection = assert.rejects(run);
    await graphStarted.promise;
    assert.equal(f.runs.size, 0);
    await processor.resume();
    await workStarted.promise;
    await processor.abort();
    await rejection;
    await workAborted.promise;
    assert.equal(processor.isRunning, false);
    assert.equal(f.runs.has('right' as NodeId), false);
  });

  void it('records only selected execution and replays it without computing omitted nodes', async () => {
    const f = fixture(independentBranches());
    const processor = f.createProcessor();
    const recorder = new ExecutionRecorder();
    recorder.record(processor);
    const outputs = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds: ['left'] });
    const runCount = [...f.runs.values()].flat().length;
    const replayProcessor = f.createProcessor();
    const replayed: NodeId[] = [];
    replayProcessor.on('nodeStart', ({ node: startedNode }) => replayed.push(startedNode.id));
    const replayDone = replayProcessor.once('done');
    await replayProcessor.replayRecording(recorder);

    assert.deepEqual((await replayDone).results, outputs);
    assert.deepEqual(replayed.sort(), ['left', 'left-output']);
    assert.equal([...f.runs.values()].flat().length, runCount);
  });

  void it('records and replays optimized SubGraph outputs with the original caller relationship', async () => {
    const child = graph(
      'recorded-child',
      [probe('shared'), probe('wanted'), probe('unused'), output('wanted'), output('unused')],
      [
        connect('shared', 'wanted'),
        connect('shared', 'unused'),
        connect('wanted', 'wanted-output', 'value'),
        connect('unused', 'unused-output', 'value'),
      ],
    );
    const main = graph(
      'recorded-parent',
      [
        node('subGraph', 'caller', {
          graphId: child.metadata!.id,
          skipUnusedOutputs: true,
          useErrorOutput: false,
          useAsGraphPartialOutput: false,
        }),
        output('result'),
      ],
      [connect('caller', 'result-output', 'value', 'wanted')],
    );
    const f = fixture(main, [child]);
    const recorder = new ExecutionRecorder();
    const processor = f.createProcessor();
    recorder.record(processor);
    const outputs = await processor.processGraph(testProcessContext());
    const savedRecording = ExecutionRecorder.deserializeFromString(recorder.serialize());
    const recordedGraphs = savedRecording.events.filter((event) => event.type === 'graphStart');
    const recordedParent = recordedGraphs.find((event) => event.data.graphId === main.metadata!.id);
    const recordedChild = recordedGraphs.find((event) => event.data.graphId === child.metadata!.id);
    const recordedCallerStart = savedRecording.events.find(
      (event) => event.type === 'nodeStart' && event.data.nodeId === 'caller',
    );
    const recordedCallerFinish = savedRecording.events.find(
      (event) => event.type === 'nodeFinish' && event.data.nodeId === 'caller',
    );
    assert.ok(recordedParent?.data.execution);
    assert.ok(recordedChild?.data.execution);
    assert.ok(recordedCallerStart?.type === 'nodeStart');
    assert.ok(recordedCallerFinish?.type === 'nodeFinish');
    assert.equal(recordedCallerFinish.data.outputs.unused?.type, 'control-flow-excluded');
    assert.equal(recordedCallerFinish.data.outputs.unused?.value, undefined);
    assert.deepEqual(recordedCallerFinish.data.outputs.wanted, { type: 'string', value: 'shared' });
    assert.equal(recordedChild.data.execution.parentGraphRunId, recordedParent.data.execution.graphRunId);
    assert.deepEqual(recordedChild.data.execution.executor, {
      nodeId: 'caller',
      parentGraphId: main.metadata!.id,
      processId: recordedCallerStart.data.processId,
      splitIndex: 0,
    });
    const recordedChildNodes = savedRecording.events
      .filter((event) => event.type === 'nodeStart' && event.data.execution?.graphId === child.metadata!.id)
      .map((event) => (event.type === 'nodeStart' ? event.data.nodeId : undefined));
    assert.deepEqual(recordedChildNodes.sort(), ['shared', 'wanted', 'wanted-output']);

    const runCount = [...f.runs.values()].flat().length;
    const replayProcessor = f.createProcessor();
    const replayGraphs: ProcessEvents['graphStart'][] = [];
    const replayStarts: ProcessEvents['nodeStart'][] = [];
    const replayFinishes: ProcessEvents['nodeFinish'][] = [];
    replayProcessor.on('graphStart', (event) => replayGraphs.push(event));
    replayProcessor.on('nodeStart', (event) => replayStarts.push(event));
    replayProcessor.on('nodeFinish', (event) => replayFinishes.push(event));
    const replayDone = replayProcessor.once('done');
    await replayProcessor.replayRecording(savedRecording);
    assert.deepEqual((await replayDone).results, outputs);

    const replayParent = replayGraphs.find((event) => event.graph.metadata!.id === main.metadata!.id);
    const replayChild = replayGraphs.find((event) => event.graph.metadata!.id === child.metadata!.id);
    const replayCaller = replayStarts.find((event) => event.node.id === 'caller');
    assert.ok(replayParent);
    assert.ok(replayChild);
    assert.ok(replayCaller);
    assert.notEqual(replayChild.execution.graphRunId, recordedChild.data.execution.graphRunId);
    assert.equal(replayChild.execution.parentGraphRunId, replayParent.execution.graphRunId);
    assert.equal(replayChild.execution.rootRunId, replayParent.execution.rootRunId);
    assert.deepEqual(replayChild.execution.executor, {
      nodeId: 'caller',
      parentGraphId: main.metadata!.id,
      processId: replayCaller.processId,
      splitIndex: 0,
    });
    const replayChildStarts = replayStarts.filter((event) => event.execution.graphId === child.metadata!.id);
    assert.deepEqual(replayChildStarts.map((event) => event.node.id).sort(), recordedChildNodes);
    assert.ok(replayChildStarts.every((event) => event.execution.graphRunId === replayChild.execution.graphRunId));
    assert.deepEqual(
      replayFinishes.find((event) => event.node.id === 'caller')?.outputs,
      recordedCallerFinish.data.outputs,
    );
    assert.equal([...f.runs.values()].flat().length, runCount);
  });

  void it('preserves caller demand for a nested SubGraph inside a same-graph tool continuation', async () => {
    const child = graph(
      'continuation-child',
      [
        node('graphInput', 'child-input', { id: 'input', dataType: 'string' }),
        probe('child-wanted'),
        probe('child-unused'),
        output('wanted'),
        output('unused'),
      ],
      [
        connect('child-input', 'child-wanted', 'input', 'data'),
        connect('child-input', 'child-unused', 'input', 'data'),
        connect('child-wanted', 'wanted-output', 'value'),
        connect('child-unused', 'unused-output', 'value'),
      ],
    );
    const main = graph(
      'nested-continuation-selection',
      [
        node('llmChatV2', 'llm', { useToolCalling: true, autoContinueToolCalls: true }),
        node('delegateFunctionCall', 'delegate', {
          handlers: [],
          autoDelegate: true,
          fallBackToExternalCall: true,
          passthroughErrors: false,
        }),
        node('subGraph', 'nested', { graphId: child.metadata!.id, skipUnusedOutputs: true }),
        probe('unused-consumer'),
        output('answer'),
        output('nestedResult'),
      ],
      [
        connect('llm', 'delegate', 'function-call', 'function-calls'),
        connect('llm', 'answer-output', 'value', 'response'),
        connect('delegate', 'nested'),
        connect('nested', 'nestedResult-output', 'value', 'wanted'),
        connect('nested', 'unused-consumer', 'input', 'unused'),
      ],
    );
    const f = fixture(main, [child]);
    const processor = f.createProcessor();
    processor.setExternalFunction('lookup', async () => ({ type: 'string', value: 'nested answer' }));
    const outputs = await processor.processGraph(
      testProcessContext(),
      {},
      {},
      {
        requestedGraphOutputIds: ['answer', 'nestedResult'],
      },
    );

    assert.deepEqual(outputs.nestedResult, outputs.answer);
    assert.equal(f.runs.get('child-wanted' as NodeId)?.length, 1);
    assert.equal(f.runs.has('child-unused' as NodeId), false);
    assert.equal(f.runs.has('unused-consumer' as NodeId), false);
  });

  for (const requestedGraphOutputIds of [['answer'], ['answer', 'toolResult', 'message']]) {
    void it(`retains a required Delegate and selects its continuation branches for ${requestedGraphOutputIds.join(', ')}`, async () => {
      const main = graph(
        'selected-tools',
        [
          node('llmChatV2', 'llm', { useToolCalling: true, autoContinueToolCalls: true }),
          node('delegateFunctionCall', 'delegate', {
            handlers: [],
            autoDelegate: true,
            fallBackToExternalCall: true,
            passthroughErrors: false,
          }),
          probe('result-probe'),
          probe('message-probe'),
          probe('unrelated-effect'),
          output('answer'),
          output('toolResult'),
          output('message'),
        ],
        [
          connect('llm', 'delegate', 'function-call', 'function-calls'),
          connect('llm', 'answer-output', 'value', 'response'),
          connect('delegate', 'result-probe'),
          connect('result-probe', 'toolResult-output', 'value'),
          connect('delegate', 'message-probe', 'input', 'assistant-message'),
          connect('message-probe', 'message-output', 'value'),
          connect('delegate', 'unrelated-effect'),
        ],
      );
      const f = fixture(main);
      const processor = f.createProcessor();
      let calls = 0;
      processor.setExternalFunction('lookup', async () => {
        calls++;
        return { type: 'string', value: 'tool answer' };
      });
      const outputs = await processor.processGraph(testProcessContext(), {}, {}, { requestedGraphOutputIds });
      const expectedToolAnswer = JSON.stringify({ type: 'string', value: 'tool answer' });

      assert.deepEqual(outputs.answer, { type: 'string', value: expectedToolAnswer });
      assert.equal(calls, 1);
      assert.equal(f.runs.has('unrelated-effect' as NodeId), false);
      if (requestedGraphOutputIds.includes('toolResult')) {
        assert.deepEqual(outputs.toolResult, { type: 'string', value: expectedToolAnswer });
        assert.deepEqual(outputs.message, { type: 'string', value: 'Looking up the answer' });
        assert.equal(f.runs.get('result-probe' as NodeId)?.length, 1);
        assert.equal(f.runs.get('message-probe' as NodeId)?.length, 1);
      } else {
        assert.equal(f.runs.size, 0);
        assert.equal(outputs.toolResult, undefined);
        assert.equal(outputs.message, undefined);
      }
    });
  }
});
