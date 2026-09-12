import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import Emittery from 'emittery';
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
import { replayExecutionRecording } from '../../src/model/RecordingPlayer.js';
import { ExecutionRecorder } from '../../src/recording/ExecutionRecorder.js';
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

function makeWatchNode(id = 'watch'): ChartNode {
  return {
    data: {
      executionMode: 'sequential',
      intervalMs: 1_000,
      maxParallelRuns: 4,
      maxQueuedUpdates: 32,
      queueOverflowBehavior: 'fail',
      triggerMode: 'every-update',
    },
    id: id as NodeId,
    title: 'Watch Streaming Output',
    type: 'watchStreamingOutput',
    visualData: { x: 200, y: 0, width: 230 },
  };
}

function makeStopWatchNode(id = 'stop-watch'): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title: 'Stop Watching Streaming Output',
    type: 'stopWatchingStreamingOutput',
    visualData: { x: 500, y: 0, width: 230 },
  };
}

function makeDataBusNode(id: string): ChartNode {
  return {
    data: {},
    id: id as NodeId,
    title: 'Data Bus',
    type: 'dataBus',
    visualData: { x: 400, y: 0, width: 175 },
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

function makeGraphInputNode(id: string, inputId = 'input'): ChartNode {
  return {
    data: { dataType: 'any', id: inputId },
    id: id as NodeId,
    title: 'Graph Input',
    type: 'graphInput',
    visualData: { x: 0, y: 0, width: 220 },
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

function makeReferencedGraphAliasNode(id: string, projectId: ProjectId, graphId: GraphId): ChartNode {
  return {
    data: { graphId, inputData: {}, projectId, useErrorOutput: false },
    id: id as NodeId,
    title: id,
    type: 'referencedGraphAlias',
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

void describe('GraphProcessor scheduler boundaries', () => {
  void it('runs a streaming watch branch before the producer finishes and rejoins after Stop', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const join = makeTestNode('join');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-rejoin',
      [source, watch, branch, stop, join, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, join.id, 'input', 'value'),
        connect(source.id, join.id, 'other'),
        connect(join.id, graphOutput.id, 'value'),
      ],
    );
    const watchReached = deferred();
    const releaseSource = deferred();
    const executionOrder: string[] = [];

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      const partialPayload = { text: 'partial value' };
      context.onPartialOutputs?.({ output: { type: 'object', value: partialPayload } });
      partialPayload.text = 'mutated after emission';
      await releaseSource.promise;
      executionOrder.push('source-finished');
      return { output: { type: 'string', value: 'final value' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      executionOrder.push('watch-branch');
      assert.deepEqual(inputs['input' as PortId]?.value, { text: 'partial value' });
      watchReached.resolve();
      releaseSource.resolve();
      return { output: { type: 'string', value: 'accepted partial' } };
    });
    AsyncTestNodeImpl.handlers.set(join.id, (inputs) => {
      executionOrder.push('join');
      assert.equal(inputs['input' as PortId]?.value, 'accepted partial');
      assert.equal(inputs['other' as PortId]?.value, 'final value');
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    const run = processor.processGraph(testProcessContext());
    await withTimeout(watchReached.promise, 'the streaming watch branch');
    const outputs = await withTimeout(run, 'the streaming watch graph');

    assert.equal(outputs.result?.value, 'accepted partial');
    assert.deepEqual(executionOrder, ['watch-branch', 'source-finished', 'join']);
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
  });

  void it('streams a direct named Subgraph output to Watch before the child graph finishes', async () => {
    const childSource = makeTestNode('child-streaming-source');
    const childOutput = makeGraphOutputNode('renamed-response');
    childOutput.data = { ...childOutput.data, dataType: 'object' };
    const child = makeGraph(
      'child-streaming-output',
      [childSource, childOutput],
      [connect(childSource.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('streaming-child', child.metadata!.id);
    subgraph.data = { ...subgraph.data, skipUnusedOutputs: true };
    const watch = makeWatchNode('watch-child-response');
    const branch = makeTestNode('watch-child-branch');
    const stop = makeStopWatchNode('stop-child-watch');
    const join = makeTestNode('join-child-result');
    const output = makeGraphOutputNode('result');
    const root = makeGraph(
      'watch-child-streaming-output',
      [subgraph, watch, branch, stop, join, output],
      [
        connect(subgraph.id, watch.id, 'stream', 'renamed-response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, join.id, 'input', 'value'),
        connect(subgraph.id, join.id, 'other', 'renamed-response'),
        connect(join.id, output.id, 'value'),
      ],
    );
    const watchReached = deferred();
    const releaseChild = deferred();

    AsyncTestNodeImpl.handlers.set(childSource.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'any', value: { phase: 'partial' } } });
      await releaseChild.promise;
      return { output: { type: 'any', value: { phase: 'final' } } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      assert.equal(inputs['input' as PortId]?.type, 'object');
      assert.deepEqual(inputs['input' as PortId]?.value, { phase: 'partial' });
      watchReached.resolve();
      releaseChild.resolve();
      return { output: { type: 'string', value: 'accepted child partial' } };
    });
    AsyncTestNodeImpl.handlers.set(join.id, (inputs) => {
      assert.equal(inputs['input' as PortId]?.value, 'accepted child partial');
      assert.equal(inputs['other' as PortId]?.type, 'object');
      assert.deepEqual(inputs['other' as PortId]?.value, { phase: 'final' });
      return { output: { type: 'string', value: 'joined child result' } };
    });

    const processor = createProcessor(root, [child]);
    const subgraphPartialEvents: ProcessEvents['partialOutput'][] = [];
    processor.on('partialOutput', (event) => {
      if (event.node.id === subgraph.id) {
        subgraphPartialEvents.push(event);
      }
    });
    const run = processor.processGraph(testProcessContext());
    await withTimeout(watchReached.promise, 'the child output watch branch');
    const outputs = await withTimeout(run, 'the child output watch graph');
    assert.equal(outputs.result?.value, 'joined child result');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
    assert.deepEqual(subgraphPartialEvents, []);
  });

  void it('streams a direct named Referenced Graph Alias output to Watch before the child graph finishes', async () => {
    const referencedProjectId = 'streaming-referenced-project' as ProjectId;
    const referencedGraphId = 'streaming-referenced-graph' as GraphId;
    const referencedSource = makeTestNode('streaming-referenced-source');
    const referencedOutput = makeGraphOutputNode('response');
    const referencedGraph = makeGraph(
      referencedGraphId,
      [referencedSource, referencedOutput],
      [connect(referencedSource.id, referencedOutput.id, 'value')],
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;

    const alias = makeReferencedGraphAliasNode('streaming-referenced-alias', referencedProjectId, referencedGraphId);
    const watch = makeWatchNode('watch-referenced-response');
    const branch = makeTestNode('watch-referenced-branch');
    const root = makeGraph(
      'watch-referenced-graph-output',
      [alias, watch, branch],
      [
        connect(alias.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const receivedSnapshots: Array<{ isFinal: unknown; value: unknown }> = [];
    const releaseReferencedSource = deferred();

    AsyncTestNodeImpl.handlers.set(referencedSource.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'referenced partial' } });
      await releaseReferencedSource.promise;
      return { output: { type: 'string', value: 'referenced final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      receivedSnapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      if (inputs['input' as PortId]?.value === 'referenced partial') {
        releaseReferencedSource.resolve();
      }
      return {};
    });

    const rootProject = makeProject(root);
    rootProject.references = [{ id: referencedProjectId }];
    const processor = new GraphProcessor(
      rootProject,
      root.metadata!.id,
      createBuiltInRegistry().register(asyncTestNode),
    );
    await withTimeout(
      processor.processGraph({
        ...testProcessContext(),
        projectReferenceLoader: { loadProject: async () => referencedProject },
      }),
      'the referenced graph output watch graph',
    );

    assert.deepEqual(receivedSnapshots, [
      { isFinal: false, value: 'referenced partial' },
      { isFinal: true, value: 'referenced final' },
    ]);
  });

  void it('keeps an error-handling Referenced Graph Alias final-only when its child fails after a partial value', async () => {
    const referencedProjectId = 'failing-streaming-referenced-project' as ProjectId;
    const referencedGraphId = 'failing-streaming-referenced-graph' as GraphId;
    const referencedSource = makeTestNode('failing-streaming-referenced-source');
    const referencedOutput = makeGraphOutputNode('response');
    const referencedGraph = makeGraph(
      referencedGraphId,
      [referencedSource, referencedOutput],
      [connect(referencedSource.id, referencedOutput.id, 'value')],
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;

    const alias = makeReferencedGraphAliasNode(
      'failing-streaming-referenced-alias',
      referencedProjectId,
      referencedGraphId,
    );
    alias.data.useErrorOutput = true;
    const watch = makeWatchNode('watch-failing-referenced-response');
    const branch = makeTestNode('watch-failing-referenced-branch');
    const root = makeGraph(
      'watch-failing-referenced-graph-output',
      [alias, watch, branch],
      [connect(alias.id, watch.id, 'stream', 'response'), connect(watch.id, branch.id, 'input', 'value')],
    );

    AsyncTestNodeImpl.handlers.set(referencedSource.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'discarded referenced partial' } });
      throw new Error('referenced child failure converted to error output');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      throw new Error('an error-handling Referenced Graph Alias must not start a Watch branch');
    });

    const rootProject = makeProject(root);
    rootProject.references = [{ id: referencedProjectId }];
    const processor = new GraphProcessor(
      rootProject,
      root.metadata!.id,
      createBuiltInRegistry().register(asyncTestNode),
    );
    let aliasOutputs: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === alias.id) {
        aliasOutputs = outputs;
      }
    });
    await withTimeout(
      processor.processGraph({
        ...testProcessContext(),
        projectReferenceLoader: { loadProject: async () => referencedProject },
      }),
      'the error-handling referenced graph output watch graph',
    );

    assert.deepEqual(aliasOutputs?.response, { type: 'control-flow-excluded', value: undefined });
    assert.equal(aliasOutputs?.error?.type, 'string');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), undefined);
  });

  void it('delivers an ambiguous duplicate named Subgraph output only after it finishes', async () => {
    const childSource = makeTestNode('duplicate-streaming-source');
    const firstOutput = makeGraphOutputNode('response');
    firstOutput.id = 'first-duplicate-response' as NodeId;
    const secondOutput = makeGraphOutputNode('response');
    secondOutput.id = 'second-duplicate-response' as NodeId;
    const child = makeGraph(
      'duplicate-streaming-output',
      [childSource, firstOutput, secondOutput],
      [connect(childSource.id, firstOutput.id, 'value'), connect(childSource.id, secondOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('duplicate-streaming-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-duplicate-response');
    const branch = makeTestNode('watch-duplicate-branch');
    const root = makeGraph(
      'watch-duplicate-streaming-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const partialPublished = deferred();
    const releaseChild = deferred();
    const branchSnapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(childSource.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'ambiguous partial' } });
      partialPublished.resolve();
      await releaseChild.promise;
      return { output: { type: 'string', value: 'terminal response' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      branchSnapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    const run = createProcessor(root, [child]).processGraph(testProcessContext());
    await withTimeout(partialPublished.promise, 'the ambiguous child partial');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(branchSnapshots, []);

    releaseChild.resolve();
    await withTimeout(run, 'the duplicate child output watch graph');
    assert.deepEqual(branchSnapshots, [{ isFinal: true, value: 'terminal response' }]);
  });

  void it('relays named streaming outputs through nested Subgraphs without leaking raw child port names', async () => {
    const source = makeTestNode('nested-streaming-source');
    const innerOutput = makeGraphOutputNode('inner-response');
    const inner = makeGraph(
      'nested-inner-streaming-output',
      [source, innerOutput],
      [connect(source.id, innerOutput.id, 'value')],
    );
    const innerSubgraph = makeSubgraphNode('nested-inner-subgraph', inner.metadata!.id);
    const middleOutput = makeGraphOutputNode('outer-response');
    const middle = makeGraph(
      'nested-middle-streaming-output',
      [innerSubgraph, middleOutput],
      [connect(innerSubgraph.id, middleOutput.id, 'value', 'inner-response')],
    );
    const outerSubgraph = makeSubgraphNode('nested-outer-subgraph', middle.metadata!.id);
    const watch = makeWatchNode('watch-nested-response');
    const branch = makeTestNode('watch-nested-branch');
    const result = makeGraphOutputNode('result');
    const root = makeGraph(
      'watch-nested-streaming-output',
      [outerSubgraph, watch, branch, result],
      [
        connect(outerSubgraph.id, watch.id, 'stream', 'outer-response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(outerSubgraph.id, result.id, 'value', 'outer-response'),
      ],
    );
    const releaseSource = deferred();
    const receivedChunks: unknown[] = [];

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'nested partial' } });
      await releaseSource.promise;
      return { output: { type: 'string', value: 'nested final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      receivedChunks.push(inputs['input' as PortId]?.value);
      if (inputs['input' as PortId]?.value === 'nested partial') {
        releaseSource.resolve();
      }
      return {};
    });

    const outputs = await withTimeout(
      createProcessor(root, [middle, inner]).processGraph(testProcessContext()),
      'nested output watch graph',
    );
    assert.equal(outputs.result?.value, 'nested final');
    assert.deepEqual(receivedChunks, ['nested partial', 'nested final']);
  });

  void it('streams a Graph Output reached through compiled Data Bus topology', async () => {
    const source = makeTestNode('data-bus-streaming-source');
    const dataBus = makeDataBusNode('data-bus');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'data-bus-child-streaming-output',
      [source, dataBus, childOutput],
      [connect(source.id, dataBus.id, 'input1'), connect(dataBus.id, childOutput.id, 'value', 'output1')],
    );
    const subgraph = makeSubgraphNode('data-bus-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-data-bus-response');
    const branch = makeTestNode('watch-data-bus-branch');
    const root = makeGraph(
      'watch-data-bus-streaming-output',
      [subgraph, watch, branch],
      [connect(subgraph.id, watch.id, 'stream', 'response'), connect(watch.id, branch.id, 'input', 'value')],
    );
    const receivedChunks: unknown[] = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'bus partial' } });
      return { output: { type: 'string', value: 'bus final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      receivedChunks.push(inputs['input' as PortId]?.value);
      return {};
    });

    await withTimeout(createProcessor(root, [child]).processGraph(testProcessContext()), 'data bus output watch graph');
    assert.deepEqual(receivedChunks, ['bus partial', 'bus final']);
  });

  void it('does not stream across an ordinary child-graph node before Graph Output', async () => {
    const source = makeTestNode('indirect-streaming-source');
    const relay = makeTestNode('indirect-streaming-relay');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'indirect-child-streaming-output',
      [source, relay, childOutput],
      [connect(source.id, relay.id), connect(relay.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('indirect-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-indirect-response');
    const branch = makeTestNode('watch-indirect-branch');
    const root = makeGraph(
      'watch-indirect-streaming-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const finalFlags: unknown[] = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'must not cross relay' } });
      return { output: { type: 'string', value: 'final through relay' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      finalFlags.push(inputs['other' as PortId]?.value);
      assert.equal(inputs['input' as PortId]?.value, 'final through relay');
      return {};
    });

    await withTimeout(createProcessor(root, [child]).processGraph(testProcessContext()), 'indirect output watch graph');
    assert.deepEqual(finalFlags, [true]);
  });

  void it('cancels a Subgraph-output Watch when the child graph errors after a partial value', async () => {
    const source = makeTestNode('failing-child-streaming-source');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'failing-child-streaming-output',
      [source, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('failing-child-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-failing-child-response');
    const branch = makeTestNode('watch-failing-child-branch');
    const root = makeGraph(
      'watch-failing-child-streaming-output',
      [subgraph, watch, branch],
      [connect(subgraph.id, watch.id, 'stream', 'response'), connect(watch.id, branch.id, 'input', 'value')],
    );
    const branchCancelled = deferred();

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial before failure' } });
      throw new Error('child streaming failure');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (_inputs, context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) {
          resolve();
          return;
        }
        context.signal.addEventListener('abort', resolve, { once: true });
      });
      branchCancelled.resolve();
      return {};
    });

    const processor = createProcessor(root, [child]);
    await assert.rejects(
      withTimeout(processor.processGraph(testProcessContext()), 'failing child output watch graph'),
      /failing-child-subgraph/,
    );
    await withTimeout(branchCancelled.promise, 'the cancelled child output watch branch');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
  });

  void it('keeps an error-handling Subgraph boundary final-only when its child fails after a partial value', async () => {
    const source = makeTestNode('error-output-child-streaming-source');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'error-output-child-streaming-output',
      [source, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('error-output-child-subgraph', child.metadata!.id);
    subgraph.data.useErrorOutput = true;
    const watch = makeWatchNode('watch-error-output-child-response');
    const branch = makeTestNode('watch-error-output-child-branch');
    const root = makeGraph(
      'watch-error-output-child-streaming-output',
      [subgraph, watch, branch],
      [connect(subgraph.id, watch.id, 'stream', 'response'), connect(watch.id, branch.id, 'input', 'value')],
    );

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial replaced by the error boundary' } });
      throw new Error('child failure converted to error output');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      throw new Error('an error-handling Subgraph must not start a Watch branch from a discarded partial');
    });

    const processor = createProcessor(root, [child]);
    let subgraphOutputs: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === subgraph.id) {
        subgraphOutputs = outputs;
      }
    });
    await withTimeout(processor.processGraph(testProcessContext()), 'error-handling child output watch graph');
    assert.deepEqual(subgraphOutputs?.response, { type: 'control-flow-excluded', value: undefined });
    assert.equal(subgraphOutputs?.error?.type, 'string');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), undefined);
  });

  void it('does not leak a partial through a false conditional child Graph Output', async () => {
    const source = makeTestNode('conditional-streaming-source');
    const condition = makeTestNode('conditional-streaming-condition');
    const childOutput = makeGraphOutputNode('response');
    childOutput.isConditional = true;
    const child = makeGraph(
      'conditional-child-streaming-output',
      [source, condition, childOutput],
      [connect(source.id, childOutput.id, 'value'), connect(condition.id, childOutput.id, '$if')],
    );
    const subgraph = makeSubgraphNode('conditional-streaming-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-conditional-response');
    const branch = makeTestNode('watch-conditional-branch');
    const root = makeGraph(
      'watch-conditional-streaming-output',
      [subgraph, watch, branch],
      [connect(subgraph.id, watch.id, 'stream', 'response'), connect(watch.id, branch.id, 'input', 'value')],
    );

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'must remain private' } });
      await wait(20);
      return { output: { type: 'string', value: 'also excluded' } };
    });
    AsyncTestNodeImpl.handlers.set(condition.id, () => ({ output: { type: 'boolean', value: false } }));
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      throw new Error('a false Graph Output must not start a Watch branch');
    });

    await withTimeout(
      createProcessor(root, [child]).processGraph(testProcessContext()),
      'conditional child output watch graph',
    );
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), undefined);
  });

  void it('waits for a delayed conditional child Graph Output before delivering its final value', async () => {
    const source = makeTestNode('delayed-conditional-source');
    const condition = makeTestNode('delayed-conditional-condition');
    const childOutput = makeGraphOutputNode('response');
    childOutput.isConditional = true;
    const child = makeGraph(
      'delayed-conditional-child-output',
      [source, condition, childOutput],
      [connect(source.id, childOutput.id, 'value'), connect(condition.id, childOutput.id, '$if')],
    );
    const subgraph = makeSubgraphNode('delayed-conditional-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-delayed-conditional-response');
    const branch = makeTestNode('watch-delayed-conditional-branch');
    const root = makeGraph(
      'watch-delayed-conditional-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const partialPublished = deferred();
    const allowCondition = deferred();
    const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial before condition' } });
      partialPublished.resolve();
      return { output: { type: 'string', value: 'final after condition' } };
    });
    AsyncTestNodeImpl.handlers.set(condition.id, async () => {
      await allowCondition.promise;
      return { output: { type: 'boolean', value: true } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      snapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    const processor = createProcessor(root, [child]);
    let subgraphOutputs: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === subgraph.id) {
        subgraphOutputs = outputs;
      }
    });
    const run = processor.processGraph(testProcessContext());
    await withTimeout(partialPublished.promise, 'the private child partial');
    await wait(20);
    assert.deepEqual(snapshots, []);

    allowCondition.resolve();
    await withTimeout(run, 'the delayed conditional child output watch graph');
    assert.deepEqual(snapshots, [{ isFinal: true, value: 'final after condition' }]);
    assert.deepEqual(subgraphOutputs?.response, { type: 'string', value: 'final after condition' });
  });

  void it('uses a frozen child Graph Output as the only Watch value without consuming its replay cursor early', async () => {
    const source = makeTestNode('frozen-boundary-source');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'frozen-boundary-child-output',
      [source, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('frozen-boundary-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-frozen-boundary-response');
    const branch = makeTestNode('watch-frozen-boundary-branch');
    const root = makeGraph(
      'watch-frozen-boundary-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'live partial must not escape' } });
      await wait(20);
      return { output: { type: 'string', value: 'live final must not escape' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      snapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    const processor = createProcessor(root, [child]);
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [child.metadata!.id!]: {
          [childOutput.id]: [
            { valueOutput: { type: 'string', value: 'first frozen response' } },
            { valueOutput: { type: 'string', value: 'second frozen response' } },
          ],
        },
      }),
    );

    await withTimeout(processor.processGraph(testProcessContext()), 'the frozen child output watch graph');
    assert.deepEqual(snapshots, [{ isFinal: true, value: 'first frozen response' }]);
  });

  void it('keeps a live child boundary streaming when generated frozen data belongs to another node', async () => {
    const source = makeTestNode('live-source-with-unrelated-freeze');
    const unrelated = makeTestNode('unrelated-frozen-node');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'unrelated-frozen-child-output',
      [source, unrelated, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('unrelated-frozen-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-live-response-with-unrelated-freeze');
    const branch = makeTestNode('watch-live-boundary-branch');
    const root = makeGraph(
      'watch-live-boundary-with-unrelated-freeze',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'live partial' } });
      return { output: { type: 'string', value: 'live final' } };
    });
    AsyncTestNodeImpl.handlers.set(unrelated.id, () => {
      throw new Error('the unrelated frozen node must not run');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      snapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    const processor = createProcessor(root, [child]);
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [child.metadata!.id!]: {
          [unrelated.id]: [{ output: { type: 'string', value: 'unrelated frozen result' } }],
        },
      }),
    );

    await withTimeout(processor.processGraph(testProcessContext()), 'the live child output with unrelated freeze');
    assert.deepEqual(snapshots, [
      { isFinal: false, value: 'live partial' },
      { isFinal: true, value: 'live final' },
    ]);
    assert.equal(AsyncTestNodeImpl.runCounts.get(unrelated.id), undefined);
  });

  void it('keeps opaque custom frozen resolvers final-only at a child boundary', async () => {
    const source = makeTestNode('opaque-frozen-resolver-source');
    const childOutput = makeGraphOutputNode('response');
    const child = makeGraph(
      'opaque-frozen-resolver-child-output',
      [source, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('opaque-frozen-resolver-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-opaque-frozen-resolver-response');
    const branch = makeTestNode('watch-opaque-frozen-resolver-branch');
    const root = makeGraph(
      'watch-opaque-frozen-resolver-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'opaque partial' } });
      return { output: { type: 'string', value: 'opaque final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      snapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    const processor = createProcessor(root, [child]);
    processor.setFrozenNodeOutputResolver(() => undefined);
    await withTimeout(processor.processGraph(testProcessContext()), 'the opaque frozen resolver child output');
    assert.deepEqual(snapshots, [{ isFinal: true, value: 'opaque final' }]);
  });

  void it('delivers a split child producer only as one final Subgraph Watch value', async () => {
    for (const isSequential of [true, false]) {
      const feeder = makeTestNode(`split-child-feeder-${isSequential}`);
      const source = makeTestNode(`split-child-source-${isSequential}`);
      source.isSplitRun = true;
      source.isSplitSequential = isSequential;
      const childOutput = makeGraphOutputNode('response');
      const child = makeGraph(
        `split-child-output-${isSequential}`,
        [feeder, source, childOutput],
        [connect(feeder.id, source.id), connect(source.id, childOutput.id, 'value')],
      );
      const subgraph = makeSubgraphNode(`split-child-subgraph-${isSequential}`, child.metadata!.id);
      const watch = makeWatchNode(`watch-split-child-response-${isSequential}`);
      const branch = makeTestNode(`watch-split-child-branch-${isSequential}`);
      const root = makeGraph(
        `watch-split-child-output-${isSequential}`,
        [subgraph, watch, branch],
        [
          connect(subgraph.id, watch.id, 'stream', 'response'),
          connect(watch.id, branch.id, 'input', 'value'),
          connect(watch.id, branch.id, 'other', 'isFinal'),
        ],
      );
      const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

      AsyncTestNodeImpl.handlers.set(feeder.id, () => ({ output: { type: 'string[]', value: ['first', 'second'] } }));
      AsyncTestNodeImpl.handlers.set(source.id, (inputs, context) => {
        const value = inputs['input' as PortId]?.value as string;
        context.onPartialOutputs?.({ output: { type: 'string', value: `${value} partial` } });
        return { output: { type: 'string', value: `${value} final` } };
      });
      AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
        snapshots.push({
          isFinal: inputs['other' as PortId]?.value,
          value: inputs['input' as PortId]?.value,
        });
        return {};
      });

      await withTimeout(
        createProcessor(root, [child]).processGraph(testProcessContext()),
        `the ${isSequential ? 'sequential' : 'parallel'} split child output watch graph`,
      );
      assert.deepEqual(snapshots, [{ isFinal: true, value: ['first final', 'second final'] }]);
    }
  });

  void it('delivers a split child Graph Output only as its ordinary terminal winner', async () => {
    const source = makeTestNode('split-boundary-source');
    const childOutput = makeGraphOutputNode('response');
    childOutput.isSplitRun = true;
    const child = makeGraph(
      'split-boundary-child-output',
      [source, childOutput],
      [connect(source.id, childOutput.id, 'value')],
    );
    const subgraph = makeSubgraphNode('split-boundary-subgraph', child.metadata!.id);
    const watch = makeWatchNode('watch-split-boundary-response');
    const branch = makeTestNode('watch-split-boundary-branch');
    const root = makeGraph(
      'watch-split-boundary-output',
      [subgraph, watch, branch],
      [
        connect(subgraph.id, watch.id, 'stream', 'response'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const snapshots: Array<{ isFinal: unknown; value: unknown }> = [];

    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string[]', value: ['partial first', 'partial second'] } });
      return { output: { type: 'string[]', value: ['terminal first', 'terminal second'] } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      snapshots.push({
        isFinal: inputs['other' as PortId]?.value,
        value: inputs['input' as PortId]?.value,
      });
      return {};
    });

    await withTimeout(
      createProcessor(root, [child]).processGraph(testProcessContext()),
      'the split boundary child watch',
    );
    assert.deepEqual(snapshots, [{ isFinal: true, value: 'terminal first' }]);
  });

  void it('selects the first Stop reached even while that invocation has an unfinished sibling', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    watch.data = { ...watch.data, executionMode: 'parallel', maxParallelRuns: 2 };
    const branch = makeTestNode('branch');
    const sibling = makeTestNode('sibling');
    const stop = makeStopWatchNode();
    const receiver = makeTestNode('receiver');
    const output = makeGraphOutputNode();
    const graph = makeGraph(
      'first-stop-reached',
      [source, watch, branch, sibling, stop, receiver, output],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, sibling.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, receiver.id, 'input', 'value'),
        connect(receiver.id, output.id, 'value'),
      ],
    );
    const firstStop = deferred();
    const releaseSibling = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'first' } });
      return { output: { type: 'string', value: 'second' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (inputs) => {
      if (inputs['input' as PortId]?.value === 'second') await firstStop.promise;
      return { output: inputs['input' as PortId]! };
    });
    AsyncTestNodeImpl.handlers.set(sibling.id, async (inputs) => {
      if (inputs['input' as PortId]?.value === 'first') await releaseSibling.promise;
      return {};
    });
    AsyncTestNodeImpl.handlers.set(receiver.id, (inputs) => {
      releaseSibling.resolve();
      return { output: inputs['input' as PortId]! };
    });
    const processor = createProcessor(graph);
    const stopTerminals: Array<{ value: unknown; streamingWatchTerminal: boolean | undefined }> = [];
    processor.on('nodeFinish', ({ node, outputs, streamingWatchTerminal }) => {
      if (node.id !== stop.id) return;
      stopTerminals.push({
        value: outputs['value' as PortId]?.value,
        streamingWatchTerminal,
      });
      if (outputs['value' as PortId]?.value === 'first') firstStop.resolve();
    });
    try {
      const outputs = await withTimeout(
        processor.processGraph(testProcessContext()),
        'first Stop with a pending sibling',
      );
      assert.equal(outputs.result?.value, 'first');
      assert.deepEqual(stopTerminals, [{ value: 'first', streamingWatchTerminal: true }]);
    } finally {
      releaseSibling.resolve();
    }
  });

  void it('does not inspect later stream payloads after Stop has accepted a value', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const stop = makeStopWatchNode();
    const receiver = makeTestNode('receiver');
    const accepted = deferred();
    const graph = makeGraph(
      'stopped-watch-payloads',
      [source, watch, stop, receiver],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(stop.id, receiver.id, 'input', 'value'),
      ],
    );
    let latePayloadReads = 0;
    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'accepted' } });
      await accepted.promise;
      const payload = {
        get text() {
          latePayloadReads += 1;
          return 'late';
        },
      };
      context.onPartialOutputs?.({ output: { type: 'object', value: payload } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(receiver.id, () => {
      accepted.resolve();
      return {};
    });
    await withTimeout(createProcessor(graph).processGraph(testProcessContext()), 'stopped watch producer');
    assert.equal(latePayloadReads, 0);
  });

  void it('isolates per-invocation attached execution state', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const branch = makeTestNode('branch');
    const graph = makeGraph(
      'isolated-watch-state',
      [source, watch, branch],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, branch.id, 'input', 'value')],
    );
    const seen: unknown[] = [];
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'number', value: 1 } });
      return { output: { type: 'number', value: 2 } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs, context) => {
      seen.push(inputs['input' as PortId]?.value);
      // Race/loop metadata belongs to this invocation, even though node IDs repeat.
      context.attachedData.races = { raceIds: [], completed: true };
      return {};
    });
    await createProcessor(graph).processGraph(testProcessContext());
    assert.deepEqual(seen, [1, 2]);
  });

  void it('includes watch costs in the containing subgraph as well as the root exactly once', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const branch = makeTestNode('branch');
    const child = makeGraph(
      'child-with-watch',
      [source, watch, branch],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, branch.id, 'input', 'value')],
    );
    const subgraph = makeSubgraphNode('child', child.metadata!.id);
    const root = makeGraph('root-with-watch', [subgraph], []);
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    AsyncTestNodeImpl.handlers.set(branch.id, () => ({ cost: { type: 'number', value: 3 } }));
    const processor = createProcessor(root, [child]);
    let childCost: unknown;
    const summaries: ProcessEvents['streamingOutputWatchSummary'][] = [];
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === subgraph.id) childCost = outputs['cost' as PortId]?.value;
    });
    processor.on('streamingOutputWatchSummary', (event) => summaries.push(event));
    const outputs = await processor.processGraph(testProcessContext());
    assert.equal(childCost, 3);
    assert.equal(outputs.cost?.value, 3);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.watchNode.id, watch.id);
  });

  void it('propagates excluded sources through Stop so ordinary fallback nodes can run', async () => {
    for (const excludeBeforeProcessing of [false, true]) {
      const gate = makeTestNode('gate');
      const source = makeTestNode('source');
      const watch = makeWatchNode();
      const stop = makeStopWatchNode();
      const fallback = makeTestNode('fallback');
      const coalesce: ChartNode = {
        ...makeTestNode('coalesce'),
        type: 'coalesce',
        data: {},
      };
      const output = makeGraphOutputNode();
      const graph = makeGraph(
        'excluded-watch-source',
        [gate, source, watch, stop, fallback, coalesce, output],
        [
          ...(excludeBeforeProcessing ? [connect(gate.id, source.id)] : []),
          connect(source.id, watch.id, 'stream'),
          connect(watch.id, stop.id, 'value', 'value'),
          connect(stop.id, coalesce.id, 'input1', 'value'),
          connect(fallback.id, coalesce.id, 'input2'),
          connect(coalesce.id, output.id, 'value'),
        ],
      );
      AsyncTestNodeImpl.handlers.set(gate.id, () => ({ output: { type: 'control-flow-excluded', value: undefined } }));
      AsyncTestNodeImpl.handlers.set(source.id, () => ({
        output: { type: 'control-flow-excluded', value: undefined },
      }));
      const result = await createProcessor(graph).processGraph(testProcessContext());
      assert.equal(result.result?.value, 'fallback');
    }
  });

  void it('still fails if a winning invocation sibling errors after Stop has returned its value', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const stop = makeStopWatchNode();
    const sibling = makeTestNode('failing-sibling');
    const receiver = makeTestNode('receiver');
    const accepted = deferred();
    const graph = makeGraph(
      'watch-winning-sibling-error',
      [source, watch, stop, sibling, receiver],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(watch.id, sibling.id, 'input', 'value'),
        connect(stop.id, receiver.id, 'input', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(sibling.id, async () => {
      await accepted.promise;
      throw new Error('winning sibling failure');
    });
    AsyncTestNodeImpl.handlers.set(receiver.id, () => {
      accepted.resolve();
      return {};
    });
    const processor = createProcessor(graph);
    const summaries: ProcessEvents['streamingOutputWatchSummary'][] = [];
    processor.on('streamingOutputWatchSummary', (event) => summaries.push(event));
    await assert.rejects(
      withTimeout(processor.processGraph(testProcessContext()), 'winning sibling failure'),
      /failing-sibling/,
    );
    assert.equal(summaries[0]?.summary.selectedIteration?.updateIndex, 1);
    assert.equal(summaries[0]?.summary.selectedIteration?.reason, 'failure');
    assert.ok(summaries[0]?.summary.selectedIteration?.graphRunId);
    assert.equal(summaries[0]?.summary.failedIterations, 1);
  });

  void it('commits a split Stop boundary with the same aggregated output it records', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const stop = { ...makeStopWatchNode(), isSplitRun: true, isSplitSequential: true };
    const output = makeGraphOutputNode();
    const graph = makeGraph(
      'split-stop',
      [source, watch, stop, output],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(stop.id, output.id, 'value', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string[]', value: ['first', 'second'] } }));
    const processor = createProcessor(graph);
    const recorder = new ExecutionRecorder();
    recorder.record(processor);
    let terminalStopOutput: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === stop.id) {
        terminalStopOutput = outputs;
      }
    });

    const result = await processor.processGraph(testProcessContext());
    const expectedValue = { type: 'string[]', value: ['first', 'second'] };
    const recordedStopOutput = recorder.events.find(
      (event) => event.type === 'nodeFinish' && event.data.nodeId === stop.id,
    );
    const replayEmitter = new Emittery<ProcessEvents>();
    let replayedStopOutput: Outputs | undefined;
    replayEmitter.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === stop.id) {
        replayedStopOutput = outputs;
      }
    });
    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: makeProject(graph),
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
    });

    assert.deepEqual(terminalStopOutput?.['value' as PortId], expectedValue);
    assert.deepEqual(
      recordedStopOutput?.type === 'nodeFinish' ? recordedStopOutput.data.outputs['value' as PortId] : undefined,
      expectedValue,
    );
    assert.deepEqual(replayedStopOutput?.['value' as PortId], expectedValue);
    assert.deepEqual(result.result, expectedValue);
  });

  void it('records and replays the normal Stop Value that resumes the parent graph', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const stop = makeStopWatchNode();
    const output = makeGraphOutputNode();
    const graph = makeGraph(
      'recorded-stop-value',
      [source, watch, stop, output],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(stop.id, output.id, 'value', 'value'),
      ],
    );
    const expectedValue = { type: 'string', value: 'accepted final chunk' } as const;
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: expectedValue }));

    const processor = createProcessor(graph);
    const recorder = new ExecutionRecorder();
    recorder.record(processor);
    let terminalStopOutput: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === stop.id) {
        terminalStopOutput = outputs;
      }
    });

    const result = await processor.processGraph(testProcessContext());
    const recordedStopOutput = recorder.events.find(
      (event) => event.type === 'nodeFinish' && event.data.nodeId === stop.id,
    );
    const replayEmitter = new Emittery<ProcessEvents>();
    let replayedStopOutput: Outputs | undefined;
    replayEmitter.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === stop.id) {
        replayedStopOutput = outputs;
      }
    });
    await replayExecutionRecording({
      emitter: replayEmitter,
      erroredNodes: new Map(),
      graphInputs: {},
      graphOutputs: {},
      isAborted: () => false,
      nodeResults: new Map(),
      project: makeProject(graph),
      recorder,
      recordingPlaybackChatLatency: 0,
      setContextValues: () => {},
      setGraphInputs: () => {},
      setGraphOutputs: () => {},
      setRunning: () => {},
      visitedNodes: new Set(),
      waitUntilUnpaused: async () => {},
    });

    assert.deepEqual(terminalStopOutput?.['value' as PortId], expectedValue);
    assert.deepEqual(
      recordedStopOutput?.type === 'nodeFinish' ? recordedStopOutput.data.outputs['value' as PortId] : undefined,
      expectedValue,
    );
    assert.deepEqual(replayedStopOutput?.['value' as PortId], expectedValue);
    assert.deepEqual(result.result, expectedValue);
  });

  void it('commits a parallel split Stop boundary with its aggregate in input order', async () => {
    const source = makeTestNode('source');
    const watch = makeWatchNode();
    const stop = { ...makeStopWatchNode(), isSplitRun: true, isSplitSequential: false };
    const output = makeGraphOutputNode();
    const graph = makeGraph(
      'parallel-split-stop',
      [source, watch, stop, output],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(stop.id, output.id, 'value', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string[]', value: ['first', 'second'] } }));

    const result = await createProcessor(graph).processGraph(testProcessContext());

    assert.deepEqual(result.result, { type: 'string[]', value: ['first', 'second'] });
  });

  void it('clones the Stop value before normal downstream scheduling can observe it', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const join = makeTestNode('join');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-stop-snapshot',
      [source, watch, branch, stop, join, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, join.id, 'input', 'value'),
        connect(join.id, graphOutput.id, 'value'),
      ],
    );
    const mutationDone = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      const accepted = { state: 'accepted' };
      setTimeout(() => {
        accepted.state = 'mutated after child completion';
        mutationDone.resolve();
      }, 0);
      return { output: { type: 'object', value: accepted } };
    });
    AsyncTestNodeImpl.handlers.set(join.id, async (inputs) => {
      await mutationDone.promise;
      assert.deepEqual(inputs['input' as PortId]?.value, { state: 'accepted' });
      return { output: inputs['input' as PortId]! };
    });

    const outputs = await withTimeout(
      createProcessor(graph).processGraph(testProcessContext()),
      'the stop-value snapshot',
    );
    assert.deepEqual(outputs.result?.value, { state: 'accepted' });
  });

  void it('drains an async branch started after Stop before the root finishes', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const asyncTrigger = makeAsyncNode('post-stop-async');
    const asyncLeaf = makeTestNode('post-stop-async-leaf');
    const graph = makeGraph(
      'streaming-watch-post-stop-async',
      [source, watch, branch, stop, asyncTrigger, asyncLeaf],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, asyncTrigger.id, 'input1', 'value'),
        connect(asyncTrigger.id, asyncLeaf.id, 'input', 'output1'),
      ],
    );
    const asyncLeafStarted = deferred();
    const releaseAsyncLeaf = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => ({ output: { type: 'string', value: 'accepted' } }));
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs) => {
      asyncLeafStarted.resolve();
      await releaseAsyncLeaf.promise;
      return { output: inputs['input' as PortId]! };
    });

    let runSettled = false;
    const run = createProcessor(graph)
      .processGraph(testProcessContext())
      .finally(() => {
        runSettled = true;
      });
    await withTimeout(asyncLeafStarted.promise, 'the post-Stop async branch');
    assert.equal(runSettled, false);
    releaseAsyncLeaf.resolve();
    await withTimeout(run, 'the post-Stop async root run');
    assert.equal(AsyncTestNodeImpl.runCounts.get(asyncLeaf.id), 1);
  });

  void it('emits a single source error when the watched final port is missing', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-missing-final-output',
      [source, watch, stop],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, stop.id, 'value', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({}));
    const lifecycle: string[] = [];
    let sourceError: Error | undefined;
    const processor = createProcessor(graph);
    processor.on('nodeFinish', ({ node }) => {
      if (node.id === source.id) lifecycle.push('finish');
    });
    processor.on('nodeError', ({ node, error }) => {
      if (node.id === source.id) {
        lifecycle.push('error');
        sourceError = error;
      }
    });

    await assert.rejects(processor.processGraph(testProcessContext()), /failed to process due to errors in nodes/);
    assert.deepEqual(lifecycle, ['error']);
    assert.match(sourceError?.message ?? '', /did not receive final output from "streaming-source"/);
  });

  void it('runs every partial and final snapshot when a watch branch has no Stop', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const graph = makeGraph(
      'streaming-watch-no-stop',
      [source, watch, branch],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'allStreamedOutput'),
      ],
    );

    const observedValues: unknown[] = [];
    const observedStreamedOutput: unknown[] = [];
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'first chunk' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'second chunk' } });
      return { output: { type: 'string', value: 'final response' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      observedValues.push(inputs['input' as PortId]?.value);
      const history = inputs['other' as PortId]?.value;
      // A branch is free to transform its own input. Its mutation must not
      // leak into a later snapshot's cumulative history.
      observedStreamedOutput.push(Array.isArray(history) ? [...history] : history);
      if (Array.isArray(history)) {
        history.push('branch mutation');
      }
      return { output: inputs['input' as PortId]! };
    });

    await createProcessor(graph).processGraph(testProcessContext());
    assert.deepEqual(observedValues, ['first chunk', 'second chunk', 'final response']);
    assert.deepEqual(observedStreamedOutput, [
      ['first chunk'],
      ['first chunk', 'second chunk'],
      ['first chunk', 'second chunk', 'final response'],
    ]);
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 3);
  });

  void it('keeps independent Watch lifecycles when two watches observe one producer', async () => {
    const source = makeTestNode('streaming-source');
    const stoppingWatch = makeWatchNode('stopping-watch');
    const stoppingBranch = makeTestNode('stopping-branch');
    const stop = makeStopWatchNode('stop-first-watch');
    const repeatWatch = makeWatchNode('repeat-watch');
    const repeatBranch = makeTestNode('repeat-branch');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'independent-streaming-watches',
      [source, stoppingWatch, stoppingBranch, stop, repeatWatch, repeatBranch, graphOutput],
      [
        connect(source.id, stoppingWatch.id, 'stream'),
        connect(stoppingWatch.id, stoppingBranch.id, 'input', 'value'),
        connect(stoppingBranch.id, stop.id, 'value'),
        connect(source.id, repeatWatch.id, 'stream'),
        connect(repeatWatch.id, repeatBranch.id, 'input', 'value'),
        connect(repeatWatch.id, repeatBranch.id, 'other', 'allStreamedOutput'),
        connect(source.id, graphOutput.id, 'value'),
      ],
    );

    const repeatedValues: unknown[] = [];
    const repeatedHistories: unknown[] = [];
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'first' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'second' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(stoppingBranch.id, (inputs) => ({ output: inputs['input' as PortId]! }));
    AsyncTestNodeImpl.handlers.set(repeatBranch.id, (inputs) => {
      repeatedValues.push(inputs['input' as PortId]?.value);
      const history = inputs['other' as PortId]?.value;
      repeatedHistories.push(Array.isArray(history) ? [...history] : history);
      return { output: inputs['input' as PortId]! };
    });

    const outputs = await createProcessor(graph).processGraph(testProcessContext());
    assert.equal(outputs.result?.value, 'final');
    assert.equal(AsyncTestNodeImpl.runCounts.get(stoppingBranch.id), 1);
    assert.deepEqual(repeatedValues, ['first', 'second', 'final']);
    assert.deepEqual(repeatedHistories, [['first'], ['first', 'second'], ['first', 'second', 'final']]);
  });

  void it('drops overflowing partial snapshots while retaining the final watch snapshot', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    watch.data = { ...watch.data, maxQueuedUpdates: 1, queueOverflowBehavior: 'drop' };
    const branch = makeTestNode('watch-branch');
    const graph = makeGraph(
      'streaming-watch-drop-overflow',
      [source, watch, branch],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
      ],
    );
    const firstBranchStarted = deferred();
    const sourceFinished = deferred();
    const releaseFirstBranch = deferred();
    const observedValues: unknown[] = [];
    const observedFinalFlags: unknown[] = [];

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'first' } });
      await firstBranchStarted.promise;
      context.onPartialOutputs?.({ output: { type: 'string', value: 'queued partial' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'dropped partial' } });
      sourceFinished.resolve();
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (inputs) => {
      const value = inputs['input' as PortId]?.value;
      observedValues.push(value);
      observedFinalFlags.push(inputs['other' as PortId]?.value);
      if (value === 'first') {
        firstBranchStarted.resolve();
        await releaseFirstBranch.promise;
      }
      return { output: inputs['input' as PortId]! };
    });

    const run = createProcessor(graph).processGraph(testProcessContext());
    await withTimeout(sourceFinished.promise, 'the overflowing streaming source');
    releaseFirstBranch.resolve();
    await withTimeout(run, 'the dropped-overflow streaming watch graph');

    assert.deepEqual(observedValues, ['first', 'final']);
    assert.deepEqual(observedFinalFlags, [false, true]);
  });

  void it('stores only new suffixes for cumulative streamed text', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const graph = makeGraph(
      'streaming-watch-cumulative-history',
      [source, watch, branch],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'allStreamedOutput'),
      ],
    );
    const histories: unknown[] = [];
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'H' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'He' } });
      return { output: { type: 'string', value: 'Hello' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      histories.push(inputs['other' as PortId]?.value);
      return { output: inputs['input' as PortId]! };
    });

    await createProcessor(graph).processGraph(testProcessContext());
    assert.deepEqual(histories, [['H'], ['H', 'e'], ['H', 'e', 'llo']]);
  });

  void it('allows a source-to-Watch draft with no downstream branch work', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const graph = makeGraph('streaming-watch-draft', [source, watch], [connect(source.id, watch.id, 'stream')]);

    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final response' } }));

    await createProcessor(graph).processGraph(testProcessContext());
    assert.equal(AsyncTestNodeImpl.runCounts.get(source.id), 1);
    assert.equal(AsyncTestNodeImpl.runCounts.get(watch.id), undefined);
  });

  void it('bounds Watch branch observer history to the first three iterations and final/latest iteration', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const graph = makeGraph(
      'streaming-watch-bounded-history',
      [source, watch, branch],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, branch.id, 'input', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      for (const value of ['1', '2', '3', '4', '5']) {
        context.onPartialOutputs?.({ output: { type: 'string', value } });
      }
      return { output: { type: 'string', value: '6' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => ({ output: inputs['input' as PortId]! }));

    const processor = createProcessor(graph);
    const recorder = new ExecutionRecorder();
    recorder.record(processor);
    const observedValues: unknown[] = [];
    const summaries: ProcessEvents['streamingOutputWatchSummary'][] = [];
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === branch.id) observedValues.push(outputs['output' as PortId]?.value);
    });
    processor.on('streamingOutputWatchSummary', (event) => summaries.push(event));

    await processor.processGraph(testProcessContext());

    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 6);
    assert.deepEqual(observedValues, ['1', '2', '3', '6']);
    const recordedValues = recorder.events.flatMap((event) =>
      event.type === 'nodeFinish' && event.data.nodeId === branch.id
        ? [event.data.outputs['output' as PortId]?.value]
        : [],
    );
    assert.deepEqual(recordedValues, ['1', '2', '3', '6']);
    assert.equal(recorder.events.filter((event) => event.type === 'streamingOutputWatchSummary').length, 1);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0]!.summary.retainedIterationUpdateIndexes, [1, 2, 3, 6]);
    assert.equal(summaries[0]!.summary.omittedIterations, 2);
  });

  void it('rejects a Stop boundary that reconnects to its own Watch branch', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-stop-reentry',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, branch.id, 'other', 'value'),
      ],
    );

    await assert.rejects(
      createProcessor(graph).processGraph(testProcessContext()),
      /cannot reconnect to its own Watch Streaming Output branch/,
    );
  });

  void it('runs the watch once with the final output when a producer has no partial updates', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-final-only',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    let observedFinalFlag: unknown;
    const eventOrder: string[] = [];
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final only' } }));
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      eventOrder.push('watch-branch');
      observedFinalFlag = inputs['other' as PortId]?.value;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    processor.on('nodeFinish', ({ node }) => {
      if (node.id === source.id) eventOrder.push('source-finished');
    });
    const outputs = await processor.processGraph(testProcessContext());
    assert.equal(observedFinalFlag, true);
    assert.equal(outputs.result?.value, 'final only');
    assert.deepEqual(eventOrder.slice(0, 2), ['source-finished', 'watch-branch']);
  });

  void it('delivers a preloaded producer once as the final Watch snapshot', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'preloaded-streaming-watch-source',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    const lifecycle: string[] = [];
    let observedFinal: unknown;
    AsyncTestNodeImpl.handlers.set(source.id, () => {
      throw new Error('a preloaded producer must not run');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      lifecycle.push('branch');
      observedFinal = inputs['other' as PortId]?.value;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    processor.preloadNodeData(source.id, { output: { type: 'string', value: 'cached final value' } });
    processor.on('nodeFinish', ({ node }) => {
      if (node.id === source.id) lifecycle.push('source');
    });

    const outputs = await processor.processGraph(testProcessContext());
    assert.equal(outputs.result?.value, 'cached final value');
    assert.equal(observedFinal, true);
    assert.equal(AsyncTestNodeImpl.runCounts.get(source.id), undefined);
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
    assert.deepEqual(lifecycle.slice(0, 2), ['source', 'branch']);
  });

  void it('delivers a frozen producer once as the final Watch snapshot', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'frozen-streaming-watch-source',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(watch.id, branch.id, 'other', 'isFinal'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    let observedFinal: unknown;
    AsyncTestNodeImpl.handlers.set(source.id, () => {
      throw new Error('a frozen producer must not run');
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      observedFinal = inputs['other' as PortId]?.value;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    processor.setFrozenNodeOutputResolver(({ node }) =>
      node.id === source.id ? { output: { type: 'string', value: 'frozen final value' } } : undefined,
    );

    const outputs = await processor.processGraph(testProcessContext());
    assert.equal(outputs.result?.value, 'frozen final value');
    assert.equal(observedFinal, true);
    assert.equal(AsyncTestNodeImpl.runCounts.get(source.id), undefined);
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
  });

  void it('rejects unsafe preloads and a missing watched producer port before cached boundary events', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'unsafe-streaming-watch-preloads',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );

    for (const node of [watch, branch, stop]) {
      const processor = createProcessor(graph);
      processor.preloadNodeData(node.id, { output: { type: 'string', value: 'stale' } });
      const finishedNodes: string[] = [];
      processor.on('nodeFinish', ({ node: finishedNode }) => finishedNodes.push(finishedNode.id));
      await assert.rejects(
        processor.processGraph(testProcessContext()),
        /Cannot preload .*streaming|Cannot preload .*repeated branch/,
      );
      assert.deepEqual(finishedNodes, []);
    }

    const missingPortProcessor = createProcessor(graph);
    missingPortProcessor.preloadNodeData(source.id, { other: { type: 'string', value: 'not watched' } });
    await assert.rejects(missingPortProcessor.processGraph(testProcessContext()), /has no final "output" output/);
  });

  void it('rejects frozen Stop output instead of reporting a later missing acceptance', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'frozen-streaming-watch-stop',
      [source, watch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, stop.id, 'value', 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'live' } }));

    const processor = createProcessor(graph);
    processor.setFrozenNodeOutputResolver(({ node }) =>
      node.id === stop.id ? { value: { type: 'string', value: 'stale stop value' } } : undefined,
    );
    const finishedNodes: string[] = [];
    processor.on('nodeFinish', ({ node }) => finishedNodes.push(node.id));

    await assert.rejects(processor.processGraph(testProcessContext()), (error: Error) => {
      assert.match(String(error.cause), /Stop Watching Streaming Output cannot use frozen outputs/);
      return true;
    });
    assert.equal(finishedNodes.includes(stop.id), false);
  });

  void it('rejects live cache injection into an active Watch boundary', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'active-streaming-watch-preload',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );
    let releaseSource: (() => void) | undefined;
    const sourceIsRunning = new Promise<void>((resolve) => {
      AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
        context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
        resolve();
        await new Promise<void>((release) => {
          releaseSource = release;
        });
        return { output: { type: 'string', value: 'final' } };
      });
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => ({ output: inputs['input' as PortId]! }));

    const processor = createProcessor(graph);
    const processing = processor.processGraph(testProcessContext());
    await sourceIsRunning;

    for (const node of [source, watch, branch, stop]) {
      assert.throws(
        () => processor.preloadNodeData(node.id, { output: { type: 'string', value: 'stale' } }),
        /Cannot preload .*Watch Streaming Output.*running|Cannot preload .*streaming boundary/,
      );
    }

    releaseSource?.();
    await processing;
  });

  void it('uses the newest snapshot for interval-triggered watches', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    watch.data = { ...watch.data, intervalMs: 20, triggerMode: 'interval' };
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-interval',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    const branchStarted = deferred();
    const sourceMayFinish = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'older' } });
      await wait(1);
      context.onPartialOutputs?.({ output: { type: 'string', value: 'newest' } });
      await sourceMayFinish.promise;
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      assert.equal(inputs['input' as PortId]?.value, 'newest');
      branchStarted.resolve();
      sourceMayFinish.resolve();
      return { output: inputs['input' as PortId]! };
    });

    const outputs = await withTimeout(
      createProcessor(graph).processGraph(testProcessContext()),
      'interval streaming watch graph',
    );
    await branchStarted.promise;
    assert.equal(outputs.result?.value, 'newest');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 1);
  });

  void it('continues watching when an earlier snapshot does not reach Stop', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-conditional-stop',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'not-ready' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'ready' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, (inputs) => {
      return {
        output:
          inputs['input' as PortId]?.value === 'ready'
            ? { type: 'string', value: 'accepted' }
            : { type: 'control-flow-excluded', value: undefined },
      };
    });

    const outputs = await createProcessor(graph).processGraph(testProcessContext());
    assert.equal(outputs.result?.value, 'accepted');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 2);
  });

  void it('reports a watch-branch failure through the root error lifecycle', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-branch-failure',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      throw new Error('watch branch exploded');
    });

    const processor = createProcessor(graph);
    const lifecycleEvents: string[] = [];
    const erroredNodeIds: NodeId[] = [];
    processor.on('graphError', () => lifecycleEvents.push('graph-error'));
    processor.on('error', () => lifecycleEvents.push('error'));
    processor.on('nodeError', ({ node }) => erroredNodeIds.push(node.id));

    await assert.rejects(processor.processGraph(testProcessContext()), /watch-branch/);
    assert.deepEqual(erroredNodeIds, [branch.id]);
    assert.deepEqual(lifecycleEvents, ['graph-error', 'error']);
  });

  void it('emits a missing-Stop coordinator failure summary before failing the root', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-missing-stop',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    // The branch excludes its value, so Stop is never reached. This leaves a
    // completed child iteration with no accepted Stop value: a coordinator
    // failure rather than a failing child node.
    AsyncTestNodeImpl.handlers.set(branch.id, () => ({
      output: { type: 'control-flow-excluded', value: undefined },
    }));

    const processor = createProcessor(graph);
    const summaries: ProcessEvents['streamingOutputWatchSummary'][] = [];
    processor.on('streamingOutputWatchSummary', (event) => summaries.push(event));

    await assert.rejects(processor.processGraph(testProcessContext()), /Watch Streaming Output/);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.summary.failureKind, 'missing-stop');
    assert.equal(summaries[0]?.summary.failedIterations, 0);
  });

  void it('normalizes a non-Error Watch branch failure once before collecting it at the root', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-non-error-branch-failure',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      throw 'watch branch threw a string';
    });

    const processor = createProcessor(graph);
    let graphError: Error | undefined;
    processor.on('graphError', ({ error }) => {
      graphError = error;
    });

    await assert.rejects(processor.processGraph(testProcessContext()), /watch-branch/);
    assert.equal(graphError?.cause instanceof Error, true);
    assert.equal(graphError?.cause?.message, 'watch branch threw a string');
  });

  void it('caps parallel watch invocations and cancels losing work after the first Stop', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    watch.data = { ...watch.data, executionMode: 'parallel', maxParallelRuns: 2 };
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-parallel',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    const sourceMayFinish = deferred();
    const firstStarted = deferred();
    const firstCancelled = deferred();
    const secondStarted = deferred();

    AsyncTestNodeImpl.handlers.set(source.id, async (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'first' } });
      context.onPartialOutputs?.({ output: { type: 'string', value: 'second' } });
      await sourceMayFinish.promise;
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (inputs, context) => {
      if (inputs['input' as PortId]?.value === 'first') {
        firstStarted.resolve();
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        firstCancelled.resolve();
        // Real streaming operations often reject once their cancellation
        // signal arrives. A losing Watch branch must not turn that expected
        // rejection into a root failure after another branch reached Stop.
        throw new Error('losing streaming branch cancelled');
      }
      secondStarted.resolve();
      sourceMayFinish.resolve();
      return { output: { type: 'string', value: 'winner' } };
    });

    const processor = createProcessor(graph);
    const summaries: ProcessEvents['streamingOutputWatchSummary'][] = [];
    processor.on('streamingOutputWatchSummary', (event) => summaries.push(event));
    const outputs = await withTimeout(processor.processGraph(testProcessContext()), 'parallel streaming watch graph');

    await Promise.all([firstStarted.promise, secondStarted.promise, firstCancelled.promise]);
    assert.equal(outputs.result?.value, 'winner');
    assert.equal(AsyncTestNodeImpl.runCounts.get(branch.id), 2);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.summary.failedIterations, 0);
    assert.equal(summaries[0]!.summary.cancelledIterations, 1);
  });

  void it('cancels active watch work when the root run is aborted', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graph = makeGraph(
      'streaming-watch-cancel',
      [source, watch, branch, stop],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
      ],
    );
    const branchStarted = deferred();
    let observedAbort = false;
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (_inputs, context) => {
      branchStarted.resolve();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
      }
      observedAbort = context.signal.aborted;
      return { output: { type: 'string', value: 'cancelled' } };
    });

    const processor = createProcessor(graph);
    const run = processor.processGraph(testProcessContext());
    await withTimeout(branchStarted.promise, 'the cancellable streaming watch branch');
    await withTimeout(processor.abort(false, 'streaming watch run cancelled'), 'root cancellation');
    await assert.rejects(withTimeout(run, 'the cancelled streaming watch run'), /streaming watch run cancelled/);
    assert.equal(observedAbort, true);
  });

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

  void it('does not publish foreground outputs before a pending Watch Stop branch can rejoin them', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-outputs-ready',
      [source, watch, branch, stop, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(stop.id, graphOutput.id, 'value', 'value'),
      ],
    );
    const branchStarted = deferred();
    const releaseBranch = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (inputs) => {
      branchStarted.resolve();
      await releaseBranch.promise;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    let outputsReadyCount = 0;
    let runSettled = false;
    processor.on('graphOutputsReady', () => {
      outputsReadyCount += 1;
    });
    const run = processor
      .processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true })
      .finally(() => {
        runSettled = true;
      });

    await withTimeout(branchStarted.promise, 'the pending Watch Stop branch');
    await Promise.resolve();
    assert.equal(runSettled, false);
    assert.equal(outputsReadyCount, 0);

    releaseBranch.resolve();
    const outputs = await withTimeout(run, 'the Watch Stop graph output');
    assert.equal(outputs.result?.value, 'partial');
    assert.equal(outputsReadyCount, 0);
  });

  void it('still publishes ordinary graph outputs early while a no-Stop Watch branch drains', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-no-stop-outputs-ready',
      [source, watch, branch, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(source.id, graphOutput.id, 'value'),
      ],
    );
    const branchStarted = deferred();
    const releaseBranch = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, async (inputs) => {
      branchStarted.resolve();
      await releaseBranch.promise;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    let outputsReadyCount = 0;
    processor.on('graphOutputsReady', () => {
      outputsReadyCount += 1;
    });
    const outputsPromise = processor.processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true });

    await withTimeout(branchStarted.promise, 'the no-Stop Watch branch');
    const outputs = await withTimeout(outputsPromise, 'the early no-Stop Watch outputs');
    assert.equal(outputs.result?.value, 'final');
    assert.equal(outputsReadyCount, 1);
    assert.equal(processor.isRunning, true);

    releaseBranch.resolve();
    await withTimeout(processor.waitForRunCompletion(), 'the no-Stop Watch branch completion');
  });

  void it('rejects an async branch nested in a Watch subgraph before it can reach the root scheduler', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const childInput = makeGraphInputNode('child-input');
    const childTrigger = { ...makeAsyncNode('child-async-trigger'), title: 'Child Start Async Branch' };
    const childAsyncLeaf = makeTestNode('child-async-leaf');
    const childGraph = makeGraph(
      'watch-async-child',
      [childInput, childTrigger, childAsyncLeaf],
      [
        connect(childInput.id, childTrigger.id, 'input1', 'data'),
        connect(childTrigger.id, childAsyncLeaf.id, 'input', 'output1'),
      ],
    );
    const subgraph = makeSubgraphNode('watched-subgraph', childGraph.metadata!.id!);
    const graph = makeGraph(
      'watch-async-child-root',
      [source, watch, subgraph],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, subgraph.id, 'input', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    const processor = createProcessor(graph, [childGraph]);
    const nodeErrors: string[] = [];
    processor.on('nodeError', ({ error }) => nodeErrors.push(String(error)));

    await assert.rejects(processor.processGraph(testProcessContext()), /watched-subgraph/);
    assert.match(nodeErrors.join('\n'), /Child Start Async Branch.*Watch Streaming Output/s);
    assert.equal(AsyncTestNodeImpl.runCounts.get(childAsyncLeaf.id), undefined);
  });

  void it('rejects a Watch nested in a Watch subgraph before its branch can execute', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const childInput = makeGraphInputNode('child-input');
    const nestedWatch = { ...makeWatchNode(), id: 'nested-watch' as NodeId, title: 'Nested Watch' };
    const nestedLeaf = makeTestNode('nested-watch-leaf');
    const childGraph = makeGraph(
      'watch-nested-watch-child',
      [childInput, nestedWatch, nestedLeaf],
      [
        connect(childInput.id, nestedWatch.id, 'stream', 'data'),
        connect(nestedWatch.id, nestedLeaf.id, 'input', 'value'),
      ],
    );
    const subgraph = makeSubgraphNode('watched-subgraph', childGraph.metadata!.id!);
    const graph = makeGraph(
      'watch-nested-watch-root',
      [source, watch, subgraph],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, subgraph.id, 'input', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    const processor = createProcessor(graph, [childGraph]);
    const nodeErrors: string[] = [];
    processor.on('nodeError', ({ error }) => nodeErrors.push(String(error)));

    // The root reports its direct failed subgraph node, while the node-error
    // event below retains the rejected nested-Watch cause for diagnostics.
    await assert.rejects(processor.processGraph(testProcessContext()), /watched-subgraph/);
    assert.match(nodeErrors.join('\n'), /Nested Watch.*cannot run inside Watch Streaming Output/s);
    assert.equal(AsyncTestNodeImpl.runCounts.get(nestedLeaf.id), undefined);
  });

  void it('rejects an async branch through every nested Watch subgraph depth', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const outerInput = makeGraphInputNode('outer-input');
    const innerInput = makeGraphInputNode('inner-input');
    const innerTrigger = { ...makeAsyncNode('inner-async-trigger'), title: 'Inner Start Async Branch' };
    const innerAsyncLeaf = makeTestNode('inner-async-leaf');
    const innerGraph = makeGraph(
      'watch-async-inner',
      [innerInput, innerTrigger, innerAsyncLeaf],
      [
        connect(innerInput.id, innerTrigger.id, 'input1', 'data'),
        connect(innerTrigger.id, innerAsyncLeaf.id, 'input', 'output1'),
      ],
    );
    const innerSubgraph = makeSubgraphNode('inner-subgraph', innerGraph.metadata!.id!);
    const outerGraph = makeGraph(
      'watch-async-outer',
      [outerInput, innerSubgraph],
      [connect(outerInput.id, innerSubgraph.id, 'input', 'data')],
    );
    const outerSubgraph = makeSubgraphNode('outer-subgraph', outerGraph.metadata!.id!);
    const graph = makeGraph(
      'watch-async-nested-root',
      [source, watch, outerSubgraph],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, outerSubgraph.id, 'input', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));
    const processor = createProcessor(graph, [outerGraph, innerGraph]);
    const nodeErrors: string[] = [];
    processor.on('nodeError', ({ error }) => nodeErrors.push(String(error)));

    await assert.rejects(processor.processGraph(testProcessContext()), /outer-subgraph/);
    assert.match(nodeErrors.join('\n'), /Inner Start Async Branch.*Watch Streaming Output/s);
    assert.equal(AsyncTestNodeImpl.runCounts.get(innerAsyncLeaf.id), undefined);
  });

  void it('allows ordinary and disabled work inside Watch subgraphs', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const ordinaryInput = makeGraphInputNode('ordinary-input');
    const ordinaryLeaf = makeTestNode('ordinary-leaf');
    const disabledInput = makeGraphInputNode('disabled-input');
    const disabledTrigger = { ...makeAsyncNode('disabled-async-trigger'), disabled: true };
    const disabledLeaf = makeTestNode('disabled-async-leaf');
    const ordinaryGraph = makeGraph(
      'watch-ordinary-child',
      [ordinaryInput, ordinaryLeaf],
      [connect(ordinaryInput.id, ordinaryLeaf.id, 'input', 'data')],
    );
    const disabledGraph = makeGraph(
      'watch-disabled-async-child',
      [disabledInput, disabledTrigger, disabledLeaf],
      [
        connect(disabledInput.id, disabledTrigger.id, 'input1', 'data'),
        connect(disabledTrigger.id, disabledLeaf.id, 'input', 'output1'),
      ],
    );
    const ordinarySubgraph = makeSubgraphNode('ordinary-subgraph', ordinaryGraph.metadata!.id!);
    const disabledSubgraph = makeSubgraphNode('disabled-subgraph', disabledGraph.metadata!.id!);
    const graph = makeGraph(
      'watch-ordinary-and-disabled-subgraphs',
      [source, watch, ordinarySubgraph, disabledSubgraph],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, ordinarySubgraph.id, 'input', 'value'),
        connect(watch.id, disabledSubgraph.id, 'input', 'value'),
      ],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));

    await createProcessor(graph, [ordinaryGraph, disabledGraph]).processGraph(testProcessContext());

    assert.equal(AsyncTestNodeImpl.runCounts.get(ordinaryLeaf.id), 1);
    assert.equal(AsyncTestNodeImpl.runCounts.get(disabledLeaf.id), undefined);
  });

  void it('permits an unfinished nested async trigger that has no branch to schedule', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const childInput = makeGraphInputNode('child-input');
    const unfinishedTrigger = makeAsyncNode('unfinished-async-trigger');
    const childGraph = makeGraph(
      'watch-unfinished-async-child',
      [childInput, unfinishedTrigger],
      [connect(childInput.id, unfinishedTrigger.id, 'input1', 'data')],
    );
    const subgraph = makeSubgraphNode('watched-subgraph', childGraph.metadata!.id!);
    const graph = makeGraph(
      'watch-unfinished-async-root',
      [source, watch, subgraph],
      [connect(source.id, watch.id, 'stream'), connect(watch.id, subgraph.id, 'input', 'value')],
    );
    AsyncTestNodeImpl.handlers.set(source.id, () => ({ output: { type: 'string', value: 'final' } }));

    await createProcessor(graph, [childGraph]).processGraph(testProcessContext());
  });

  void it('does not publish an early result before a required Watch Stop can report failure', async () => {
    const source = makeTestNode('streaming-source');
    const watch = makeWatchNode();
    const branch = makeTestNode('watch-branch');
    const stop = makeStopWatchNode();
    const asyncTrigger = makeAsyncNode('background-trigger');
    const asyncLeaf = makeTestNode('background-leaf');
    const graphOutput = makeGraphOutputNode();
    const graph = makeGraph(
      'streaming-watch-stop-failure-before-outputs-ready',
      [source, watch, branch, stop, asyncTrigger, asyncLeaf, graphOutput],
      [
        connect(source.id, watch.id, 'stream'),
        connect(watch.id, branch.id, 'input', 'value'),
        connect(branch.id, stop.id, 'value'),
        connect(source.id, asyncTrigger.id, 'input1'),
        connect(asyncTrigger.id, asyncLeaf.id, 'input', 'output1'),
        connect(source.id, graphOutput.id, 'value'),
      ],
    );
    const watchBranchRan = deferred();
    const asyncLeafStarted = deferred();
    const releaseAsyncLeaf = deferred();
    AsyncTestNodeImpl.handlers.set(source.id, (_inputs, context) => {
      context.onPartialOutputs?.({ output: { type: 'string', value: 'partial' } });
      return { output: { type: 'string', value: 'final' } };
    });
    AsyncTestNodeImpl.handlers.set(branch.id, () => {
      watchBranchRan.resolve();
      return { output: { type: 'control-flow-excluded', value: undefined } };
    });
    AsyncTestNodeImpl.handlers.set(asyncLeaf.id, async (inputs) => {
      asyncLeafStarted.resolve();
      await releaseAsyncLeaf.promise;
      return { output: inputs['input' as PortId]! };
    });

    const processor = createProcessor(graph);
    let outputsReadyCount = 0;
    let runSettled = false;
    processor.on('graphOutputsReady', () => {
      outputsReadyCount += 1;
    });
    const run = processor
      .processGraph(testProcessContext(), {}, {}, { returnWhenGraphOutputsReady: true })
      .finally(() => {
        runSettled = true;
      });

    await Promise.all([
      withTimeout(watchBranchRan.promise, 'the unaccepted Watch Stop branch'),
      withTimeout(asyncLeafStarted.promise, 'the pending background branch'),
    ]);
    await Promise.resolve();
    assert.equal(runSettled, false);
    assert.equal(outputsReadyCount, 0);

    releaseAsyncLeaf.resolve();
    await assert.rejects(withTimeout(run, 'the failed Watch Stop graph'), /Watch Streaming Output/);
    assert.equal(outputsReadyCount, 0);
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
    const graphErrors: ProcessEvents['graphError'][] = [];
    outputProcessor.on('error', ({ error }) => rootErrors.push(error));
    outputProcessor.on('graphError', (event) => graphErrors.push(event));
    await assert.rejects(outputProcessor.processGraph(testProcessContext()), /cannot contain Graph Output node/);
    assert.equal(rootErrors.length, 1);
    assert.match(String(rootErrors[0]), /cannot contain Graph Output node/);
    assert.equal(graphErrors.length, 1);
    assert.equal(graphErrors[0]!.graph.metadata?.id, graphWithOutput.metadata?.id);
    assert.match(String(graphErrors[0]!.error), /cannot contain Graph Output node/);
    assert.equal(graphErrors[0]!.execution.graphId, graphWithOutput.metadata?.id);
    assert.ok(String(graphErrors[0]!.execution.rootRunId));
    assert.ok(String(graphErrors[0]!.execution.graphRunId));

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
