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
} from '@valerypopoff/rivet2-core';
import {
  buildAiGraphBuilderExternalFunctions,
  parseAiGraphBuilderEditNodeArgs,
  resolveAiGraphBuilderNodeDataKey,
  resolveAiGraphBuilderNodeType,
} from './aiGraphBuilderHelpers';

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

  const helpers = buildAiGraphBuilderExternalFunctions({
    project: {
      metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
      graphs: {},
      plugins: [],
    } as Project,
    referencedProjects: {},
    registry,
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

  const helpers = buildAiGraphBuilderExternalFunctions({
    project: {
      metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
      graphs: {},
      plugins: [],
    } as Project,
    referencedProjects: {},
    registry,
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

  const helpers = buildAiGraphBuilderExternalFunctions({
    project: {
      metadata: { id: 'project-1' as ProjectId, title: 'Project', description: '' },
      graphs: {},
      plugins: [],
    } as Project,
    referencedProjects: {},
    registry,
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
