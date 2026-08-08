import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  GraphProcessor,
  NodeImpl,
  createBuiltInRegistry,
  nodeDefinition,
  type ChartNode,
  type DataValue,
  type GraphId,
  type GraphProcessorRuntimeCache,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type NodeGraph,
  type NodeId,
  type NodePrefabId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type Outputs,
  type PortId,
  type ProcessEvents,
  type Project,
  type ProjectId,
  type ScalarOrArrayDataValue,
} from '../../src/index.js';
import { GRAPH_BOUNDARY_OUTPUT_DEMAND_OPTIMIZATION_ENABLED } from '../../src/model/GraphBoundaryCache.js';
import { testProcessContext } from '../testUtils.js';

type CharacterizationNode = ChartNode<'graphProcessorCharacterization', CharacterizationNodeData>;

type CharacterizationNodeData = {
  value?: DataValue;
  delayMs?: number;
  throwMessage?: string;
  partialValues?: DataValue[];
  setGlobal?: {
    id: string;
    value: ScalarOrArrayDataValue;
  };
  waitForGlobal?: string;
  waitForEvent?: string;
  successfulAbortGraph?: boolean;
};

const graphId = 'graph-processor-characterization' as GraphId;
const demandOptimizationIt = GRAPH_BOUNDARY_OUTPUT_DEMAND_OPTIMIZATION_ENABLED ? it : it.skip;

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  });

  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class CharacterizationNodeImpl extends NodeImpl<CharacterizationNode> {
  static create(): CharacterizationNode {
    return makeProbeNode('probe-node');
  }

  static getUIData() {
    return {};
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'input' as PortId,
        title: 'Input',
        dataType: 'any',
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

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    if (this.data.delayMs) {
      await waitFor(this.data.delayMs);
    }

    for (const partialValue of this.data.partialValues ?? []) {
      context.onPartialOutputs?.({ output: partialValue });
    }

    if (this.data.throwMessage) {
      throw new Error(this.data.throwMessage);
    }

    if (this.data.setGlobal) {
      context.setGlobal(this.data.setGlobal.id, this.data.setGlobal.value);
    }

    if (this.data.waitForGlobal) {
      const value = await context.waitForGlobal(this.data.waitForGlobal);
      return { output: value };
    }

    if (this.data.waitForEvent) {
      const value = await context.waitEvent(this.data.waitForEvent);
      return { output: value ?? { type: 'string', value: 'event did not provide data' } };
    }

    if (this.data.successfulAbortGraph) {
      context.abortGraph();
    }

    return {
      output: this.data.value ?? inputs['input' as PortId] ?? { type: 'string', value: this.id },
    };
  }
}

const characterizationNode = nodeDefinition(CharacterizationNodeImpl, 'Graph Processor Characterization');

function createRegistry() {
  return createBuiltInRegistry().register(characterizationNode);
}

function makeProbeNode(id: string, data: CharacterizationNodeData = {}): CharacterizationNode {
  return {
    id: id as NodeId,
    type: 'graphProcessorCharacterization',
    title: id,
    data,
    visualData: { x: 0, y: 0, width: 200 },
  };
}

function makeGraphOutputNode(id = 'result'): ChartNode {
  return {
    id: `${id}-output-node` as NodeId,
    type: 'graphOutput',
    title: 'Graph Output',
    data: {
      id,
      dataType: 'any',
    },
    visualData: { x: 600, y: 0, width: 240 },
  };
}

function makeSubgraphNode(id: string, targetGraphId: GraphId, data: Record<string, unknown> = {}): ChartNode {
  return {
    id: id as NodeId,
    type: 'subGraph',
    title: 'Subgraph',
    data: {
      graphId: targetGraphId,
      useErrorOutput: false,
      useAsGraphPartialOutput: false,
      ...data,
    },
    visualData: { x: 0, y: 0, width: 240 },
  };
}

function connect(outputNodeId: string, inputNodeId: string, inputId = 'input', outputId = 'output'): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}

function makeGraph(nodes: ChartNode[], connections: NodeConnection[], id: GraphId = graphId): NodeGraph {
  return {
    metadata: {
      id,
      name: id,
      description: '',
    },
    nodes,
    connections,
  };
}

function makeProject(graph: NodeGraph, extraGraphs: NodeGraph[] = []): Project {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: graph.metadata!.id,
    },
    graphs: Object.fromEntries(
      [graph, ...extraGraphs].map((projectGraph) => [projectGraph.metadata!.id, projectGraph]),
    ),
    plugins: [],
  };
}

function createProcessor(graph: NodeGraph, extraGraphs: NodeGraph[] = []): GraphProcessor {
  return new GraphProcessor(makeProject(graph, extraGraphs), graph.metadata!.id, createRegistry());
}

void describe('GraphProcessor characterization', () => {
  void it('keeps graph boundary output-demand pruning disabled while the optimization is parked', () => {
    assert.equal(GRAPH_BOUNDARY_OUTPUT_DEMAND_OPTIMIZATION_ENABLED, false);
  });

  void it('runs full subgraph child graphs while output-demand pruning is parked', async () => {
    const usedProbe = makeProbeNode('parked-subgraph-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('parked-subgraph-unused-probe', {
      setGlobal: { id: 'parked-subgraph-unused-side-effect', value: { type: 'string', value: 'ran' } },
      value: { type: 'string', value: 'unused' },
    });
    const usedOutput = makeGraphOutputNode('used');
    const unusedOutput = makeGraphOutputNode('unused');
    const childGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      'parked-subgraph-child' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('parked-subgraph-node', childGraph.metadata!.id);
    const parentOutput = makeGraphOutputNode('parentUsed');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutput],
      [connect(subgraphNode.id, parentOutput.id, 'value', 'used')],
      'parked-subgraph-parent' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];
    const globalSetIds: string[] = [];
    let subgraphFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeFinish', (event) => {
      finishedNodeIds.push(event.node.id);
      if (event.node.id === subgraphNode.id) {
        subgraphFinish = event;
      }
    });
    processor.on('globalSet', (event) => globalSetIds.push(event.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentUsed, { type: 'string', value: 'used' });
    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), true);
    assert.deepEqual(globalSetIds, ['parked-subgraph-unused-side-effect']);
    assert.deepEqual(subgraphFinish?.outputs.unused, { type: 'string', value: 'unused' });
  });

  void it('runs full referenced graph alias child graphs while output-demand pruning is parked', async () => {
    const referencedProjectId = 'parked-referenced-project' as ProjectId;
    const referencedGraphId = 'parked-referenced-child' as GraphId;
    const usedProbe = makeProbeNode('parked-referenced-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('parked-referenced-unused-probe', { value: { type: 'string', value: 'unused' } });
    const usedOutput = makeGraphOutputNode('used');
    const unusedOutput = makeGraphOutputNode('unused');
    const referencedGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;
    const aliasNode: ChartNode = {
      id: 'parked-referenced-alias' as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutput = makeGraphOutputNode('parentUsed');
    const parentGraph = makeGraph(
      [aliasNode, parentOutput],
      [connect(aliasNode.id, parentOutput.id, 'value', 'used')],
      'parked-referenced-parent' as GraphId,
    );
    const project = makeProject(parentGraph);
    project.references = [{ id: referencedProjectId }];
    const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry());
    const finishedNodeIds: NodeId[] = [];
    let aliasFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeFinish', (event) => {
      finishedNodeIds.push(event.node.id);
      if (event.node.id === aliasNode.id) {
        aliasFinish = event;
      }
    });

    const outputs = await processor.processGraph({
      ...testProcessContext(),
      projectReferenceLoader: {
        loadProject: async () => referencedProject,
      },
    });

    assert.deepEqual(outputs.parentUsed, { type: 'string', value: 'used' });
    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), true);
    assert.deepEqual(aliasFinish?.outputs.unused, { type: 'string', value: 'unused' });
  });

  void it('preserves successful root event order from graph start through finish', async () => {
    const nodeA = makeProbeNode('node-a', { value: { type: 'string', value: 'alpha' } });
    const nodeB = makeProbeNode('node-b');
    const outputNode = makeGraphOutputNode('result');
    const graph = makeGraph(
      [nodeA, nodeB, outputNode],
      [connect('node-a', 'node-b'), connect('node-b', outputNode.id, 'value')],
    );
    const processor = createProcessor(graph);
    const events: string[] = [];

    processor.on('start', () => events.push('start'));
    processor.on('graphStart', () => events.push('graphStart'));
    processor.on('nodeStart', ({ node }) => events.push(`nodeStart:${node.id}`));
    processor.on('nodeFinish', ({ node }) => events.push(`nodeFinish:${node.id}`));
    processor.on('graphFinish', () => events.push('graphFinish'));
    processor.on('done', () => events.push('done'));
    processor.on('finish', () => events.push('finish'));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'alpha' });
    assert.deepEqual(events, [
      'start',
      'graphStart',
      'nodeStart:node-a',
      'nodeFinish:node-a',
      'nodeStart:node-b',
      'nodeFinish:node-b',
      `nodeStart:${outputNode.id}`,
      `nodeFinish:${outputNode.id}`,
      'graphFinish',
      'done',
      'finish',
    ]);
  });

  void it('replaces preprocessed graph maps when a reused processor sees graph edits', async () => {
    const nodeA = makeProbeNode('node-a', { value: { type: 'string', value: 'alpha' } });
    const outputNode = makeGraphOutputNode('result');
    const graph = makeGraph([nodeA, outputNode], [connect(nodeA.id, outputNode.id, 'value')]);
    const processor = createProcessor(graph);

    const firstOutputs = await processor.processGraph(testProcessContext());
    graph.connections = [];
    const secondOutputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(firstOutputs.result, { type: 'string', value: 'alpha' });
    assert.equal(secondOutputs.result, undefined);
  });

  void it('emits node and graph errors without graphFinish or done, then still emits finish', async () => {
    const failingNode = makeProbeNode('failing-node', { throwMessage: 'characterized failure' });
    const graph = makeGraph([failingNode], []);
    const processor = createProcessor(graph);
    const events: string[] = [];
    const nodeErrored = processor.once('nodeError');
    const graphErrored = processor.once('graphError');
    const genericErrored = processor.once('error');

    processor.on('start', () => events.push('start'));
    processor.on('graphStart', () => events.push('graphStart'));
    processor.on('nodeStart', ({ node }) => events.push(`nodeStart:${node.id}`));
    processor.on('nodeError', ({ node }) => events.push(`nodeError:${node.id}`));
    processor.on('graphError', () => events.push('graphError'));
    processor.on('error', () => events.push('error'));
    processor.on('graphFinish', () => events.push('graphFinish'));
    processor.on('done', () => events.push('done'));
    processor.on('finish', () => events.push('finish'));

    await assert.rejects(
      () => withTimeout(processor.processGraph(testProcessContext()), 'failing graph rejection'),
      (error) =>
        error instanceof Error &&
        error.message.includes('failed to process due to errors in nodes') &&
        error.cause instanceof Error &&
        error.cause.message === 'characterized failure',
    );
    await withTimeout(Promise.all([nodeErrored, graphErrored, genericErrored]), 'processor error events');

    assert.equal(events.includes('nodeError:failing-node'), true);
    assert.equal(events.includes('graphError'), true);
    assert.equal(events.includes('error'), true);
    assert.equal(events.includes('graphFinish'), false);
    assert.equal(events.includes('done'), false);
    assert.equal(events.at(-1), 'finish');
    assert.ok(events.indexOf('nodeStart:failing-node') < events.indexOf('nodeError:failing-node'));
    assert.ok(events.indexOf('graphError') < events.indexOf('finish'));
  });

  void it('does not start downstream nodes after an input node errors', async () => {
    const failingNode = makeProbeNode('failing-node', { throwMessage: 'upstream failure' });
    const downstreamNode = makeProbeNode('downstream-node');
    const graph = makeGraph([failingNode, downstreamNode], [connect('failing-node', 'downstream-node')]);
    const processor = createProcessor(graph);
    const nodeStarts: NodeId[] = [];
    const nodeErrors: NodeId[] = [];

    processor.on('nodeStart', ({ node }) => nodeStarts.push(node.id));
    processor.on('nodeError', ({ node }) => nodeErrors.push(node.id));

    await assert.rejects(
      () => withTimeout(processor.processGraph(testProcessContext()), 'errored-input graph rejection'),
      (error) =>
        error instanceof Error &&
        error.message.includes('failed to process due to errors in nodes') &&
        error.cause instanceof Error &&
        error.cause.message === 'upstream failure',
    );

    assert.deepEqual(nodeStarts, [failingNode.id]);
    assert.deepEqual(nodeErrors, [failingNode.id]);
  });

  void it('emits partial outputs with the same process id as the finished node', async () => {
    const partialNode = makeProbeNode('partial-node', {
      partialValues: [
        { type: 'string', value: 'partial one' },
        { type: 'string', value: 'partial two' },
      ],
      value: { type: 'string', value: 'final' },
    });
    const graph = makeGraph([partialNode], []);
    const processor = createProcessor(graph);
    const partialOutputs: ProcessEvents['partialOutput'][] = [];
    let resolvePartialOutputs: (() => void) | undefined;
    const allPartialOutputs = new Promise<void>((resolve) => {
      resolvePartialOutputs = resolve;
    });
    let nodeStartProcessId: ProcessEvents['nodeStart']['processId'] | undefined;
    let nodeFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeStart', ({ node, processId }) => {
      if (node.id === partialNode.id) {
        nodeStartProcessId = processId;
      }
    });
    processor.on('partialOutput', (event) => {
      partialOutputs.push(event);
      if (partialOutputs.length === 2) {
        resolvePartialOutputs?.();
      }
    });
    processor.on('nodeFinish', (event) => {
      if (event.node.id === partialNode.id) {
        nodeFinish = event;
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'partial-output graph run');
    await withTimeout(allPartialOutputs, 'partial output events');

    assert.equal(partialOutputs.length, 2);
    assert.deepEqual(
      partialOutputs.map((event) => event.outputs.output),
      [
        { type: 'string', value: 'partial one' },
        { type: 'string', value: 'partial two' },
      ],
    );
    assert.equal(
      partialOutputs.every((event) => event.processId === nodeStartProcessId),
      true,
    );
    assert.equal(nodeFinish?.processId, nodeStartProcessId);
    assert.deepEqual(nodeFinish?.outputs.output, { type: 'string', value: 'final' });
  });

  void it('forwards subgraph events with stable root, parent, executor, and graph run metadata', async () => {
    const childInputNode: ChartNode = {
      id: 'child-input' as NodeId,
      type: 'graphInput',
      title: 'Child Input',
      data: {
        id: 'incoming',
        dataType: 'string',
        useDefaultValueInput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const childProbeNode = makeProbeNode('child-probe');
    const childOutputNode = makeGraphOutputNode('childResult');
    const childGraph = makeGraph(
      [childInputNode, childProbeNode, childOutputNode],
      [
        {
          outputNodeId: childInputNode.id,
          outputId: 'data' as PortId,
          inputNodeId: childProbeNode.id,
          inputId: 'input' as PortId,
        },
        connect(childProbeNode.id, childOutputNode.id, 'value'),
      ],
      'child-graph' as GraphId,
    );
    const subgraphNode: ChartNode = {
      id: 'subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Subgraph',
      data: {
        graphId: childGraph.metadata!.id,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
        inputData: {
          incoming: { type: 'string', value: 'from parent' },
        },
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutputNode = makeGraphOutputNode('parentResult');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutputNode],
      [
        {
          outputNodeId: subgraphNode.id,
          outputId: 'childResult' as PortId,
          inputNodeId: parentOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
      'parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const graphStarts: ProcessEvents['graphStart'][] = [];
    let parentSubgraphProcessId: ProcessEvents['nodeStart']['processId'] | undefined;

    processor.on('graphStart', (event) => graphStarts.push(event));
    processor.on('nodeStart', ({ node, processId }) => {
      if (node.id === subgraphNode.id) {
        parentSubgraphProcessId = processId;
      }
    });

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentResult, { type: 'string', value: 'from parent' });
    assert.equal(graphStarts.length, 2);
    assert.equal(graphStarts[0]!.execution.graphId, parentGraph.metadata!.id);
    assert.equal(graphStarts[1]!.execution.graphId, childGraph.metadata!.id);
    assert.equal(graphStarts[1]!.execution.rootRunId, graphStarts[0]!.execution.rootRunId);
    assert.equal(graphStarts[1]!.execution.parentGraphRunId, graphStarts[0]!.execution.graphRunId);
    assert.deepEqual(graphStarts[1]!.execution.executor, {
      nodeId: subgraphNode.id,
      parentGraphId: parentGraph.metadata!.id,
      processId: parentSubgraphProcessId,
      splitIndex: 0,
    });
  });

  void demandOptimizationIt('runs only subgraph output branches demanded by active parent output connections', async () => {
    const usedProbe = makeProbeNode('child-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('child-unused-probe', {
      setGlobal: { id: 'unused-side-effect', value: { type: 'string', value: 'should not be set' } },
      value: { type: 'string', value: 'unused' },
    });
    const usedOutput = makeGraphOutputNode('childUsed');
    const unusedOutput = makeGraphOutputNode('childUnused');
    const childGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      'demand-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('demand-subgraph', childGraph.metadata!.id);
    const parentOutput = makeGraphOutputNode('parentUsed');
    const disabledConsumer = makeProbeNode('disabled-consumer');
    disabledConsumer.disabled = true;
    const parentGraph = makeGraph(
      [subgraphNode, parentOutput, disabledConsumer],
      [
        connect(subgraphNode.id, parentOutput.id, 'value', 'childUsed'),
        connect(subgraphNode.id, disabledConsumer.id, 'input', 'childUnused'),
      ],
      'demand-parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];
    const globalSetIds: string[] = [];
    let subgraphFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeFinish', (event) => {
      finishedNodeIds.push(event.node.id);
      if (event.node.id === subgraphNode.id) {
        subgraphFinish = event;
      }
    });
    processor.on('globalSet', (event) => globalSetIds.push(event.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentUsed, { type: 'string', value: 'used' });
    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), false);
    assert.deepEqual(globalSetIds, []);
    assert.deepEqual(subgraphFinish?.outputs.childUnused, {
      type: 'control-flow-excluded',
      value: undefined,
    });
  });

  void demandOptimizationIt('treats a subgraph output connected to any enabled downstream node as demanded', async () => {
    const childProbe = makeProbeNode('child-enabled-consumer-probe', { value: { type: 'string', value: 'value' } });
    const childOutput = makeGraphOutputNode('childValue');
    const childGraph = makeGraph(
      [childProbe, childOutput],
      [connect(childProbe.id, childOutput.id, 'value')],
      'enabled-consumer-child' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('enabled-consumer-subgraph', childGraph.metadata!.id);
    const enabledConsumer = makeProbeNode('enabled-consumer');
    const parentGraph = makeGraph(
      [subgraphNode, enabledConsumer],
      [connect(subgraphNode.id, enabledConsumer.id, 'input', 'childValue')],
      'enabled-consumer-parent' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    await processor.processGraph(testProcessContext());

    assert.equal(finishedNodeIds.includes(childProbe.id), true);
    assert.equal(finishedNodeIds.includes(enabledConsumer.id), true);
  });

  void demandOptimizationIt('skips errors from unrequested subgraph output branches', async () => {
    const usedProbe = makeProbeNode('skipped-error-used-probe', { value: { type: 'string', value: 'used' } });
    const throwingProbe = makeProbeNode('skipped-error-throwing-probe', { throwMessage: 'unused branch failed' });
    const usedOutput = makeGraphOutputNode('used');
    const unusedOutput = makeGraphOutputNode('unused');
    const childGraph = makeGraph(
      [usedProbe, usedOutput, throwingProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(throwingProbe.id, unusedOutput.id, 'value'),
      ],
      'skipped-error-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('skipped-error-subgraph', childGraph.metadata!.id);
    const parentOutput = makeGraphOutputNode('parentUsed');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutput],
      [connect(subgraphNode.id, parentOutput.id, 'value', 'used')],
      'skipped-error-parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const erroredNodeIds: NodeId[] = [];
    const finishedNodeIds: NodeId[] = [];

    processor.on('nodeError', ({ node }) => erroredNodeIds.push(node.id));
    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentUsed, { type: 'string', value: 'used' });
    assert.deepEqual(erroredNodeIds, []);
    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(throwingProbe.id), false);
  });

  void it('runs shared child dependencies once when multiple subgraph outputs need them', async () => {
    const sharedProbe = makeProbeNode('shared-child-probe', { value: { type: 'string', value: 'shared' } });
    const leftOutput = makeGraphOutputNode('left');
    const rightOutput = makeGraphOutputNode('right');
    const childGraph = makeGraph(
      [sharedProbe, leftOutput, rightOutput],
      [
        connect(sharedProbe.id, leftOutput.id, 'value'),
        connect(sharedProbe.id, rightOutput.id, 'value'),
      ],
      'shared-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('shared-subgraph', childGraph.metadata!.id);
    const leftParentOutput = makeGraphOutputNode('parentLeft');
    const rightParentOutput = makeGraphOutputNode('parentRight');
    const parentGraph = makeGraph(
      [subgraphNode, leftParentOutput, rightParentOutput],
      [
        connect(subgraphNode.id, leftParentOutput.id, 'value', 'left'),
        connect(subgraphNode.id, rightParentOutput.id, 'value', 'right'),
      ],
      'shared-parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentLeft, { type: 'string', value: 'shared' });
    assert.deepEqual(outputs.parentRight, { type: 'string', value: 'shared' });
    assert.equal(finishedNodeIds.filter((nodeId) => nodeId === sharedProbe.id).length, 1);
  });

  void demandOptimizationIt('skips child graph execution when a subgraph has no active output consumers', async () => {
    const childProbe = makeProbeNode('skipped-child-probe', { value: { type: 'string', value: 'unused' } });
    const childOutput = makeGraphOutputNode('childValue');
    const childGraph = makeGraph(
      [childProbe, childOutput],
      [connect(childProbe.id, childOutput.id, 'value')],
      'skipped-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('skipped-subgraph', childGraph.metadata!.id);
    const parentGraph = makeGraph([subgraphNode], [], 'skipped-parent-graph' as GraphId);
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];
    let subgraphFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeFinish', (event) => {
      finishedNodeIds.push(event.node.id);
      if (event.node.id === subgraphNode.id) {
        subgraphFinish = event;
      }
    });

    await processor.processGraph(testProcessContext());

    assert.equal(finishedNodeIds.includes(childProbe.id), false);
    assert.deepEqual(subgraphFinish?.outputs.childValue, {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(subgraphFinish?.outputs.cost, { type: 'number', value: 0 });
    assert.deepEqual(subgraphFinish?.outputs.duration, { type: 'number', value: 0 });
  });

  void it('runs a direct run-to subgraph target as a full child graph for inspection', async () => {
    const usedProbe = makeProbeNode('run-to-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('run-to-unused-probe', { value: { type: 'string', value: 'unused' } });
    const usedOutput = makeGraphOutputNode('used');
    const unusedOutput = makeGraphOutputNode('unused');
    const childGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      'run-to-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('run-to-subgraph', childGraph.metadata!.id);
    const parentGraph = makeGraph([subgraphNode], [], 'run-to-parent-graph' as GraphId);
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.runToNodeIds = [subgraphNode.id];
    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    await processor.processGraph(testProcessContext());

    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), true);
  });

  void demandOptimizationIt('uses downstream run-to targets to demand only relevant subgraph output ports', async () => {
    const leftProbe = makeProbeNode('run-to-downstream-left-probe', { value: { type: 'string', value: 'left' } });
    const rightProbe = makeProbeNode('run-to-downstream-right-probe', { value: { type: 'string', value: 'right' } });
    const leftOutput = makeGraphOutputNode('left');
    const rightOutput = makeGraphOutputNode('right');
    const childGraph = makeGraph(
      [leftProbe, leftOutput, rightProbe, rightOutput],
      [
        connect(leftProbe.id, leftOutput.id, 'value'),
        connect(rightProbe.id, rightOutput.id, 'value'),
      ],
      'run-to-downstream-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('run-to-downstream-subgraph', childGraph.metadata!.id);
    const leftConsumer = makeProbeNode('run-to-downstream-left-consumer');
    const rightConsumer = makeProbeNode('run-to-downstream-right-consumer');
    const parentGraph = makeGraph(
      [subgraphNode, leftConsumer, rightConsumer],
      [
        connect(subgraphNode.id, leftConsumer.id, 'input', 'left'),
        connect(subgraphNode.id, rightConsumer.id, 'input', 'right'),
      ],
      'run-to-downstream-parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.runToNodeIds = [leftConsumer.id];
    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    await processor.processGraph(testProcessContext());

    assert.equal(finishedNodeIds.includes(leftProbe.id), true);
    assert.equal(finishedNodeIds.includes(rightProbe.id), false);
    assert.equal(finishedNodeIds.includes(leftConsumer.id), true);
    assert.equal(finishedNodeIds.includes(rightConsumer.id), false);
  });

  void it('runs the full child graph when a subgraph error output is actively connected', async () => {
    const goodProbe = makeProbeNode('error-active-good-probe', { value: { type: 'string', value: 'good' } });
    const throwingProbe = makeProbeNode('error-active-throwing-probe', { throwMessage: 'unused branch failed' });
    const goodOutput = makeGraphOutputNode('good');
    const throwingOutput = makeGraphOutputNode('unused');
    const childGraph = makeGraph(
      [goodProbe, goodOutput, throwingProbe, throwingOutput],
      [
        connect(goodProbe.id, goodOutput.id, 'value'),
        connect(throwingProbe.id, throwingOutput.id, 'value'),
      ],
      'error-active-child-graph' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('error-active-subgraph', childGraph.metadata!.id, {
      useErrorOutput: true,
    });
    const parentGoodOutput = makeGraphOutputNode('parentGood');
    const parentErrorOutput = makeGraphOutputNode('parentError');
    const parentGraph = makeGraph(
      [subgraphNode, parentGoodOutput, parentErrorOutput],
      [
        connect(subgraphNode.id, parentGoodOutput.id, 'value', 'good'),
        connect(subgraphNode.id, parentErrorOutput.id, 'value', 'error'),
      ],
      'error-active-parent-graph' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const erroredNodeIds: NodeId[] = [];

    processor.on('nodeError', ({ node }) => erroredNodeIds.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.equal(erroredNodeIds.includes(throwingProbe.id), true);
    assert.deepEqual(outputs.parentGood, {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.equal(outputs.parentError?.type, 'string');
    assert.match(String(outputs.parentError?.value), /unused branch failed|error-active-throwing-probe/);
  });

  void it('runs the full child graph when subgraph partial-output forwarding is enabled', async () => {
    const usedProbe = makeProbeNode('partial-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('partial-unused-probe', { value: { type: 'string', value: 'unused' } });
    const usedOutput = makeGraphOutputNode('used');
    const unusedOutput = makeGraphOutputNode('unused');
    const childGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      'partial-subgraph-child' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('partial-subgraph', childGraph.metadata!.id, {
      useAsGraphPartialOutput: true,
    });
    const parentOutput = makeGraphOutputNode('parentUsed');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutput],
      [connect(subgraphNode.id, parentOutput.id, 'value', 'used')],
      'partial-subgraph-parent' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    await processor.processGraph(testProcessContext());

    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), true);
  });

  void demandOptimizationIt('targets the winning duplicate Graph Output node when pruning subgraph outputs', async () => {
    const firstProbe = makeProbeNode('duplicate-first-probe', { value: { type: 'string', value: 'first' } });
    const secondProbe = makeProbeNode('duplicate-second-probe', { value: { type: 'string', value: 'second' } });
    const firstOutput = makeGraphOutputNode('duplicate');
    firstOutput.id = 'duplicate-output-first' as NodeId;
    const secondOutput = makeGraphOutputNode('duplicate');
    secondOutput.id = 'duplicate-output-second' as NodeId;
    const childGraph = makeGraph(
      [firstProbe, firstOutput, secondProbe, secondOutput],
      [
        connect(firstProbe.id, firstOutput.id, 'value'),
        connect(secondProbe.id, secondOutput.id, 'value'),
      ],
      'duplicate-output-child' as GraphId,
    );
    const subgraphNode = makeSubgraphNode('duplicate-output-subgraph', childGraph.metadata!.id);
    const parentOutput = makeGraphOutputNode('parentDuplicate');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutput],
      [connect(subgraphNode.id, parentOutput.id, 'value', 'duplicate')],
      'duplicate-output-parent' as GraphId,
    );
    const processor = createProcessor(parentGraph, [childGraph]);
    const finishedNodeIds: NodeId[] = [];

    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentDuplicate, { type: 'string', value: 'first' });
    assert.equal(finishedNodeIds.includes(firstProbe.id), true);
    assert.equal(finishedNodeIds.includes(secondProbe.id), false);
  });

  void demandOptimizationIt('runs only referenced graph alias output branches demanded by active parent output connections', async () => {
    const referencedProjectId = 'referenced-demand-project' as ProjectId;
    const referencedGraphId = 'referenced-demand-graph' as GraphId;
    const usedProbe = makeProbeNode('referenced-used-probe', { value: { type: 'string', value: 'used' } });
    const unusedProbe = makeProbeNode('referenced-unused-probe', { value: { type: 'string', value: 'unused' } });
    const usedOutput = makeGraphOutputNode('referencedUsed');
    const unusedOutput = makeGraphOutputNode('referencedUnused');
    const referencedGraph = makeGraph(
      [usedProbe, usedOutput, unusedProbe, unusedOutput],
      [
        connect(usedProbe.id, usedOutput.id, 'value'),
        connect(unusedProbe.id, unusedOutput.id, 'value'),
      ],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;
    const aliasNode: ChartNode = {
      id: 'referenced-demand-alias' as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutput = makeGraphOutputNode('parentReferencedUsed');
    const disabledConsumer = makeProbeNode('referenced-disabled-consumer');
    disabledConsumer.disabled = true;
    const parentGraph = makeGraph(
      [aliasNode, parentOutput, disabledConsumer],
      [
        connect(aliasNode.id, parentOutput.id, 'value', 'referencedUsed'),
        connect(aliasNode.id, disabledConsumer.id, 'input', 'referencedUnused'),
      ],
      'referenced-demand-parent' as GraphId,
    );
    const project = makeProject(parentGraph);
    project.references = [{ id: referencedProjectId }];
    const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry());
    const finishedNodeIds: NodeId[] = [];
    let aliasFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('nodeFinish', (event) => {
      finishedNodeIds.push(event.node.id);
      if (event.node.id === aliasNode.id) {
        aliasFinish = event;
      }
    });

    const outputs = await processor.processGraph({
      ...testProcessContext(),
      projectReferenceLoader: {
        loadProject: async () => referencedProject,
      },
    });

    assert.deepEqual(outputs.parentReferencedUsed, { type: 'string', value: 'used' });
    assert.equal(finishedNodeIds.includes(usedProbe.id), true);
    assert.equal(finishedNodeIds.includes(unusedProbe.id), false);
    assert.deepEqual(aliasFinish?.outputs.referencedUnused, {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.equal(aliasFinish?.outputs.cost, undefined);
    assert.equal(aliasFinish?.outputs.duration, undefined);
  });

  void demandOptimizationIt('honors the referenced graph alias metric toggle when demand pruning skips the child graph', async () => {
    const referencedProjectId = 'referenced-skipped-metrics-project' as ProjectId;
    const referencedGraphId = 'referenced-skipped-metrics-graph' as GraphId;
    const childProbe = makeProbeNode('referenced-skipped-metrics-probe', {
      value: { type: 'string', value: 'unused' },
    });
    const childOutput = makeGraphOutputNode('childValue');
    const referencedGraph = makeGraph(
      [childProbe, childOutput],
      [connect(childProbe.id, childOutput.id, 'value')],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;
    const createAliasNode = (outputCostDuration: boolean): ChartNode => ({
      id: `referenced-skipped-metrics-alias-${outputCostDuration}` as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        outputCostDuration,
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    });
    const runAlias = async (outputCostDuration: boolean) => {
      const aliasNode = createAliasNode(outputCostDuration);
      const parentGraph = makeGraph([aliasNode], [], `referenced-skipped-metrics-${outputCostDuration}` as GraphId);
      const project = makeProject(parentGraph);
      project.references = [{ id: referencedProjectId }];
      const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry());
      let aliasFinish: ProcessEvents['nodeFinish'] | undefined;

      processor.on('nodeFinish', (event) => {
        if (event.node.id === aliasNode.id) {
          aliasFinish = event;
        }
      });

      await processor.processGraph({
        ...testProcessContext(),
        projectReferenceLoader: {
          loadProject: async () => referencedProject,
        },
      });

      return aliasFinish?.outputs;
    };

    const outputsWithoutMetrics = await runAlias(false);
    assert.deepEqual(outputsWithoutMetrics?.childValue, {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.equal(outputsWithoutMetrics?.cost, undefined);
    assert.equal(outputsWithoutMetrics?.duration, undefined);

    const outputsWithMetrics = await runAlias(true);
    assert.deepEqual(outputsWithMetrics?.childValue, {
      type: 'control-flow-excluded',
      value: undefined,
    });
    assert.deepEqual(outputsWithMetrics?.cost, { type: 'number', value: 0 });
    assert.deepEqual(outputsWithMetrics?.duration, { type: 'number', value: 0 });
  });

  void it('preloads boundary nodes and runs only the requested terminal slice', async () => {
    const nodeA = makeProbeNode('node-a', { value: { type: 'string', value: 'fresh a' } });
    const nodeB = makeProbeNode('node-b');
    const nodeC = makeProbeNode('node-c');
    const graph = makeGraph([nodeA, nodeB, nodeC], [connect('node-a', 'node-b'), connect('node-b', 'node-c')]);
    const processor = createProcessor(graph);
    const starts: Array<{ nodeId: NodeId; processId: ProcessEvents['nodeStart']['processId'] }> = [];
    const finishes: Array<{ nodeId: NodeId; processId: ProcessEvents['nodeFinish']['processId']; outputs: Outputs }> =
      [];

    processor.preloadNodeData(nodeB.id, {
      output: { type: 'string', value: 'preloaded b' },
    });
    processor.runToNodeIds = [nodeC.id];
    processor.on('nodeStart', ({ node, processId }) => starts.push({ nodeId: node.id, processId }));
    processor.on('nodeFinish', ({ node, outputs, processId }) =>
      finishes.push({ nodeId: node.id, processId, outputs }),
    );

    await processor.processGraph(testProcessContext());

    assert.equal(starts.length, 2);
    assert.deepEqual(starts[0], {
      nodeId: nodeB.id,
      processId: 'preload' as ProcessEvents['nodeStart']['processId'],
    });
    assert.equal(starts[1]!.nodeId, nodeC.id);
    assert.notEqual(starts[1]!.processId, 'preload');
    assert.equal(finishes.length, 2);
    assert.equal(finishes[0]!.nodeId, nodeB.id);
    assert.equal(finishes[0]!.processId, 'preload');
    assert.deepEqual(finishes[0]!.outputs.output, { type: 'string', value: 'preloaded b' });
    assert.equal(finishes[1]!.nodeId, nodeC.id);
    assert.deepEqual(finishes[1]!.outputs.output, { type: 'string', value: 'preloaded b' });
    assert.equal(
      starts.some((event) => event.nodeId === nodeA.id),
      false,
    );
    assert.equal(starts.filter((event) => event.nodeId === nodeB.id).length, 1);
  });

  void it('honors runTo terminal selection without executing downstream consumers', async () => {
    const nodeA = makeProbeNode('node-a', { value: { type: 'string', value: 'alpha' } });
    const nodeB = makeProbeNode('node-b');
    const nodeC = makeProbeNode('node-c');
    const outputNode = makeGraphOutputNode('result');
    const graph = makeGraph(
      [nodeA, nodeB, nodeC, outputNode],
      [connect('node-a', 'node-b'), connect('node-b', 'node-c'), connect('node-c', outputNode.id, 'value')],
    );
    const processor = createProcessor(graph);
    const finishedNodeIds: NodeId[] = [];

    processor.runToNodeIds = [nodeB.id];
    processor.on('nodeFinish', ({ node }) => finishedNodeIds.push(node.id));

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(finishedNodeIds, [nodeA.id, nodeB.id]);
    assert.equal(outputs.result, undefined);
    assert.deepEqual(outputs.cost, { type: 'number', value: 0 });
  });

  void it('does not start queued nodes while paused and resumes them in the same run', async () => {
    const pausedNode = makeProbeNode('paused-node', { value: { type: 'string', value: 'resumed' } });
    const graph = makeGraph([pausedNode], []);
    const processor = createProcessor(graph);
    const events: string[] = [];
    const pauseEmitted = processor.once('pause');
    const graphStarted = processor.once('graphStart');

    processor.on('pause', () => events.push('pause'));
    processor.on('graphStart', () => events.push('graphStart'));
    processor.on('nodeStart', ({ node }) => events.push(`nodeStart:${node.id}`));
    processor.on('resume', () => events.push('resume'));
    processor.on('finish', () => events.push('finish'));

    processor.pause();
    await withTimeout(pauseEmitted, 'pause event');

    const runPromise = processor.processGraph(testProcessContext());
    await withTimeout(graphStarted, 'paused graph start');
    await waitFor(20);

    assert.deepEqual(events, ['pause', 'graphStart']);

    processor.resume();
    await withTimeout(runPromise, 'paused graph run to finish');

    assert.deepEqual(events, ['pause', 'graphStart', 'resume', `nodeStart:${pausedNode.id}`, 'finish']);
  });

  void it('keeps globals shared across concurrently-started nodes in the same run', async () => {
    const writerNode = makeProbeNode('writer-node', {
      delayMs: 10,
      setGlobal: { id: 'shared', value: { type: 'string', value: 'global value' } },
      value: { type: 'string', value: 'writer done' },
    });
    const readerNode = makeProbeNode('reader-node', {
      waitForGlobal: 'shared',
    });
    const graph = makeGraph([writerNode, readerNode], []);
    const processor = createProcessor(graph);
    const globalSetEvents: ProcessEvents['globalSet'][] = [];
    let resolveReaderFinished: (() => void) | undefined;
    const readerFinished = new Promise<void>((resolve) => {
      resolveReaderFinished = resolve;
    });
    let readerFinish: ProcessEvents['nodeFinish'] | undefined;

    processor.on('globalSet', (event) => globalSetEvents.push(event));
    processor.on('nodeFinish', (event) => {
      if (event.node.id === readerNode.id) {
        readerFinish = event;
        resolveReaderFinished?.();
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'global-sharing graph run');
    await withTimeout(readerFinished, 'reader node finish event');

    assert.deepEqual(
      globalSetEvents.map((event) => [event.id, event.value]),
      [['shared', { type: 'string', value: 'global value' }]],
    );
    assert.deepEqual(readerFinish?.outputs.output, { type: 'string', value: 'global value' });
  });

  void it('emits a scoped startup error when project-reference loading fails', async () => {
    const startupGraph = makeGraph([], [], 'reference-loader-failure' as GraphId);
    const project = makeProject(startupGraph);
    project.references = [{ id: 'missing-reference' as ProjectId, title: 'Missing reference' }];
    const processor = new GraphProcessor(project, startupGraph.metadata!.id!, createRegistry());
    const lifecycleEvents: string[] = [];
    const graphErrors: ProcessEvents['graphError'][] = [];
    const rootErrors: Array<Error | string> = [];
    processor.on('graphError', (event) => {
      lifecycleEvents.push('graphError');
      graphErrors.push(event);
    });
    processor.on('error', ({ error }) => {
      lifecycleEvents.push('error');
      rootErrors.push(error);
    });

    await assert.rejects(
      processor.processGraph({
        ...testProcessContext(),
        projectReferenceLoader: {
          async loadProject() {
            throw new Error('reference loader unavailable');
          },
        },
      }),
      /reference loader unavailable/,
    );

    assert.deepEqual(lifecycleEvents, ['graphError', 'error']);
    assert.equal(graphErrors.length, 1);
    assert.equal(graphErrors[0]!.graph.metadata?.id, startupGraph.metadata?.id);
    assert.match(String(graphErrors[0]!.error), /reference loader unavailable/);
    assert.ok(String(graphErrors[0]!.execution.rootRunId));
    assert.ok(String(graphErrors[0]!.execution.graphRunId));
    assert.equal(rootErrors.length, 1);
    assert.match(String(rootErrors[0]), /reference loader unavailable/);
  });

  void it('reads cached referenced projects only when loaded-project caching is enabled', async () => {
    const mainGraphId = 'reference-cache-main' as GraphId;
    const referencedProjectId = 'reference-cache-child' as ProjectId;
    const project: Project = {
      graphs: {
        [mainGraphId]: {
          connections: [],
          metadata: {
            id: mainGraphId,
            name: 'Reference Cache Main',
          },
          nodes: [],
        },
      },
      metadata: {
        description: '',
        id: 'reference-cache-root' as ProjectId,
        mainGraphId,
        title: 'Reference Cache Root',
      },
      plugins: [],
      references: [{ id: referencedProjectId, title: 'Reference Cache Child' }],
    };
    const referencedProject: Project = {
      graphs: {},
      metadata: {
        description: '',
        id: referencedProjectId,
        title: 'Reference Cache Child',
      },
      plugins: [],
    };
    const mainGraph = project.graphs[mainGraphId]!;
    const runtimeCache: GraphProcessorRuntimeCache = {
      loadedProjects: {
        [referencedProjectId]: referencedProject,
      },
    };
    let loadCalls = 0;
    const context = {
      ...testProcessContext(),
      projectReferenceLoader: {
        async loadProject() {
          loadCalls += 1;
          return referencedProject;
        },
      },
    };

    const uncachedProcessor = new GraphProcessor(project, mainGraphId, createRegistry(), false, {
      cacheLoadedProjects: false,
      runtimeCache,
    });
    await uncachedProcessor.processGraph(context);
    assert.equal(loadCalls, 1);
    assert.notEqual(runtimeCache.executionPlans?.has(mainGraph), true);

    const cachedProcessor = new GraphProcessor(project, mainGraphId, createRegistry(), false, {
      cacheLoadedProjects: true,
      runtimeCache,
    });
    await cachedProcessor.processGraph(context);
    assert.equal(loadCalls, 1);
    assert.equal(runtimeCache.executionPlans?.has(mainGraph), true);
  });

  void it('does not cache unresolved referenced graph ports when data is preloaded before a cached run', async () => {
    const referencedProjectId = 'preload-reference-cache-child' as ProjectId;
    const referencedGraphId = 'preload-reference-cache-graph' as GraphId;
    const referencedProbe = makeProbeNode('preload-reference-cache-probe', {
      value: { type: 'string', value: 'referenced value' },
    });
    const referencedOutput = makeGraphOutputNode('referencedResult');
    const referencedGraph = makeGraph(
      [referencedProbe, referencedOutput],
      [connect(referencedProbe.id, referencedOutput.id, 'value')],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;

    const preloadedProbe = makeProbeNode('preload-reference-cache-boundary');
    const aliasNode: ChartNode = {
      id: 'preload-reference-cache-alias' as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutput = makeGraphOutputNode('result');
    const parentGraph = makeGraph(
      [preloadedProbe, aliasNode, parentOutput],
      [connect(aliasNode.id, parentOutput.id, 'value', 'referencedResult')],
      'preload-reference-cache-parent' as GraphId,
    );
    const project = makeProject(parentGraph);
    project.references = [{ id: referencedProjectId }];
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry(), false, {
      cacheLoadedProjects: true,
      runtimeCache,
    });

    // Preloading must not preprocess the graph: the referenced alias cannot
    // expose its boundary ports until processGraph has loaded its project.
    processor.preloadNodeData(preloadedProbe.id, {
      output: { type: 'string', value: 'preloaded boundary' },
    });
    assert.notEqual(runtimeCache.executionPlans?.has(parentGraph), true);

    const outputs = await processor.processGraph({
      ...testProcessContext(),
      projectReferenceLoader: {
        loadProject: async () => referencedProject,
      },
    });

    assert.deepEqual(outputs.result, { type: 'string', value: 'referenced value' });
    assert.equal(runtimeCache.executionPlans?.has(parentGraph), true);
  });

  void it('does not cache unresolved referenced graph ports during a pre-run dependency inspection', async () => {
    const referencedProjectId = 'dependency-reference-cache-child' as ProjectId;
    const referencedGraphId = 'dependency-reference-cache-graph' as GraphId;
    const referencedProbe = makeProbeNode('dependency-reference-cache-probe', {
      value: { type: 'string', value: 'referenced value' },
    });
    const referencedOutput = makeGraphOutputNode('referencedResult');
    const referencedGraph = makeGraph(
      [referencedProbe, referencedOutput],
      [connect(referencedProbe.id, referencedOutput.id, 'value')],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;

    const aliasNode: ChartNode = {
      id: 'dependency-reference-cache-alias' as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutput = makeGraphOutputNode('result');
    const parentGraph = makeGraph(
      [aliasNode, parentOutput],
      [connect(aliasNode.id, parentOutput.id, 'value', 'referencedResult')],
      'dependency-reference-cache-parent' as GraphId,
    );
    const project = makeProject(parentGraph);
    project.references = [{ id: referencedProjectId }];
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry(), false, {
      cacheLoadedProjects: true,
      runtimeCache,
    });

    processor.getDependencyNodesDeep(parentOutput.id);
    assert.notEqual(runtimeCache.executionPlans?.has(parentGraph), true);

    const outputs = await processor.processGraph({
      ...testProcessContext(),
      projectReferenceLoader: {
        loadProject: async () => referencedProject,
      },
    });

    assert.deepEqual(outputs.result, { type: 'string', value: 'referenced value' });
    assert.equal(runtimeCache.executionPlans?.has(parentGraph), true);
  });

  void it('can cache execution plans for subprocessors without caching the root graph', async () => {
    const childProbeNode = makeProbeNode('child-probe', { value: { type: 'string', value: 'child value' } });
    const childOutputNode = makeGraphOutputNode('childResult');
    const childGraph = makeGraph(
      [childProbeNode, childOutputNode],
      [connect(childProbeNode.id, childOutputNode.id, 'value')],
      'subprocessor-cache-child' as GraphId,
    );
    const subgraphNode: ChartNode = {
      id: 'subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Subgraph',
      data: {
        graphId: childGraph.metadata!.id,
        inputData: {},
        useAsGraphPartialOutput: false,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutputNode = makeGraphOutputNode('parentResult');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutputNode],
      [
        {
          outputNodeId: subgraphNode.id,
          outputId: 'childResult' as PortId,
          inputNodeId: parentOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
      'subprocessor-cache-parent' as GraphId,
    );
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = new GraphProcessor(
      makeProject(parentGraph, [childGraph]),
      parentGraph.metadata!.id,
      createRegistry(),
      false,
      {
        executionPlanCacheMode: 'subprocessors',
        runtimeCache,
      },
    );

    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.parentResult, { type: 'string', value: 'child value' });
    assert.notEqual(runtimeCache.executionPlans?.has(parentGraph), true);
    assert.equal(runtimeCache.executionPlans?.has(childGraph), true);
  });

  void it('rebuilds a cached execution plan when library nodes change', async () => {
    const prefabId = 'cached-prefab' as NodePrefabId;
    const instanceNode: ChartNode = {
      id: 'prefab-instance' as NodeId,
      type: 'nodePrefabInstance',
      title: 'Linked item',
      data: {
        prefabId,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const outputNode = makeGraphOutputNode('result');
    const graph = makeGraph(
      [instanceNode, outputNode],
      [connect(instanceNode.id, outputNode.id, 'value')],
      'prefab-cache-graph' as GraphId,
    );
    const project = {
      ...makeProject(graph),
      nodePrefabs: {
        [prefabId]: {
          id: prefabId,
          sourceNode: makeProbeNode('prefab-source-a', { value: { type: 'string', value: 'first' } }),
        },
      },
    };
    const runtimeCache: GraphProcessorRuntimeCache = {};

    const firstProcessor = new GraphProcessor(project, graph.metadata!.id, createRegistry(), false, { runtimeCache });
    const firstOutputs = await firstProcessor.processGraph(testProcessContext());

    assert.deepEqual(firstOutputs.result, { type: 'string', value: 'first' });
    assert.equal(runtimeCache.executionPlans?.has(graph), true);

    const updatedProject = {
      ...project,
      nodePrefabs: {
        [prefabId]: {
          id: prefabId,
          sourceNode: makeProbeNode('prefab-source-b', { value: { type: 'string', value: 'second' } }),
        },
      },
    };
    const secondProcessor = new GraphProcessor(updatedProject, graph.metadata!.id, createRegistry(), false, {
      runtimeCache,
    });
    const secondOutputs = await secondProcessor.processGraph(testProcessContext());

    assert.deepEqual(secondOutputs.result, { type: 'string', value: 'second' });
    assert.equal(runtimeCache.executionPlanNodePrefabs?.get(graph), updatedProject.nodePrefabs);
  });

  void it('uses the runtime graph boundary cache while preprocessing subgraph definitions', () => {
    const childProbeNode = makeProbeNode('child-probe', { value: { type: 'string', value: 'child value' } });
    const childOutputNode = makeGraphOutputNode('childResult');
    const childGraph = makeGraph(
      [childProbeNode, childOutputNode],
      [connect(childProbeNode.id, childOutputNode.id, 'value')],
      'boundary-cache-child' as GraphId,
    );
    const subgraphNode: ChartNode = {
      id: 'subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Subgraph',
      data: {
        graphId: childGraph.metadata!.id,
        inputData: {},
        useAsGraphPartialOutput: false,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutputNode = makeGraphOutputNode('parentResult');
    const parentGraph = makeGraph(
      [subgraphNode, parentOutputNode],
      [
        {
          outputNodeId: subgraphNode.id,
          outputId: 'childResult' as PortId,
          inputNodeId: parentOutputNode.id,
          inputId: 'value' as PortId,
        },
      ],
      'boundary-cache-parent' as GraphId,
    );
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = new GraphProcessor(
      makeProject(parentGraph, [childGraph]),
      parentGraph.metadata!.id,
      createRegistry(),
      false,
      {
        executionPlanCacheMode: 'subprocessors',
        runtimeCache,
      },
    );

    processor.getDependencyNodesDeep(parentOutputNode.id);

    assert.notEqual(runtimeCache.executionPlans?.has(parentGraph), true);
    assert.equal(runtimeCache.graphBoundaries?.has(childGraph), true);
  });

  void it('does not reuse referenced-project graph boundaries across runs when referenced projects reload', async () => {
    const referencedProjectId = 'referenced-project' as ProjectId;
    const referencedGraphId = 'referenced-boundary-graph' as GraphId;
    const referencedProbeNode = makeProbeNode('referenced-probe', {
      value: { type: 'string', value: 'referenced value' },
    });
    const referencedOutputNode = makeGraphOutputNode('oldResult');
    const referencedGraph = makeGraph(
      [referencedProbeNode, referencedOutputNode],
      [connect(referencedProbeNode.id, referencedOutputNode.id, 'value')],
      referencedGraphId,
    );
    const referencedProject = makeProject(referencedGraph);
    referencedProject.metadata.id = referencedProjectId;

    const aliasNode: ChartNode = {
      id: 'referenced-alias' as NodeId,
      type: 'referencedGraphAlias',
      title: 'Referenced Graph Alias',
      data: {
        graphId: referencedGraphId,
        inputData: {},
        projectId: referencedProjectId,
        useErrorOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const parentOutputNode = makeGraphOutputNode('parentResult');
    const aliasConnection: NodeConnection = {
      outputNodeId: aliasNode.id,
      outputId: 'oldResult' as PortId,
      inputNodeId: parentOutputNode.id,
      inputId: 'value' as PortId,
    };
    const parentGraph = makeGraph(
      [aliasNode, parentOutputNode],
      [aliasConnection],
      'referenced-boundary-parent' as GraphId,
    );
    const project = makeProject(parentGraph);
    project.references = [{ id: referencedProjectId }];
    const runtimeCache: GraphProcessorRuntimeCache = {};
    const processor = new GraphProcessor(project, parentGraph.metadata!.id, createRegistry(), false, {
      runtimeCache,
    });
    const context = {
      ...testProcessContext(),
      projectReferenceLoader: {
        loadProject: async () => referencedProject,
      },
    };

    const firstOutputs = await processor.processGraph(context);
    assert.deepEqual(firstOutputs.parentResult, { type: 'string', value: 'referenced value' });
    assert.equal(runtimeCache.graphBoundaries?.has(referencedGraph), true);

    referencedOutputNode.data.id = 'newResult';
    aliasConnection.outputId = 'newResult' as PortId;

    const secondOutputs = await processor.processGraph(context);

    assert.deepEqual(secondOutputs.parentResult, { type: 'string', value: 'referenced value' });
    assert.equal(runtimeCache.graphBoundaries?.has(referencedGraph), true);
  });

  void it('allows a race winner to finish the graph while the losing branch is aborted', async () => {
    const slowNode = makeProbeNode('slow-node', {
      delayMs: 50,
      value: { type: 'string', value: 'slow' },
    });
    const fastNode = makeProbeNode('fast-node', {
      value: { type: 'string', value: 'fast' },
    });
    const raceNode: ChartNode = {
      id: 'race-node' as NodeId,
      type: 'raceInputs',
      title: 'Race Inputs',
      data: {},
      visualData: { x: 250, y: 0, width: 240 },
    };
    const graph = makeGraph(
      [slowNode, fastNode, raceNode],
      [connect('slow-node', raceNode.id, 'input1'), connect('fast-node', raceNode.id, 'input2')],
    );
    const processor = createProcessor(graph);
    let raceFinish: ProcessEvents['nodeFinish'] | undefined;
    const nodeErrors: NodeId[] = [];
    const nodeExcluded: NodeId[] = [];
    const slowNodeExcluded = processor.once('nodeExcluded');

    processor.on('nodeFinish', (event) => {
      if (event.node.id === raceNode.id) {
        raceFinish = event;
      }
    });
    processor.on('nodeError', ({ node }) => nodeErrors.push(node.id));
    processor.on('nodeExcluded', ({ node }) => nodeExcluded.push(node.id));

    await withTimeout(processor.processGraph(testProcessContext()), 'race graph run');
    await withTimeout(slowNodeExcluded, 'race loser nodeExcluded');

    assert.deepEqual(raceFinish?.outputs.result, { type: 'string', value: 'fast' });
    assert.equal(nodeErrors.includes(slowNode.id), false);
    assert.equal(nodeExcluded.includes(slowNode.id), true);
  });

  void it('forwards late race-loser exclusions from nodes inside subgraphs', async () => {
    const slowChildProbe = makeProbeNode('slow-child-probe', {
      delayMs: 50,
      value: { type: 'string', value: 'slow' },
    });
    const slowChildOutput = makeGraphOutputNode('slowChildResult');
    const slowChildGraph = makeGraph(
      [slowChildProbe, slowChildOutput],
      [connect(slowChildProbe.id, slowChildOutput.id, 'value')],
      'slow-child-graph' as GraphId,
    );
    const slowSubgraphNode: ChartNode = {
      id: 'slow-subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Slow Subgraph',
      data: {
        graphId: slowChildGraph.metadata!.id,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const slowDirectNode = makeProbeNode('slow-direct-node', {
      delayMs: 50,
      value: { type: 'string', value: 'slow direct' },
    });
    const fastNode = makeProbeNode('fast-node', {
      value: { type: 'string', value: 'fast' },
    });
    const raceNode: ChartNode = {
      id: 'race-node' as NodeId,
      type: 'raceInputs',
      title: 'Race Inputs',
      data: {},
      visualData: { x: 250, y: 0, width: 240 },
    };
    const raceOutput = makeGraphOutputNode('raceResult');
    const raceGraph = makeGraph(
      [slowSubgraphNode, slowDirectNode, fastNode, raceNode, raceOutput],
      [
        {
          outputNodeId: slowSubgraphNode.id,
          outputId: 'slowChildResult' as PortId,
          inputNodeId: raceNode.id,
          inputId: 'input1' as PortId,
        },
        connect(slowDirectNode.id, raceNode.id, 'input2'),
        connect(fastNode.id, raceNode.id, 'input3'),
        {
          outputNodeId: raceNode.id,
          outputId: 'result' as PortId,
          inputNodeId: raceOutput.id,
          inputId: 'value' as PortId,
        },
      ],
      'race-subgraph' as GraphId,
    );
    const rootSubgraphNode: ChartNode = {
      id: 'root-subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Root Subgraph',
      data: {
        graphId: raceGraph.metadata!.id,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const rootOutput = makeGraphOutputNode('rootResult');
    const rootGraph = makeGraph(
      [rootSubgraphNode, rootOutput],
      [
        {
          outputNodeId: rootSubgraphNode.id,
          outputId: 'raceResult' as PortId,
          inputNodeId: rootOutput.id,
          inputId: 'value' as PortId,
        },
      ],
      'root-graph' as GraphId,
    );
    const processor = createProcessor(rootGraph, [raceGraph, slowChildGraph]);
    const nodeErrorIds: NodeId[] = [];
    const nodeExcludedById = new Map<NodeId, ProcessEvents['nodeExcluded']>();
    const nodeExcludedIds: NodeId[] = [];
    const waitForNodeExcluded = (nodeId: NodeId) =>
      new Promise<ProcessEvents['nodeExcluded']>((resolve) => {
        processor.on('nodeExcluded', (event) => {
          if (event.node.id === nodeId) {
            nodeExcludedById.set(nodeId, event);
            resolve(event);
          }
        });
      });
    const slowSubgraphExcluded = waitForNodeExcluded(slowSubgraphNode.id);
    const slowDirectNodeExcluded = waitForNodeExcluded(slowDirectNode.id);

    processor.on('nodeError', (event) => {
      nodeErrorIds.push(event.node.id);
    });
    processor.on('nodeExcluded', (event) => {
      nodeExcludedById.set(event.node.id, event);
      nodeExcludedIds.push(event.node.id);
    });

    const outputs = await withTimeout(processor.processGraph(testProcessContext()), 'nested race graph run');
    const [slowSubgraphExcludedEvent, slowDirectNodeExcludedEvent] = await withTimeout(
      Promise.all([slowSubgraphExcluded, slowDirectNodeExcluded]),
      'late race loser nodeExcluded events',
    );

    assert.deepEqual(outputs.rootResult, { type: 'string', value: 'fast' });
    assert.equal(slowSubgraphExcludedEvent.node.id, slowSubgraphNode.id);
    assert.equal(slowDirectNodeExcludedEvent.node.id, slowDirectNode.id);
    assert.equal(slowSubgraphExcludedEvent.reason, 'Race branch lost');
    assert.equal(slowDirectNodeExcludedEvent.reason, 'Race branch lost');
    assert.deepEqual(
      [...nodeExcludedById.keys()].sort(),
      [slowChildProbe.id, slowChildOutput.id, slowDirectNode.id, slowSubgraphNode.id].sort(),
    );
    for (const nodeId of [slowChildProbe.id, slowChildOutput.id, slowDirectNode.id, slowSubgraphNode.id]) {
      assert.equal(nodeErrorIds.filter((id) => id === nodeId).length, 0);
      assert.equal(nodeExcludedIds.filter((id) => id === nodeId).length, 1);
    }
  });

  void it('lets active leaf subgraph nodes finish after successful graph abort without queueing dependents', async () => {
    const slowChildProbe = makeProbeNode('slow-child-probe', {
      delayMs: 50,
      value: { type: 'string', value: 'slow' },
    });
    const slowChildOutput = makeGraphOutputNode('slowChildResult');
    const slowChildGraph = makeGraph(
      [slowChildProbe, slowChildOutput],
      [connect(slowChildProbe.id, slowChildOutput.id, 'value')],
      'slow-child-graph' as GraphId,
    );
    const leafSubgraphNode: ChartNode = {
      id: 'leaf-subgraph-node' as NodeId,
      type: 'subGraph',
      title: 'Leaf Subgraph',
      data: {
        graphId: slowChildGraph.metadata!.id,
        useErrorOutput: false,
        useAsGraphPartialOutput: false,
      },
      visualData: { x: 0, y: 0, width: 240 },
    };
    const abortNode = makeProbeNode('successful-abort-node', {
      delayMs: 5,
      successfulAbortGraph: true,
    });
    const downstreamAfterLeaf = makeProbeNode('downstream-after-leaf');
    const graph = makeGraph(
      [leafSubgraphNode, abortNode, downstreamAfterLeaf],
      [connect(leafSubgraphNode.id, downstreamAfterLeaf.id, 'input', 'slowChildResult')],
      'successful-abort-root' as GraphId,
    );
    const processor = createProcessor(graph, [slowChildGraph]);
    const nodeErrorIds: NodeId[] = [];
    const nodeExcludedById = new Map<NodeId, ProcessEvents['nodeExcluded']>();
    const nodeFinishIds: NodeId[] = [];

    processor.on('nodeError', ({ node }) => nodeErrorIds.push(node.id));
    processor.on('nodeExcluded', (event) => {
      nodeExcludedById.set(event.node.id, event);
    });
    processor.on('nodeFinish', ({ node }) => nodeFinishIds.push(node.id));

    await withTimeout(processor.processGraph(testProcessContext()), 'successful abort with leaf subgraph');

    assert.equal(nodeErrorIds.includes(leafSubgraphNode.id), false);
    assert.equal(nodeErrorIds.includes(slowChildProbe.id), false);
    assert.equal(nodeExcludedById.has(leafSubgraphNode.id), false);
    assert.equal(nodeExcludedById.has(slowChildProbe.id), false);
    assert.equal(nodeFinishIds.includes(leafSubgraphNode.id), true);
    assert.equal(nodeFinishIds.includes(slowChildProbe.id), true);
    assert.equal(nodeFinishIds.includes(slowChildOutput.id), false);
    assert.equal(nodeFinishIds.includes(downstreamAfterLeaf.id), false);
  });

  void it('does not queue dependents from nodes interrupted by successful graph abort', async () => {
    const waitingNode = makeProbeNode('waiting-node', {
      waitForEvent: 'never-raised',
    });
    const abortNode = makeProbeNode('successful-abort-node', {
      delayMs: 5,
      successfulAbortGraph: true,
    });
    const downstreamNode = makeProbeNode('downstream-after-waiting-node');
    const graph = makeGraph(
      [waitingNode, abortNode, downstreamNode],
      [connect(waitingNode.id, downstreamNode.id)],
      'successful-abort-interrupted-node' as GraphId,
    );
    const processor = createProcessor(graph);
    const terminalEventsById = new Map<NodeId, string[]>();

    for (const eventName of ['nodeStart', 'nodeFinish', 'nodeError', 'nodeExcluded'] as const) {
      processor.on(eventName, ({ node }) => {
        terminalEventsById.set(node.id, [...(terminalEventsById.get(node.id) ?? []), eventName]);
      });
    }

    await withTimeout(processor.processGraph(testProcessContext()), 'successful abort with interrupted node');

    assert.deepEqual(terminalEventsById.get(waitingNode.id), ['nodeStart', 'nodeExcluded']);
    assert.deepEqual(terminalEventsById.get(downstreamNode.id), undefined);
  });

  void it('does not process queued parallel split-run items after successful graph abort', async () => {
    const inputNode = makeProbeNode('split-input', {
      value: { type: 'string[]', value: ['a', 'b', 'c', 'd', 'e'] },
    });
    const splitNode = makeProbeNode('parallel-split-node', {
      delayMs: 30,
    });
    splitNode.isSplitRun = true;
    splitNode.isSplitSequential = false;
    splitNode.splitRunMax = 5;
    splitNode.splitRunConcurrency = 2;
    const abortNode = makeProbeNode('successful-abort-node', {
      delayMs: 5,
      successfulAbortGraph: true,
    });
    const graph = makeGraph(
      [inputNode, splitNode, abortNode],
      [connect(inputNode.id, splitNode.id)],
      'successful-abort-split-run' as GraphId,
    );
    const processor = createProcessor(graph);
    const splitNodeExcluded = new Promise<ProcessEvents['nodeExcluded']>((resolve) => {
      processor.on('nodeExcluded', (event) => {
        if (event.node.id === splitNode.id) {
          resolve(event);
        }
      });
    });
    const splitNodeFinishIds: NodeId[] = [];

    processor.on('nodeFinish', ({ node }) => {
      if (node.id === splitNode.id) {
        splitNodeFinishIds.push(node.id);
      }
    });

    await withTimeout(processor.processGraph(testProcessContext()), 'successful abort with parallel split-run');
    const excludedEvent = await withTimeout(splitNodeExcluded, 'parallel split-run successful-abort exclusion');

    assert.equal(excludedEvent.reason, 'Graph aborted successfully');
    assert.deepEqual(splitNodeFinishIds, []);
  });

  void it('does not abort active non-race nodes whose ids share a race loser prefix', async () => {
    const slowNode = makeProbeNode('slow-node', {
      delayMs: 50,
      value: { type: 'string', value: 'slow' },
    });
    const unrelatedNode = makeProbeNode('slow-node-extra', {
      delayMs: 75,
      value: { type: 'string', value: 'unrelated' },
    });
    const fastNode = makeProbeNode('fast-node', {
      value: { type: 'string', value: 'fast' },
    });
    const raceNode: ChartNode = {
      id: 'race-node' as NodeId,
      type: 'raceInputs',
      title: 'Race Inputs',
      data: {},
      visualData: { x: 250, y: 0, width: 240 },
    };
    const graph = makeGraph(
      [slowNode, unrelatedNode, fastNode, raceNode],
      [connect('slow-node', raceNode.id, 'input1'), connect('fast-node', raceNode.id, 'input2')],
    );
    const processor = createProcessor(graph);
    const nodeErrors: NodeId[] = [];
    const nodeExcluded: NodeId[] = [];
    const nodeFinishes: NodeId[] = [];

    processor.on('nodeError', ({ node }) => nodeErrors.push(node.id));
    processor.on('nodeExcluded', ({ node }) => nodeExcluded.push(node.id));
    processor.on('nodeFinish', ({ node }) => nodeFinishes.push(node.id));

    await withTimeout(processor.processGraph(testProcessContext()), 'race graph run with prefix node');

    assert.equal(nodeErrors.includes(slowNode.id), false);
    assert.equal(nodeExcluded.includes(slowNode.id), true);
    assert.equal(nodeErrors.includes(unrelatedNode.id), false);
    assert.equal(nodeFinishes.includes(unrelatedNode.id), true);
  });
});
