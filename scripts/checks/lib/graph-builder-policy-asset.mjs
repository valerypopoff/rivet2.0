import { createHash } from 'node:crypto';
import {
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  LLMChatV2NodeImpl,
  TextNodeImpl,
} from '../../../packages/core/src/index.ts';
import {
  GRAPH_BUILDER_POLICY_SYSTEM_PROMPT,
  normalizeGraphBuilderPolicyPrompt,
} from '../../../packages/app/src/features/graphBuilder/policyPrompt.ts';
import {
  GRAPH_BUILDER_POLICY_ASSET_PATH,
  GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS,
  GRAPH_BUILDER_POLICY_IDS,
  GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_SEALED_EMPTY_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_SEALED_FALSE_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_VERSION,
} from '../../../packages/app/src/features/graphBuilder/policyAssetContract.ts';

export { GRAPH_BUILDER_POLICY_ASSET_PATH, GRAPH_BUILDER_POLICY_IDS };
export const GRAPH_BUILDER_POLICY_MANIFEST_PATH = 'packages/app/graphs/graph-builder-policy.manifest.json';

export { GRAPH_BUILDER_POLICY_SYSTEM_PROMPT, normalizeGraphBuilderPolicyPrompt };

const EXPECTED_NODE_TYPES = Object.freeze({
  schema: ['graphInput', 'graphInput', 'text', 'llmChatV2', 'graphOutput'],
  text: ['graphInput', 'text', 'llmChatV2', 'graphOutput'],
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function withIdentity(node, id, title, x, y) {
  return {
    ...node,
    id,
    title,
    visualData: {
      ...node.visualData,
      x,
      y,
    },
  };
}

function createPolicyTurnInput(id, x, y) {
  const node = withIdentity(GraphInputNodeImpl.create(), id, 'Policy Turn', x, y);
  node.data = {
    id: 'policyTurn',
    dataType: 'string',
    useDefaultValueInput: false,
  };
  return node;
}

function createResponseSchemaInput(id, x, y) {
  const node = withIdentity(GraphInputNodeImpl.create(), id, 'Response Schema', x, y);
  node.data = {
    id: 'responseSchema',
    dataType: 'object',
    useDefaultValueInput: false,
  };
  return node;
}

function createSystemPromptNode(id, x, y) {
  const node = withIdentity(TextNodeImpl.create(), id, 'Graph Builder Policy', x, y);
  node.data = {
    text: GRAPH_BUILDER_POLICY_SYSTEM_PROMPT,
    normalizeLineEndings: true,
  };
  return node;
}

function createPolicyLlmNode(id, responseFormat, x, y) {
  const node = withIdentity(LLMChatV2NodeImpl.create(), id, 'Policy Decision', x, y);
  node.data = {
    ...node.data,
    configurationMode: 'inline',
    provider: 'openai',
    model: 'gpt-5',
    apiKeySource: 'environment',
    customProviderApiKeyEnvVarName: '',
    temperature: 0,
    maxTokens: 32_768,
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

function createDecisionOutput(id, dataType, x, y) {
  const node = withIdentity(GraphOutputNodeImpl.create(), id, 'Decision', x, y);
  node.data = {
    id: 'decision',
    dataType,
  };
  return node;
}

function connection(outputNodeId, outputId, inputNodeId, inputId) {
  return { outputNodeId, outputId, inputNodeId, inputId };
}

function createSchemaGraph() {
  const ids = GRAPH_BUILDER_POLICY_IDS.schema;
  return {
    metadata: {
      id: ids.graph,
      name: 'Policy Decision (Schema)',
      description: 'Graph Builder policy decision with a host-supplied JSON Schema.',
    },
    nodes: [
      createPolicyTurnInput(ids.policyTurnInput, 0, 140),
      createResponseSchemaInput(ids.responseSchemaInput, 0, 340),
      createSystemPromptNode(ids.systemPrompt, 420, 0),
      createPolicyLlmNode(ids.llm, 'json_schema', 850, 180),
      createDecisionOutput(ids.decisionOutput, 'any', 1280, 180),
    ],
    connections: GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS.schema.map(
      ([outputNodeId, outputId, inputNodeId, inputId]) => connection(outputNodeId, outputId, inputNodeId, inputId),
    ),
  };
}

function createTextGraph() {
  const ids = GRAPH_BUILDER_POLICY_IDS.text;
  return {
    metadata: {
      id: ids.graph,
      name: 'Policy Decision (Text)',
      description: 'Graph Builder policy decision for conservative host-side JSON extraction.',
    },
    nodes: [
      createPolicyTurnInput(ids.policyTurnInput, 0, 240),
      createSystemPromptNode(ids.systemPrompt, 420, 0),
      createPolicyLlmNode(ids.llm, '', 850, 180),
      createDecisionOutput(ids.decisionOutput, 'string', 1280, 180),
    ],
    connections: GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS.text.map(([outputNodeId, outputId, inputNodeId, inputId]) =>
      connection(outputNodeId, outputId, inputNodeId, inputId),
    ),
  };
}

export function buildGraphBuilderPolicyProject() {
  const schemaGraph = createSchemaGraph();
  const textGraph = createTextGraph();
  return {
    metadata: {
      id: GRAPH_BUILDER_POLICY_IDS.project,
      title: 'Graph Builder Policy',
      description: 'Checked model-policy workflows for Graph Builder Plan B.',
    },
    graphs: {
      [schemaGraph.metadata.id]: schemaGraph,
      [textGraph.metadata.id]: textGraph,
    },
    plugins: [],
    references: [],
  };
}

export function buildGraphBuilderPolicyManifest() {
  return {
    version: 1,
    policyVersion: GRAPH_BUILDER_POLICY_VERSION,
    assetPath: GRAPH_BUILDER_POLICY_ASSET_PATH,
    projectId: GRAPH_BUILDER_POLICY_IDS.project,
    normalizedPromptSha256: sha256(normalizeGraphBuilderPolicyPrompt(GRAPH_BUILDER_POLICY_SYSTEM_PROMPT)),
    allowedInjectedLlmDataKeys: [...GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS],
    variants: {
      schema: {
        graphId: GRAPH_BUILDER_POLICY_IDS.schema.graph,
        llmNodeId: GRAPH_BUILDER_POLICY_IDS.schema.llm,
        policyTurnInputNodeId: GRAPH_BUILDER_POLICY_IDS.schema.policyTurnInput,
        responseSchemaInputNodeId: GRAPH_BUILDER_POLICY_IDS.schema.responseSchemaInput,
        decisionOutputNodeId: GRAPH_BUILDER_POLICY_IDS.schema.decisionOutput,
        responseFormat: 'json_schema',
      },
      text: {
        graphId: GRAPH_BUILDER_POLICY_IDS.text.graph,
        llmNodeId: GRAPH_BUILDER_POLICY_IDS.text.llm,
        policyTurnInputNodeId: GRAPH_BUILDER_POLICY_IDS.text.policyTurnInput,
        decisionOutputNodeId: GRAPH_BUILDER_POLICY_IDS.text.decisionOutput,
        responseFormat: '',
      },
    },
  };
}

function canonicalConnection(value) {
  return [value.outputNodeId, value.outputId, value.inputNodeId, value.inputId];
}

function compareCanonicalValues(left, right) {
  return stableJson(left).localeCompare(stableJson(right));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateManifest(manifest, errors) {
  const expected = buildGraphBuilderPolicyManifest();
  if (stableJson(manifest) !== stableJson(expected)) {
    errors.push('Manifest does not match the checked Graph Builder policy contract.');
  }
}

function findNode(graph, id, type, errors) {
  const node = graph?.nodes?.find((candidate) => candidate.id === id);
  if (!node) {
    errors.push(`Missing node ${id}.`);
    return undefined;
  }
  if (node.type !== type) {
    errors.push(`Node ${id} must have type ${type}, found ${node.type}.`);
  }
  return node;
}

function validateGraphEnvelope(graph, variant, errors) {
  if (!graph) return;
  const expectedTypes = EXPECTED_NODE_TYPES[variant];
  if (stableJson(graph.nodes.map((node) => node.type).sort()) !== stableJson([...expectedTypes].sort())) {
    errors.push(`${variant} variant contains an unexpected node set.`);
  }
  for (const node of graph.nodes) {
    if (
      node.disabled ||
      node.isConditional ||
      node.isSplitRun ||
      node.isSplitSequential ||
      node.splitRunConcurrency != null ||
      (node.variants?.length ?? 0) > 0
    ) {
      errors.push(`${variant} node ${node.id} enables unsupported execution or variant behavior.`);
    }
  }
  const actualConnections = graph.connections.map(canonicalConnection).sort(compareCanonicalValues);
  const expectedConnections = [...GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS[variant]].sort(compareCanonicalValues);
  if (stableJson(actualConnections) !== stableJson(expectedConnections)) {
    errors.push(`${variant} variant connections do not match the checked topology.`);
  }
}

function validateGraphInput(node, expectedId, expectedType, errors) {
  if (!node) return;
  if (
    node.data?.id !== expectedId ||
    node.data?.dataType !== expectedType ||
    node.data?.useDefaultValueInput !== false ||
    node.data?.defaultValue !== undefined
  ) {
    errors.push(`Graph input ${node.id} does not match ${expectedId}:${expectedType}.`);
  }
}

function validateDecisionOutput(node, expectedType, errors) {
  if (!node) return;
  if (node.data?.id !== 'decision' || node.data?.dataType !== expectedType) {
    errors.push(`Graph output ${node.id} must be the sole decision:${expectedType} output.`);
  }
}

function validateLlmNode(node, responseFormat, errors) {
  if (!node) return;
  const data = node.data ?? {};
  if (data.configurationMode !== 'inline') {
    errors.push(`LLM node ${node.id} must use inline configuration.`);
  }
  if (data.apiKeySource !== 'environment') {
    errors.push(`LLM node ${node.id} must resolve credentials from the environment.`);
  }
  for (const key of GRAPH_BUILDER_POLICY_SEALED_FALSE_LLM_DATA_KEYS) {
    if (data[key]) {
      errors.push(`LLM node ${node.id} must keep ${key} disabled.`);
    }
  }
  for (const key of GRAPH_BUILDER_POLICY_SEALED_EMPTY_LLM_DATA_KEYS) {
    if (data[key] !== '') {
      errors.push(`LLM node ${node.id} must keep ${key} empty.`);
    }
  }
  if (!Array.isArray(data.headers) || data.headers.length !== 0) {
    errors.push(`LLM node ${node.id} must not serialize headers.`);
  }
  if (data.responseFormat !== responseFormat) {
    errors.push(`LLM node ${node.id} has the wrong response format.`);
  }
  if (data.retryOnNon200RepeatTimes !== 0 || data.retryOnNon200CooldownMs !== 0) {
    errors.push(`LLM node ${node.id} must not retain lower-level retry settings.`);
  }
  if (data.maxToolRounds !== 1) {
    errors.push(`LLM node ${node.id} must retain the inert single-round tool limit.`);
  }
}

function validateVariant(project, manifest, variant, errors) {
  const config = manifest.variants?.[variant];
  if (!config || typeof config !== 'object') {
    errors.push(`Manifest is missing the ${variant} variant.`);
    return;
  }
  const graph = project.graphs?.[config?.graphId];
  if (!graph) {
    errors.push(`Missing ${variant} policy graph ${config?.graphId ?? '(unknown)'}.`);
    return;
  }

  validateGraphEnvelope(graph, variant, errors);
  const turnInput = findNode(graph, config.policyTurnInputNodeId, 'graphInput', errors);
  const systemPrompt = findNode(
    graph,
    variant === 'schema' ? GRAPH_BUILDER_POLICY_IDS.schema.systemPrompt : GRAPH_BUILDER_POLICY_IDS.text.systemPrompt,
    'text',
    errors,
  );
  const llm = findNode(graph, config.llmNodeId, 'llmChatV2', errors);
  const output = findNode(graph, config.decisionOutputNodeId, 'graphOutput', errors);

  validateGraphInput(turnInput, 'policyTurn', 'string', errors);
  validateDecisionOutput(output, variant === 'text' ? 'string' : 'any', errors);
  validateLlmNode(llm, config.responseFormat, errors);

  if (systemPrompt) {
    const normalizedPrompt = normalizeGraphBuilderPolicyPrompt(String(systemPrompt.data?.text ?? ''));
    if (sha256(normalizedPrompt) !== manifest.normalizedPromptSha256) {
      errors.push(`${variant} variant prompt does not match the checked prompt hash.`);
    }
    if (systemPrompt.data?.normalizeLineEndings !== true) {
      errors.push(`${variant} variant prompt must normalize line endings.`);
    }
  }

  if (variant === 'schema') {
    const schemaInput = findNode(graph, config.responseSchemaInputNodeId, 'graphInput', errors);
    validateGraphInput(schemaInput, 'responseSchema', 'object', errors);
  } else if (
    graph.nodes.some((node) => node.type === 'graphInput' && node.data?.id === 'responseSchema') ||
    graph.connections.some((item) => item.inputNodeId === config.llmNodeId && item.inputId === 'responseSchema')
  ) {
    errors.push('Text variant must not contain a responseSchema input or edge.');
  }
}

export function validateGraphBuilderPolicyAsset(project, manifest) {
  const errors = [];
  validateManifest(manifest, errors);

  if (project.metadata?.id !== manifest.projectId) {
    errors.push('Project ID does not match the policy manifest.');
  }
  if (
    project.data != null ||
    project.nodePrefabs != null ||
    project.uiGraphs != null ||
    project.metadata?.knowledgeStores != null ||
    (project.plugins?.length ?? 0) !== 0 ||
    (project.references?.length ?? 0) !== 0
  ) {
    errors.push('Policy project must not contain data, prefabs, UI graphs, knowledge stores, plugins, or references.');
  }

  const graphIds = Object.keys(project.graphs ?? {}).sort();
  const expectedGraphIds = [manifest.variants?.schema?.graphId, manifest.variants?.text?.graphId]
    .filter((graphId) => typeof graphId === 'string')
    .sort();
  if (stableJson(graphIds) !== stableJson(expectedGraphIds)) {
    errors.push('Policy project must contain exactly the two manifested entry graphs.');
  }

  validateVariant(project, manifest, 'schema', errors);
  validateVariant(project, manifest, 'text', errors);

  const prompts = ['schema', 'text'].map((variant) => {
    const graph = project.graphs?.[manifest.variants?.[variant]?.graphId];
    return graph?.nodes?.find((node) => node.type === 'text')?.data?.text ?? '';
  });
  if (normalizeGraphBuilderPolicyPrompt(prompts[0]) !== normalizeGraphBuilderPolicyPrompt(prompts[1])) {
    errors.push('Schema and text variants must have equivalent normalized prompts.');
  }

  return errors;
}
