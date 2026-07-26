import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBuiltInRegistry,
  deserializeProject,
  type GraphId,
  type Inputs,
  type NodeId,
  type Outputs,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import {
  constrainAiAssistGeneratorToolCallsToOneForLegacyLoop,
  createAiAssistVercelGeneratorChatNodeDefinition,
  normalizeAiAssistGeneratorResponseForTaggedHelper,
} from './aiAssistVercelGenerator.js';

function createProject(): Project {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Project',
      description: '',
    },
    graphs: {
      ['graph' as GraphId]: {
        metadata: {
          id: 'graph' as GraphId,
          name: 'Graph',
        },
        nodes: [
          {
            id: 'text' as NodeId,
            type: 'text',
            title: 'Text',
            visualData: { x: 0, y: 0 },
            data: { text: 'hello' },
          },
        ],
        connections: [],
      },
    },
  };
}

function createTaggedPromptInputs(message: string): Inputs {
  return {
    ['prompt' as PortId]: {
      type: 'chat-message',
      value: {
        type: 'user',
        message,
      },
    },
  };
}

function readBundledGraph(name: string): Project {
  const projectText = readFileSync(fileURLToPath(new URL(`../../graphs/${name}`, import.meta.url)), 'utf8');
  const [project] = deserializeProject(projectText);
  return project;
}

test('bundled AI assist generator graphs store Vercel adapter nodes directly', () => {
  const project = readBundledGraph('code-node-generator.rivet-project');
  const nodes = Object.values(project.graphs).flatMap((graph) => graph.nodes);
  const adapterNodes = nodes.filter((node) => node.type === 'aiAssistGeneratorChatV2');

  assert.equal(
    nodes.some((node) => node.type === 'chat' || node.type === 'chatAnthropic'),
    false,
  );
  assert.equal(adapterNodes.length, 2);
  assert.deepEqual(
    adapterNodes.map((node) => (node.data as Record<string, unknown>).aiAssistGeneratorChatBranch).sort(),
    ['anthropic', 'openaiCompatible'],
  );
  assert.equal(
    adapterNodes.some((node) => 'aiAssistGeneratorChatSourceType' in (node.data as Record<string, unknown>)),
    false,
  );
});

test('bundled AI graph creator graph stores Vercel adapter nodes directly', () => {
  const project = readBundledGraph('graph-creator.rivet-project');
  const nodes = Object.values(project.graphs).flatMap((graph) => graph.nodes);
  const adapterNodes = nodes.filter((node) => node.type === 'aiAssistGeneratorChatV2');
  const functionNodes = nodes.filter((node) => node.type === 'gptFunction');
  const deleteNodeFunction = functionNodes.find((node) => (node.data as Record<string, unknown>).name === 'deleteNode');
  const deleteNodeSchema = JSON.parse(
    String((deleteNodeFunction?.data as Record<string, unknown> | undefined)?.schema ?? '{}'),
  );

  assert.equal(
    nodes.some((node) => node.type === 'chat' || node.type === 'chatAnthropic'),
    false,
  );
  assert.equal(adapterNodes.length, 2);
  assert.deepEqual(
    adapterNodes.map((node) => (node.data as Record<string, unknown>).aiAssistGeneratorChatBranch).sort(),
    ['anthropic', 'openaiCompatible'],
  );
  assert.equal(
    adapterNodes.every((node) =>
      Object.keys(node.data as Record<string, unknown>).every((key) =>
        ['aiAssistGeneratorChatBranch', 'maxTokens'].includes(key),
      ),
    ),
    true,
  );
  assert.deepEqual(deleteNodeSchema.required, ['nodeId']);
  assert.equal('data' in deleteNodeSchema.properties, false);
});

test('legacy graph creator asset has no repository discovery or nested research agents', () => {
  const project = readBundledGraph('graph-creator.rivet-project');
  const graphs = Object.values(project.graphs);
  const graphNames = graphs.map((graph) => graph.metadata?.name);
  const nodes = graphs.flatMap((graph) => graph.nodes);
  const functionNames = nodes
    .filter((node) => node.type === 'gptFunction')
    .map((node) => String((node.data as Record<string, unknown>).name));

  assert.equal(
    nodes.some((node) => node.type === 'readDirectory' || node.type === 'readAllFiles'),
    false,
  );
  assert.equal(
    nodes.some(
      (node) => node.type === 'externalCall' && (node.data as Record<string, unknown>).functionName === 'showChanges',
    ),
    false,
  );
  for (const removedName of [
    'Function: addNodeData',
    'Function: brainstorm',
    'Function: plan',
    'Function: readNodeDocumentation',
    'Function: readNodeSourceCode',
    'Load Node Documentation Files',
    'Load Node Source Code',
  ]) {
    assert.equal(graphNames.includes(removedName), false);
  }
  for (const removedFunction of ['addNodeData', 'brainstorm', 'plan', 'readNodeDocumentation', 'readNodeSourceCode']) {
    assert.equal(functionNames.includes(removedFunction), false);
  }
});

test('legacy graph creator asset has valid live input and output ports on every connection', () => {
  const project = readBundledGraph('graph-creator.rivet-project');
  const registry = createBuiltInRegistry();
  registry.register(
    createAiAssistVercelGeneratorChatNodeDefinition({
      displayName: 'Test model',
      generatorBranch: 'openai',
      model: 'test-model',
      provider: 'openai',
    }),
  );

  for (const graph of Object.values(project.graphs)) {
    const nodesById = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    for (const connection of graph.connections) {
      const source = nodesById[connection.outputNodeId];
      const destination = nodesById[connection.inputNodeId];
      assert.ok(source, `${graph.metadata?.name}: missing source ${connection.outputNodeId}`);
      assert.ok(destination, `${graph.metadata?.name}: missing destination ${connection.inputNodeId}`);
      const sourceImpl = registry.createDynamicImpl(source);
      const destinationImpl = registry.createDynamicImpl(destination);
      const sourceConnections = graph.connections.filter(
        (candidate) => candidate.outputNodeId === source.id || candidate.inputNodeId === source.id,
      );
      const destinationConnections = graph.connections.filter(
        (candidate) => candidate.outputNodeId === destination.id || candidate.inputNodeId === destination.id,
      );
      const outputs = sourceImpl.getOutputDefinitions(sourceConnections, nodesById, project, {});
      const inputs = destinationImpl.getInputDefinitionsIncludingBuiltIn(
        destinationConnections,
        nodesById,
        project,
        {},
      );
      assert.ok(
        outputs.some((port) => port.id === connection.outputId),
        `${graph.metadata?.name}: missing output ${source.id}.${connection.outputId}`,
      );
      assert.ok(
        inputs.some((port) => port.id === connection.inputId),
        `${graph.metadata?.name}: missing input ${destination.id}.${connection.inputId}`,
      );
    }
  }
});

test('AI assist generator Vercel adapter preserves the legacy generator graph port contract', () => {
  const definition = createAiAssistVercelGeneratorChatNodeDefinition({
    displayName: 'GPT-5',
    generatorBranch: 'openai',
    model: 'gpt-5',
    provider: 'openai',
  });
  const node = definition.impl.create();
  const impl = new definition.impl(node, undefined);

  const inputIds = impl.getInputDefinitions([], {}, createProject(), {}).map((input) => input.id);
  const outputIds = impl.getOutputDefinitions([], {}, createProject(), {}).map((output) => output.id);

  assert.deepEqual(
    inputIds.filter((id) => ['prompt', 'systemPrompt', 'system', 'model', 'functions', 'tools'].includes(id)),
    ['systemPrompt', 'system', 'model', 'prompt', 'functions', 'tools'],
  );
  assert.equal(
    inputIds.some((id) => ['temperature', 'top_p', 'useTopP'].includes(id)),
    false,
  );
  assert.deepEqual(outputIds, ['response', 'function-calls', 'all-messages']);
});

test('AI assist generator adapter owns the Vercel SDK path instead of legacy chat transport', () => {
  const source = readFileSync(fileURLToPath(new URL('./aiAssistVercelGenerator.ts', import.meta.url)), 'utf8');

  assert.match(source, /runChatV2Pipeline/);
  assert.match(source, /createResolvedChatV2Provider/);
  assert.match(source, /emitPartialOutputs: false/);
  assert.match(source, /getInputRawString\(inputs, 'stop'\)/);
  assert.match(source, /parallelToolCalls: false/);
  assert.doesNotMatch(source, /temperature:\s*getTemperature/);
  assert.doesNotMatch(source, /topP:\s*getTopP/);
  assert.doesNotMatch(source, /streamChatCompletions/);
  assert.doesNotMatch(source, /openAiCompatibleBaseURLToChatEndpoint/);
});

test('AI assist generator adapter preserves the legacy graph builder one-tool-call loop contract', () => {
  const outputs: Outputs = {
    ['function-calls' as PortId]: {
      type: 'object[]',
      value: [
        { name: 'updateUser', arguments: { message: 'Working' }, id: 'call-1' },
        { name: 'plan', arguments: { plan: 'Next' }, id: 'call-2' },
      ],
    },
    ['all-messages' as PortId]: {
      type: 'chat-message[]',
      value: [
        {
          type: 'assistant',
          message: '',
          function_call: undefined,
          function_calls: [
            { name: 'updateUser', arguments: '{"message":"Working"}', id: 'call-1' },
            { name: 'plan', arguments: '{"plan":"Next"}', id: 'call-2' },
          ],
        },
      ],
    },
  };

  constrainAiAssistGeneratorToolCallsToOneForLegacyLoop(outputs);

  assert.deepEqual(outputs['function-calls' as PortId], {
    type: 'object[]',
    value: [{ name: 'updateUser', arguments: { message: 'Working' }, id: 'call-1' }],
  });
  assert.deepEqual(outputs['all-messages' as PortId], {
    type: 'chat-message[]',
    value: [
      {
        type: 'assistant',
        message: '',
        function_call: { name: 'updateUser', arguments: '{"message":"Working"}', id: 'call-1' },
        function_calls: [{ name: 'updateUser', arguments: '{"message":"Working"}', id: 'call-1' }],
      },
    ],
  });
});

test('AI assist generator wraps plain text for tagged response helper graphs', () => {
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Generated text',
      createTaggedPromptInputs('Return the result inside <answer> tags. Close with </answer>.'),
    ),
    '<answer>Generated text</answer>',
  );
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Prompt instructions',
      createTaggedPromptInputs('Write the prompt inside <Instructions> tags and close with </Instructions>.'),
    ),
    '<Instructions>Prompt instructions</Instructions>',
  );
});

test('AI assist generator leaves already-tagged or untagged-contract responses alone', () => {
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      '<answer>Already wrapped</answer>',
      createTaggedPromptInputs('Return the result inside <answer> tags. Close with </answer>.'),
    ),
    '<answer>Already wrapped</answer>',
  );
  assert.equal(
    normalizeAiAssistGeneratorResponseForTaggedHelper(
      'Plain response',
      createTaggedPromptInputs('Return a plain response.'),
    ),
    'Plain response',
  );
});
