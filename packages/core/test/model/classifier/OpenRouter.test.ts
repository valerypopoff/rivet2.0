import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClassifierEvaluateNodeImpl } from '../../../src/model/nodes/ClassifierEvaluateNode.js';
import { ClassifierProfileNodeImpl } from '../../../src/model/nodes/ClassifierProfileNode.js';
import { classifierProfileHealthIdentity } from '../../../src/model/classifier/profile.js';
import {
  calculateClassifierUsageCost,
  getClassifierProvider,
  getClassifierProviderEnvironmentVariableNames,
} from '../../../src/model/classifier/providers.js';
import { resolveClassifierApiKey } from '../../../src/model/classifier/credentials.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';
import {
  GraphProcessor,
  ArrayNodeImpl,
  GraphOutputNodeImpl,
  createBuiltInRegistry,
  serializeProject,
  deserializeProject,
  type Project,
  type NodeConnection,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';

const provider = getClassifierProvider('openrouter');
const endpoint = 'https://openrouter.ai/api/alpha/decisions';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const questions: ClassifierQuestionDefinition[] = [
  { questionId: 'route', type: 'choice', instructions: 'Route', criteria: { a: 'A', b: 'B' } },
  { questionId: 'severity', type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
  { questionId: 'repeat', type: 'noul', instructions: 'Repeat?', criteria: { true: 'Yes', false: 'No' } },
];
const responseBody = {
  model: 'microsoft/microsoft-decision-1',
  answers: {
    route: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
    severity: {
      type: 'score',
      score: 0.2,
      confidence: 0.8,
      probabilities: { '0': 0.8, '1': 0.2 },
      legend: { '0': 'Low', '1': 'High' },
    },
    repeat: { type: 'noul', noul: 0.7 },
  },
  id: 'gen-dec-test',
  provider: 'Azure',
  usage: { input_tokens: 1000, output_tokens: 0, cost: 0.000042 },
};
const reply = () => Response.json(responseBody);
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { openrouter: { apiKey: 'private-key' } } },
    project: { metadata: { id: 'test-project' }, graphs: {} },
  }) as InternalProcessContext;
const directArgs = () => ({
  apiKey: 'private-key',
  model: 'microsoft/microsoft-decision-1',
  questions,
  state: { message: 'Incident', count: 3 },
  signal: new AbortController().signal,
  timeoutMs: 30_000,
});

test('OpenRouter uses the native Decisions batch and Bearer header, preserving IDs, JSON State and receipts', async () => {
  let calls = 0;
  const attempts: unknown[] = [];
  const args = directArgs();
  const result = await provider.evaluate({
    ...args,
    onAttempt: (event) => attempts.push(event),
    fetchImplementation: async (url, init) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer private-key');
      assert.equal(headers.get('api-key'), null);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'microsoft/microsoft-decision-1');
      assert.deepEqual(body.state, args.state);
      assert.deepEqual(
        body.questions,
        Object.fromEntries(questions.map(({ questionId, ...question }) => [questionId, question])),
      );
      return reply();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.response, responseBody);
  assert.deepEqual(result.responseBody, responseBody);
  assert.doesNotMatch(JSON.stringify([result, attempts]), /private-key|api-key/);
  assert.match(JSON.stringify(attempts), /estimatedCostUsd/);
});

test('OpenRouter inline and profile modes produce identical requests, outputs and pricing', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return reply();
  };
  const ctx = context();
  const node = ClassifierEvaluateNodeImpl.create();
  node.data = {
    ...node.data,
    provider: provider.id,
    model: 'microsoft/microsoft-decision-1',
    outputUsage: true,
  };
  const inputs = {
    state: { type: 'object' as const, value: { message: 'Incident' } },
    question1: { type: 'object[]' as const, value: questions },
  };
  const inline = await new ClassifierEvaluateNodeImpl(node).process(inputs, ctx);
  const profileNode = ClassifierProfileNodeImpl.create();
  Object.assign(profileNode.data, { provider: provider.id, model: 'microsoft/microsoft-decision-1' });
  const profile = (await new ClassifierProfileNodeImpl(profileNode).process({}, { ...ctx, node: profileNode }))
    .profile!;
  assert.doesNotMatch(JSON.stringify(profileNode), /private-key/);
  node.data.configurationMode = 'profile';
  const configured = await new ClassifierEvaluateNodeImpl(node).process({ ...inputs, classifierProfile: profile }, ctx);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(configured, inline);
  assert.equal(inline.cost?.value, 0.000042);
  assert.deepEqual(inline.usage?.value, { ...responseBody.usage, totalCost: 0.000042 });
});

test('OpenRouter credentials resolve on the host with explicit precedence and provider isolation', () => {
  const ctx = context();
  const keyArgs = { providerId: provider.id, defaults: provider.credentialNames, context: ctx, inputs: {} };
  assert.equal(resolveClassifierApiKey({ ...keyArgs, apiKeySource: 'classifier-settings' }), 'private-key');
  ctx.settings[provider.credentialNames.programmaticName] = 'named-key';
  assert.equal(resolveClassifierApiKey(keyArgs), 'named-key');
  assert.equal(
    resolveClassifierApiKey({
      ...keyArgs,
      apiKeySource: 'input',
      inputs: { apiKey: { type: 'string', value: 'port-key' } },
    }),
    'port-key',
  );
  assert.ok(getClassifierProviderEnvironmentVariableNames().includes('OPENROUTER_API_KEY'));
});

test('OpenRouter rejects Browser execution before reading credentials', async () => {
  const ctx = context();
  ctx.executor = 'browser';
  Object.defineProperty(ctx.settings, 'classifierProviders', {
    get() {
      assert.fail('Browser execution must not read credentials');
    },
  });
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.provider = provider.id;
  await assert.rejects(
    new ClassifierEvaluateNodeImpl(node).process({ question1: { type: 'object[]', value: questions } }, ctx),
    /Node|node|Browser|browser/,
  );
});

test('OpenRouter rejects image evidence before sending credentials', async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    return reply();
  };
  // One valid 1x1 PNG, carried through the normal shared State evidence boundary.
  await assert.rejects(
    provider.evaluate({
      ...directArgs(),
      state: '',
      stateMessages: [
        {
          parts: [
            {
              type: 'image',
              dataUrl:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=',
            },
          ],
        },
      ],
      fetchImplementation,
    }),
    (error: any) => error.kind === 'capability',
  );
  assert.equal(calls, 0);
});

test('OpenRouter retries rate limits with identical native requests but never retries authentication failures', async () => {
  const requests: { body: string; headers: string | null }[] = [];
  await provider.evaluate({
    ...directArgs(),
    fetchImplementation: async (_url, init) => {
      requests.push({ body: String(init?.body), headers: new Headers(init?.headers).get('Authorization') });
      return requests.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : reply();
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  for (const status of [401, 403]) {
    let calls = 0;
    await assert.rejects(
      provider.evaluate({
        ...directArgs(),
        retryOnNon200: true,
        fetchImplementation: async () => {
          calls++;
          return new Response('private-key', { status });
        },
      }),
      (error: any) => error.kind === 'http' && error.statusCode === status && !error.message.includes('private-key'),
    );
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    provider.evaluate({
      ...directArgs(),
      signal: controller.signal,
      fetchImplementation: async () => {
        assert.fail('Cancelled request must not be sent');
      },
    }),
    /cancelled/,
  );
});

test('OpenRouter pricing requires recognized requested and returned models; health identity remains secret-free', async () => {
  assert.equal(
    calculateClassifierUsageCost(provider, responseBody.usage, {
      requestedModel: 'microsoft/microsoft-decision-1',
      responseModel: 'microsoft/microsoft-decision-1',
    }),
    0.000042,
  );
  assert.equal(
    calculateClassifierUsageCost(provider, responseBody.usage, {
      requestedModel: 'microsoft/microsoft-decision-1',
      responseModel: 'other-model',
    }),
    undefined,
  );
  const ctx = context();
  const node = ClassifierProfileNodeImpl.create();
  node.data.provider = provider.id;
  const value = (await new ClassifierProfileNodeImpl(node).process({}, { ...ctx, node })).profile!.value as any;
  const identity = classifierProfileHealthIdentity(value, 'test-project' as never, node.id);
  assert.doesNotMatch(JSON.stringify(identity), /private-key/);
  assert.equal(
    calculateClassifierUsageCost(provider, responseBody.usage, {
      requestedModel: 'other-model',
      responseModel: provider.defaultModel,
    }),
    undefined,
  );
});

test('Missing OpenRouter credentials can fall back without making a provider request', async () => {
  const ctx = context();
  ctx.settings.classifierProviders = {};
  const node = ClassifierProfileNodeImpl.create();
  node.data.provider = provider.id;
  const first = (await new ClassifierProfileNodeImpl(node).process({}, { ...ctx, node })).profile!.value;
  const evaluate = ClassifierEvaluateNodeImpl.create();
  evaluate.data.configurationMode = 'profile';
  evaluate.data.outputClassifierAttempts = true;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({
      model: 'jev-latest',
      answers: { repeat: responseBody.answers.repeat },
      usage: responseBody.usage,
    });
  };
  const result = await new ClassifierEvaluateNodeImpl(evaluate).process(
    {
      classifierProfile: {
        type: 'any[]',
        value: [
          first,
          {
            version: 1,
            configuration: { provider: 'jev', model: 'jev-latest' },
            credential: { value: 'fallback-key' },
          },
        ],
      },
      question1: { type: 'object', value: questions[2] },
    },
    ctx,
  );
  assert.deepEqual(calls, ['https://api.typesafe.ai/v1/systemone']);
  assert.equal(result.answers?.type, 'object');
  assert.match(JSON.stringify(result.classifierAttempts), /configuration/);
});

for (const provider of [getClassifierProvider('openrouter'), getClassifierProvider('perplexity')])
  for (const split of [false, true])
    test(`Saved ${provider.label} Profile → Array → Evaluate graph runs through the Node executor (split=${split})`, async () => {
      const profile = ClassifierProfileNodeImpl.create();
      profile.data.provider = provider.id;
      profile.data.model = provider.defaultModel;
      const array = ArrayNodeImpl.create();
      const evaluate = ClassifierEvaluateNodeImpl.create();
      evaluate.data.configurationMode = 'profile';
      evaluate.data.outputRequestBody = true;
      evaluate.isSplitRun = split;
      const output = GraphOutputNodeImpl.create();
      output.data.id = 'request';
      output.data.dataType = 'object';
      // Exercise real question/profile nodes and the processor's array handling,
      // rather than supplying a hand-built runtime profile value.
      const { ClassifierQuestionNodeImpl } = await import('../../../src/model/nodes/ClassifierQuestionNode.js');
      const question = ClassifierQuestionNodeImpl.create();
      Object.assign(question.data, { questionType: 'noul', questionId: 'repeat', instructions: 'Repeat?' });
      const wire = (from: string, outputId: string, to: string, inputId: string) =>
        ({ outputNodeId: from, outputId, inputNodeId: to, inputId }) as NodeConnection;
      const project = {
        metadata: { id: `${provider.id}-project`, title: provider.label, description: '', mainGraphId: 'main' },
        plugins: [],
        graphs: {
          main: {
            metadata: { id: 'main', name: 'Main' },
            nodes: [profile, array, question, evaluate, output],
            connections: [
              wire(profile.id, 'profile', array.id, 'input1'),
              wire(array.id, 'output', evaluate.id, 'classifierProfile'),
              wire(question.id, 'question', evaluate.id, 'question1'),
              wire(evaluate.id, 'requestBody', output.id, 'value'),
            ],
          },
        },
      } as unknown as Project;
      const saved = serializeProject(project);
      assert.doesNotMatch(saved, /private-key/);
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-key');
        return Response.json({
          model: provider.defaultModel,
          answers: { repeat: responseBody.answers.repeat },
          usage: responseBody.usage,
        });
      };
      const processor = new GraphProcessor(deserializeProject(saved)[0], 'main' as never, createBuiltInRegistry(), {
        executor: 'nodejs',
      });
      const result = await processor.processGraph({
        ...testProcessContext(),
        settings: {
          classifierProviders: { [provider.id]: { apiKey: 'private-key' } },
        },
      });
      assert.equal(calls, 1);
      const body = (split ? (result.request!.value as unknown[])[0] : result.request!.value) as Record<string, unknown>;
      assert.equal(body.model, provider.defaultModel);
    });
