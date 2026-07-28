import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  GraphProcessor,
  NodeImpl,
  createBuiltInRegistry,
  createFrozenNodeOutputResolver,
  nodeDefinition,
  type ChartNode,
  type GraphId,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type ProcessEvents,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { ManagedAsyncBranches } from '../../src/model/ManagedAsyncBranches.js';
import { testProcessContext } from '../testUtils.js';

type AsyncTestNode = ChartNode<'asyncBranchTest', Record<string, never>>;
type AsyncTestHandler = (inputs: Inputs, context: InternalProcessContext) => Promise<Outputs> | Outputs;

class AsyncTestNodeImpl extends NodeImpl<AsyncTestNode> {
  static handlers = new Map<NodeId, AsyncTestHandler>();
  static runCounts = new Map<NodeId, number>();

  static create(): AsyncTestNode {
    return makeTestNode('async-test-node');
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      { dataType: 'any', id: 'input' as PortId, title: 'Input' },
      { dataType: 'any', id: 'other' as PortId, title: 'Other' },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { dataType: 'any', id: 'output' as PortId, title: 'Output' },
      { dataType: 'number', id: 'cost' as PortId, title: 'Cost' },
    ];
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    AsyncTestNodeImpl.runCounts.set(this.id, (AsyncTestNodeImpl.runCounts.get(this.id) ?? 0) + 1);
    const handler = AsyncTestNodeImpl.handlers.get(this.id);
    if (handler) {
      return await handler(inputs, context);
    }
    return { output: inputs['input' as PortId] ?? { type: 'string', value: this.id } };
  }
}

const asyncTestNode = nodeDefinition(AsyncTestNodeImpl, 'Async Branch Test');

function makeTestNode(id: string, disabled = false): AsyncTestNode {
  return {
    data: {},
    disabled,
    id: id as NodeId,
    title: id,
    type: 'asyncBranchTest',
    visualData: { x: 0, y: 0, width: 180 },
  };
}

function makeAsyncNode(id = 'async-trigger'): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title: 'Start Async Branch',
    type: 'startBackgroundBranch',
    visualData: { x: 200, y: 0, width: 200 },
  };
}

function makeGraphOutputNode(id = 'result'): ChartNode {
  return {
    data: { dataType: 'any', id },
    id: `${id}-graph-output` as NodeId,
    title: 'Graph Output',
    type: 'graphOutput',
    visualData: { x: 600, y: 0, width: 220 },
  };
}

function makeSubgraphNode(id: string, graphId: GraphId): ChartNode {
  return {
    data: {
      graphId,
      useAsGraphPartialOutput: false,
      useErrorOutput: false,
    },
    id: id as NodeId,
    title: id,
    type: 'subGraph',
    visualData: { x: 0, y: 0, width: 220 },
  };
}

function connect(outputNodeId: string, inputNodeId: string, inputId = 'input', outputId = 'output'): NodeConnection {
  return {
    inputId: inputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    outputId: outputId as PortId,
    outputNodeId: outputNodeId as NodeId,
  };
}

function makeGraph(id: string, nodes: ChartNode[], connections: NodeConnection[]): NodeGraph {
  return {
    connections,
    metadata: { description: '', id: id as GraphId, name: id },
    nodes,
  };
}

function makeProject(mainGraph: NodeGraph, extraGraphs: NodeGraph[] = []): Project {
  return {
    graphs: Object.fromEntries([mainGraph, ...extraGraphs].map((graph) => [graph.metadata!.id, graph])),
    metadata: {
      description: '',
      id: 'async-branch-project' as ProjectId,
      mainGraphId: mainGraph.metadata!.id,
      title: 'Async Branch Project',
    },
    plugins: [],
  };
}

function createProcessor(mainGraph: NodeGraph, extraGraphs: NodeGraph[] = []): GraphProcessor {
  const registry = createBuiltInRegistry().register(asyncTestNode);
  return new GraphProcessor(makeProject(mainGraph, extraGraphs), mainGraph.metadata!.id, registry);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

beforeEach(() => {
  AsyncTestNodeImpl.handlers.clear();
  AsyncTestNodeImpl.runCounts.clear();
});

void describe('GraphProcessor managed async branches', () => {
  void it('lets foreground nodes finish while the root run still waits for the async branch', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const foreground = makeTestNode('foreground');
    const asyncLeaf = makeTestNode('async-leaf');
    const graph = makeGraph(
      'async-foreground',
      [source, trigger, foreground, asyncLeaf],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(source.id, foreground.id),
      ],
    );
    const branchStarted = deferred();
    const releaseBranch = deferred();
    const foregroundFinished = deferred();
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs) => {
      branchStarted.resolve();
      await releaseBranch.promise;
      return { output: inputs['input' as PortId]! };
    });
    AsyncTestNodeImpl.handlers.set(foreground.id, (inputs) => {
      foregroundFinished.resolve();
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    let runSettled = false;
    const run = processor.processGraph(testProcessContext()).finally(() => {
      runSettled = true;
    });

    await Promise.all([branchStarted.promise, foregroundFinished.promise]);
    assert.equal(runSettled, false);
    assert.equal(AsyncTestNodeImpl.runCounts.get(asyncLeaf.id), 1);

    releaseBranch.resolve();
    await run;
    assert.equal(runSettled, true);
  });

  void it('returns foreground graph outputs early while the root lifecycle still owns the async branch', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const asyncLeaf = makeTestNode('async-leaf');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'async-outputs-ready',
      [source, trigger, asyncLeaf, graphOutput],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(source.id, graphOutput.id, 'value'),
      ],
    );
    const branchStarted = deferred();
    const releaseBranch = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, () => ({
      cost: { type: 'number', value: 2 },
      output: { type: 'string', value: 'ready' },
    }));
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs) => {
      branchStarted.resolve();
      await releaseBranch.promise;
      return {
        cost: { type: 'number', value: 3 },
        output: inputs['input' as PortId]!,
      };
    });

    const processor = createProcessor(graph);
    const lifecycleEvents: string[] = [];
    let publishedOutputs: Outputs | undefined;
    let completedOutputs: Outputs | undefined;
    processor.on('graphOutputsReady', ({ outputs }) => {
      lifecycleEvents.push('outputs-ready');
      publishedOutputs = outputs;
    });
    processor.on('graphFinish', () => lifecycleEvents.push('graph-finish'));
    processor.on('done', ({ results }) => {
      lifecycleEvents.push('done');
      completedOutputs = results;
    });

    const outputsPromise = processor.processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true });
    await branchStarted.promise;
    const outputs = await withTimeout(outputsPromise, 'foreground graph outputs');

    assert.equal(outputs.result?.value, 'ready');
    assert.equal(outputs.cost?.value, 2);
    assert.equal(publishedOutputs, outputs);
    assert.equal(processor.isRunning, true);
    assert.deepEqual(lifecycleEvents, ['outputs-ready']);

    releaseBranch.resolve();
    await withTimeout(processor.waitForRunCompletion(), 'managed async branch completion');

    assert.equal(processor.isRunning, false);
    assert.equal(outputs.cost?.value, 2);
    assert.equal(completedOutputs?.cost?.value, 5);
    assert.notEqual(completedOutputs, outputs);
    assert.deepEqual(lifecycleEvents, ['outputs-ready', 'graph-finish', 'done']);
  });

  void it('keeps the full lifecycle boundary when early-output mode has no pending async work', async () => {
    const source = makeTestNode('source');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'no-async-outputs-ready',
      [source, graphOutput],
      [connect(source.id, graphOutput.id, 'value')],
    );
    const finishStarted = deferred();
    const releaseFinish = deferred();
    const processor = createProcessor(graph);
    processor.on('finish', async () => {
      finishStarted.resolve();
      await releaseFinish.promise;
    });

    let runSettled = false;
    const run = processor
      .processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true })
      .finally(() => {
        runSettled = true;
      });

    await withTimeout(finishStarted.promise, 'the normal finish boundary');
    await Promise.resolve();
    assert.equal(runSettled, false);

    releaseFinish.resolve();
    const outputs = await withTimeout(run, 'the full graph lifecycle');
    assert.equal(outputs.result?.value, 'source');
    assert.equal(runSettled, true);
  });

  void it('keeps the full lifecycle boundary when foreground work fails before early publication', async () => {
    const source = makeTestNode('failing-source');
    const graph = makeGraph('foreground-error-before-outputs-ready', [source], []);
    AsyncTestNodeImpl.handlers.set(source.id, () => {
      throw new Error('foreground exploded');
    });
    const finishStarted = deferred();
    const releaseFinish = deferred();
    const processor = createProcessor(graph);
    processor.on('finish', async () => {
      finishStarted.resolve();
      await releaseFinish.promise;
    });

    let runSettled = false;
    const run = processor
      .processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true })
      .then(
        (outputs) => ({ outputs, status: 'fulfilled' as const }),
        (error: unknown) => ({ error, status: 'rejected' as const }),
      )
      .finally(() => {
        runSettled = true;
      });

    await withTimeout(finishStarted.promise, 'the failed graph finish boundary');
    await Promise.resolve();
    assert.equal(runSettled, false);

    releaseFinish.resolve();
    const outcome = await withTimeout(run, 'the failed full graph lifecycle');
    assert.equal(outcome.status, 'rejected');
    assert.match(
      String('error' in outcome ? outcome.error : ''),
      /foreground-error-before-outputs-ready.*failing-source/s,
    );
    assert.equal(runSettled, true);
  });

  void it('reports a late async failure through completion without retracting published outputs', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const asyncLeaf = makeTestNode('async-leaf');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'async-late-error',
      [source, trigger, asyncLeaf, graphOutput],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(source.id, graphOutput.id, 'value'),
      ],
    );
    const branchStarted = deferred();
    const releaseBranch = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'ready' } }));
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async () => {
      branchStarted.resolve();
      await releaseBranch.promise;
      throw new Error('late async failure');
    });

    const processor = createProcessor(graph);
    const lifecycleEvents: string[] = [];
    processor.on('graphError', () => lifecycleEvents.push('graph-error'));
    processor.on('error', () => lifecycleEvents.push('error'));
    processor.on('graphFinish', () => lifecycleEvents.push('graph-finish'));

    const outputsPromise = processor.processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true });
    await branchStarted.promise;
    const outputs = await outputsPromise;
    assert.equal(outputs.result?.value, 'ready');

    releaseBranch.resolve();
    await assert.rejects(processor.waitForRunCompletion(), /async-late-error.*async-leaf/s);
    assert.deepEqual(lifecycleEvents, ['graph-error', 'error']);
  });

  void it('attributes async node failures to the failing node without failing the trigger node', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const failingLeaf = makeTestNode('async-failure');
    const graph = makeGraph(
      'async-error',
      [source, trigger, failingLeaf],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, failingLeaf.id, 'input', 'output1')],
    );
    AsyncTestNodeImpl.handlers.set(failingLeaf.id, () => {
      throw new Error('background exploded');
    });

    const processor = createProcessor(graph);
    const erroredNodeIds: NodeId[] = [];
    const finishedNodeIds: NodeId[] = [];
    processor.on('nodeError', ({ node }) => {
      erroredNodeIds.push(node.id);
    });
    processor.on('nodeFinish', ({ node }) => {
      finishedNodeIds.push(node.id);
    });

    await assert.rejects(processor.processGraph(testProcessContext()), (error: Error) => {
      assert.match(error.message, /async-failure/);
      return true;
    });
    assert.deepEqual(erroredNodeIds, [failingLeaf.id]);
    assert.equal(finishedNodeIds.includes(trigger.id), true);
  });

  void it('drains nested async branches to a fixed point', async () => {
    const source = makeTestNode('source');
    const outerTrigger = makeAsyncNode('outer-trigger');
    const between = makeTestNode('between');
    const innerTrigger = makeAsyncNode('inner-trigger');
    const innerLeaf = makeTestNode('inner-leaf');
    const graph = makeGraph(
      'nested-async',
      [source, outerTrigger, between, innerTrigger, innerLeaf],
      [
        connect(source.id, outerTrigger.id, 'input1'),
        connect(outerTrigger.id, between.id, 'input', 'output1'),
        connect(between.id, innerTrigger.id, 'input1'),
        connect(innerTrigger.id, innerLeaf.id, 'input', 'output1'),
      ],
    );
    const innerStarted = deferred();
    const releaseInner = deferred();
    AsyncTestNodeImpl.handlers.set(innerLeaf.id, async (inputs) => {
      innerStarted.resolve();
      await releaseInner.promise;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    let runSettled = false;
    const run = processor.processGraph(testProcessContext()).finally(() => {
      runSettled = true;
    });
    await innerStarted.promise;
    assert.equal(runSettled, false);
    releaseInner.resolve();
    await run;
    assert.equal(AsyncTestNodeImpl.runCounts.get(between.id), 1);
    assert.equal(AsyncTestNodeImpl.runCounts.get(innerLeaf.id), 1);
  });

  void it('keeps async work owned by the root when a subgraph returns first', async () => {
    const childSource = makeTestNode('child-source');
    const trigger = makeAsyncNode('child-trigger');
    const asyncLeaf = makeTestNode('child-async-leaf');
    const childOutput = makeGraphOutputNode('child-result');
    const childGraph = makeGraph(
      'async-child',
      [childSource, trigger, asyncLeaf, childOutput],
      [
        connect(childSource.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(childSource.id, childOutput.id, 'value'),
      ],
    );
    const subgraph = makeSubgraphNode('subgraph', childGraph.metadata!.id!);
    const mainGraph = makeGraph('async-parent', [subgraph], []);
    const branchStarted = deferred();
    const releaseBranch = deferred();
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs) => {
      branchStarted.resolve();
      await releaseBranch.promise;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(mainGraph, [childGraph]);
    let subgraphFinished = false;
    const subgraphFinishedEvent = deferred();
    let rootSettled = false;
    const childGraphStarts: ProcessEvents['graphStart'][] = [];
    const childGraphFinishes: ProcessEvents['graphFinish'][] = [];
    const eventOrder: Array<{ kind: 'graphFinish' | 'node'; graphRunId: string }> = [];
    processor.on('graphStart', (event) => {
      if (event.execution.graphId === childGraph.metadata!.id) {
        childGraphStarts.push(event);
      }
    });
    processor.on('graphFinish', (event) => {
      eventOrder.push({ kind: 'graphFinish', graphRunId: event.execution.graphRunId });
      if (event.execution.graphId === childGraph.metadata!.id) {
        childGraphFinishes.push(event);
      }
    });
    processor.on('nodeStart', (event) => {
      eventOrder.push({ kind: 'node', graphRunId: event.execution.graphRunId });
    });
    processor.on('nodeFinish', (event: ProcessEvents['nodeFinish']) => {
      eventOrder.push({ kind: 'node', graphRunId: event.execution.graphRunId });
      if (event.node.id === subgraph.id) {
        subgraphFinished = true;
        subgraphFinishedEvent.resolve();
      }
    });
    const run = processor.processGraph(testProcessContext()).finally(() => {
      rootSettled = true;
    });

    await Promise.all([branchStarted.promise, subgraphFinishedEvent.promise]);
    assert.equal(subgraphFinished, true);
    assert.equal(rootSettled, false);
    assert.equal(childGraphStarts.length, 2);
    assert.equal(new Set(childGraphStarts.map((event) => event.execution.graphRunId)).size, 2);
    assert.equal(childGraphFinishes.length, 1);
    releaseBranch.resolve();
    await run;

    assert.equal(childGraphFinishes.length, 2);
    for (let index = 0; index < eventOrder.length; index++) {
      const event = eventOrder[index]!;
      if (event.kind !== 'graphFinish') {
        continue;
      }
      assert.equal(
        eventOrder.slice(index + 1).some((later) => later.kind === 'node' && later.graphRunId === event.graphRunId),
        false,
        `Node event emitted after graphFinish for graph run ${event.graphRunId}`,
      );
    }
  });

  void it('cancels subgraph async work when the source subgraph loses a parent race', async () => {
    const childSource = makeTestNode('race-child-source');
    const trigger = makeAsyncNode('race-child-trigger');
    const asyncLeaf = makeTestNode('race-child-async-leaf');
    const childForeground = makeTestNode('race-child-foreground');
    const childOutput = makeGraphOutputNode('race-child-result');
    const childGraph = makeGraph(
      'async-race-child',
      [childSource, trigger, asyncLeaf, childForeground, childOutput],
      [
        connect(childSource.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(childSource.id, childForeground.id),
        connect(childForeground.id, childOutput.id, 'value'),
      ],
    );
    const subgraph = makeSubgraphNode('race-subgraph', childGraph.metadata!.id!);
    const competitor = makeTestNode('race-competitor');
    const race: ChartNode = {
      data: {},
      id: 'parent-race' as NodeId,
      title: 'Race Inputs',
      type: 'raceInputs',
      visualData: { x: 400, y: 0, width: 220 },
    };
    const raceOutput = makeGraphOutputNode('race-result');
    const mainGraph = makeGraph(
      'async-parent-race',
      [subgraph, competitor, race, raceOutput],
      [
        connect(subgraph.id, race.id, 'input1', 'race-child-result'),
        connect(competitor.id, race.id, 'input2'),
        connect(race.id, raceOutput.id, 'value', 'result'),
      ],
    );
    const asyncLeafStarted = deferred();
    const asyncLeafAborted = deferred();
    let asyncLeafObservedAbort = false;

    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs, context) => {
      asyncLeafStarted.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      asyncLeafObservedAbort = context.signal.aborted;
      asyncLeafAborted.resolve();
      return { output: inputs['input' as PortId]! };
    });
    AsyncTestNodeImpl.handlers.set(childForeground.id, async (inputs, context) => {
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { output: inputs['input' as PortId]! };
    });
    AsyncTestNodeImpl.handlers.set(competitor.id, async () => {
      await asyncLeafStarted.promise;
      return { output: { type: 'string', value: 'winner' } };
    });

    const processor = createProcessor(mainGraph, [childGraph]);
    const outputs = await withTimeout(
      processor.processGraph(testProcessContext()),
      'parent race with subgraph async work',
    );

    await withTimeout(asyncLeafAborted.promise, 'subgraph async leaf cancellation');
    assert.deepEqual(outputs['race-result' as PortId], { type: 'string', value: 'winner' });
    assert.equal(asyncLeafObservedAbort, true);
    assert.deepEqual(outputs.cost, { type: 'number', value: 0 });
  });

  void it('rejects graph outputs and foreground dependencies inside async branches', async () => {
    const source = makeTestNode('source');
    const otherSource = makeTestNode('other-source');
    const trigger = makeAsyncNode();
    const joined = makeTestNode('joined');
    const graphOutput = makeGraphOutputNode();
    const graphWithOutput = makeGraph(
      'async-output-invalid',
      [source, trigger, graphOutput],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, graphOutput.id, 'value', 'output1')],
    );
    const outputProcessor = createProcessor(graphWithOutput);
    const rootErrors: Array<Error | string> = [];
    outputProcessor.on('error', ({ error }) => rootErrors.push(error));
    await assert.rejects(outputProcessor.processGraph(testProcessContext()), /cannot contain Graph Output node/);
    assert.equal(rootErrors.length, 1);
    assert.match(String(rootErrors[0]), /cannot contain Graph Output node/);

    const graphWithJoin = makeGraph(
      'async-join-invalid',
      [source, otherSource, trigger, joined],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, joined.id, 'input', 'output1'),
        connect(otherSource.id, joined.id, 'other'),
      ],
    );
    await assert.rejects(
      createProcessor(graphWithJoin).processGraph(testProcessContext()),
      /depends on "other-source" outside the async branch/,
    );
  });

  void it('does not traverse or validate unreachable nodes behind a disabled boundary', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const disabledBoundary = makeTestNode('disabled-boundary', true);
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'async-disabled',
      [source, trigger, disabledBoundary, graphOutput],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, disabledBoundary.id, 'input', 'output1'),
        connect(disabledBoundary.id, graphOutput.id, 'value'),
      ],
    );

    await createProcessor(graph).processGraph(testProcessContext());
    assert.equal(AsyncTestNodeImpl.runCounts.get(disabledBoundary.id), undefined);
  });

  void it('rejects frozen async triggers and includes foreground plus async cost before the root finishes', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const costLeaf = makeTestNode('cost-leaf');
    const graph = makeGraph(
      'async-cost',
      [source, trigger, costLeaf],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, costLeaf.id, 'input', 'output1')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({
      cost: { type: 'number', value: 2 },
      output: { type: 'string', value: 'start' },
    }));
    AsyncTestNodeImpl.handlers.set(costLeaf.id, (inputs) => ({
      cost: { type: 'number', value: 3 },
      output: inputs['input' as PortId]!,
    }));
    const costOutputs = await createProcessor(graph).processGraph(testProcessContext());
    assert.equal(costOutputs.cost?.value, 5);

    const frozenProcessor = createProcessor(graph);
    frozenProcessor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata!.id!]: {
          [trigger.id]: [{ output1: { type: 'string', value: 'frozen' } }],
        },
      }),
    );
    await assert.rejects(frozenProcessor.processGraph(testProcessContext()), (error: Error) => {
      assert.match(String(error.cause), /cannot use frozen outputs.*async side effects/);
      return true;
    });
    assert.equal(AsyncTestNodeImpl.runCounts.get(costLeaf.id), 1);
  });

  void it('reuses explicit preloads without retaining prior runtime results or cost', async () => {
    const boundary = makeTestNode('preloaded-boundary');
    const foreground = makeTestNode('foreground-cost');
    const trigger = makeAsyncNode();
    const asyncLeaf = makeTestNode('async-cost');
    const graph = makeGraph(
      'async-reused-processor',
      [boundary, foreground, trigger, asyncLeaf],
      [
        connect(boundary.id, foreground.id),
        connect(foreground.id, trigger.id, 'input1'),
        connect(trigger.id, asyncLeaf.id, 'input', 'output1'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(foreground.id, (inputs) => ({
      cost: { type: 'number', value: 2 },
      output: inputs['input' as PortId]!,
    }));
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, (inputs) => ({
      cost: { type: 'number', value: 3 },
      output: inputs['input' as PortId]!,
    }));

    const processor = createProcessor(graph);
    processor.preloadNodeData(boundary.id, {
      output: { type: 'string', value: 'boundary' },
    });

    const firstOutputs = await processor.processGraph(testProcessContext());
    const secondOutputs = await processor.processGraph(testProcessContext());

    assert.equal(firstOutputs.cost?.value, 5);
    assert.equal(secondOutputs.cost?.value, 5);
    assert.equal(AsyncTestNodeImpl.runCounts.get(boundary.id), undefined);
    assert.equal(AsyncTestNodeImpl.runCounts.get(foreground.id), 2);
    assert.equal(AsyncTestNodeImpl.runCounts.get(asyncLeaf.id), 2);
  });

  void it('launches for explicit undefined values but not for control-flow exclusions', async () => {
    for (const [scenario, output, expectedRuns] of [
      ['explicit-undefined', { type: 'any', value: undefined }, 1],
      ['excluded', { type: 'control-flow-excluded', value: undefined }, undefined],
    ] as const) {
      const source = makeTestNode(`${scenario}-source`);
      const trigger = makeAsyncNode(`${scenario}-trigger`);
      const leaf = makeTestNode(`${scenario}-leaf`);
      const graph = makeGraph(
        `async-${scenario}`,
        [source, trigger, leaf],
        [connect(source.id, trigger.id, 'input1'), connect(trigger.id, leaf.id, 'input', 'output1')],
      );
      AsyncTestNodeImpl.handlers.set(source.id, () => ({ output }));

      await createProcessor(graph).processGraph(testProcessContext());

      assert.equal(AsyncTestNodeImpl.runCounts.get(leaf.id), expectedRuns, `${scenario} launch behavior was incorrect`);
    }
  });

  void it('pauses queued async descendants and resumes them with the root run', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const first = makeTestNode('first');
    const second = makeTestNode('second');
    const graph = makeGraph(
      'async-pause',
      [source, trigger, first, second],
      [
        connect(source.id, trigger.id, 'input1'),
        connect(trigger.id, first.id, 'input', 'output1'),
        connect(first.id, second.id),
      ],
    );
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    AsyncTestNodeImpl.handlers.set(first.id, async (inputs) => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { output: inputs['input' as PortId]! };
    });
    AsyncTestNodeImpl.handlers.set(second.id, (inputs) => {
      secondStarted.resolve();
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    const run = processor.processGraph(testProcessContext());
    await withTimeout(firstStarted.promise, 'the first async node');
    processor.pause();
    releaseFirst.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(AsyncTestNodeImpl.runCounts.get(second.id), undefined);

    processor.resume();
    await withTimeout(Promise.all([secondStarted.promise, run]), 'the resumed async branch');
    assert.equal(AsyncTestNodeImpl.runCounts.get(second.id), 1);
  });

  void it('cancels active async work with the root run', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const leaf = makeTestNode('cancelled-leaf');
    const graph = makeGraph(
      'async-cancel',
      [source, trigger, leaf],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, leaf.id, 'input', 'output1')],
    );
    const branchStarted = deferred();
    let observedAbort = false;
    AsyncTestNodeImpl.handlers.set(leaf.id, async (_inputs, context) => {
      branchStarted.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      observedAbort = context.signal.aborted;
      return { output: { type: 'string', value: 'cancelled' } };
    });

    const processor = createProcessor(graph);
    const run = processor.processGraph(testProcessContext());
    await withTimeout(branchStarted.promise, 'the cancellable async branch');
    await withTimeout(processor.abort(false, 'async run cancelled'), 'root cancellation');
    await assert.rejects(withTimeout(run, 'the cancelled root run'), /async run cancelled/);
    assert.equal(observedAbort, true);
  });

  void it('falls back from the fast scheduler when an async trigger is present', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const leaf = makeTestNode('leaf');
    const graph = makeGraph(
      'async-fast-fallback',
      [source, trigger, leaf],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, leaf.id, 'input', 'output1')],
    );
    const buckets: string[] = [];
    const project = makeProject(graph);
    const processor = new GraphProcessor(
      project,
      graph.metadata!.id,
      createBuiltInRegistry().register(asyncTestNode),
      false,
      {
        scheduler: 'fast-acyclic',
        runtimeProfiler: { addDuration: (bucket) => buckets.push(bucket) },
      },
    );

    await processor.processGraph(testProcessContext());

    assert.equal(buckets.includes('processCompatibleGraph'), true);
    assert.equal(buckets.includes('processFastAcyclicGraph'), false);
    assert.equal(AsyncTestNodeImpl.runCounts.get(leaf.id), 1);
  });

  void it('ignores invalid disabled and Run To-unrelated async subtrees', async () => {
    const source = makeTestNode('source');
    const disabledTrigger = { ...makeAsyncNode('disabled-trigger'), disabled: true };
    const disabledOutput = makeGraphOutputNode('disabled-result');
    const target = makeTestNode('target');
    const unrelatedTrigger = makeAsyncNode('unrelated-trigger');
    const unrelatedOutput = makeGraphOutputNode('unrelated-result');
    const graph = makeGraph(
      'async-irrelevant',
      [source, disabledTrigger, disabledOutput, target, unrelatedTrigger, unrelatedOutput],
      [
        connect(source.id, disabledTrigger.id, 'input1'),
        connect(disabledTrigger.id, disabledOutput.id, 'value', 'output1'),
        connect(source.id, target.id),
        connect(source.id, unrelatedTrigger.id, 'input1'),
        connect(unrelatedTrigger.id, unrelatedOutput.id, 'value', 'output1'),
      ],
    );
    const processor = createProcessor(graph);
    processor.runToNodeIds = [target.id];

    await processor.processGraph(testProcessContext());

    assert.equal(AsyncTestNodeImpl.runCounts.get(target.id), 1);
  });

  void it('runs and waits when Run To targets an async descendant', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const target = makeTestNode('async-target');
    const graph = makeGraph(
      'async-run-to',
      [source, trigger, target],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, target.id, 'input', 'output1')],
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    AsyncTestNodeImpl.handlers.set(target.id, async (inputs) => {
      targetStarted.resolve();
      await releaseTarget.promise;
      return { output: inputs['input' as PortId]! };
    });
    const processor = createProcessor(graph);
    processor.runToNodeIds = [target.id];
    let settled = false;
    const run = processor.processGraph(testProcessContext()).finally(() => {
      settled = true;
    });

    await withTimeout(targetStarted.promise, 'the Run To async target');
    assert.equal(settled, false);
    releaseTarget.resolve();
    await withTimeout(run, 'the Run To async branch');
  });

  void it('rejects explicitly preloaded async descendants', async () => {
    const source = makeTestNode('source');
    const trigger = makeAsyncNode();
    const leaf = makeTestNode('preloaded-leaf');
    const graph = makeGraph(
      'async-preload',
      [source, trigger, leaf],
      [connect(source.id, trigger.id, 'input1'), connect(trigger.id, leaf.id, 'input', 'output1')],
    );
    const processor = createProcessor(graph);
    processor.preloadNodeData(leaf.id, { output: { type: 'string', value: 'preloaded' } });

    await assert.rejects(
      processor.processGraph(testProcessContext()),
      /cannot contain preloaded node "preloaded-leaf"/,
    );

    const preloadedTriggerProcessor = createProcessor(graph);
    preloadedTriggerProcessor.preloadNodeData(trigger.id, {
      output1: { type: 'string', value: 'preloaded trigger' },
    });
    await assert.rejects(preloadedTriggerProcessor.processGraph(testProcessContext()), /cannot use preloaded outputs/);
  });

  void it('serializes repeated invocations of the same async trigger', async () => {
    const controller = new ManagedAsyncBranches();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const enqueue = (label: string, block: boolean) => {
      controller.enqueue(
        'project:graph:trigger',
        async () => {
          order.push(`${label}:start`);
          active++;
          maxActive = Math.max(maxActive, active);
          if (block) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          active--;
          order.push(`${label}:finish`);
        },
        (error) => {
          throw error;
        },
      );
    };
    enqueue('first', true);
    enqueue('second', false);

    await withTimeout(firstStarted.promise, 'the first FIFO branch invocation');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['first:start']);
    releaseFirst.resolve();
    await withTimeout(controller.drain(), 'serialized async invocations');

    assert.deepEqual(order, ['first:start', 'first:finish', 'second:start', 'second:finish']);
    assert.equal(maxActive, 1);
  });
});
