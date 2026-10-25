import assert from 'node:assert/strict';
import { ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl, type InternalProcessContext } from '../src/index.js';

const base = new URL(process.env.RIVET_LIQUID_SIMULATION_URL ?? 'http://127.0.0.1:4933/liquid');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = `${base.href.replace(/\/$/, '')}/decisions/v1/systemone`;
const realFetch = globalThis.fetch;
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const questions = [
  { questionId: 'route', type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } },
  { questionId: 'score', type: 'score', instructions: 'Rate', criteria: ['Low', 'High'] },
  { questionId: 'gate', type: 'noul', instructions: 'Ready?' },
];
const answers = {
  route: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } },
  score: {
    type: 'score',
    score: 0.5,
    confidence: 0,
    probabilities: { '0': 0.5, '1': 0.5 },
    legend: { '0': 'Low', '1': 'High' },
  },
  gate: { type: 'noul', noul: 0.9 },
};
const context = () =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { liquid: { apiKey: 'fixture-key' } } },
  }) as InternalProcessContext;
let calls = 0;
try {
  globalThis.fetch = (url, init) => {
    assert.equal(url, 'https://api.liquid.ai/decisions/v1/systemone');
    calls++;
    return realFetch(endpoint, init);
  };
  for (const model of ['d1', 'd1.1'])
    for (const configurationMode of ['inline', 'profile'] as const) {
      const profile = ClassifierProfileNodeImpl.create();
      Object.assign(profile.data, { provider: 'liquid', model, apiKeySource: 'classifier-settings' });
      const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, {
        provider: 'liquid',
        model,
        configurationMode,
        apiKeySource: 'classifier-settings',
        outputRequestBody: true,
        outputResponseBody: true,
        outputUsage: true,
      });
      const result = await new ClassifierEvaluateNodeImpl(node).process(
        {
          state: { type: 'string[]', value: ['Before', image, 'After'] },
          question1: { type: 'object[]', value: questions },
          ...(configurationMode === 'profile' ? { classifierProfile: profileOutput.profile! } : {}),
        },
        context(),
      );
      assert.deepEqual(result.answers!.value, answers);
      assert.deepEqual(result.requestBody!.value, {
        model,
        state: 'Before\n[Image 1]\nAfter',
        images: [image],
        questions: Object.fromEntries(questions.map(({ questionId, ...question }) => [questionId, question])),
      });
      assert.deepEqual(result.responseBody!.value, { model, answers, usage: { input_tokens: 1000, output_tokens: 0 } });
      assert.equal(result.cost!.type, model === 'd1' ? 'number' : 'control-flow-excluded');
      if (model === 'd1') assert.equal(result.cost!.value, 0.00002);
      assert.doesNotMatch(JSON.stringify(result), /fixture-key/);
    }
  assert.equal(calls, 4);
  console.log(
    'Liquid real-HTTP simulation passed: d1/d1.1 inline/Profile, ordered shared images, Choice/Score/Noul, cost and credential privacy.',
  );
} finally {
  globalThis.fetch = realFetch;
}
