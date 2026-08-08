import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  coreRunGraph,
  deserializeProject,
  loadProjectFromString,
  serializeProject,
  validateProjectUiGraphActionBindings,
  type BooleanNode,
  type ChartNode,
  type CodeNewNode,
  type CompareNode,
  type DelegateFunctionCallNode,
  type GptFunctionNode,
  type GraphId,
  type GraphInputNode,
  type GraphOutputNode,
  type LLMChatV2Node,
  type NodeGraph,
  type NumberNode,
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
  boolean: BooleanNode;
  codeNew: CodeNewNode;
  compare: CompareNode;
  delegateFunctionCall: DelegateFunctionCallNode;
  gptFunction: GptFunctionNode;
  graphInput: GraphInputNode;
  graphOutput: GraphOutputNode;
  llmChatV2: LLMChatV2Node;
  number: NumberNode;
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

async function assertVisualCode(project: Project): Promise<void> {
  assert.equal(Object.keys(project.graphs).length, 1, 'The visual-code demo must not contain subgraphs.');
  const graph = getMainGraph(project);
  assertNodeTypes(graph, [
    'boolean',
    'boolean',
    'codeNew',
    'compare',
    'compare',
    'compare',
    'graphInput',
    'graphInput',
    'graphInput',
    'graphInput',
    'graphOutput',
    'number',
    'number',
  ]);

  const amount = findNodeByTitle(graph, 'Expense amount') as NumberNode;
  const limit = findNodeByTitle(graph, 'Auto-approval limit') as NumberNode;
  const receiptPresent = findNodeByTitle(graph, 'Receipt present') as BooleanNode;
  const tripPreApproved = findNodeByTitle(graph, 'Trip pre-approved') as BooleanNode;
  const amountCheck = findNodeByTitle(graph, 'Compare - Is amount within auto-approval limit?') as CompareNode;
  const evidenceCheck = findNodeByTitle(graph, 'Compare - Is there evidence and pre-approval?') as CompareNode;
  const policyGate = findNodeByTitle(graph, 'Compare - Is policy eligible?') as CompareNode;
  const code = findNode(graph, 'codeNew');
  const output = findNode(graph, 'graphOutput');
  const graphInputs = Object.fromEntries(
    filterNodes(graph, 'graphInput').map((node) => [node.data.id, node]),
  ) as Record<string, GraphInputNode>;

  assert.equal(output.data.dataType, 'string');
  assert.deepEqual(Object.fromEntries(Object.entries(graphInputs).map(([id, node]) => [id, node.data.dataType])), {
    autoApprovalLimit: 'number',
    expenseAmount: 'number',
    receiptPresent: 'boolean',
    tripPreApproved: 'boolean',
  });
  assert.ok(
    Object.values(graphInputs).every((node) => node.data.useDefaultValueInput === true),
    'The visual-code demo must remain immediately runnable through visible default values.',
  );
  assert.equal(amount.data.value, 860);
  assert.equal(limit.data.value, 1000);
  assert.equal(receiptPresent.data.value, true);
  assert.equal(tripPreApproved.data.value, true);
  assert.equal(amountCheck.data.comparisonFunction, '<=');
  assert.equal(evidenceCheck.data.comparisonFunction, 'and');
  assert.equal(policyGate.data.comparisonFunction, 'and');
  assert.equal(filterNodes(graph, 'codeNew').length, 1, 'The demo must use exactly one focused Code node.');
  assert.match(code.data.code, /const tiers = \[/u);
  assert.match(code.data.code, /visible policy gates/u);
  assert.match(code.data.code, /Auto-approve/u);

  const expectedConnections = [
    [amount.id, 'value', graphInputs.expenseAmount!.id, 'default'],
    [limit.id, 'value', graphInputs.autoApprovalLimit!.id, 'default'],
    [receiptPresent.id, 'value', graphInputs.receiptPresent!.id, 'default'],
    [tripPreApproved.id, 'value', graphInputs.tripPreApproved!.id, 'default'],
    [graphInputs.expenseAmount!.id, 'data', amountCheck.id, 'a'],
    [graphInputs.autoApprovalLimit!.id, 'data', amountCheck.id, 'b'],
    [graphInputs.receiptPresent!.id, 'data', evidenceCheck.id, 'a'],
    [graphInputs.tripPreApproved!.id, 'data', evidenceCheck.id, 'b'],
    [amountCheck.id, 'output', policyGate.id, 'a'],
    [evidenceCheck.id, 'output', policyGate.id, 'b'],
    [policyGate.id, 'output', code.id, 'policyEligible'],
    [graphInputs.expenseAmount!.id, 'data', code.id, 'amount'],
    [code.id, 'output', output.id, 'value'],
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
      `The visual-code graph is missing ${String(outputId)} -> ${String(inputId)}.`,
    );
  }

  assert.ok(graph.metadata?.id, 'The visual-code graph must have an id.');
  const outputs = await coreRunGraph(project, { graph: graph.metadata.id });
  const decision = Object.values(outputs)[0]?.value;
  assert.ok(typeof decision === 'string');
  assert.match(decision, /Auto-approve/u);
  assert.match(decision, /Finance \+ Travel desk/u);
}

function assertWebApp(project: Project): void {
  assert.equal(Object.keys(project.graphs).length, 1, 'The web-app demo must not contain subgraphs.');
  assert.equal(Object.keys(project.uiGraphs ?? {}).length, 1);
  assert.deepEqual(validateProjectUiGraphActionBindings(project), []);
  const graph = getMainGraph(project);
  assertNodeTypes(graph, ['graphInput', 'graphInput', 'graphOutput', 'llmChatV2', 'text', 'text', 'text']);
  const graphInputTypes = Object.fromEntries(
    filterNodes(graph, 'graphInput').map((node) => [node.data.id, node.data.dataType]),
  );
  const graphOutputTypes = Object.fromEntries(
    filterNodes(graph, 'graphOutput').map((node) => [node.data.id, node.data.dataType]),
  );
  assert.deepEqual(graphInputTypes, { audience: 'string', productIdea: 'string' });
  assert.deepEqual(graphOutputTypes, { output: 'string' });
  const uiGraph = Object.values(project.uiGraphs ?? {})[0]!;
  assert.equal(uiGraph.components.length, 5, 'The web-app demo needs a compact conventional form and result view.');
  assert.equal(
    uiGraph.components.some((component) => component.type === 'chat'),
    false,
  );

  const productIdeaField = uiGraph.components.find(
    (component) => component.type === 'textarea' && component.stateKey === 'productIdea',
  );
  const audienceField = uiGraph.components.find(
    (component) => component.type === 'input' && component.stateKey === 'audience',
  );
  const button = uiGraph.components.find((component) => component.type === 'button');
  const outputView = uiGraph.components.find(
    (component): component is Extract<(typeof uiGraph.components)[number], { type: 'output' }> =>
      component.type === 'output' && component.stateKey === 'launchBrief',
  );
  assert.ok(productIdeaField && audienceField, 'The web app must provide its two editable form fields.');
  assert.ok(button && button.action.type === 'runGraph');
  assert.equal(button.action.graphId, project.metadata.mainGraphId);
  assert.deepEqual(button.action.inputMappings, [
    { inputKey: 'productIdea', stateKey: 'productIdea' },
    { inputKey: 'audience', stateKey: 'audience' },
  ]);
  assert.deepEqual(button.action.outputs, [{ outputKey: 'output', stateKey: 'launchBrief' }]);
  assert.ok(outputView);
  assert.equal(outputView.renderAs, 'markdown');

  const productIdeaInput = filterNodes(graph, 'graphInput').find((node) => node.data.id === 'productIdea');
  const audienceInput = filterNodes(graph, 'graphInput').find((node) => node.data.id === 'audience');
  assert.ok(productIdeaInput && audienceInput, 'The web-app graph must expose its form values.');
  const instructions = findNodeByTitle(graph, 'Brief instructions');
  const prompt = findNodeByTitle(graph, 'Build launch brief prompt');
  const llm = findNode(graph, 'llmChatV2');
  const output = findNode(graph, 'graphOutput');
  const expectedConnections = [
    [productIdeaInput.id, 'data', prompt.id, 'productIdea'],
    [audienceInput.id, 'data', prompt.id, 'audience'],
    [instructions.id, 'output', llm.id, 'systemPrompt'],
    [prompt.id, 'output', llm.id, 'prompt'],
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

  if (demo.kind !== 'visual-code') {
    const apiKeyNode = findApiKeyNode(project);
    assertApiKeyWiring(project, apiKeyNode);
  }
  assertRoundTrip(project);

  if (demo.kind === 'agent') await assertAgent(project);
  if (demo.kind === 'visual-code') await assertVisualCode(project);
  if (demo.kind === 'workflow') assertWorkflow(project);
  if (demo.kind === 'web-app') assertWebApp(project);
}

console.log('All promo Rivet projects are structurally valid, key-safe, and wired to their intended feature.');
