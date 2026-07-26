import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  type ExternalFunctionProcessContext,
  type GraphId,
  type NodeId,
  type NodeGraph,
  type Project,
  type ProjectId,
  type TextNode,
  type ExtractJsonNode,
  type GraphInputNode,
  type GraphOutputNode,
  type SubGraphNode,
} from '@valerypopoff/rivet2-core';
import {
  buildAiGraphBuilderExternalFunctions,
  parseAiGraphBuilderEditNodeArgs,
  resolveAiGraphBuilderNodeDataKey,
  resolveAiGraphBuilderNodeType,
} from './aiGraphBuilderHelpers';
import { createGraphBuilderAuthoringCatalog } from '../features/graphBuilder/authoringCatalog';

function createCatalog(registry: ReturnType<typeof createBuiltInRegistry>, project: Project) {
  return createGraphBuilderAuthoringCatalog({
    registry,
    project,
    referencedProjects: {},
  });
}

test('resolveAiGraphBuilderNodeType accepts model-friendly node type labels', () => {
  const registry = createBuiltInRegistry();

  assert.equal(resolveAiGraphBuilderNodeType(registry, 'text'), 'text');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'Text'), 'text');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'Text node'), 'text');
  assert.equal(resolveAiGraphBuilderNodeType(registry, '"text"'), 'text');
  assert.equal(resolveAiGraphBuilderNodeType(registry, '```text\ntext\n```'), 'text');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'Extract JSON'), 'extractJson');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'Code node'), 'codeNew');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'Chat node'), 'llmChatV2');
  assert.equal(resolveAiGraphBuilderNodeType(registry, 'OpenAI Chat'), 'llmChatV2');
  assert.equal(resolveAiGraphBuilderNodeType(registry, { nodeType: 'LLMChatV2Node' }), 'llmChatV2');
});

test('createNode normalizes model-friendly node type labels before creating nodes', async () => {
  const registry = createBuiltInRegistry();
  let workingGraph: NodeGraph = {
    metadata: { id: 'graph-1' as GraphId, name: 'Graph', description: '' },
    nodes: [],
    connections: [],
  };

  const project = {
    metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
    graphs: { [workingGraph.metadata!.id!]: workingGraph },
    plugins: [],
  } as Project;
  const helpers = buildAiGraphBuilderExternalFunctions({
    project,
    referencedProjects: {},
    registry,
    catalog: createCatalog(registry, project),
    showChanges: () => {},
    workingGraph: () => workingGraph,
    setWorkingGraph: (nextGraph) => {
      workingGraph = nextGraph;
    },
  });

  const result = (await helpers.createNode?.({} as ExternalFunctionProcessContext, 'Text node')) as {
    type: 'string';
    value: NodeId;
  };

  assert.equal(result.type, 'string');
  assert.equal(workingGraph.nodes.length, 1);
  assert.equal(workingGraph.nodes[0]?.id, result.value);
  assert.equal(workingGraph.nodes[0]?.type, 'text');
});

test('createNode keeps working after app state freezes a published graph snapshot', async () => {
  const registry = createBuiltInRegistry();
  let workingGraph: NodeGraph = {
    metadata: { id: 'graph-1' as GraphId, name: 'Graph', description: '' },
    nodes: [],
    connections: [],
  };

  const project = {
    metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
    graphs: { [workingGraph.metadata!.id!]: workingGraph },
    plugins: [],
  } as Project;
  const helpers = buildAiGraphBuilderExternalFunctions({
    project,
    referencedProjects: {},
    registry,
    catalog: createCatalog(registry, project),
    showChanges: () => {
      Object.freeze(workingGraph.nodes);
      Object.freeze(workingGraph.connections);
      Object.freeze(workingGraph);
    },
    workingGraph: () => workingGraph,
    setWorkingGraph: (nextGraph) => {
      workingGraph = nextGraph;
    },
  });

  await helpers.createNode?.({} as ExternalFunctionProcessContext, 'Text');
  await helpers.createNode?.({} as ExternalFunctionProcessContext, 'Chat');

  assert.equal(workingGraph.nodes.length, 2);
  assert.equal(workingGraph.nodes[0]?.type, 'text');
  assert.equal(workingGraph.nodes[1]?.type, 'llmChatV2');
});

test('AI graph builder edit helpers accept object-shaped calls and data path keys', () => {
  assert.deepEqual(parseAiGraphBuilderEditNodeArgs({ nodeId: 'node-a', key: 'data.text', value: 'Hello' }), {
    nodeId: 'node-a',
    key: 'data.text',
    value: 'Hello',
  });

  assert.equal(resolveAiGraphBuilderNodeDataKey({ text: '' }, 'data.text'), 'text');
  assert.equal(resolveAiGraphBuilderNodeDataKey({ text: '' }, 'node.data["text"]'), 'text');
  assert.equal(resolveAiGraphBuilderNodeDataKey({ jsonTemplate: '' }, '$.data.jsonTemplate'), 'jsonTemplate');
  assert.throws(() => resolveAiGraphBuilderNodeDataKey({}, 'constructor'), /does not exist on node data/);
});

test('getPorts only reports connections that belong to the requested node', async () => {
  const registry = createBuiltInRegistry();
  let workingGraph: NodeGraph = {
    metadata: { id: 'graph-1' as GraphId, name: 'Graph', description: '' },
    nodes: [],
    connections: [],
  };

  const nodeA = registry.createDynamic('text') as TextNode;
  nodeA.id = 'node-a' as any;
  nodeA.data.text = '{{input}}';

  const nodeB = registry.createDynamic('text') as TextNode;
  nodeB.id = 'node-b' as any;
  nodeB.data.text = '{{input}}';

  const nodeC = registry.createDynamic('extractJson') as ExtractJsonNode;
  nodeC.id = 'node-c' as any;

  const nodeD = registry.createDynamic('extractJson') as ExtractJsonNode;
  nodeD.id = 'node-d' as any;

  const context = {} as ExternalFunctionProcessContext;

  workingGraph = {
    ...workingGraph,
    nodes: [nodeA, nodeB, nodeC, nodeD],
    connections: [
      {
        outputNodeId: nodeA.id,
        outputId: 'output' as any,
        inputNodeId: nodeC.id,
        inputId: 'input' as any,
      },
      {
        outputNodeId: nodeB.id,
        outputId: 'output' as any,
        inputNodeId: nodeD.id,
        inputId: 'input' as any,
      },
    ],
  };

  const project = {
    metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
    graphs: { [workingGraph.metadata!.id!]: workingGraph },
    plugins: [],
  } as Project;
  const helpers = buildAiGraphBuilderExternalFunctions({
    project,
    referencedProjects: {},
    registry,
    catalog: createCatalog(registry, project),
    showChanges: () => {},
    workingGraph: () => workingGraph,
    setWorkingGraph: (nextGraph) => {
      workingGraph = nextGraph;
    },
  });

  const ports = (await helpers.getPorts?.(context, nodeC.id)) as { type: 'object'; value: any };
  const inputPort = ports.value.inputs.find((input: any) => input.definition.id === 'input');

  assert.equal(inputPort.connectedTo.outputNodeId, nodeA.id);
  assert.equal(inputPort.connectedTo.inputNodeId, nodeC.id);

  const outputPorts = (await helpers.getPorts?.(context, nodeA.id)) as { type: 'object'; value: any };
  const outputPort = outputPorts.value.outputs.find((output: any) => output.definition.id === 'output');

  assert.equal(outputPort.connectedTo.length, 1);
  assert.equal(outputPort.connectedTo[0].inputNodeId, nodeC.id);
});

test('getPorts includes built-in conditional inputs and uses the supplied authoring project', async () => {
  const registry = createBuiltInRegistry();
  const activeGraphId = 'graph-active' as GraphId;
  const targetGraphId = 'graph-target' as GraphId;
  const conditionalNode = registry.createDynamic('text') as TextNode;
  conditionalNode.id = 'conditional' as NodeId;
  conditionalNode.isConditional = true;

  const subGraphNode = registry.createDynamic('subGraph') as SubGraphNode;
  subGraphNode.id = 'subgraph' as NodeId;
  subGraphNode.data.graphId = targetGraphId;

  const graphInput = registry.createDynamic('graphInput') as GraphInputNode;
  graphInput.data.id = 'question';
  const graphOutput = registry.createDynamic('graphOutput') as GraphOutputNode;
  graphOutput.data.id = 'answer';

  let workingGraph: NodeGraph = {
    metadata: { id: activeGraphId, name: 'Active', description: '' },
    nodes: [conditionalNode, subGraphNode],
    connections: [],
  };
  const project: Project = {
    metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
    graphs: {
      [activeGraphId]: workingGraph,
      [targetGraphId]: {
        metadata: { id: targetGraphId, name: 'Target', description: '' },
        nodes: [graphInput, graphOutput],
        connections: [],
      },
    },
  };
  const helpers = buildAiGraphBuilderExternalFunctions({
    project: () => project,
    referencedProjects: {},
    registry,
    catalog: createCatalog(registry, project),
    showChanges: () => {},
    workingGraph: () => workingGraph,
    setWorkingGraph: (nextGraph) => {
      workingGraph = nextGraph;
    },
  });

  const conditionalPorts = (await helpers.getPorts?.({} as ExternalFunctionProcessContext, conditionalNode.id)) as {
    value: { inputs: Array<{ definition: { id: string } }> };
  };
  const subGraphPorts = (await helpers.getPorts?.({} as ExternalFunctionProcessContext, subGraphNode.id)) as {
    value: {
      inputs: Array<{ definition: { id: string } }>;
      outputs: Array<{ definition: { id: string } }>;
    };
  };

  assert.ok(conditionalPorts.value.inputs.some((input) => input.definition.id === '$if'));
  assert.ok(subGraphPorts.value.inputs.some((input) => input.definition.id === 'question'));
  assert.ok(subGraphPorts.value.outputs.some((output) => output.definition.id === 'answer'));
});

test('connectNodes rejects incompatible port types through shared editor compatibility', async () => {
  const registry = createBuiltInRegistry();
  const sourceNode = registry.createDynamic('text') as TextNode;
  sourceNode.id = 'source' as NodeId;
  const outputNode = registry.createDynamic('graphOutput') as GraphOutputNode;
  outputNode.id = 'output' as NodeId;
  outputNode.data.dataType = 'binary';

  let workingGraph: NodeGraph = {
    metadata: { id: 'graph-1' as GraphId, name: 'Graph', description: '' },
    nodes: [sourceNode, outputNode],
    connections: [],
  };
  const project: Project = {
    metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
    graphs: { [workingGraph.metadata!.id!]: workingGraph },
  };
  const helpers = buildAiGraphBuilderExternalFunctions({
    project,
    referencedProjects: {},
    registry,
    catalog: createCatalog(registry, project),
    showChanges: () => {},
    workingGraph: () => workingGraph,
    setWorkingGraph: (nextGraph) => {
      workingGraph = nextGraph;
    },
  });

  await assert.rejects(
    () =>
      helpers.connectNodes!({} as ExternalFunctionProcessContext, {
        sourceNodeId: sourceNode.id,
        sourcePortId: 'output',
        destNodeId: outputNode.id,
        destPortId: 'value',
      }),
    /is not compatible/,
  );
  assert.equal(workingGraph.connections.length, 0);
});
