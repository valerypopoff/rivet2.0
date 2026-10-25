import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ClassifierQuestionNodeImpl,
  ClassifierEvaluateNodeImpl,
  ClassifierProfileNodeImpl,
} from '../../../src/index.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';
import { getClassifierProvider } from '../../../src/model/classifier/providers.js';
import { validateClassifierEvaluationResponse } from '../../../src/model/classifier/response.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
// Header-only preflight fixture; the local HTTP simulation uses a complete PNG.
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
bytes.writeUInt32BE(280, 16);
bytes.writeUInt32BE(280, 20);
const image = { type: 'image' as const, value: { mediaType: 'image/png' as const, data: bytes } };
const url = `data:image/png;base64,${bytes.toString('base64')}`;
const box = { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 };
const q = { questionId: 'target', type: 'box' as const, instructions: 'Find the mug' };
const context = (): InternalProcessContext =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { jev: { apiKey: 'fixture' } } },
    graphInputNodeValues: {},
    contextValues: {},
    getGlobal: () => undefined,
  }) as InternalProcessContext;
const reply = (answer: unknown = { type: 'box', box, confidence: 0.92 }) => ({
  model: 'jev-1.14.0',
  answers: { target: answer },
  usage: { input_tokens: 290, output_tokens: 21 },
});

void test('Bounding Box constructs criteria-free questions and ignores inactive criteria inputs/templates without deleting saved settings', async () => {
  const node = ClassifierQuestionNodeImpl.create();
  Object.assign(node.data, {
    questionId: 'target',
    questionType: 'box',
    instructions: 'Find {{target}}',
    useCriteriaInput: true,
    noulTrueCriteria: '{{inactive}}',
    options: [{ key: 'a', value: '{{unused}}' }],
  });
  const impl = new ClassifierQuestionNodeImpl(node);
  assert.deepEqual(
    impl.getInputDefinitions().map((input) => input.id),
    ['target'],
  );
  const inputs = { target: { type: 'string' as const, value: 'the mug' } };
  Object.defineProperty(inputs, 'criteria', {
    enumerable: true,
    get() {
      throw new Error('Inactive criteria was read');
    },
  });
  const output = await impl.process(inputs, context());
  assert.deepEqual(output.question!.value, q);
  assert.match((impl.getBody() as { text: string }).text, /Bounding Box/);
  const criteria = impl.getEditors().find((editor) => editor.type === 'group' && editor.label === 'Criteria')!;
  assert.equal(criteria.hideIf!(node.data), true);
  node.data.questionType = 'choice';
  assert.equal(
    impl.getInputDefinitions().some((input) => input.id === 'criteria'),
    true,
  );
  assert.equal(node.data.noulTrueCriteria, '{{inactive}}');
});

void test('Verified Jev Box models execute in inline/Profile modes with either shared or question-local images', async () => {
  for (const model of ['jev-1.14.0', 'jev-latest', 'jev-preview'])
    for (const mode of ['inline', 'profile'])
      for (const local of [false, true]) {
        const question = ClassifierQuestionNodeImpl.create();
        Object.assign(question.data, {
          questionType: 'box',
          questionId: 'target',
          instructions: 'Find the mug',
          useInstructionsInput: local,
        });
        const built = await new ClassifierQuestionNodeImpl(question).process(
          local ? { instructions: image } : {},
          context(),
        );
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, {
          model,
          configurationMode: mode,
          outputRequestBody: true,
          outputResponseBody: true,
          outputUsage: true,
        });
        const profile = ClassifierProfileNodeImpl.create();
        Object.assign(profile.data, { model });
        const profileOutput = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
        let calls = 0;
        let sent: any;
        let headers: Headers | undefined;
        globalThis.fetch = async (_url, init) => {
          calls++;
          sent = JSON.parse(String(init?.body));
          headers = new Headers(init?.headers);
          return Response.json(reply());
        };
        const output = await new ClassifierEvaluateNodeImpl(node).process(
          {
            question1: built.question,
            ...(!local ? { state: image } : {}),
            ...(mode === 'profile' ? { classifierProfile: profileOutput.profile } : {}),
          },
          context(),
        );
        assert.equal(calls, 1);
        assert.deepEqual(output.answers!.value, reply().answers);
        assert.deepEqual(output.responseBody!.value, reply());
        assert.equal(output.cost!.value, (290 * 0.042) / 1_000_000);
        assert.equal(headers!.get('TypeSafe-Danger-Zone-Images'), 'true');
        assert.deepEqual(sent.questions.target, {
          type: 'box',
          instructions: local ? Object.keys(sent.assets)[0] : 'Find the mug',
        });
        assert.equal(sent.state, local ? '' : Object.keys(sent.assets)[0]);
        assert.equal(Object.values(sent.assets as Record<string, any>)[0].data_base64, url.split(',')[1]);
      }
});

void test('Unsupported Box models, absent visible images and explicit criteria are rejected before HTTP', async () => {
  let calls = 0;
  const args = {
    apiKey: 'fixture',
    state: '',
    stateMessages: [{ parts: [{ type: 'image' as const, dataUrl: url }] }],
    questions: [q],
    signal: context().signal,
    fetchImplementation: async () => {
      calls++;
      return Response.json(reply());
    },
  };
  for (const [id, model] of [
    ['jev', 'jev-1.13.0'],
    ['jev', 'jev-future'],
    ['openai', 'gpt-6-luna'],
    ['liquid', 'd1'],
    ['subq', 'subq-snap-1.1'],
    ['perplexity', 'pplx-decider-v1.1-27b'],
    ['openrouter', 'microsoft/microsoft-decision-1'],
  ]) {
    await assert.rejects(
      getClassifierProvider(id!).evaluate({ ...args, model: model! }),
      /does not support Bounding Box/,
    );
  }
  for (const questions of [
    [q],
    [q, { questionId: 'other', type: 'noul', instructions: '', instructionsMessages: args.stateMessages }],
  ])
    await assert.rejects(
      getClassifierProvider('jev').evaluate({
        ...args,
        model: 'jev-latest',
        stateMessages: undefined,
        questions: questions as ClassifierQuestionDefinition[],
      }),
      /requires an image.*shared State.*own Instructions/,
    );
  for (const criteria of [null, {}, [], 'unused'])
    await assert.rejects(
      getClassifierProvider('jev').evaluate({ ...args, model: 'jev-latest', questions: [{ ...q, criteria }] }),
      /does not accept criteria/,
    );
  assert.equal(calls, 0);
});

void test('Box responses require own finite coordinates and confidence but preserve provider numerical values without clamping', () => {
  const valid = reply({ type: 'box', box: { top: 3, bottom: -2, left: 99, right: -5 }, confidence: 9.5 });
  assert.equal(validateClassifierEvaluationResponse(valid, [q]), valid);
  for (const field of ['top', 'bottom', 'left', 'right']) {
    const missing: Record<string, unknown> = { ...box };
    delete missing[field];
    assert.throws(
      () => validateClassifierEvaluationResponse(reply({ type: 'box', box: missing, confidence: 0.9 }), [q]),
      /box/,
    );
    for (const value of ['0.1', NaN, Infinity, null])
      assert.throws(
        () =>
          validateClassifierEvaluationResponse(
            reply({ type: 'box', box: { ...box, [field]: value }, confidence: 0.9 }),
            [q],
          ),
        /box/,
      );
  }
  for (const answer of [
    { type: 'box', box },
    { type: 'box', box: null, confidence: 0.9 },
    { type: 'box', box: { ...box, extra: 1 }, confidence: 0.9 },
    { type: 'noul', noul: 0.9 },
  ])
    assert.throws(() => validateClassifierEvaluationResponse(reply(answer), [q]));
  for (const confidence of [undefined, null, '0.9', NaN, Infinity])
    assert.throws(
      () => validateClassifierEvaluationResponse(reply({ type: 'box', box, confidence }), [q]),
      /confidence/,
    );
  const inherited = Object.assign(Object.create({ left: box.left }), {
    top: box.top,
    bottom: box.bottom,
    right: box.right,
  });
  assert.throws(
    () => validateClassifierEvaluationResponse(reply({ type: 'box', box: inherited, confidence: 0.9 }), [q]),
    /box/,
  );
});

void test('Box can share a batch with Noul and incompatible Profiles fall through without splitting or reinterpreting it', async () => {
  const profiles = [];
  for (const model of ['jev-1.13.0', 'jev-1.14.0']) {
    const node = ClassifierProfileNodeImpl.create();
    node.data.model = model;
    profiles.push((await new ClassifierProfileNodeImpl(node).process({}, { ...context(), node })).profile!.value);
  }
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, 'jev-1.14.0');
    return Response.json({ ...reply(), answers: { ...reply().answers, visible: { type: 'noul', noul: 0.97 } } });
  };
  const node = ClassifierEvaluateNodeImpl.create();
  node.data.configurationMode = 'profile';
  const result = await new ClassifierEvaluateNodeImpl(node).process(
    {
      state: image,
      classifierProfile: { type: 'any[]', value: profiles },
      question1: {
        type: 'object[]',
        value: [q, { questionId: 'visible', type: 'noul', instructions: 'Is the mug visible?' }],
      },
    },
    context(),
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.answers!.value, { ...reply().answers, visible: { type: 'noul', noul: 0.97 } });
});
