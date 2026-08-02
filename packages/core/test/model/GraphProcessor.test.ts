import { afterEach, it, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  GraphProcessor,
  NodeImpl,
  createBuiltInRegistry,
  createFrozenNodeOutputResolver,
  globalRivetNodeRegistry,
  nodeDefinition,
  type ChartNode,
  type ChatV2CallFinishedEvent,
  type GraphId,
  type GraphProgress,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type ProcessEvents,
  type ProcessId,
  type Tokenizer,
  type TokenizerCallInfo,
} from '../../src/index.js';
import { loadTestGraphInProcessor, testProcessContext } from '../testUtils';

type TrackedNode = ChartNode<'trackedTest', { delayMs: number; markEditorCacheHit?: boolean }>;
type FailingNode = ChartNode<'failingTest', { delayMs: number }>;
type LoopRequiredNode = ChartNode<'loopRequiredTest', Record<string, never>>;
type ObservedLlmCallNode = ChartNode<'observedLlmCallTest', Record<string, never>>;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function waitFor(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TrackedTestNodeImpl extends NodeImpl<TrackedNode> {
  static activeCount = 0;
  static maxActiveCount = 0;
  static processCount = 0;

  static resetCounts() {
    TrackedTestNodeImpl.activeCount = 0;
    TrackedTestNodeImpl.maxActiveCount = 0;
    TrackedTestNodeImpl.processCount = 0;
  }

  static create(): TrackedNode {
    return {
      type: 'trackedTest',
      id: `tracked-${Math.random()}` as NodeId,
      title: 'Tracked Test',
      visualData: { x: 0, y: 0, width: 175 },
      data: { delayMs: 25 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const hasInputConnection = connections.some(
      (connection) => connection.inputNodeId === this.chartNode.id && connection.inputId === ('input1' as PortId),
    );

    return hasInputConnection
      ? [
          {
            id: 'input1' as PortId,
            title: 'Input 1',
            dataType: 'string',
          },
        ]
      : [];
  }

  getOutputDefinitions(connections: NodeConnection[]): NodeOutputDefinition[] {
    const hasOutputConnection = connections.some(
      (connection) => connection.outputNodeId === this.chartNode.id && connection.outputId === ('output1' as PortId),
    );

    return hasOutputConnection
      ? [
          {
            id: 'output1' as PortId,
            title: 'Output 1',
            dataType: 'string',
          },
        ]
      : [];
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    TrackedTestNodeImpl.activeCount += 1;
    TrackedTestNodeImpl.maxActiveCount = Math.max(TrackedTestNodeImpl.maxActiveCount, TrackedTestNodeImpl.activeCount);
    TrackedTestNodeImpl.processCount += 1;

    try {
      await waitFor(this.data.delayMs);
      if (this.data.markEditorCacheHit) {
        context.markResultAsEditorCacheHit?.();
      }
      return inputs['input1' as PortId] != null ? { ['output1' as PortId]: inputs['input1' as PortId] } : {};
    } finally {
      TrackedTestNodeImpl.activeCount -= 1;
    }
  }
}

const trackedTestNode = nodeDefinition(TrackedTestNodeImpl, 'Tracked Test');

class FailingTestNodeImpl extends NodeImpl<FailingNode> {
  static create(): FailingNode {
    return {
      type: 'failingTest',
      id: `failing-${Math.random()}` as NodeId,
      title: 'Failing Test',
      visualData: { x: 0, y: 0, width: 175 },
      data: { delayMs: 10 },
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [];
  }

  async process(): Promise<Outputs> {
    await waitFor(this.data.delayMs);
    throw new Error('failing test node failed');
  }
}

const failingTestNode = nodeDefinition(FailingTestNodeImpl, 'Failing Test');

class LoopRequiredTestNodeImpl extends NodeImpl<LoopRequiredNode> {
  static create(): LoopRequiredNode {
    return {
      type: 'loopRequiredTest',
      id: 'loop-required-node' as NodeId,
      title: 'Loop Required Test',
      visualData: { x: 0, y: 0, width: 175 },
      data: {},
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'loop' as PortId,
        title: 'Loop',
        dataType: 'any',
      },
      {
        id: 'required' as PortId,
        title: 'Required',
        dataType: 'any',
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'output' as PortId,
        title: 'Output',
        dataType: 'any',
      },
    ];
  }

  async process(): Promise<Outputs> {
    throw new Error('LoopRequiredTestNode should not process when its required input is missing.');
  }
}

const loopRequiredTestNode = nodeDefinition(LoopRequiredTestNodeImpl, 'Loop Required Test');

class ObservedLlmCallTestNodeImpl extends NodeImpl<ObservedLlmCallNode> {
  static create(): ObservedLlmCallNode {
    return {
      type: 'observedLlmCallTest',
      id: 'observed-llm-call-node' as NodeId,
      title: 'Observed LLM Call Test',
      visualData: { x: 0, y: 0, width: 175 },
      data: {},
    };
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'output' as PortId, title: 'Output', dataType: 'string' }];
  }

  process(_inputs: Inputs, context: InternalProcessContext): Outputs {
    context.onChatV2CallFinished?.({
      callId: 'nested-call' as never,
      attemptIndex: 0,
      nodeId: this.chartNode.id,
      processId: context.processId!,
      provider: 'openai',
      model: 'test-model',
      outcome: 'success',
      pricing: { status: 'unknown' },
    });

    return { ['output' as PortId]: { type: 'string', value: 'done' } };
  }
}

const observedLlmCallTestNode = nodeDefinition(ObservedLlmCallTestNodeImpl, 'Observed LLM Call Test');

function createTrackedRegistry() {
  return createBuiltInRegistry().register(trackedTestNode);
}

function createTimingRegistry() {
  return createTrackedRegistry().register(failingTestNode);
}

function createLoopRequiredRegistry() {
  return createBuiltInRegistry().register(loopRequiredTestNode);
}

function createObservedLlmCallRegistry() {
  return createBuiltInRegistry().register(observedLlmCallTestNode);
}

function makeProject(graph: any) {
  return {
    metadata: {
      id: 'project-1',
      title: 'Project',
      description: '',
      mainGraphId: graph.metadata.id,
    },
    graphs: {
      [graph.metadata.id]: graph,
    },
    plugins: [],
  } as any;
}

function makeGraphOutputNode(id = 'output', dataType = 'any') {
  return {
    id: `${id}-output-node`,
    type: 'graphOutput',
    title: 'Graph Output',
    data: {
      id,
      dataType,
    },
    visualData: { x: 500, y: 0, width: 300 },
  };
}

function makeSubgraphNode(id: string, graphId: string) {
  return {
    id: id as NodeId,
    type: 'subGraph',
    title: id,
    data: {
      graphId,
      useErrorOutput: false,
      useAsGraphPartialOutput: false,
    },
    visualData: { x: 0, y: 0, width: 300 },
  };
}

async function runGraphOutputFromNode(node: ChartNode, outputId: PortId, outputDataType = 'object') {
  const outputNode = makeGraphOutputNode('result', outputDataType);
  const graph = {
    metadata: {
      id: `${node.id}-graph-output`,
      name: 'Single Node Graph Output',
      description: '',
    },
    nodes: [node, outputNode],
    connections: [
      {
        outputNodeId: node.id,
        outputId,
        inputNodeId: outputNode.id,
        inputId: 'value',
      },
    ],
  };

  const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
  const outputs = await processor.processGraph(testProcessContext());

  return outputs.result;
}

function makeExpressionNode(expression: string): ChartNode {
  return {
    id: 'expression-node',
    type: 'expression',
    title: 'Expression',
    data: {
      expression,
    },
    visualData: { x: 0, y: 0, width: 260 },
  };
}

function makeCodeNewNode(code: string): ChartNode {
  return {
    id: 'code-node',
    type: 'codeNew',
    title: 'Code',
    data: {
      code,
      allowFetch: false,
      allowRequire: false,
      allowRivet: false,
      allowProcess: false,
      allowConsole: false,
    },
    visualData: { x: 0, y: 0, width: 260 },
  };
}

function makeDestructureNode(overrides: Partial<ChartNode> = {}) {
  return {
    id: 'destructure-node',
    type: 'destructure',
    title: 'Destructure',
    data: {
      paths: ['$.name'],
      pathPortIds: ['name'],
    },
    visualData: { x: 0, y: 0, width: 250 },
    ...overrides,
  };
}

function makeExtractObjectPathNode(overrides: Partial<ChartNode> = {}) {
  return {
    id: 'extract-object-path-node',
    type: 'extractObjectPath',
    title: 'Extract Object Path',
    data: {
      path: '$.name',
      usePathInput: false,
    },
    visualData: { x: 0, y: 0, width: 250 },
    ...overrides,
  };
}

function createTrackedSplitGraph(
  registry: ReturnType<typeof createTrackedRegistry>,
  { graphId, splitRunMax, splitRunConcurrency }: { graphId: string; splitRunMax: number; splitRunConcurrency?: number },
) {
  const inputNode = registry.create('graphInput');
  inputNode.id = 'input-node' as NodeId;
  inputNode.data = {
    ...inputNode.data,
    id: 'items',
    dataType: 'string[]',
    useDefaultValueInput: false,
  };

  const trackedNode = registry.create('trackedTest');
  trackedNode.id = 'tracked-node' as NodeId;
  trackedNode.title = 'Tracked Split Node';
  trackedNode.isSplitRun = true;
  trackedNode.splitRunMax = splitRunMax;
  trackedNode.splitRunConcurrency = splitRunConcurrency;

  const outputNode = registry.create('graphOutput');
  outputNode.id = 'output-node' as NodeId;
  outputNode.data = {
    ...outputNode.data,
    id: 'output',
    dataType: 'string[]',
  };

  return {
    metadata: {
      id: graphId,
      name: graphId,
      description: '',
    },
    nodes: [inputNode, trackedNode, outputNode],
    connections: [
      {
        outputNodeId: inputNode.id,
        outputId: 'data' as PortId,
        inputNodeId: trackedNode.id,
        inputId: 'input1' as PortId,
      },
      {
        outputNodeId: trackedNode.id,
        outputId: 'output1' as PortId,
        inputNodeId: outputNode.id,
        inputId: 'value' as PortId,
      },
    ],
  };
}

function createSingleNodeGraph(node: ChartNode, graphId = `${node.id}-graph`) {
  return {
    metadata: {
      id: graphId,
      name: graphId,
      description: '',
    },
    nodes: [node],
    connections: [],
  };
}

class CountingTokenizer implements Tokenizer {
  readonly listeners = new Set<(error: Error) => void>();

  on(_event: 'error', listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getTokenCountForString(_input: string, _info: TokenizerCallInfo): Promise<number> {
    return 0;
  }

  async getTokenCountForMessages(): Promise<number> {
    return 0;
  }

  emitError(error = new Error('tokenizer failure')): void {
    for (const listener of this.listeners) {
      listener(error);
    }
  }
}

class ThrowingCleanupTokenizer extends CountingTokenizer {
  cleanupCount = 0;

  override on(event: 'error', listener: (error: Error) => void): () => void {
    const unsubscribe = super.on(event, listener);

    return () => {
      unsubscribe();
      this.cleanupCount += 1;
      throw new Error('tokenizer cleanup failed');
    };
  }
}

void describe('GraphProcessor', () => {
  void it('provides the web-app status external function to every graph processor', async () => {
    const graph = {
      metadata: {
        id: 'web-app-status-graph',
        name: 'Web app status graph',
        description: '',
      },
      nodes: [
        {
          id: 'input-node',
          type: 'graphInput',
          title: 'Graph Input',
          data: { dataType: 'any[]', id: 'message' },
          visualData: { x: 0, y: 0, width: 200 },
        },
        {
          id: 'status-node',
          type: 'externalCall',
          title: 'Set web app status',
          data: { functionName: 'setWebAppStatus', useErrorOutput: false, useFunctionNameInput: false },
          visualData: { x: 250, y: 0, width: 200 },
        },
        makeGraphOutputNode('result', 'any'),
      ],
      connections: [
        { inputId: 'arguments', inputNodeId: 'status-node', outputId: 'data', outputNodeId: 'input-node' },
        { inputId: 'value', inputNodeId: 'result-output-node', outputId: 'result', outputNodeId: 'status-node' },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const progress: GraphProgress[] = [];
    processor.on('progress', (event) => progress.push(event.progress));

    const outputs = await processor.processGraph(testProcessContext(), {
      message: { type: 'any[]', value: ['Working...'] },
    });

    assert.equal(outputs.result?.value, 'Working...');
    assert.deepEqual(progress, [{ message: 'Working...' }]);
  });

  void it('does not automatically define the removed web-app storage External Calls', async () => {
    const graph = {
      metadata: {
        id: 'web-app-storage-graph',
        name: 'Web app storage graph',
        description: '',
      },
      nodes: [
        {
          id: 'function-name-input-node',
          type: 'graphInput',
          title: 'Function Name',
          data: { dataType: 'string', id: 'functionName' },
          visualData: { x: 0, y: 0, width: 200 },
        },
        {
          id: 'arguments-input-node',
          type: 'graphInput',
          title: 'Arguments',
          data: { dataType: 'any[]', id: 'arguments' },
          visualData: { x: 0, y: 100, width: 200 },
        },
        {
          id: 'storage-node',
          type: 'externalCall',
          title: 'Web app storage',
          data: { functionName: '', useErrorOutput: false, useFunctionNameInput: true },
          visualData: { x: 250, y: 0, width: 200 },
        },
        makeGraphOutputNode('result', 'any'),
      ],
      connections: [
        {
          inputId: 'functionName',
          inputNodeId: 'storage-node',
          outputId: 'data',
          outputNodeId: 'function-name-input-node',
        },
        {
          inputId: 'arguments',
          inputNodeId: 'storage-node',
          outputId: 'data',
          outputNodeId: 'arguments-input-node',
        },
        { inputId: 'value', inputNodeId: 'result-output-node', outputId: 'result', outputNodeId: 'storage-node' },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);

    await assert.rejects(
      () =>
        processor.processGraph(testProcessContext(), {
          arguments: { type: 'any[]', value: ['preferences'] },
          functionName: { type: 'string', value: 'getWebAppStorage' },
        }),
      /failed to process due to errors in nodes/,
    );
  });

  void it('shares the root-run Stored Value controller with nested graphs', async () => {
    const parentGraph = {
      metadata: {
        id: 'parent-web-app-storage-graph',
        name: 'Parent web app storage graph',
        description: '',
      },
      nodes: [
        {
          id: 'storage-subgraph-node',
          type: 'subGraph',
          title: 'Read stored value',
          data: {
            graphId: 'child-web-app-storage-graph',
            useAsGraphPartialOutput: false,
            useErrorOutput: false,
          },
          visualData: { x: 0, y: 0, width: 200 },
        },
        makeGraphOutputNode('result', 'object'),
      ],
      connections: [
        {
          inputId: 'value',
          inputNodeId: 'result-output-node',
          outputId: 'result',
          outputNodeId: 'storage-subgraph-node',
        },
      ],
    };
    const childGraph = {
      metadata: {
        id: 'child-web-app-storage-graph',
        name: 'Child web app storage graph',
        description: '',
      },
      nodes: [
        {
          id: 'storage-read-node',
          type: 'getStoredValue',
          title: 'Get Stored Value',
          data: { dataType: 'object', key: 'preferences', onDemand: false, useKeyInput: false, wait: false },
          visualData: { x: 0, y: 0, width: 200 },
        },
        makeGraphOutputNode('result', 'object'),
      ],
      connections: [
        {
          inputId: 'value',
          inputNodeId: 'result-output-node',
          outputId: 'value',
          outputNodeId: 'storage-read-node',
        },
      ],
    };
    const project = makeProject(parentGraph);
    project.graphs[childGraph.metadata.id] = childGraph;
    const processor = new GraphProcessor(project, parentGraph.metadata.id, globalRivetNodeRegistry);
    processor.setStoredValueStore({
      get: (key) => (key === 'preferences' ? { density: 'compact' } : undefined),
      set() {},
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'object', value: { density: 'compact' } });
  });

  void it('Can run passthrough graph', async () => {
    const processor = await loadTestGraphInProcessor('Passthrough');

    const outputs = await processor.processGraph(testProcessContext(), {
      input: {
        type: 'string',
        value: 'input value',
      },
    });

    assert.deepEqual(outputs.output, {
      type: 'string',
      value: 'input value',
    });
  });

  void it('coerces Expression any object output to the declared Graph Output object type', async () => {
    const result = await runGraphOutputFromNode(
      makeExpressionNode('({ foo: "bar", nested: { ok: true } })'),
      'output' as PortId,
      'object',
    );

    assert.deepStrictEqual(result, {
      type: 'object',
      value: { foo: 'bar', nested: { ok: true } },
    });
  });

  void it('coerces Code any object output to the declared Graph Output object type', async () => {
    const result = await runGraphOutputFromNode(
      makeCodeNewNode('const value = { foo: "bar", nested: { ok: true } };\nreturn value;'),
      'output' as PortId,
      'object',
    );

    assert.deepStrictEqual(result, {
      type: 'object',
      value: { foo: 'bar', nested: { ok: true } },
    });
  });

  void it('keeps Expression object output as any when Graph Output is declared any', async () => {
    const result = await runGraphOutputFromNode(makeExpressionNode('({ foo: "bar" })'), 'output' as PortId, 'any');

    assert.deepStrictEqual(result, {
      type: 'any',
      value: { foo: 'bar' },
    });
  });

  void it('coerces Expression any array output to the declared Graph Output object array type', async () => {
    const result = await runGraphOutputFromNode(
      makeExpressionNode('([{ foo: "bar" }])'),
      'output' as PortId,
      'object[]',
    );

    assert.deepStrictEqual(result, {
      type: 'object[]',
      value: [{ foo: 'bar' }],
    });
  });

  void it('does not relabel Expression scalar any output as a declared Graph Output object', async () => {
    const result = await runGraphOutputFromNode(makeExpressionNode('"not an object"'), 'output' as PortId, 'object');

    assert.deepStrictEqual(result, {
      type: 'any',
      value: 'not an object',
    });
  });

  void it('does not relabel non-plain Expression object instances as declared Graph Output objects', async () => {
    const result = await runGraphOutputFromNode(makeExpressionNode('new Date(0)'), 'output' as PortId, 'object');

    assert.equal(result.type, 'any');
    assert.ok(result.value instanceof Date);
  });

  void it('does not relabel Expression object any output as a declared Graph Output object array', async () => {
    const result = await runGraphOutputFromNode(makeExpressionNode('({ foo: "bar" })'), 'output' as PortId, 'object[]');

    assert.deepStrictEqual(result, {
      type: 'any',
      value: { foo: 'bar' },
    });
  });

  void it('does not relabel Expression primitive arrays as declared Graph Output object arrays', async () => {
    const result = await runGraphOutputFromNode(makeExpressionNode('[1, 2, 3]'), 'output' as PortId, 'object[]');

    assert.deepStrictEqual(result, {
      type: 'any',
      value: [1, 2, 3],
    });
  });

  void it('Can stream graph processor events', async () => {
    const processor = await loadTestGraphInProcessor('Passthrough');

    void processor.processGraph(testProcessContext(), {
      input: {
        type: 'string',
        value: 'input value',
      },
    });

    const eventNames: string[] = [];
    for await (const event of processor.events()) {
      if (event.type !== 'trace') {
        eventNames.push(event.type);
      }
    }

    assert.equal(eventNames[eventNames.length - 2], 'done');
    assert.equal(eventNames[eventNames.length - 1], 'finish');
  });

  void it('captures node run duration only when requested', async () => {
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'timed-node' as NodeId;
    const graph = createSingleNodeGraph(trackedNode, 'timing-disabled-graph');

    let untimedFinish: ProcessEvents['nodeFinish'] | undefined;
    let untimedStart: ProcessEvents['nodeStart'] | undefined;
    const untimedProcessor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, registry);
    untimedProcessor.on('nodeStart', (event) => {
      untimedStart = event;
    });
    untimedProcessor.on('nodeFinish', (event) => {
      untimedFinish = event;
    });
    await untimedProcessor.processGraph(testProcessContext(), {});

    assert.equal(Object.prototype.hasOwnProperty.call(untimedFinish!, 'durationMs'), false);
    assert.equal(untimedStart?.resultOrigin, 'executed');
    assert.equal(untimedFinish?.resultOrigin, 'executed');

    let timedFinish: ProcessEvents['nodeFinish'] | undefined;
    const timedProcessor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, registry, false, {
      captureNodeTimings: true,
    });
    timedProcessor.on('nodeFinish', (event) => {
      timedFinish = event;
    });
    await timedProcessor.processGraph(testProcessContext(), {});

    assert.equal(typeof timedFinish?.durationMs, 'number');
    assert.ok(timedFinish!.durationMs! >= 0);
  });

  void it('uses terminal provenance to report a confirmed editor-cache replay', async () => {
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'editor-cache-node' as NodeId;
    trackedNode.data.markEditorCacheHit = true;
    const graph = createSingleNodeGraph(trackedNode, 'editor-cache-origin-graph');
    const origins: Array<{ event: 'start' | 'finish'; origin: ProcessEvents['nodeFinish']['resultOrigin'] }> = [];
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as GraphId, registry);
    processor.on('nodeStart', ({ node, resultOrigin }) => {
      if (node.id === trackedNode.id) origins.push({ event: 'start', origin: resultOrigin });
    });
    processor.on('nodeFinish', ({ node, resultOrigin }) => {
      if (node.id === trackedNode.id) origins.push({ event: 'finish', origin: resultOrigin });
    });

    await processor.processGraph(testProcessContext(), {});

    assert.deepEqual(origins, [
      { event: 'start', origin: 'executed' },
      { event: 'finish', origin: 'editor-cache' },
    ]);
  });

  void it('captures node error duration when requested', async () => {
    const registry = createTimingRegistry();
    const failingNode = registry.create('failingTest');
    failingNode.id = 'timed-failing-node' as NodeId;
    const graph = createSingleNodeGraph(failingNode, 'timing-error-graph');

    let nodeError: ProcessEvents['nodeError'] | undefined;
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, registry, false, {
      captureNodeTimings: true,
    });
    processor.on('nodeError', (event) => {
      if (event.node.id === failingNode.id) {
        nodeError = event;
      }
    });

    await assert.rejects(() => processor.processGraph(testProcessContext(), {}));
    await waitFor(0);

    assert.equal(typeof nodeError?.durationMs, 'number');
    assert.ok(nodeError!.durationMs! >= 0);
    assert.equal(nodeError?.resultOrigin, 'executed');
  });

  void it('captures split-run aggregate and per-item durations when requested', async () => {
    const registry = createTrackedRegistry();
    const graph = createTrackedSplitGraph(registry, {
      graphId: 'timing-split-graph',
      splitRunMax: 2,
      splitRunConcurrency: 1,
    });

    let splitFinish: ProcessEvents['nodeFinish'] | undefined;
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, registry, false, {
      captureNodeTimings: true,
    });
    processor.on('nodeFinish', (event) => {
      if (event.node.id === 'tracked-node') {
        splitFinish = event;
      }
    });

    await processor.processGraph(testProcessContext(), {
      items: { type: 'string[]', value: ['a', 'b'] },
    });

    assert.equal(typeof splitFinish?.durationMs, 'number');
    assert.ok(splitFinish!.durationMs! >= 0);
    assert.equal(typeof splitFinish?.splitRunDurationMs?.[0], 'number');
    assert.equal(typeof splitFinish?.splitRunDurationMs?.[1], 'number');
    assert.ok(splitFinish!.splitRunDurationMs![0]! >= 0);
    assert.ok(splitFinish!.splitRunDurationMs![1]! >= 0);
    assert.equal(splitFinish?.resultOrigin, 'executed');
  });

  void it('does not add duration to preloaded node events', async () => {
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'preloaded-node' as NodeId;
    const graph = createSingleNodeGraph(trackedNode, 'timing-preload-graph');

    let preloadFinish: ProcessEvents['nodeFinish'] | undefined;
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as any, registry, false, {
      captureNodeTimings: true,
    });
    processor.preloadNodeData(trackedNode.id, {});
    processor.on('nodeFinish', (event) => {
      if (event.processId === ('preload' as ProcessId)) {
        preloadFinish = event;
      }
    });

    await processor.processGraph(testProcessContext(), {});

    assert.equal(Object.prototype.hasOwnProperty.call(preloadFinish!, 'durationMs'), false);
    assert.equal(preloadFinish?.resultOrigin, 'preloaded');
  });

  void it('replays frozen node outputs and skips the node implementation', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'frozen-tracked-node' as NodeId;
    const outputNode = makeGraphOutputNode('result', 'string');
    const graph = {
      metadata: {
        id: 'frozen-output-graph',
        name: 'Frozen Output Graph',
        description: '',
      },
      nodes: [trackedNode, outputNode],
      connections: [
        {
          outputNodeId: trackedNode.id,
          outputId: 'output1' as PortId,
          inputNodeId: outputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as GraphId, registry);
    const nodeEvents: Array<{ label: string; resultOrigin: ProcessEvents['nodeStart']['resultOrigin'] }> = [];
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata.id]: {
          [trackedNode.id]: [
            {
              ['output1' as PortId]: { type: 'string', value: 'frozen value' },
            },
          ],
        },
      } as any),
    );
    processor.on('nodeStart', ({ node, resultOrigin }) => nodeEvents.push({ label: `start:${node.id}`, resultOrigin }));
    processor.on('nodeFinish', ({ node, resultOrigin }) =>
      nodeEvents.push({ label: `finish:${node.id}`, resultOrigin }),
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'frozen value' });
    assert.equal(TrackedTestNodeImpl.processCount, 0);
    assert.deepEqual(nodeEvents, [
      { label: 'start:frozen-tracked-node', resultOrigin: 'frozen' },
      { label: 'finish:frozen-tracked-node', resultOrigin: 'frozen' },
      { label: `start:${outputNode.id}`, resultOrigin: 'executed' },
      { label: `finish:${outputNode.id}`, resultOrigin: 'executed' },
    ]);
  });

  void it('inherits the frozen output resolver into subprocessors', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'frozen-child-node' as NodeId;
    const childOutputNode = makeGraphOutputNode('childResult', 'string');
    const childGraph = {
      metadata: {
        id: 'frozen-child-graph',
        name: 'Frozen Child Graph',
        description: '',
      },
      nodes: [trackedNode, childOutputNode],
      connections: [
        {
          outputNodeId: trackedNode.id,
          outputId: 'output1' as PortId,
          inputNodeId: childOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const subGraphNode = {
      id: 'call-frozen-child' as NodeId,
      type: 'subGraph',
      title: 'Call Frozen Child',
      data: {
        graphId: childGraph.metadata.id,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
      },
      visualData: { x: 0, y: 0, width: 300 },
    };
    const mainOutputNode = makeGraphOutputNode('result', 'string');
    const mainGraph = {
      metadata: {
        id: 'frozen-main-graph',
        name: 'Frozen Main Graph',
        description: '',
      },
      nodes: [subGraphNode, mainOutputNode],
      connections: [
        {
          outputNodeId: subGraphNode.id,
          outputId: 'childResult' as PortId,
          inputNodeId: mainOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const project = makeProject(mainGraph);
    project.graphs[childGraph.metadata.id] = childGraph as any;
    const processor = new GraphProcessor(project, mainGraph.metadata.id as GraphId, registry);
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [childGraph.metadata.id]: {
          [trackedNode.id]: [
            {
              ['output1' as PortId]: { type: 'string', value: 'frozen child value' },
            },
          ],
        },
      } as any),
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'frozen child value' });
    assert.equal(TrackedTestNodeImpl.processCount, 0);
  });

  void it('emits a nested LLM call once with its nested execution identity', async () => {
    const registry = createObservedLlmCallRegistry();
    const observedNode = registry.create('observedLlmCallTest');
    const childOutputNode = makeGraphOutputNode('childResult', 'string');
    const childGraph = {
      metadata: {
        id: 'observed-call-child-graph',
        name: 'Observed Call Child Graph',
        description: '',
      },
      nodes: [observedNode, childOutputNode],
      connections: [
        {
          outputNodeId: observedNode.id,
          outputId: 'output' as PortId,
          inputNodeId: childOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const middleSubgraphNode = makeSubgraphNode('call-observed-child', childGraph.metadata.id);
    const middleOutputNode = makeGraphOutputNode('middleResult', 'string');
    const middleGraph = {
      metadata: {
        id: 'observed-call-middle-graph',
        name: 'Observed Call Middle Graph',
        description: '',
      },
      nodes: [middleSubgraphNode, middleOutputNode],
      connections: [
        {
          outputNodeId: middleSubgraphNode.id,
          outputId: 'childResult' as PortId,
          inputNodeId: middleOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const rootSubgraphNode = makeSubgraphNode('call-observed-middle', middleGraph.metadata.id);
    const rootOutputNode = makeGraphOutputNode('result', 'string');
    const rootGraph = {
      metadata: {
        id: 'observed-call-root-graph',
        name: 'Observed Call Root Graph',
        description: '',
      },
      nodes: [rootSubgraphNode, rootOutputNode],
      connections: [
        {
          outputNodeId: rootSubgraphNode.id,
          outputId: 'middleResult' as PortId,
          inputNodeId: rootOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const project = makeProject(rootGraph);
    project.graphs[middleGraph.metadata.id] = middleGraph as any;
    project.graphs[childGraph.metadata.id] = childGraph as any;
    const processor = new GraphProcessor(project, rootGraph.metadata.id as GraphId, registry);
    const hostEvents: ChatV2CallFinishedEvent[] = [];
    const processorEvents: ProcessEvents['llmCallFinished'][] = [];
    processor.on('llmCallFinished', (event) => processorEvents.push(event));

    const outputs = await processor.processGraph({
      ...testProcessContext(),
      onChatV2CallFinished: (event) => hostEvents.push(event),
    });

    assert.deepEqual(outputs.result, { type: 'string', value: 'done' });
    assert.equal(hostEvents.length, 1);
    assert.equal(processorEvents.length, 1);
    assert.equal(processorEvents[0]!.callId, 'nested-call');
    assert.equal(processorEvents[0]!.execution.graphId, childGraph.metadata.id);
    assert.equal(processorEvents[0]!.execution.parentGraphRunId == null, false);
  });

  void it('keeps readiness and control-flow exclusions ahead of frozen output replay', async () => {
    const outputNode = makeGraphOutputNode('result');
    const graph = {
      metadata: {
        id: 'frozen-missing-required-input-graph',
        name: 'Frozen Missing Required Input Graph',
        description: '',
      },
      nodes: [makeDestructureNode(), outputNode],
      connections: [
        {
          outputNodeId: 'destructure-node',
          outputId: 'name',
          inputNodeId: outputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as GraphId, globalRivetNodeRegistry);
    const startedNodes: string[] = [];
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata.id]: {
          ['destructure-node' as NodeId]: [
            {
              ['name' as PortId]: { type: 'string', value: 'should not replay' },
            },
          ],
        },
      } as any),
    );
    processor.on('nodeStart', ({ node }) => startedNodes.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
    assert.equal(startedNodes.includes('destructure-node'), false);
  });

  void it('replays frozen output instances in order and reuses the last output within one graph run', () => {
    const graphId = 'resolver-frozen-graph' as GraphId;
    const node = {
      id: 'resolver-frozen-node' as NodeId,
      type: 'text',
      title: 'Text',
      data: {},
      visualData: { x: 0, y: 0, width: 175 },
    } as ChartNode;
    const resolver = createFrozenNodeOutputResolver({
      [graphId]: {
        [node.id]: [
          { ['output' as PortId]: { type: 'string', value: 'first' } },
          { ['output' as PortId]: { type: 'string', value: 'second' } },
        ],
      },
    })!;
    const request = {
      execution: {
        rootRunId: 'root-run' as any,
        graphRunId: 'graph-run-1' as any,
        graphId,
      },
      graphId,
      inputs: {},
      node,
      processId: 'process-1' as ProcessId,
    };

    assert.deepEqual(resolver(request)?.output, { type: 'string', value: 'first' });
    assert.deepEqual(resolver(request)?.output, { type: 'string', value: 'second' });
    assert.deepEqual(resolver(request)?.output, { type: 'string', value: 'second' });
    assert.deepEqual(
      resolver({
        ...request,
        execution: { ...request.execution, graphRunId: 'graph-run-2' as any },
      })?.output,
      { type: 'string', value: 'first' },
    );
  });

  void it('applies recoverable frozen Graph Output dataflow effects', async () => {
    const registry = createBuiltInRegistry();
    const textNode = registry.create('text');
    textNode.id = 'live-text-node' as NodeId;
    textNode.data = {
      ...(textNode.data as Record<string, unknown>),
      text: 'live value',
    };
    const outputNode = makeGraphOutputNode('result', 'string');
    const graph = {
      metadata: {
        id: 'frozen-graph-output-effect-graph',
        name: 'Frozen Graph Output Effect Graph',
        description: '',
      },
      nodes: [textNode, outputNode],
      connections: [
        {
          outputNodeId: textNode.id,
          outputId: 'output' as PortId,
          inputNodeId: outputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as GraphId, registry);
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata.id]: {
          [outputNode.id as NodeId]: [
            {
              ['valueOutput' as PortId]: { type: 'string', value: 'frozen graph output value' },
            },
          ],
        },
      } as any),
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'frozen graph output value' });
  });

  void it('applies recoverable frozen Set Global dataflow effects', async () => {
    const registry = createBuiltInRegistry();
    const textNode = registry.create('text');
    textNode.id = 'global-input-text-node' as NodeId;
    textNode.data = {
      ...(textNode.data as Record<string, unknown>),
      text: 'live global value',
    };
    const setGlobalNode = registry.create('setGlobal');
    setGlobalNode.id = 'frozen-set-global-node' as NodeId;
    setGlobalNode.data = {
      ...(setGlobalNode.data as Record<string, unknown>),
      id: 'frozen-global-id',
      dataType: 'string',
      useIdInput: false,
    };
    const getGlobalNode = registry.create('getGlobal');
    getGlobalNode.id = 'get-frozen-global-node' as NodeId;
    getGlobalNode.data = {
      ...(getGlobalNode.data as Record<string, unknown>),
      dataType: 'string',
      useIdInput: true,
      wait: false,
    };
    const outputNode = makeGraphOutputNode('result', 'string');
    const graph = {
      metadata: {
        id: 'frozen-set-global-effect-graph',
        name: 'Frozen Set Global Effect Graph',
        description: '',
      },
      nodes: [textNode, setGlobalNode, getGlobalNode, outputNode],
      connections: [
        {
          outputNodeId: textNode.id,
          outputId: 'output' as PortId,
          inputNodeId: setGlobalNode.id,
          inputId: 'value' as PortId,
        },
        {
          outputNodeId: setGlobalNode.id,
          outputId: 'variable_id_out' as PortId,
          inputNodeId: getGlobalNode.id,
          inputId: 'id' as PortId,
        },
        {
          outputNodeId: getGlobalNode.id,
          outputId: 'value' as PortId,
          inputNodeId: outputNode.id,
          inputId: 'value' as PortId,
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id as GraphId, registry);
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata.id]: {
          [setGlobalNode.id]: [
            {
              ['saved-value' as PortId]: { type: 'string', value: 'frozen global value' },
              ['previous-value' as PortId]: { type: 'string', value: '' },
              ['variable_id_out' as PortId]: { type: 'string', value: 'frozen-global-id' },
            },
          ],
        },
      } as any),
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'frozen global value' });
  });

  void it('seeds the run cache from frozen Set Stored Value output without persisting again', async () => {
    const textNode = globalRivetNodeRegistry.create('text');
    textNode.id = 'stored-text-node' as NodeId;
    textNode.data = { ...textNode.data, text: 'live value' };
    const setNode = globalRivetNodeRegistry.create('setStoredValue');
    setNode.id = 'frozen-set-stored-node' as NodeId;
    setNode.data = { ...setNode.data, dataType: 'string', key: 'analysis', useKeyInput: false };
    const getNode = globalRivetNodeRegistry.create('getStoredValue');
    getNode.id = 'get-frozen-stored-node' as NodeId;
    getNode.data = {
      ...getNode.data,
      dataType: 'string',
      key: 'analysis',
      onDemand: false,
      useKeyInput: true,
      wait: false,
    };
    const outputNode = makeGraphOutputNode('result', 'string');
    const graph = {
      metadata: { id: 'frozen-stored-effect-graph', name: 'Frozen stored effect', description: '' },
      nodes: [textNode, setNode, getNode, outputNode],
      connections: [
        { inputId: 'value', inputNodeId: setNode.id, outputId: 'output', outputNodeId: textNode.id },
        { inputId: 'key', inputNodeId: getNode.id, outputId: 'key', outputNodeId: setNode.id },
        { inputId: 'value', inputNodeId: outputNode.id, outputId: 'value', outputNodeId: getNode.id },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    let persistentWrites = 0;
    processor.setStoredValueStore({
      get: () => undefined,
      set: () => {
        persistentWrites += 1;
      },
    });
    processor.setFrozenNodeOutputResolver(
      createFrozenNodeOutputResolver({
        [graph.metadata.id]: {
          [setNode.id]: [
            {
              ['saved-value' as PortId]: { type: 'string', value: 'frozen stored value' },
              ['previous-value' as PortId]: { type: 'string', value: '' },
              ['had-previous-value' as PortId]: { type: 'boolean', value: false },
              ['key' as PortId]: { type: 'string', value: 'analysis' },
            },
          ],
        },
      }),
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'frozen stored value' });
    assert.equal(persistentWrites, 0);
  });

  void it('marks nodes with unconnected required inputs as not ran', async () => {
    const outputNode = makeGraphOutputNode('result');
    const graph = {
      metadata: {
        id: 'missing-required-input-graph',
        name: 'Missing Required Input Graph',
        description: '',
      },
      nodes: [makeDestructureNode(), outputNode],
      connections: [
        {
          outputNodeId: 'destructure-node',
          outputId: 'name',
          inputNodeId: outputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const excludedNodes: Array<{ nodeId: string; reason: string; outputs: Outputs }> = [];
    const startedNodes: string[] = [];
    const finishedNodes: string[] = [];

    processor.on('nodeExcluded', ({ node, reason, outputs }) => {
      excludedNodes.push({ nodeId: node.id, reason, outputs });
    });
    processor.on('nodeStart', ({ node }) => {
      startedNodes.push(node.id);
    });
    processor.on('nodeFinish', ({ node }) => {
      finishedNodes.push(node.id);
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
    assert.deepEqual(excludedNodes, [
      {
        nodeId: 'destructure-node',
        reason: 'missing required input',
        outputs: {
          name: { type: 'control-flow-excluded', value: undefined },
        },
      },
    ]);
    assert.equal(startedNodes.includes('destructure-node'), false);
    assert.equal(finishedNodes.includes('destructure-node'), false);
  });

  void it('marks Extract Object Path with an unconnected Object input as not ran', async () => {
    const outputNode = makeGraphOutputNode('result');
    const graph = {
      metadata: {
        id: 'missing-extract-object-input-graph',
        name: 'Missing Extract Object Input Graph',
        description: '',
      },
      nodes: [makeExtractObjectPathNode(), outputNode],
      connections: [
        {
          outputNodeId: 'extract-object-path-node',
          outputId: 'match',
          inputNodeId: outputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const excludedNodes: Array<{ nodeId: string; reason: string; outputs: Outputs }> = [];

    processor.on('nodeExcluded', ({ node, reason, outputs }) => {
      excludedNodes.push({ nodeId: node.id, reason, outputs });
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
    assert.deepEqual(excludedNodes, [
      {
        nodeId: 'extract-object-path-node',
        reason: 'missing required input',
        outputs: {
          match: { type: 'control-flow-excluded', value: undefined },
          all_matches: { type: 'control-flow-excluded', value: undefined },
        },
      },
    ]);
  });

  void it('propagates missing required input exclusion through downstream nodes', async () => {
    const outputNode = makeGraphOutputNode('result');
    const passthroughNode = {
      id: 'passthrough-node',
      type: 'passthrough',
      title: 'Passthrough',
      data: {},
      visualData: { x: 250, y: 0, width: 175 },
    };
    const graph = {
      metadata: {
        id: 'missing-required-input-propagation-graph',
        name: 'Missing Required Input Propagation Graph',
        description: '',
      },
      nodes: [makeDestructureNode(), passthroughNode, outputNode],
      connections: [
        {
          outputNodeId: 'destructure-node',
          outputId: 'name',
          inputNodeId: 'passthrough-node',
          inputId: 'input1',
        },
        {
          outputNodeId: 'passthrough-node',
          outputId: 'output1',
          inputNodeId: outputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const excludedNodes: Array<{ nodeId: string; reason: string }> = [];

    processor.on('nodeExcluded', ({ node, reason }) => {
      excludedNodes.push({ nodeId: node.id, reason });
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'control-flow-excluded', value: undefined });
    assert.deepEqual(excludedNodes, [
      { nodeId: 'destructure-node', reason: 'missing required input' },
      { nodeId: 'passthrough-node', reason: 'input is excluded value' },
    ]);
  });

  void it('keeps disabled and false if-port exclusions ahead of missing required inputs', async () => {
    const disabledOutputNode = makeGraphOutputNode('disabledResult');
    const falseIfOutputNode = makeGraphOutputNode('falseIfResult');
    const disabledDestructureNode = makeDestructureNode({
      id: 'disabled-destructure-node',
      disabled: true,
    });
    const falseIfDestructureNode = makeDestructureNode({
      id: 'false-if-destructure-node',
      isConditional: true,
    });
    const booleanNode = {
      id: 'false-boolean-node',
      type: 'boolean',
      title: 'Bool',
      data: {
        value: false,
      },
      visualData: { x: 0, y: 150, width: 130 },
    };
    const graph = {
      metadata: {
        id: 'missing-required-input-precedence-graph',
        name: 'Missing Required Input Precedence Graph',
        description: '',
      },
      nodes: [disabledDestructureNode, falseIfDestructureNode, booleanNode, disabledOutputNode, falseIfOutputNode],
      connections: [
        {
          outputNodeId: 'disabled-destructure-node',
          outputId: 'name',
          inputNodeId: disabledOutputNode.id,
          inputId: 'value',
        },
        {
          outputNodeId: 'false-boolean-node',
          outputId: 'value',
          inputNodeId: 'false-if-destructure-node',
          inputId: '$if',
        },
        {
          outputNodeId: 'false-if-destructure-node',
          outputId: 'name',
          inputNodeId: falseIfOutputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const excludedReasons = new Map<string, string>();

    processor.on('nodeExcluded', ({ node, reason }) => {
      excludedReasons.set(node.id, reason);
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.equal(excludedReasons.get('disabled-destructure-node'), 'disabled');
    assert.equal(excludedReasons.get('false-if-destructure-node'), 'if port is false');
    assert.deepEqual(outputs.disabledResult, { type: 'control-flow-excluded', value: undefined });
    assert.deepEqual(outputs.falseIfResult, { type: 'control-flow-excluded', value: undefined });
  });

  void it('keeps connected control-flow exclusions ahead of missing required inputs', async () => {
    const outputNode = makeGraphOutputNode('result');
    const ifNode = {
      id: 'if-node',
      type: 'if',
      title: 'If',
      data: {
        unconnectedControlFlowExcluded: true,
      },
      visualData: { x: 0, y: 0, width: 125 },
    };
    const extractNode = makeExtractObjectPathNode({
      data: {
        path: '$.name',
        usePathInput: true,
      },
    });
    const graph = {
      metadata: {
        id: 'missing-required-input-control-flow-precedence-graph',
        name: 'Missing Required Input Control Flow Precedence Graph',
        description: '',
      },
      nodes: [ifNode, extractNode, outputNode],
      connections: [
        {
          outputNodeId: 'if-node',
          outputId: 'output',
          inputNodeId: 'extract-object-path-node',
          inputId: 'object',
        },
        {
          outputNodeId: 'extract-object-path-node',
          outputId: 'match',
          inputNodeId: outputNode.id,
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const excludedReasons = new Map<string, string>();

    processor.on('nodeExcluded', ({ node, reason }) => {
      excludedReasons.set(node.id, reason);
    });

    await processor.processGraph(testProcessContext());

    assert.equal(excludedReasons.get('extract-object-path-node'), 'input is excluded value');
  });

  void it('clears excluded nodes inside active loops between iterations', async () => {
    const graph = {
      metadata: {
        id: 'missing-required-input-loop-graph',
        name: 'Missing Required Input Loop Graph',
        description: '',
      },
      nodes: [
        {
          id: 'default-text-node',
          type: 'text',
          title: 'Default Text',
          data: {
            text: 'seed',
            normalizeLineEndings: false,
          },
          visualData: { x: 0, y: 0, width: 175 },
        },
        {
          id: 'loop-controller-node',
          type: 'loopController',
          title: 'Loop Controller',
          data: {
            maxIterations: 2,
            atMaxIterationsAction: 'break',
          },
          visualData: { x: 200, y: 0, width: 250 },
        },
        {
          id: 'loop-required-node',
          type: 'loopRequiredTest',
          title: 'Loop Required Test',
          data: {},
          visualData: { x: 450, y: 0, width: 175 },
        },
        makeGraphOutputNode('result', 'any[]'),
      ],
      connections: [
        {
          outputNodeId: 'default-text-node',
          outputId: 'output',
          inputNodeId: 'loop-controller-node',
          inputId: 'input1Default',
        },
        {
          outputNodeId: 'loop-controller-node',
          outputId: 'output1',
          inputNodeId: 'loop-required-node',
          inputId: 'loop',
        },
        {
          outputNodeId: 'loop-required-node',
          outputId: 'output',
          inputNodeId: 'loop-controller-node',
          inputId: 'input1',
        },
        {
          outputNodeId: 'loop-controller-node',
          outputId: 'break',
          inputNodeId: 'result-output-node',
          inputId: 'value',
        },
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, createLoopRequiredRegistry());
    const loopRequiredExclusions: string[] = [];

    processor.on('nodeExcluded', ({ node, reason }) => {
      if (node.id === 'loop-required-node') {
        loopRequiredExclusions.push(reason);
      }
    });

    await processor.processGraph(testProcessContext());

    assert.deepEqual(loopRequiredExclusions, ['missing required input', 'input is excluded value']);
  });

  void it('emits finish once for a successful run', async () => {
    const processor = await loadTestGraphInProcessor('Passthrough');
    let finishCount = 0;

    processor.on('finish', () => {
      finishCount += 1;
    });

    await processor.processGraph(testProcessContext(), {
      input: {
        type: 'string',
        value: 'input value',
      },
    });

    assert.equal(finishCount, 1);
  });

  void it('can resolve dependency nodes before processing and through cycles', () => {
    const graph = {
      metadata: {
        id: 'cycle-graph',
        name: 'Cycle Graph',
        description: '',
      },
      nodes: [
        {
          id: 'node-a',
          type: 'passthrough',
          title: 'Node A',
          data: {},
          visualData: { x: 0, y: 0, width: 175 },
        },
        {
          id: 'node-b',
          type: 'passthrough',
          title: 'Node B',
          data: {},
          visualData: { x: 250, y: 0, width: 175 },
        },
      ],
      connections: [
        {
          outputNodeId: 'node-a',
          outputId: 'output1',
          inputNodeId: 'node-b',
          inputId: 'input1',
        },
        {
          outputNodeId: 'node-b',
          outputId: 'output1',
          inputNodeId: 'node-a',
          inputId: 'input1',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);

    assert.deepEqual(new Set(processor.getDependencyNodesDeep('node-a' as any)), new Set(['node-a', 'node-b']));
  });

  void it('uses the latest context values for each run', async () => {
    const graph = {
      metadata: {
        id: 'context-graph',
        name: 'Context Graph',
        description: '',
      },
      nodes: [
        {
          id: 'context-node',
          type: 'context',
          title: 'Context',
          data: {
            id: 'greeting',
            dataType: 'string',
            useDefaultValueInput: false,
          },
          visualData: { x: 0, y: 0, width: 300 },
        },
        {
          id: 'output-node',
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'output',
            dataType: 'string',
          },
          visualData: { x: 250, y: 0, width: 300 },
        },
      ],
      connections: [
        {
          outputNodeId: 'context-node',
          outputId: 'data',
          inputNodeId: 'output-node',
          inputId: 'value',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);

    const firstOutputs = await processor.processGraph(
      testProcessContext(),
      {},
      {
        greeting: { type: 'string', value: 'hello' },
      },
    );
    const secondOutputs = await processor.processGraph(
      testProcessContext(),
      {},
      {
        greeting: { type: 'string', value: 'goodbye' },
      },
    );

    assert.deepEqual(firstOutputs.output, { type: 'string', value: 'hello' });
    assert.deepEqual(secondOutputs.output, { type: 'string', value: 'goodbye' });
  });

  void it('cleans up tokenizer error listeners after repeated runs', async () => {
    const graph = {
      metadata: {
        id: 'empty-graph',
        name: 'Empty Graph',
        description: '',
      },
      nodes: [],
      connections: [],
    };
    const tokenizer = new CountingTokenizer();
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    let errorEvents = 0;

    processor.on('error', () => {
      errorEvents += 1;
    });

    await processor.processGraph({ ...testProcessContext(), tokenizer });
    await processor.processGraph({ ...testProcessContext(), tokenizer });
    tokenizer.emitError();
    await waitFor(0);

    assert.equal(tokenizer.listeners.size, 0);
    assert.equal(errorEvents, 0);
  });

  void it('does not clean up an active tokenizer listener when a second run is rejected', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const trackedNode = registry.create('trackedTest');
    trackedNode.id = 'tracked-node' as NodeId;
    trackedNode.data = { delayMs: 40 };

    const graph = {
      metadata: {
        id: 'overlapping-run-graph',
        name: 'Overlapping Run Graph',
        description: '',
      },
      nodes: [trackedNode],
      connections: [],
    };
    const tokenizer = new CountingTokenizer();
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, registry);
    let finishCount = 0;

    processor.on('finish', () => {
      finishCount += 1;
    });

    const runPromise = processor.processGraph({ ...testProcessContext(), tokenizer });
    await waitFor(0);

    assert.equal(tokenizer.listeners.size, 1);

    await assert.rejects(
      () => processor.processGraph({ ...testProcessContext(), tokenizer }),
      /Cannot process graph while already processing/,
    );

    assert.equal(tokenizer.listeners.size, 1);
    assert.equal(finishCount, 0);

    await runPromise;

    assert.equal(tokenizer.listeners.size, 0);
    assert.equal(finishCount, 1);
  });

  void it('reports tokenizer cleanup errors without failing graph execution', async () => {
    const graph = {
      metadata: {
        id: 'cleanup-error-graph',
        name: 'Cleanup Error Graph',
        description: '',
      },
      nodes: [],
      connections: [],
    };
    const tokenizer = new ThrowingCleanupTokenizer();
    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    let cleanupErrorEvents = 0;

    processor.on('error', ({ error }) => {
      if (error instanceof Error && error.message === 'tokenizer cleanup failed') {
        cleanupErrorEvents += 1;
      }
    });

    await processor.processGraph({ ...testProcessContext(), tokenizer });
    await waitFor(0);

    assert.equal(tokenizer.listeners.size, 0);
    assert.equal(tokenizer.cleanupCount, 1);
    assert.equal(cleanupErrorEvents, 1);
  });

  void it('cleans up tokenizer error listeners from subgraph runs', async () => {
    const mainGraph = {
      metadata: {
        id: 'main-graph',
        name: 'Main Graph',
        description: '',
      },
      nodes: [
        {
          id: 'subgraph-node',
          type: 'subGraph',
          title: 'Subgraph',
          data: {
            graphId: 'child-graph',
            useErrorOutput: false,
            useAsGraphPartialOutput: false,
          },
          visualData: { x: 0, y: 0, width: 300 },
        },
      ],
      connections: [],
    };
    const childGraph = {
      metadata: {
        id: 'child-graph',
        name: 'Child Graph',
        description: '',
      },
      nodes: [],
      connections: [],
    };
    const project = {
      metadata: {
        id: 'project-1',
        title: 'Project',
        description: '',
        mainGraphId: mainGraph.metadata.id,
      },
      graphs: {
        [mainGraph.metadata.id]: mainGraph,
        [childGraph.metadata.id]: childGraph,
      },
      plugins: [],
    } as any;
    const tokenizer = new CountingTokenizer();
    const processor = new GraphProcessor(project, mainGraph.metadata.id as any, globalRivetNodeRegistry);

    await processor.processGraph({ ...testProcessContext(), tokenizer });

    assert.equal(tokenizer.listeners.size, 0);
  });

  void it('keeps forwarding parent subgraph node events after a nested subgraph finishes', async () => {
    const mainGraph = {
      metadata: {
        id: 'main-graph',
        name: 'Main Graph',
        description: '',
      },
      nodes: [
        {
          id: 'call-middle-graph',
          type: 'subGraph',
          title: 'Call Middle Graph',
          data: {
            graphId: 'middle-graph',
            useErrorOutput: false,
            useAsGraphPartialOutput: true,
          },
          visualData: { x: 0, y: 0, width: 300 },
        },
      ],
      connections: [],
    };
    const middleGraph = {
      metadata: {
        id: 'middle-graph',
        name: 'Middle Graph',
        description: '',
      },
      nodes: [
        {
          id: 'call-leaf-graph',
          type: 'subGraph',
          title: 'Call Leaf Graph',
          data: {
            graphId: 'leaf-graph',
            useErrorOutput: false,
            useAsGraphPartialOutput: true,
          },
          visualData: { x: 0, y: 0, width: 300 },
        },
      ],
      connections: [],
    };
    const leafGraph = {
      metadata: {
        id: 'leaf-graph',
        name: 'Leaf Graph',
        description: '',
      },
      nodes: [],
      connections: [],
    };
    const project = {
      metadata: {
        id: 'project-1',
        title: 'Project',
        description: '',
        mainGraphId: mainGraph.metadata.id,
      },
      graphs: {
        [mainGraph.metadata.id]: mainGraph,
        [middleGraph.metadata.id]: middleGraph,
        [leafGraph.metadata.id]: leafGraph,
      },
      plugins: [],
    } as any;
    const processor = new GraphProcessor(project, mainGraph.metadata.id as any, globalRivetNodeRegistry);
    const nodeEvents: string[] = [];

    processor.on('nodeStart', ({ node }) => {
      nodeEvents.push(`start:${node.id}`);
    });
    processor.on('nodeFinish', ({ node }) => {
      nodeEvents.push(`finish:${node.id}`);
    });

    await processor.processGraph(testProcessContext());

    assert.deepEqual(nodeEvents, [
      'start:call-middle-graph',
      'start:call-leaf-graph',
      'finish:call-leaf-graph',
      'finish:call-middle-graph',
    ]);
  });

  void it('aborting a paused graph does not hang the run promise', async () => {
    const processor = await loadTestGraphInProcessor('Passthrough');

    processor.pause();

    const runOutcome = processor
      .processGraph(testProcessContext(), {
        input: {
          type: 'string',
          value: 'input value',
        },
      })
      .then(
        () => 'resolved',
        (error) => `rejected:${(error as Error).message}`,
      );

    setTimeout(() => {
      void processor.abort(false, 'graph execution aborted');
    }, 10);

    const outcome = await Promise.race([
      runOutcome,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);

    assert.equal(outcome, 'rejected:graph execution aborted');
  });

  void it('bounds graph-level node concurrency', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const makeTrackedNode = (id: string) => ({
      ...registry.create('trackedTest'),
      id: id as NodeId,
      title: id,
    });

    const graph = {
      metadata: {
        id: 'bounded-node-concurrency',
        name: 'Bounded Node Concurrency',
        description: '',
      },
      nodes: [
        makeTrackedNode('node-a'),
        makeTrackedNode('node-b'),
        makeTrackedNode('node-c'),
        makeTrackedNode('node-d'),
      ],
      connections: [],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, registry, true, {
      concurrency: { nodeConcurrency: 2 },
    });

    await processor.processGraph(testProcessContext());

    assert.equal(TrackedTestNodeImpl.maxActiveCount, 2);
  });

  void it('bounds split-run parallel concurrency', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const graph = createTrackedSplitGraph(registry, {
      graphId: 'bounded-split-concurrency',
      splitRunMax: 4,
    });

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, registry, true, {
      concurrency: { splitRunConcurrency: 2 },
    });

    const outputs = await processor.processGraph(testProcessContext(), {
      items: { type: 'string[]', value: ['a', 'b', 'c', 'd'] },
    });

    assert.deepEqual(outputs.output, { type: 'string[]', value: ['a', 'b', 'c', 'd'] });
    assert.equal(TrackedTestNodeImpl.maxActiveCount, 2);
  });

  void it('uses node-specific split-run parallel concurrency when set', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const graph = createTrackedSplitGraph(registry, {
      graphId: 'node-specific-split-concurrency',
      splitRunMax: 5,
      splitRunConcurrency: 3,
    });

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, registry, true, {
      concurrency: { splitRunConcurrency: 4 },
    });

    const outputs = await processor.processGraph(testProcessContext(), {
      items: { type: 'string[]', value: ['a', 'b', 'c', 'd', 'e'] },
    });

    assert.deepEqual(outputs.output, { type: 'string[]', value: ['a', 'b', 'c', 'd', 'e'] });
    assert.equal(TrackedTestNodeImpl.maxActiveCount, 3);
  });

  void it('falls back to processor split-run concurrency when node-specific concurrency is invalid', async () => {
    TrackedTestNodeImpl.resetCounts();
    const registry = createTrackedRegistry();
    const graph = createTrackedSplitGraph(registry, {
      graphId: 'invalid-node-split-concurrency',
      splitRunMax: 4,
      splitRunConcurrency: 1,
    });

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, registry, true, {
      concurrency: { splitRunConcurrency: 2 },
    });

    const outputs = await processor.processGraph(testProcessContext(), {
      items: { type: 'string[]', value: ['a', 'b', 'c', 'd'] },
    });

    assert.deepEqual(outputs.output, { type: 'string[]', value: ['a', 'b', 'c', 'd'] });
    assert.equal(TrackedTestNodeImpl.maxActiveCount, 2);
  });

  void it('treats caught Http Call request failures as successful node finishes', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const graph = {
      metadata: {
        id: 'http-call-catch-request-failed',
        name: 'HTTP Call Catch Request Failed',
        description: '',
      },
      nodes: [
        {
          id: 'http-node',
          type: 'httpCall',
          title: 'Http Call',
          data: {
            method: 'GET',
            url: 'https://example.invalid',
            headers: '',
            body: '',
            errorOnNon200: true,
            catchRequestFailed: true,
          },
          visualData: { x: 0, y: 0, width: 250 },
        },
        {
          id: 'output-node',
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'requestFailed',
            dataType: 'boolean',
          },
          visualData: { x: 250, y: 0, width: 300 },
        },
      ],
      connections: [
        {
          outputNodeId: 'http-node',
          outputId: 'requestFailed',
          inputNodeId: 'output-node',
          inputId: 'value',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const nodeErrors: string[] = [];
    const finishedNodes: string[] = [];

    processor.on('nodeError', ({ node }) => {
      nodeErrors.push(node.id);
    });

    processor.on('nodeFinish', ({ node }) => {
      finishedNodes.push(node.id);
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepStrictEqual(outputs.requestFailed, { type: 'boolean', value: true });
    assert.equal(nodeErrors.includes('http-node'), false);
    assert.equal(finishedNodes.includes('http-node'), true);
  });

  void it('treats caught non-2XX Http Call responses as successful node finishes', async () => {
    globalThis.fetch = async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });

    const graph = {
      metadata: {
        id: 'http-call-catch-non-2xx',
        name: 'HTTP Call Catch Non-2XX',
        description: '',
      },
      nodes: [
        {
          id: 'http-node',
          type: 'httpCall',
          title: 'Http Call',
          data: {
            method: 'GET',
            url: 'https://example.invalid',
            headers: '',
            body: '',
            errorOnNon200: true,
            catchRequestFailed: true,
          },
          visualData: { x: 0, y: 0, width: 250 },
        },
        {
          id: 'output-node',
          type: 'graphOutput',
          title: 'Graph Output',
          data: {
            id: 'requestFailed',
            dataType: 'boolean',
          },
          visualData: { x: 250, y: 0, width: 300 },
        },
      ],
      connections: [
        {
          outputNodeId: 'http-node',
          outputId: 'requestFailed',
          inputNodeId: 'output-node',
          inputId: 'value',
        },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), graph.metadata.id, globalRivetNodeRegistry);
    const nodeErrors: string[] = [];
    const finishedNodes: string[] = [];

    processor.on('nodeError', ({ node }) => {
      nodeErrors.push(node.id);
    });

    processor.on('nodeFinish', ({ node }) => {
      finishedNodes.push(node.id);
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepStrictEqual(outputs.requestFailed, { type: 'boolean', value: true });
    assert.equal(nodeErrors.includes('http-node'), false);
    assert.equal(finishedNodes.includes('http-node'), true);
  });
});
