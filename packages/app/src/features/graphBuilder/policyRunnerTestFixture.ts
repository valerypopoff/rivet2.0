import {
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  LLMChatV2NodeImpl,
  TextNodeImpl,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { GRAPH_BUILDER_POLICY_MANIFEST } from './policyManifest.js';
import { GRAPH_BUILDER_POLICY_SYSTEM_PROMPT } from './policyPrompt.js';

/**
 * Creates an in-memory policy project for runner tests. Asset freshness and
 * exact prompt content belong to check-graph-builder-policy; runtime tests
 * should not read repository files.
 */
export function createGraphBuilderPolicyTestProject(): Project {
  const schema = GRAPH_BUILDER_POLICY_MANIFEST.variants.schema;
  const text = GRAPH_BUILDER_POLICY_MANIFEST.variants.text;
  const schemaGraph = {
    metadata: {
      id: schema.graphId as GraphId,
      name: 'Policy Decision (Schema)',
      description: 'Synthetic Graph Builder schema-policy test graph.',
    },
    nodes: [
      createGraphInput(schema.policyTurnInputNodeId, 'policyTurn', 'string'),
      createGraphInput(schema.responseSchemaInputNodeId!, 'responseSchema', 'object'),
      createSystemPrompt('gbps-system-prompt'),
      createLlmNode(schema.llmNodeId, 'json_schema'),
      createGraphOutput(schema.decisionOutputNodeId),
    ],
    connections: [
      connection(schema.policyTurnInputNodeId, 'data', schema.llmNodeId, 'prompt'),
      connection(schema.responseSchemaInputNodeId!, 'data', schema.llmNodeId, 'responseSchema'),
      connection('gbps-system-prompt', 'output', schema.llmNodeId, 'systemPrompt'),
      connection(schema.llmNodeId, 'response', schema.decisionOutputNodeId, 'value'),
    ],
  };
  const textGraph = {
    metadata: {
      id: text.graphId as GraphId,
      name: 'Policy Decision (Text)',
      description: 'Synthetic Graph Builder text-policy test graph.',
    },
    nodes: [
      createGraphInput(text.policyTurnInputNodeId, 'policyTurn', 'string'),
      createSystemPrompt('gbpt-system-prompt'),
      createLlmNode(text.llmNodeId, ''),
      createGraphOutput(text.decisionOutputNodeId),
    ],
    connections: [
      connection(text.policyTurnInputNodeId, 'data', text.llmNodeId, 'prompt'),
      connection('gbpt-system-prompt', 'output', text.llmNodeId, 'systemPrompt'),
      connection(text.llmNodeId, 'response', text.decisionOutputNodeId, 'value'),
    ],
  };

  return {
    metadata: {
      id: GRAPH_BUILDER_POLICY_MANIFEST.projectId as ProjectId,
      title: 'Graph Builder Policy Test Fixture',
      description: 'In-memory fixture for policy runner tests.',
    },
    graphs: {
      [schemaGraph.metadata.id]: schemaGraph,
      [textGraph.metadata.id]: textGraph,
    },
    plugins: [],
    references: [],
  };
}

function withIdentity<T extends ChartNode>(node: T, id: string, title: string): T {
  return {
    ...node,
    id: id as NodeId,
    title,
  };
}

function createGraphInput(id: string, inputId: string, dataType: 'object' | 'string') {
  const node = withIdentity(GraphInputNodeImpl.create(), id, inputId);
  node.data = {
    id: inputId,
    dataType,
    useDefaultValueInput: false,
  };
  return node;
}

function createSystemPrompt(id: string) {
  const textNode = withIdentity(TextNodeImpl.create(), id, 'Graph Builder Policy');
  textNode.data = {
    text: GRAPH_BUILDER_POLICY_SYSTEM_PROMPT,
    normalizeLineEndings: true,
  };
  return textNode;
}

function createLlmNode(id: string, responseFormat: 'json_schema' | '') {
  const node = withIdentity(LLMChatV2NodeImpl.create(), id, 'Policy Decision');
  node.data = {
    ...node.data,
    configurationMode: 'inline',
    provider: 'openai',
    model: 'graph-builder-policy-test-model',
    apiKeySource: 'environment',
    customProviderApiKeyEnvVarName: '',
    temperature: 0,
    maxTokens: 8_192,
    responseFormat,
    responseSchemaName: responseFormat === 'json_schema' ? 'graph_builder_decision' : '',
    responseSchemaDescription:
      responseFormat === 'json_schema' ? 'One GraphBuilderDecision for the current policy turn.' : '',
    useAsGraphPartialOutput: false,
    retryOnNon200: false,
    retryOnNon200RepeatTimes: 0,
    retryOnNon200CooldownMs: 0,
    maxToolRounds: 1,
  };
  return node;
}

function createGraphOutput(id: string) {
  const node = withIdentity(GraphOutputNodeImpl.create(), id, 'Decision');
  node.data = {
    id: 'decision',
    dataType: 'any',
  };
  return node;
}

function connection(outputNodeId: string, outputId: string, inputNodeId: string, inputId: string): NodeConnection {
  return {
    outputNodeId: outputNodeId as NodeId,
    outputId: outputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    inputId: inputId as PortId,
  };
}
