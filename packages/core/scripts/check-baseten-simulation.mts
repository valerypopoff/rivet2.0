import assert from 'node:assert/strict';
import { ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl, getClassifierProvider } from '../src/index.js';
import { BASETEN_DECISION_MODELS } from '../src/model/classifier/baseten.js';
import { ClassifierProviderError } from '../src/model/classifier/providers.js';
import type { InternalProcessContext } from '../src/model/ProcessContext.js';

const base = new URL(process.env.RIVET_BASETEN_SIMULATION_URL ?? 'http://127.0.0.1:4932/baseten');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/v1/systemone`;
const realFetch = globalThis.fetch;
const destination =
  (scenario = ''): typeof fetch =>
  (url, init) => {
    assert.equal(url, 'https://inference.baseten.co/v1/systemone');
    return realFetch(endpoint + (scenario ? `?fixture=${scenario}` : ''), init);
  };
const questions = [
  { questionId: 'route', type: 'choice' as const, instructions: 'Route', criteria: { a: 'A', b: 'B' } },
  { questionId: 'score', type: 'score' as const, instructions: 'Rate', criteria: ['Low', 'High'] },
  { questionId: 'gate', type: 'noul' as const, instructions: 'Ready?' },
];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
);
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { baseten: { apiKey: 'fixture-key' } } },
  }) as InternalProcessContext;
try {
  globalThis.fetch = destination();
  for (const model of BASETEN_DECISION_MODELS)
    for (const configurationMode of ['inline', 'profile'] as const) {
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, {
        provider: 'baseten',
        model,
        configurationMode,
        questionCount: 3,
        apiKeySource: 'classifier-settings',
        outputRequestBody: true,
        outputResponseBody: true,
        outputUsage: true,
      });
      const profile = ClassifierProfileNodeImpl.create();
      Object.assign(profile.data, { provider: 'baseten', model, apiKeySource: 'classifier-settings' });
      const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
      const result = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: { type: 'image', value: { mediaType: 'image/png', data: png } },
          ...Object.fromEntries(questions.map((value, index) => [`question${index + 1}`, { type: 'object', value }])),
          ...(configurationMode === 'profile' ? { classifierProfile: profileOutput.profile! } : {}),
        },
        context(),
      );
      assert.equal(result.answers!.type, 'object');
      assert.deepEqual(result.answers!.value, {
        route: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
        score: {
          type: 'score',
          score: 0.5,
          confidence: 0,
          probabilities: { '0': 0.5, '1': 0.5 },
          legend: { '0': 'Low', '1': 'High' },
        },
        gate: { type: 'noul', noul: 0.9 },
      });
      assert.equal(result.cost!.type, 'control-flow-excluded');
      assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
    }
  const provider = getClassifierProvider('baseten');
  const args = {
    model: provider.defaultModel,
    apiKey: 'fixture-key',
    questions,
    state: { ticket: 'Help' },
    signal: new AbortController().signal,
  };
  const specialId = await provider.evaluate({
    ...args,
    questions: [{ ...questions[2]!, questionId: '__proto__' }],
    fetchImplementation: destination(),
  });
  assert.deepEqual(Object.keys(specialId.response.answers), ['__proto__']);
  assert.deepEqual(specialId.response.answers['__proto__'], { type: 'noul', noul: 0.9 });
  for (const [scenario, kind, status] of [
    ['unauthorized', 'http', 401],
    ['json-error', 'http', 503],
    ['html-error', 'http', 502],
    ['malformed', 'response-validation', undefined],
    ['hang', 'timeout', undefined],
  ] as const)
    await assert.rejects(
      provider.evaluate({ ...args, timeoutMs: 2000, fetchImplementation: destination(scenario) }),
      (error) => error instanceof ClassifierProviderError && error.kind === kind && error.statusCode === status,
    );
  let attempts = 0;
  await provider.evaluate({
    ...args,
    fetchImplementation: destination('rate-limit'),
    onAttempt: () => {
      attempts++;
    },
  });
  assert.equal(attempts, 3);
  const invalidAuth = await realFetch(endpoint, {
    method: 'POST',
    headers: { authorization: 'Api-Key fixture-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.defaultModel, state: '', questions: {} }),
  });
  assert.equal(invalidAuth.status, 401);
  console.log(
    'Baseten real-HTTP simulation passed: both models, inline/Profile images, typed answers, auth, errors, rate limiting and timeout.',
  );
} finally {
  globalThis.fetch = realFetch;
}
