import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  coreRunGraph,
  deserializeProject,
  loadProjectFromString,
  serializeProject,
  validateProjectUiGraphActionBindings,
  type AssemblePromptNode,
  type ChartNode,
  type DelegateFunctionCallNode,
  type DestructureNode,
  type GptFunctionNode,
  type GraphId,
  type GraphInputNode,
  type GraphOutputNode,
  type LLMChatV2Node,
  type NodeGraph,
  type ObjectNode,
  type Project,
  type TextNode,
} from '../../core/src/index.js';
import { isPromoProjectKey, PROMO_PROJECT_MANIFEST, type PromoProjectKey } from '../src/promo/promoProjectManifest.js';

const demos = Object.entries(PROMO_PROJECT_MANIFEST).map(([kind, definition]) => ({
  ...definition,
  kind: kind as PromoProjectKey,
}));

const promoProjectsDirectory = fileURLToPath(new URL('../src/promo/projects/', import.meta.url));
const declaredPromoProjectFiles = demos.map((demo) => demo.file).sort();
const storedPromoProjectFiles = (await readdir(promoProjectsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.rivet-project'))
  .map((entry) => entry.name)
  .sort();

assert.deepEqual(
  storedPromoProjectFiles,
  declaredPromoProjectFiles,
  'The dedicated promo/projects directory must contain exactly the projects declared by the promo manifest.',
);

for (const field of ['file', 'path', 'projectId'] as const) {
  assert.equal(
    new Set(demos.map((demo) => demo[field])).size,
    demos.length,
    `Every promo project must have a unique ${field}.`,
  );
}
assert.ok(
  demos.every((demo) => demo.loadingHint.trim()),
  'Every promo project must have a loading hint.',
);
for (const demo of demos) {
  assert.equal(isPromoProjectKey(demo.kind), true);
}
for (const unknownId of ['', 'unknown', '__proto__', 'toString']) {
  assert.equal(isPromoProjectKey(unknownId), false);
}

type PromoNodeByType = {
  assemblePrompt: AssemblePromptNode;
  delegateFunctionCall: DelegateFunctionCallNode;
  destructure: DestructureNode;
  gptFunction: GptFunctionNode;
  graphInput: GraphInputNode;
  graphOutput: GraphOutputNode;
  llmChatV2: LLMChatV2Node;
  object: ObjectNode;
  text: TextNode;
};

function getGraph(project: Project, graphId: GraphId | string | undefined, label: string): NodeGraph {
  assert.ok(graphId, `${project.metadata.title} has no ${label} graph id.`);
  const graph = project.graphs[graphId as GraphId];
  assert.ok(graph, `${project.metadata.title} has no ${label} graph "${graphId}".`);
  return graph;
}

function getMainGraph(project: Project): NodeGraph {
  return getGraph(project, project.metadata.mainGraphId, 'main');
}

function findNode<TType extends keyof PromoNodeByType>(graph: NodeGraph, type: TType): PromoNodeByType[TType] {
  const node = graph.nodes.find((candidate) => candidate.type === type);
  assert.ok(node, `${graph.metadata?.name ?? graph.metadata?.id ?? 'Graph'} has no ${type} node.`);
  return node as PromoNodeByType[TType];
}

function filterNodes<TType extends keyof PromoNodeByType>(graph: NodeGraph, type: TType): PromoNodeByType[TType][] {
  return graph.nodes.filter((node) => node.type === type) as PromoNodeByType[TType][];
}

function findNodeByTitle(graph: NodeGraph, title: string): ChartNode {
  const node = graph.nodes.find((candidate) => candidate.title === title);
  assert.ok(node, `${graph.metadata?.name ?? graph.metadata?.id ?? 'Graph'} has no node titled "${title}".`);
  return node;
}

function findApiKeyNode(project: Project): TextNode {
  const matches = Object.values(project.graphs)
    .flatMap((graph) => filterNodes(graph, 'text'))
    .filter((node) => /\bAPI Key\b/iu.test(node.title ?? ''));

  assert.equal(matches.length, 1, `${project.metadata.title} must contain exactly one API Key text node.`);
  assert.equal(matches[0]!.data.text, '', `${project.metadata.title} must not ship an API key.`);
  return matches[0]!;
}

function assertApiKeyWiring(project: Project, apiKeyNode: TextNode): void {
  const llmNodes = Object.values(project.graphs).flatMap((graph) => filterNodes(graph, 'llmChatV2'));
  assert.ok(llmNodes.length > 0, `${project.metadata.title} must contain an LLM Chat node.`);

  for (const llmNode of llmNodes) {
    assert.equal(llmNode.data.configurationMode, 'inline', `${llmNode.title} must keep its settings inline.`);
    assert.equal(llmNode.data.apiKeySource, 'input', `${llmNode.title} must use its API Key input.`);
    assert.equal(llmNode.data.outputLLMAttempts, false, `${llmNode.title} must not expose an LLM attempts port.`);
    assert.equal(llmNode.data.outputUsage, false, `${llmNode.title} must not expose an unused usage port.`);
    const ownerGraph = Object.values(project.graphs).find((graph) =>
      graph.nodes.some((node) => node.id === llmNode.id),
    );
    assert.ok(ownerGraph, `Could not find the graph containing ${llmNode.title}.`);
    assert.ok(
      ownerGraph.connections.some(
        (connection) =>
          connection.outputNodeId === apiKeyNode.id &&
          connection.outputId === 'output' &&
          connection.inputNodeId === llmNode.id &&
          connection.inputId === 'apiKey',
      ),
      `${llmNode.title} must be connected directly to the API Key text node.`,
    );
  }

  assert.equal(
    Object.values(project.graphs)
      .flatMap((graph) => graph.nodes)
      .filter((node) => node.type === 'llmProfile').length,
    0,
    `${project.metadata.title} must use no LLM Profile nodes.`,
  );
}

function assertNodeTypes(graph: NodeGraph, expectedTypes: string[]): void {
  assert.deepEqual(
    graph.nodes.map((node) => node.type).sort(),
    [...expectedTypes].sort(),
    `${graph.metadata?.name ?? graph.metadata?.id ?? 'Graph'} must keep its intentionally minimal node topology.`,
  );
}

function assertRoundTrip(project: Project): void {
  const [roundTripped] = deserializeProject(serializeProject(project));
  assert.equal(roundTripped.metadata.id, project.metadata.id);
  assert.equal(roundTripped.metadata.mainGraphId, project.metadata.mainGraphId);
  assert.deepEqual(Object.keys(roundTripped.graphs).sort(), Object.keys(project.graphs).sort());
  for (const [graphId, graph] of Object.entries(project.graphs)) {
    const roundTrippedGraph = roundTripped.graphs[graphId as GraphId];
    assert.deepEqual(
      [...(roundTrippedGraph?.nodes ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
      [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(
      [...(roundTrippedGraph?.connections ?? [])].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
      [...graph.connections].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
  }
  assert.deepEqual(roundTripped.uiGraphs, project.uiGraphs);
}

function assertAgent(project: Project): Promise<void> {
  const mainGraph = getMainGraph(project);
  const llm = findNode(mainGraph, 'llmChatV2');
  const tool = findNode(mainGraph, 'gptFunction');
  const delegate = findNode(mainGraph, 'delegateFunctionCall');

  assert.equal(
    Object.keys(project.graphs).length,
    2,
    'The agent needs only its main graph and one tool handler graph.',
  );
  assertNodeTypes(mainGraph, [
    'delegateFunctionCall',
    'gptFunction',
    'graphInput',
    'graphOutput',
    'llmChatV2',
    'prompt',
    'text',
    'text',
    'text',
  ]);
  assert.equal(llm.data.useToolCalling, true);
  assert.equal(llm.data.autoContinueToolCalls, true);
  assert.equal(llm.data.maxToolRounds, 3);
  assert.equal(llm.data.toolChoice, '');
  assert.equal(llm.data.toolChoiceFunction, '');
  assert.equal(tool.data.resultHandling, 'continue');
  assert.equal(delegate.data.autoDelegate, true);
  assert.ok(
    mainGraph.connections.some(
      (connection) =>
        connection.outputNodeId === llm.id &&
        connection.outputId === 'function-calls' &&
        connection.inputNodeId === delegate.id &&
        connection.inputId === 'function-call',
    ),
    'The agent LLM must use the connected Delegate Tool Call continuation path.',
  );

  const handlerGraph = Object.values(project.graphs).find((graph) => graph.metadata?.name === tool.data.name);
  assert.ok(handlerGraph, `No handler graph matches tool ${String(tool.data.name)}.`);
  assertNodeTypes(handlerGraph, ['codeNew', 'graphOutput']);

  assert.ok(handlerGraph.metadata?.id, 'The agent tool handler graph must have an id.');
  return coreRunGraph(project, {
    graph: handlerGraph.metadata.id,
  }).then((outputs) => {
    assert.ok(outputs.output, 'The UTC-time tool must return an output.');
    const timestamp = (
      typeof outputs.output.value === 'string' ? JSON.parse(outputs.output.value) : outputs.output.value
    ) as { iso?: unknown; unixMs?: unknown };
    assert.equal(typeof timestamp.iso, 'string');
    assert.equal(typeof timestamp.unixMs, 'number');
    assert.equal(Date.parse(timestamp.iso as string), timestamp.unixMs);
  });
}

function assertWorkflow(project: Project): void {
  const graph = getMainGraph(project);
  assert.equal(Object.keys(project.graphs).length, 1, 'The workflow demo must not contain subgraphs.');
  assertNodeTypes(graph, ['graphOutput', 'llmChatV2', 'llmChatV2', 'text', 'text', 'text', 'text', 'text']);
  const llmNodes = filterNodes(graph, 'llmChatV2');
  assert.equal(llmNodes.length, 2);
  const mergeNode = findNodeByTitle(graph, 'Merge the parallel reviews');
  const mergeSources = graph.connections
    .filter((connection) => connection.inputNodeId === mergeNode.id)
    .map((connection) => connection.outputNodeId)
    .sort();
  assert.deepEqual(mergeSources, llmNodes.map((node) => node.id).sort());
  assert.equal(
    graph.connections.some(
      (connection) =>
        llmNodes.some((node) => node.id === connection.outputNodeId) &&
        llmNodes.some((node) => node.id === connection.inputNodeId),
    ),
    false,
    'The two workflow model calls must not depend on each other.',
  );
}

function assertBatchRuns(project: Project): void {
  assert.equal(Object.keys(project.graphs).length, 1, 'The batch-runs demo must not contain subgraphs.');
  const graph = getMainGraph(project);
  assertNodeTypes(graph, ['graphInput', 'graphOutput', 'llmChatV2', 'text', 'text']);

  const requests = findNode(graph, 'graphInput');
  const instructions = findNodeByTitle(graph, 'Classification instructions');
  const llm = findNode(graph, 'llmChatV2');
  const output = findNode(graph, 'graphOutput');

  assert.equal(llm.isSplitRun, true, 'The batch LLM must use Many parallel runs.');
  assert.notEqual(llm.isSplitSequential, true, 'The batch LLM runs must remain parallel.');
  assert.equal(llm.data.useToolCalling, false);
  assert.equal(llm.data.responseFormat, 'text');
  assert.equal(output.data.dataType, 'string[]');
  assert.equal(requests.data.id, 'requests');
  assert.equal(requests.data.dataType, 'string[]');
  assert.equal(requests.data.useDefaultValueInput, false);
  assert.deepEqual(requests.data.defaultValue, [
    'I was charged twice for my monthly plan.',
    'The dashboard stays blank after I sign in.',
    'Please add a dark mode for late-night work.',
  ]);

  const expectedConnections = [
    [requests.id, 'data', llm.id, 'prompt'],
    [instructions.id, 'output', llm.id, 'systemPrompt'],
    [llm.id, 'response', output.id, 'value'],
  ];

  for (const [outputNodeId, outputId, inputNodeId, inputId] of expectedConnections) {
    assert.ok(
      graph.connections.some(
        (connection) =>
          connection.outputNodeId === outputNodeId &&
          connection.outputId === outputId &&
          connection.inputNodeId === inputNodeId &&
          connection.inputId === inputId,
      ),
      `The batch-runs graph is missing ${String(outputId)} -> ${String(inputId)}.`,
    );
  }
}

function assertStructuredOutput(project: Project): void {
  assert.equal(Object.keys(project.graphs).length, 1, 'The structured-output demo must not contain subgraphs.');
  const graph = getMainGraph(project);
  assertNodeTypes(graph, ['destructure', 'graphOutput', 'llmChatV2', 'object', 'text', 'text', 'text']);

  const ticket = findNodeByTitle(graph, 'Messy support ticket');
  const schemaNode = findNode(graph, 'object');
  const llm = findNode(graph, 'llmChatV2');
  const destructure = findNode(graph, 'destructure');
  const render = findNodeByTitle(graph, 'Render triage card');
  const output = findNode(graph, 'graphOutput');

  assert.equal(llm.data.responseFormat, 'json_schema');
  assert.equal(llm.data.useToolCalling, false);
  assert.equal(output.data.dataType, 'string');

  const schema = JSON.parse(String(schemaNode.data.jsonTemplate)) as {
    additionalProperties?: unknown;
    properties?: Record<string, unknown>;
    required?: unknown;
    type?: unknown;
  };
  const fieldNames = ['category', 'needsHuman', 'priority', 'summary'];
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fieldNames);
  assert.deepEqual([...(Array.isArray(schema.required) ? schema.required : [])].sort(), fieldNames);
  assert.deepEqual(destructure.data.paths, ['$.category', '$.priority', '$.summary', '$.needsHuman']);
  assert.deepEqual(destructure.data.pathPortIds, ['category', 'priority', 'summary', 'needsHuman']);

  const expectedConnections = [
    [ticket.id, 'output', llm.id, 'prompt'],
    [schemaNode.id, 'output', llm.id, 'responseSchema'],
    [llm.id, 'response', destructure.id, 'object'],
    [destructure.id, 'category', render.id, 'category'],
    [destructure.id, 'priority', render.id, 'priority'],
    [destructure.id, 'summary', render.id, 'summary'],
    [destructure.id, 'needsHuman', render.id, 'needsHuman'],
    [render.id, 'output', output.id, 'value'],
  ];

  for (const [outputNodeId, outputId, inputNodeId, inputId] of expectedConnections) {
    assert.ok(
      graph.connections.some(
        (connection) =>
          connection.outputNodeId === outputNodeId &&
          connection.outputId === outputId &&
          connection.inputNodeId === inputNodeId &&
          connection.inputId === inputId,
      ),
      `The structured-output graph is missing ${String(outputId)} -> ${String(inputId)}.`,
    );
  }
}

function assertWebApp(project: Project): void {
  assert.equal(Object.keys(project.graphs).length, 1, 'The web-app demo must not contain subgraphs.');
  assert.equal(Object.keys(project.uiGraphs ?? {}).length, 1);
  assert.deepEqual(validateProjectUiGraphActionBindings(project), []);
  const graph = getMainGraph(project);
  assertNodeTypes(graph, ['assemblePrompt', 'graphInput', 'graphInput', 'graphOutput', 'llmChatV2', 'text', 'text']);
  const graphInputTypes = Object.fromEntries(
    filterNodes(graph, 'graphInput').map((node) => [node.data.id, node.data.dataType]),
  );
  const graphOutputTypes = Object.fromEntries(
    filterNodes(graph, 'graphOutput').map((node) => [node.data.id, node.data.dataType]),
  );
  assert.deepEqual(graphInputTypes, { conversationHistory: 'chat-message[]', userInput: 'string' });
  assert.deepEqual(graphOutputTypes, { output: 'string' });
  const uiGraph = Object.values(project.uiGraphs ?? {})[0]!;
  assert.equal(uiGraph.components.length, 1, 'The web-app demo needs only its Chat component.');
  const chat = uiGraph.components.find((component) => component.type === 'chat');
  assert.ok(chat && chat.action?.type === 'runGraph');
  assert.equal(chat.action.graphId, project.metadata.mainGraphId);
  assert.equal(chat.action.userInputId, 'userInput');
  assert.equal(chat.action.historyInputId, 'conversationHistory');
  assert.equal(chat.action.responseOutputId, 'output');
  assert.deepEqual(chat.action.inputMappings ?? [], []);

  const historyInput = filterNodes(graph, 'graphInput').find((node) => node.data.id === 'conversationHistory');
  const userInput = filterNodes(graph, 'graphInput').find((node) => node.data.id === 'userInput');
  assert.ok(historyInput && userInput, 'The web-app graph must expose userInput and conversationHistory.');
  const instructions = findNodeByTitle(graph, 'Assistant instructions');
  const prompt = findNode(graph, 'assemblePrompt');
  const llm = findNode(graph, 'llmChatV2');
  const output = findNode(graph, 'graphOutput');
  const expectedConnections = [
    [historyInput.id, 'data', prompt.id, 'message1'],
    [userInput.id, 'data', prompt.id, 'message2'],
    [instructions.id, 'output', llm.id, 'systemPrompt'],
    [prompt.id, 'prompt', llm.id, 'prompt'],
    [llm.id, 'response', output.id, 'value'],
  ];

  for (const [outputNodeId, outputId, inputNodeId, inputId] of expectedConnections) {
    assert.ok(
      graph.connections.some(
        (connection) =>
          connection.outputNodeId === outputNodeId &&
          connection.outputId === outputId &&
          connection.inputNodeId === inputNodeId &&
          connection.inputId === inputId,
      ),
      `The web-app graph is missing ${String(outputId)} -> ${String(inputId)}.`,
    );
  }
}

for (const demo of demos) {
  const path = fileURLToPath(new URL(`../src/promo/projects/${demo.file}`, import.meta.url));
  const project = loadProjectFromString(await readFile(path, 'utf8'));
  assert.equal(project.metadata.id, demo.projectId);
  assert.equal(project.metadata.mainGraphId, demo.graphId);
  getGraph(project, demo.graphId, 'declared main');
  assert.deepEqual(project.plugins, []);
  assert.equal(Object.keys(project.nodePrefabs ?? {}).length, 0, `${demo.file} must not contain node-library prefabs.`);

  const apiKeyNode = findApiKeyNode(project);
  assertApiKeyWiring(project, apiKeyNode);
  assertRoundTrip(project);

  if (demo.kind === 'agent') await assertAgent(project);
  if (demo.kind === 'batch-runs') assertBatchRuns(project);
  if (demo.kind === 'structured-output') assertStructuredOutput(project);
  if (demo.kind === 'workflow') assertWorkflow(project);
  if (demo.kind === 'web-app') assertWebApp(project);
}

console.log('All promo Rivet projects are structurally valid, key-safe, and wired to their intended feature.');
