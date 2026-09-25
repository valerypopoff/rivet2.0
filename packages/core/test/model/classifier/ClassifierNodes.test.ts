import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ClassifierEvaluateNodeImpl,
  ClassifierQuestionNodeImpl,
  calculateClassifierUsageCost,
  classifierProviders,
  createBuiltInRegistry,
  deserializeProject,
  hasLegacyClassifierProjectData,
  normalizeClassifierProject,
  serializeProject,
  validateApiCompatibleClassifierResponse,
  type ChartNode,
  type ClassifierProvider,
  type InternalProcessContext,
  type NodeConnection,
  type NodeId,
  type PortId,
  type Project,
} from '../../../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context(overrides: Partial<InternalProcessContext> = {}): InternalProcessContext {
  return {
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { jev: { apiKey: 'first-party-key' } } },
    getPluginConfig: () => {
      throw new Error('Classifier nodes must not access plugin configuration.');
    },
    graphInputNodeValues: {},
    contextValues: {},
    getGlobal: () => undefined,
    ...overrides,
  } as InternalProcessContext;
}

function questionNode(data: Partial<ClassifierQuestionNodeImpl['data']>) {
  const node = ClassifierQuestionNodeImpl.create();
  return new ClassifierQuestionNodeImpl({ ...node, data: { ...node.data, ...data } });
}

function evaluateNode(data: Partial<ClassifierEvaluateNodeImpl['data']> = {}) {
  const node = ClassifierEvaluateNodeImpl.create();
  return new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, ...data } });
}

test('Classifier nodes are first-party built-ins in the Classifier group', () => {
  const registry = createBuiltInRegistry();
  assert.equal(registry.getPluginFor('classifierQuestion'), undefined);
  assert.equal(registry.getPluginFor('classifierEvaluate'), undefined);
  assert.deepEqual(ClassifierQuestionNodeImpl.getUIData().group, ['Classifier']);
  assert.deepEqual(ClassifierEvaluateNodeImpl.getUIData().group, ['Classifier']);
});

test('Classifier Question presents dimmed Type and ID fields before separated question and criteria summaries', () => {
  const body = questionNode({ questionId: 'route', instructions: 'Route {{subject}}' }).getBody();

  assert.deepEqual(body, {
    type: 'markdown',
    disableLinks: true,
    text: [
      '<div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">Type:</span> <span class="rivet-node-body-field-value">Choice</span></div>',
      '<div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">ID:</span> <span class="rivet-node-body-field-value">route</span></div>',
      '<div class="rivet-node-body-separator"></div>',
      '<div class="rivet-node-body-text-row"><span class="rivet-node-body-field-value">Route {{subject}}</span></div>',
      '<div class="rivet-node-body-separator"></div>',
      '<div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">Criteria:</span> <span class="rivet-node-body-field-value">2 choices</span></div>',
    ].join(''),
  });
});

test('legacy Jev projects migrate their node types, wires, prefabs, plugin declarations, and credential settings', () => {
  // Exercise the actual ingress seam before a plugin can be resolved. The
  // fixture deliberately declares the removed TypeSafe plugin and old node
  // types, exactly as a saved project does.
  const original = legacyProject();
  assert.equal(hasLegacyClassifierProjectData(original), true);
  const [project] = deserializeProject(serializeProject(original));
  // Migration is safe to invoke at nested ingress seams too.
  normalizeClassifierProject(project);
  const nodes = project.graphs.main!.nodes as ChartNode[];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(nodesById.get('choice' as NodeId)?.type, 'classifierQuestion');
  assert.equal(nodesById.get('score' as NodeId)?.type, 'classifierQuestion');
  assert.equal(nodesById.get('noul' as NodeId)?.type, 'classifierQuestion');
  assert.equal(nodesById.get('evaluate' as NodeId)?.type, 'classifierEvaluate');
  assert.equal((nodesById.get('choice' as NodeId)?.data as { questionType?: string }).questionType, 'choice');
  assert.equal((nodesById.get('score' as NodeId)?.data as { questionType?: string }).questionType, 'score');
  assert.equal((nodesById.get('noul' as NodeId)?.data as { questionType?: string }).questionType, 'noul');
  assert.equal(nodesById.get('choice' as NodeId)?.title, 'Classifier Question');
  assert.equal(nodesById.get('score' as NodeId)?.title, 'Custom score title');
  assert.equal(nodesById.get('evaluate' as NodeId)?.title, 'Classifier Evaluate');
  assert.deepEqual((nodesById.get('evaluate' as NodeId)?.data as { apiKeyNamesByProvider?: unknown }).apiKeyNamesByProvider, {
    jev: { programmaticName: 'projectKey', environmentVariableName: 'PROJECT_KEY' },
  });
  assert.equal(project.plugins.length, 3);
  assert.ok(project.plugins.some((plugin) => plugin.type === 'built-in' && plugin.id === 'pinecone'));
  assert.ok(project.plugins.some((plugin) => plugin.type === 'package' && plugin.id === 'typesafe'));
  assert.ok(project.plugins.some((plugin) => plugin.type === 'uri' && plugin.id === 'typesafe'));
  assert.deepEqual(project.graphs.main!.connections, [
    {
      outputNodeId: 'choice' as NodeId,
      outputId: 'question' as PortId,
      inputNodeId: 'evaluate' as NodeId,
      inputId: 'question1' as PortId,
    },
  ]);
  assert.equal(project.nodePrefabs?.prefab.sourceNode.type, 'classifierQuestion');

  const [roundTripped] = deserializeProject(serializeProject(project));
  assert.deepEqual(serializeProject(roundTripped), serializeProject(project));
  assert.equal(roundTripped.plugins.some((plugin) => plugin.type === 'built-in' && plugin.id === 'typesafe'), false);
  assert.ok(roundTripped.graphs.main!.nodes.every((node) => !node.type.startsWith('jev')));
  assert.equal(hasLegacyClassifierProjectData(roundTripped), false);
});

test('pre-provider first-party evaluators scope their API-key names to the selected provider', () => {
  const project = legacyProject();
  project.plugins = [];
  project.graphs.main!.nodes = [
    {
      data: {
        apiKeyNames: { environmentVariableName: 'OLD_CLASSIFIER_KEY', programmaticName: 'oldClassifierKey' },
        provider: 'jev',
      },
      id: 'first-party-evaluate' as NodeId,
      title: 'Classifier Evaluate',
      type: 'classifierEvaluate',
      visualData: { x: 0, y: 0, width: 280 },
    },
  ];

  assert.equal(hasLegacyClassifierProjectData(project), true);
  normalizeClassifierProject(project);
  const data = project.graphs.main!.nodes[0]!.data as {
    apiKeyNames?: unknown;
    apiKeyNamesByProvider?: unknown;
  };
  assert.equal(data.apiKeyNames, undefined);
  assert.deepEqual(data.apiKeyNamesByProvider, {
    jev: { environmentVariableName: 'OLD_CLASSIFIER_KEY', programmaticName: 'oldClassifierKey' },
  });
  assert.equal(hasLegacyClassifierProjectData(project), false);
});

test('one question node produces choice, score, and noul definitions while retaining inactive editor data', async () => {
  const choice = await questionNode({
    questionType: 'choice',
    questionId: '__proto__',
    instructionsType: 'lines',
    instructionsLines: ['Route {{subject}}', 'Choose one team'],
    options: [
      { key: 'sales', value: 'For {{subject}}' },
      { key: 'support', value: '' },
    ],
    scoreCriteria: [
      { type: 'text', text: 'low', lines: [''], objectTemplate: '{}' },
      { type: 'object', text: '', lines: [''], objectTemplate: '{"label":"{{subject}}"}' },
    ],
    noulTrueCriteria: 'yes',
    noulFalseCriteria: 'no',
  }).process({ ['subject' as PortId]: { type: 'string', value: 'tickets' } }, context());
  assert.equal((choice.question!.value as any).type, 'choice');
  assert.equal(Object.hasOwn(choice.question!.value as object, 'questionId'), true);
  assert.deepEqual((choice.question!.value as any).instructions, ['Route tickets', 'Choose one team']);
  assert.equal((choice.question!.value as any).criteria.sales, 'For tickets');

  const scoreFromInput = await questionNode({
    questionType: 'score',
    questionId: 'severity',
    instructions: '',
    useInstructionsInput: true,
    useCriteriaInput: true,
  }).process(
    {
      ['instructions' as PortId]: { type: 'object', value: { question: 'Severity?' } },
      ['criteria' as PortId]: { type: 'any[]', value: [{ label: 'low' }, ['high']] },
    },
    context(),
  );
  assert.deepEqual((scoreFromInput.question!.value as any).criteria, [{ label: 'low' }, ['high']]);

  const score = await questionNode({
    questionType: 'score',
    questionId: 'structured-severity',
    criteriaType: undefined,
    instructionsType: 'object',
    instructionsObjectTemplate: '{"question":"Severity of {{subject}}?"}',
    scoreCriteria: [
      { type: 'text', text: 'low', lines: [], objectTemplate: '{}' },
      { type: 'lines', text: '', lines: ['high', 'urgent {{subject}}'], objectTemplate: '{}' },
      { type: 'object', text: '', lines: [], objectTemplate: '{"label":"critical","example":"{{subject}}"}' },
    ],
  }).process({ ['subject' as PortId]: { type: 'string', value: 'tickets' } }, context());
  assert.deepEqual((score.question!.value as any).instructions, { question: 'Severity of tickets?' });
  assert.deepEqual((score.question!.value as any).criteria, [
    'low',
    ['high', 'urgent tickets'],
    { label: 'critical', example: 'tickets' },
  ]);

  const noul = await questionNode({
    questionType: 'noul',
    questionId: 'refund',
    instructions: 'Refund?',
    useNoulTrueCriteriaInput: true,
    noulFalseCriteria: 'No refund for {{subject}}',
  }).process(
    {
      ['criteriaTrue' as PortId]: { type: 'string', value: 'Refund requested' },
      ['subject' as PortId]: { type: 'string', value: 'shipping questions' },
    },
    context(),
  );
  assert.deepEqual((noul.question!.value as any).criteria, {
    true: 'Refund requested',
    false: 'No refund for shipping questions',
  });

  const editors = questionNode({ questionType: 'score' }).getEditors();
  const questionTypeEditor = editors.find((editor) => editor.type === 'segmented' && editor.dataKey === 'questionType') as any;
  assert.deepEqual(questionTypeEditor.options, [
    { value: 'noul', label: 'Noul' },
    { value: 'choice', label: 'Choice' },
    { value: 'score', label: 'Score' },
  ]);
  assert.equal(questionTypeEditor.allowOptionWrap, false);
  const instructionsGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Instructions') as any;
  const criteriaGroup = editors.find((editor) => editor.type === 'group' && editor.label === 'Criteria') as any;
  assert.equal(instructionsGroup.presentation, 'section');
  assert.equal(criteriaGroup.presentation, 'section');
  assert.ok(instructionsGroup.editors.some((editor: any) => editor.type === 'dropdown' && editor.dataKey === 'instructionsType'));
  assert.ok(criteriaGroup.editors.some((editor: any) => editor.type === 'dropdown' && editor.dataKey === 'criteriaType'));
  assert.ok(criteriaGroup.editors.some((editor: any) => editor.type === 'custom' && editor.customEditorId === 'ClassifierScoreCriteria'));
  const instructionsObjectEditor = instructionsGroup.editors.find(
    (editor: any) => editor.type === 'code' && editor.dataKey === 'instructionsObjectTemplate',
  ) as any;
  assert.equal(instructionsObjectEditor.defaultValue, '{}');
  assert.equal(instructionsObjectEditor.height, 200);

  const noulEditors = questionNode({ questionType: 'noul' }).getEditors();
  const noulCriteriaGroup = noulEditors.find((editor) => editor.type === 'group' && editor.label === 'Criteria') as any;
  assert.deepEqual(
    noulCriteriaGroup.editors
      .filter((editor: any) => String(editor.dataKey ?? '').startsWith('noul'))
      .map((editor: any) => [editor.label, editor.useInputToggleDataKey]),
    [
      ['true', 'useNoulTrueCriteriaInput'],
      ['false', 'useNoulFalseCriteriaInput'],
      ['true', 'useNoulTrueCriteriaInput'],
      ['false', 'useNoulFalseCriteriaInput'],
      ['true', 'useNoulTrueCriteriaInput'],
      ['false', 'useNoulFalseCriteriaInput'],
    ],
  );
});

test('shared criteria type selects one representation for Choice, Score, and Noul', async () => {
  const choice = await questionNode({
    questionType: 'choice',
    questionId: 'route',
    instructions: 'Route this request.',
    criteriaType: 'object',
    choiceCriteria: [
      { key: 'sales', text: '', lines: [''], objectTemplate: '{"department":"sales"}' },
      { key: 'support', text: '', lines: [''], objectTemplate: '{"department":"support"}' },
    ],
  }).process({}, context());
  assert.deepEqual({ ...(choice.question!.value as any).criteria }, {
    sales: { department: 'sales' },
    support: { department: 'support' },
  });

  const score = await questionNode({
    questionType: 'score',
    questionId: 'severity',
    instructions: 'Score the request.',
    criteriaType: 'lines',
    scoreCriteria: [
      { type: 'text', text: 'ignored', lines: ['low', 'minor'], objectTemplate: '{}' },
      { type: 'object', text: 'ignored', lines: ['high', 'urgent'], objectTemplate: '{}' },
    ],
  }).process({}, context());
  assert.deepEqual((score.question!.value as any).criteria, [
    ['low', 'minor'],
    ['high', 'urgent'],
  ]);

  const noul = await questionNode({
    questionType: 'noul',
    questionId: 'refund',
    instructions: 'Is this a refund?',
    criteriaType: 'lines',
    noulTrueCriteriaLines: ['The customer requests a refund.'],
    noulFalseCriteriaLines: ['The customer only asks a question.'],
  }).process({}, context());
  assert.deepEqual((noul.question!.value as any).criteria, {
    true: ['The customer requests a refund.'],
    false: ['The customer only asks a question.'],
  });
});

test('Classifier Evaluate preserves arrays, exposes trailing question input, and selects Jev first', () => {
  const instance = evaluateNode();
  assert.equal(instance.chartNode.data.model, undefined);
  const connection = { inputNodeId: instance.chartNode.id, inputId: 'question3' as PortId } as NodeConnection;
  const inputs = instance.getInputDefinitions([connection], {}, {} as Project, {});
  assert.deepEqual(
    inputs.filter((input) => input.id.startsWith('question')).map((input) => input.id),
    ['question1', 'question2', 'question3', 'question4'],
  );
  assert.equal(inputs.find((input) => input.id === 'state')?.required, false);
  assert.ok(inputs.filter((input) => input.id === 'state' || input.id.startsWith('question')).every((input) => input.splitRunBehavior === 'preserve-array'));
  const providerEditor = instance.getEditors().find((editor) => editor.type === 'dropdown' && editor.dataKey === 'provider');
  assert.deepEqual(providerEditor && 'options' in providerEditor ? providerEditor.options : undefined, [{ value: 'jev', label: 'Jev' }]);
  assert.deepEqual(instance.getOutputDefinitions().map((output) => output.id), ['answers', 'usage']);
  const body = instance.getBody();
  assert.deepEqual(body, {
    type: 'markdown',
    disableLinks: true,
    text: [
      '<div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">Provider:</span> <span class="rivet-node-body-field-value">Jev</span></div>',
      '<div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">Model:</span> <span class="rivet-node-body-field-value">jev-latest</span></div>',
    ].join(''),
  });
  assert.doesNotMatch(body.text, /Batch: one request/);
});

test('Classifier Evaluate sends an empty string when optional State is omitted', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const outputs = await evaluateNode({ outputRequestBody: true }).process(
    {
      ['question1' as PortId]: {
        type: 'object',
        value: { questionId: 'q', type: 'noul', instructions: 'Question?' },
      },
    },
    context(),
  );

  assert.equal(requestBodies[0]?.state, '');
  assert.equal((outputs.requestBody!.value as Record<string, unknown>).state, '');
});

test('Classifier Evaluate exposes provider HTTP body outputs only when enabled in Outputs', () => {
  const defaultNode = evaluateNode();
  const requestNode = evaluateNode({ outputRequestBody: true });
  const responseNode = evaluateNode({ outputResponseBody: true });
  const bothNode = evaluateNode({ outputRequestBody: true, outputResponseBody: true });
  const outputsGroup = bothNode.getEditors().find((editor) => editor.type === 'group' && editor.label === 'Outputs') as any;

  assert.equal(defaultNode.getOutputDefinitions().some((output) => output.id === 'requestBody'), false);
  assert.equal(defaultNode.getOutputDefinitions().some((output) => output.id === 'responseBody'), false);
  assert.deepEqual(requestNode.getOutputDefinitions().find((output) => output.id === 'requestBody'), {
    id: 'requestBody',
    title: 'Classifier request body',
    dataType: 'object',
  });
  assert.deepEqual(responseNode.getOutputDefinitions().find((output) => output.id === 'responseBody'), {
    id: 'responseBody',
    title: 'Classifier response body',
    dataType: 'object',
  });
  assert.deepEqual(
    bothNode.getOutputDefinitions().slice(-2).map((output) => output.id),
    ['requestBody', 'responseBody'],
  );
  assert.equal(outputsGroup.editors[0]?.dataKey, 'outputUsage');
  assert.equal(outputsGroup.editors[0]?.label, 'Output usage details');
  assert.equal(outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputRequestBody')?.label, 'Output request body');
  assert.equal(outputsGroup.editors.find((editor: any) => editor.dataKey === 'outputResponseBody')?.label, 'Output response body');
});

test('Classifier Evaluate mirrors LLM Chat Error behavior settings and its node-body summary', () => {
  const instance = evaluateNode({ retryOnNon200: true, retryOnNon200RepeatTimes: 2, retryOnNon200CooldownMs: 25 });
  const errorGroup = instance.getEditors().at(-1) as any;

  assert.equal(errorGroup.label, 'Error behavior');
  assert.deepEqual(errorGroup.editors.map((editor: any) => editor.dataKey), [
    'retryOnNon200',
    'retryOnNon200RepeatTimes',
    'retryOnNon200CooldownMs',
  ]);
  assert.equal(errorGroup.editors[1].hideIf({ retryOnNon200: false }), true);
  assert.equal(errorGroup.editors[1].hideIf({ retryOnNon200: true }), false);
  const body = instance.getBody().text;
  assert.match(body, /Retry on non-200:<\/span> <span class="rivet-node-body-field-value">Enabled/);
  assert.match(body, /Repeat times:<\/span> <span class="rivet-node-body-field-value">2/);
  assert.match(body, /Cooldown, ms:<\/span> <span class="rivet-node-body-field-value">25/);
  assert.match(body, /<div class="rivet-node-body-separator"><\/div>/);
  assert.doesNotMatch(body, /\n/);
});

test('Classifier Evaluate resolves a newly selected provider default model without serializing Jev into the node', async () => {
  let resolvedModel: string | undefined;
  const provider: ClassifierProvider = {
    id: 'future',
    label: 'Future',
    defaultModel: 'future-latest',
    credentialNames: { programmaticName: 'futureApiKey', environmentVariableName: 'FUTURE_API_KEY' },
    browserExecutionSupported: false,
    async evaluate(args) {
      resolvedModel = args.model;
      return {
        requestBody: {},
        response: { model: args.model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } },
        responseBody: {},
      };
    },
  };
  const providers = classifierProviders as ClassifierProvider[];
  const originalLength = providers.length;
  providers.push(provider);
  try {
    const instance = evaluateNode({ provider: provider.id });
    assert.match(
      instance.getBody().text,
      /Provider:<\/span> <span class="rivet-node-body-field-value">Future<\/span><\/div><div class="rivet-node-body-field-row"><span class="rivet-node-body-field-label">Model:<\/span> <span class="rivet-node-body-field-value">future-latest<\/span>/,
    );
    await instance.process(
      {
        ['state' as PortId]: { type: 'string', value: 'state' },
        ['question1' as PortId]: {
          type: 'object',
          value: { questionId: 'question', type: 'noul', instructions: 'Question?' },
        },
      },
      context({ settings: { classifierProviders: { future: { apiKey: 'future-key' } } } }),
    );
    assert.equal(resolvedModel, 'future-latest');
  } finally {
    providers.splice(originalLength);
  }
});

test('Classifier Evaluate uses its selected provider and first-party, input, and legacy configured keys', async () => {
  const keys: string[] = [];
  const models: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    keys.push((init?.headers as Record<string, string>).Authorization);
    models.push(JSON.parse(String(init?.body)).model);
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const inputs = {
    ['state' as PortId]: { type: 'string' as const, value: 'state' },
    ['question1' as PortId]: { type: 'object' as const, value: { questionId: 'q', type: 'noul', instructions: 'Q?' } },
  };
  await evaluateNode({ apiKeySource: 'input' }).process(
    { ...inputs, ['apiKey' as PortId]: { type: 'string', value: 'input-key' } },
    context(),
  );
  await evaluateNode().process(inputs, context());
  await evaluateNode().process(
    inputs,
    context({ settings: { pluginSettings: { typesafe: { typesafeApiKey: 'legacy-key' } } } }),
  );
  assert.deepEqual(keys, ['Bearer input-key', 'Bearer first-party-key', 'Bearer legacy-key']);
  assert.deepEqual(models, ['jev-latest', 'jev-latest', 'jev-latest']);
});

test('Classifier Evaluate makes one API-compatible Jev request and excludes Rivet-only fields', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const providerResponse = {
    model: 'jev-1.13.0',
    answers: {
      route: { type: 'choice', choice: 'sales', confidence: 0.8, probabilities: { sales: 0.9, support: 0.1 } },
      severity: {
        type: 'score',
        score: 0.5,
        confidence: 0.2,
        probabilities: { 0: 0.5, 1: 0.5 },
        legend: { 0: 'low', 1: 'high' },
      },
      refund: { type: 'noul', noul: 0.75 },
    },
    usage: { input_tokens: 12, output_tokens: 8 },
  };
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(providerResponse), { status: 200 });
  }) as typeof fetch;

  const outputs = await evaluateNode({
    outputRequestBody: true,
    outputResponseBody: true,
    useModelInput: true,
  }).process(
    {
      ['state' as PortId]: { type: 'object', value: { ticket: 'hello' } },
      ['model' as PortId]: { type: 'string', value: 'jev-latest' },
      ['question1' as PortId]: {
        type: 'object',
        value: {
          questionId: 'route',
          type: 'choice',
          instructions: 'Route?',
          criteria: { sales: null, support: null },
          rivetMetadata: 'must not leave Rivet',
        },
      },
      ['question2' as PortId]: {
        type: 'any[]',
        value: [
          [{ questionId: 'severity', type: 'score', instructions: 'Severity?', criteria: ['low', 'high'] }],
          [{ questionId: 'refund', type: 'noul', instructions: 'Refund?' }],
        ],
      },
    },
    context(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0]!.body.questions.route.rivetMetadata, undefined);
  assert.equal(calls[0]!.body.questions.route.questionId, undefined);
  assert.equal(outputs['model' as PortId], undefined);
  assert.deepEqual(outputs.usage!.value, { input_tokens: 12, output_tokens: 8 });
  assert.deepEqual(outputs.requestBody!.value, calls[0]!.body);
  assert.deepEqual(outputs.responseBody!.value, providerResponse);
  assert.equal(JSON.stringify(outputs.requestBody!.value).includes('first-party-key'), false);
});

test("Classifier Evaluate adds Jev's fixed input-only totalCost to opt-in Usage details", async () => {
  const providerResponse = {
    model: 'jev-1.13.0',
    answers: { q: { type: 'noul', noul: 0.5 } },
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  };
  globalThis.fetch = (async () => new Response(JSON.stringify(providerResponse), { status: 200 })) as typeof fetch;
  const inputs = {
    ['state' as PortId]: { type: 'string' as const, value: 'state' },
    ['question1' as PortId]: {
      type: 'object' as const,
      value: { questionId: 'q', type: 'noul', instructions: 'Question?' },
    },
  };

  const plainOutputs = await evaluateNode({ outputResponseBody: true }).process(inputs, context());
  assert.deepEqual(plainOutputs.usage!.value, providerResponse.usage);

  const detailedOutputs = await evaluateNode({ outputResponseBody: true, outputUsage: true }).process(inputs, context());
  assert.deepEqual(detailedOutputs.usage!.value, { ...providerResponse.usage, totalCost: 0.042 });
  assert.deepEqual(detailedOutputs.responseBody!.value, providerResponse);
  assert.equal(calculateClassifierUsageCost({}, providerResponse.usage), undefined);
});

test('Classifier request output stays identical to every retry even if shared state changes', async () => {
  const state = { phase: 'original' };
  const sentBodies: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    sentBodies.push(JSON.parse(String(init?.body)));
    if (sentBodies.length === 1) {
      state.phase = 'changed-after-first-attempt';
      return new Response(null, { status: 429 });
    }
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const outputs = await evaluateNode({ outputRequestBody: true }).process(
    {
      ['state' as PortId]: { type: 'object', value: state },
      ['question1' as PortId]: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Question?' } },
    },
    context(),
  );

  assert.equal(sentBodies.length, 2);
  assert.deepEqual(sentBodies[1], sentBodies[0]);
  assert.deepEqual(outputs.requestBody!.value, sentBodies[0]);
  assert.deepEqual((outputs.requestBody!.value as { state: unknown }).state, { phase: 'original' });
});

test('Classifier Error behavior retries configured non-200 responses without widening auth, validation, or rate-limit policy', async () => {
  const inputs = {
    ['state' as PortId]: { type: 'string' as const, value: 'state' },
    ['question1' as PortId]: { type: 'object' as const, value: { questionId: 'q', type: 'noul', instructions: 'Question?' } },
  };
  const validResponse = () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );

  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1 ? new Response(null, { status: 500 }) : validResponse();
  }) as typeof fetch;
  await evaluateNode({ retryOnNon200: true, retryOnNon200RepeatTimes: 1, retryOnNon200CooldownMs: 0 }).process(
    inputs,
    context(),
  );
  assert.equal(requests, 2);

  requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  await assert.rejects(
    evaluateNode({ retryOnNon200: true, retryOnNon200RepeatTimes: 3 }).process(inputs, context()),
    /authentication failed/,
  );
  assert.equal(requests, 1);

  requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
  }) as typeof fetch;
  await assert.rejects(
    evaluateNode({ retryOnNon200: true, retryOnNon200RepeatTimes: 3 }).process(inputs, context()),
    /HTTP 429/,
  );
  assert.equal(requests, 3, 'The configured non-200 retry must not exceed Jev\'s existing rate-limit retry bound.');
});

test('browser execution fails before credentials or provider requests', async () => {
  globalThis.fetch = (async () => {
    throw new Error('must not call');
  }) as typeof fetch;
  await assert.rejects(
    evaluateNode().process(
      {
        ['state' as PortId]: { type: 'string', value: 'state' },
        ['question1' as PortId]: { type: 'object', value: {} },
      },
      context({ executor: 'browser' }),
    ),
    /Select the Node executor.*Studio Server.*remote debugging/,
  );
});

test('provider validation remains fail-closed for fractional scores, unsafe IDs, and malformed answers', () => {
  const score = { questionId: 'score', type: 'score' as const, instructions: 'Rate', criteria: ['low', 'high'] };
  const valid = validateApiCompatibleClassifierResponse(
    {
      model: 'jev-1.13.0',
      answers: {
        score: {
          type: 'score',
          score: 0.4,
          confidence: 0.3,
          probabilities: { 0: 0.6, 1: 0.4 },
          legend: { 0: 'low', 1: 'high' },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    [score],
    'Jev',
  );
  assert.equal((valid.answers.score as any).score, 0.4);
  assert.throws(
    () => validateApiCompatibleClassifierResponse({ ...valid, answers: {} }, [score], 'Jev'),
    /question IDs/,
  );
  assert.throws(
    () =>
      validateApiCompatibleClassifierResponse(
        {
          ...valid,
          answers: {
            score: {
              ...(valid.answers.score as object),
              probabilities: { 0: 0.7, 1: 0.7 },
            },
          },
        },
        [score],
        'Jev',
      ),
    /sum to 1/,
  );
});

function legacyProject(): Project {
  return {
    metadata: { id: 'legacy-classifier' as any, title: 'Legacy', mainGraphId: 'main' as any },
    graphs: {
      main: {
        metadata: { id: 'main' as any, name: 'Main', description: '' },
        nodes: [
          {
            id: 'choice' as NodeId,
            type: 'jevChoiceQuestion',
            title: 'Jev Choice Question',
            visualData: { x: 0, y: 0, width: 280 },
            data: { questionId: 'route', instructions: 'Route?', options: [{ key: 'yes', value: '' }, { key: 'no', value: '' }] },
          },
          {
            id: 'score' as NodeId,
            type: 'jevScoreQuestion',
            title: 'Custom score title',
            visualData: { x: 0, y: 0, width: 280 },
            data: { questionId: 'severity', instructions: 'Severity?', levels: ['low', 'high'] },
          },
          {
            id: 'noul' as NodeId,
            type: 'jevNoulQuestion',
            title: 'Jev Noul Question',
            visualData: { x: 0, y: 0, width: 280 },
            data: { questionId: 'refund', instructions: 'Refund?', yesMeans: '', noMeans: '' },
          },
          {
            id: 'evaluate' as NodeId,
            type: 'jevEvaluate',
            title: 'Jev Evaluate',
            visualData: { x: 0, y: 0, width: 280 },
            data: {
              model: 'jev-latest',
              apiKeyNames: { programmaticName: 'projectKey', environmentVariableName: 'PROJECT_KEY' },
            },
          },
        ],
        connections: [
          {
            outputNodeId: 'choice' as NodeId,
            outputId: 'question' as PortId,
            inputNodeId: 'evaluate' as NodeId,
            inputId: 'question1' as PortId,
          },
        ],
      },
    },
    nodePrefabs: {
      prefab: {
        id: 'prefab' as any,
        sourceNode: {
          id: 'prefab-node' as NodeId,
          type: 'jevChoiceQuestion',
          title: 'Jev Choice Question',
          visualData: { x: 0, y: 0, width: 280 },
          data: { questionId: 'prefab', instructions: 'Prefab?', options: [{ key: 'a', value: '' }, { key: 'b', value: '' }] },
        },
      },
    },
    plugins: [
      { type: 'built-in', id: 'typesafe', name: 'TypeSafe AI (Jev)' },
      { type: 'built-in', id: 'pinecone', name: 'Pinecone' },
      { type: 'package', id: 'typesafe', package: 'unrelated-typesafe-plugin', tag: 'latest' },
      { type: 'uri', id: 'typesafe', uri: 'file:///plugins/unrelated-typesafe-plugin.js' },
    ],
    references: [],
  } as Project;
}
