import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  AssembleMessageNodeImpl,
  AssemblePromptNodeImpl,
  ArrayNodeImpl,
  ClassifierQuestionNodeImpl,
  ClassifierEvaluateNodeImpl,
  ClassifierProfileNodeImpl,
  GraphProcessor,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  createBuiltInRegistry,
  type Project,
  type NodeConnection,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';
import type { DataValue } from '../../../src/model/DataValue.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { ClassifierQuestionDefinition } from '../../../src/model/classifier/types.js';
import { getClassifierProvider } from '../../../src/model/classifier/providers.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
// Header-only preflight fixture. Real HTTP verification uses a complete generated PNG.
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
bytes.writeUInt32BE(280, 16);
bytes.writeUInt32BE(280, 20);
const image = { mediaType: 'image/png' as const, data: bytes };
const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
const context = (): InternalProcessContext =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { jev: { apiKey: 'fixture' }, openai: { apiKey: 'fixture' } } },
    graphInputNodeValues: {},
    contextValues: {},
    getGlobal: () => undefined,
  }) as InternalProcessContext;

async function makeQuestion(input: DataValue, type: 'choice' | 'score' | 'noul' = 'noul') {
  const node = ClassifierQuestionNodeImpl.create();
  Object.assign(node.data, {
    questionId: 'q',
    questionType: type,
    useInstructionsInput: true,
    options: [
      { key: 'yes', value: 'Matches' },
      { key: 'no', value: 'Different' },
    ],
    scoreCriteria: undefined,
    levels: ['Low', 'High'],
    noulTrueCriteria: 'Matches',
    noulFalseCriteria: 'Different',
  });
  const output = await new ClassifierQuestionNodeImpl(node).process({ instructions: input }, context());
  return output.question!.value as ClassifierQuestionDefinition;
}

function response(provider: string, questions: ClassifierQuestionDefinition[]) {
  return Response.json({
    model: getClassifierProvider(provider).defaultModel,
    answers:
      provider === 'openai'
        ? questions.map((q) =>
            q.type === 'noul'
              ? { name: q.questionId, type: 'predicate', probability: 0.8 }
              : q.type === 'choice'
                ? {
                    name: q.questionId,
                    type: 'choice',
                    choice: 'yes',
                    confidence: 0.8,
                    probabilities: [
                      { value: 'yes', probability: 0.8 },
                      { value: 'no', probability: 0.2 },
                    ],
                  }
                : {
                    name: q.questionId,
                    type: 'score',
                    score: 0.8,
                    confidence: 0.8,
                    probabilities: [
                      { value: 0, label: 'Low', probability: 0.2 },
                      { value: 1, label: 'High', probability: 0.8 },
                    ],
                  },
          )
        : Object.fromEntries(
            questions.map((q) => [
              q.questionId,
              q.type === 'noul'
                ? { type: 'noul', noul: 0.8 }
                : q.type === 'choice'
                  ? { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } }
                  : {
                      type: 'score',
                      score: 0.8,
                      legend: { 0: 'Low', 1: 'High' },
                      probabilities: { 0: 0.2, 1: 0.8 },
                      confidence: 0.8,
                    },
            ]),
          ),
    usage: { input_tokens: 100, output_tokens: 0 },
  });
}

test('Question Instructions accept native images, Assemble Message and Assemble Prompt without array splitting', async () => {
  const message = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Before' },
    part2: { type: 'image', value: image },
    part3: { type: 'string', value: 'After' },
  });
  const prompt = await new AssemblePromptNodeImpl(AssemblePromptNodeImpl.create()).process(
    {
      message1: message.message,
      message2: { type: 'chat-message', value: { type: 'user', message: 'Last' } },
    },
    context(),
  );
  for (const input of [{ type: 'image', value: image } as DataValue, message.message!, prompt.prompt!]) {
    const question = await makeQuestion(input);
    assert.equal(question.instructions, '');
    assert.equal(question.instructionsMessages!.flatMap((m) => m.parts).filter((p) => p.type === 'image').length, 1);
    assert.equal(question.instructionsMessages![0]!.parts.find((p) => p.type === 'image')!.dataUrl, dataUrl);
  }
  const definition = new ClassifierQuestionNodeImpl({
    ...ClassifierQuestionNodeImpl.create(),
    data: { ...ClassifierQuestionNodeImpl.create().data, useInstructionsInput: true },
  })
    .getInputDefinitions()
    .find((p) => p.id === 'instructions')!;
  assert.equal(definition.splitRunBehavior, 'preserve-array');
  for (const type of ['image', 'image[]', 'chat-message', 'chat-message[]'])
    assert.ok(definition.dataType.includes(type as never));
});

test('Text-only User messages retain the same meaning through Any wrappers and Array; typed empty content is rejected', async () => {
  const message = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'First' },
  });
  const combined = await new ArrayNodeImpl(ArrayNodeImpl.create()).process({
    input1: message.message,
    input2: { type: 'chat-message', value: { type: 'user', message: 'Second' } },
  });
  for (const input of [{ type: 'any', value: message.message!.value } as DataValue, combined.output!]) {
    const q = await makeQuestion(input);
    assert.equal(q.instructions, '');
    assert.equal(q.instructionsMessages![0]!.parts[0]!.type, 'text');
    assert.equal((q.instructionsMessages![0]!.parts[0] as { text: string }).text, 'First');
    const result = await getClassifierProvider('liquid').evaluate({
      apiKey: 'fixture',
      model: 'd1',
      state: '',
      questions: [q],
      signal: context().signal,
      fetchImplementation: async () => response('liquid', [q]),
    });
    assert.equal(
      (result.requestBody.questions as any).q.instructions,
      input.type === 'any' ? 'First' : 'First\n\nSecond',
    );
  }
  for (const type of ['image[]', 'chat-message[]'] as const)
    await assert.rejects(makeQuestion({ type, value: [] }), /Instructions.*empty|instructions.*empty/);
  const filtered = AssemblePromptNodeImpl.create();
  filtered.data.filterEmptyPrompts = true;
  const emptyPrompt = await new AssemblePromptNodeImpl(filtered).process(
    {
      message1: { type: 'chat-message', value: { type: 'user', message: '  ' } },
    },
    context(),
  );
  await assert.rejects(makeQuestion(emptyPrompt.prompt!), /Instructions.*empty/);
  // Existing list/JSON instructions must not be reinterpreted as a conversation.
  for (const type of ['string[]', 'any[]', 'object[]'] as const) {
    const value = type === 'object[]' ? [{ text: 'First' }] : ['First', 'Second'];
    const q = await makeQuestion({ type, value } as DataValue);
    assert.deepEqual(q.instructions, value);
    assert.equal(q.instructionsMessages, undefined);
  }
});

test('Jev and OpenAI retain question scope, criteria, bytes and order for every question type in inline/profile modes', async () => {
  const message = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Before' },
    part2: { type: 'image', value: image },
    part3: { type: 'string', value: 'After' },
  });
  for (const provider of ['jev', 'openai'])
    for (const mode of ['inline', 'profile'])
      for (const type of ['choice', 'score', 'noul'] as const) {
        const q = await makeQuestion(message.message!, type);
        const other: ClassifierQuestionDefinition = { questionId: 'other', type: 'noul', instructions: 'Text only' };
        const questions = [q, other];
        let body: any;
        let headers: Headers | undefined;
        let calls = 0;
        globalThis.fetch = async (_url, init) => {
          calls++;
          body = JSON.parse(String(init?.body));
          headers = new Headers(init?.headers);
          return response(provider, questions);
        };
        const model = getClassifierProvider(provider).defaultModel;
        const node = ClassifierEvaluateNodeImpl.create();
        Object.assign(node.data, { provider, model, configurationMode: mode, outputRequestBody: true });
        const profile = ClassifierProfileNodeImpl.create();
        Object.assign(profile.data, { provider, model });
        const profiles = await new ClassifierProfileNodeImpl(profile).process({}, { ...context(), node: profile });
        const output = await new ClassifierEvaluateNodeImpl(node).process(
          {
            question1: { type: 'object[]', value: questions },
            ...(mode === 'profile' ? { classifierProfile: profiles.profile } : {}),
          },
          context(),
        );
        assert.equal(calls, 1, `${provider}/${mode}/${type}`);
        assert.deepEqual(output.requestBody!.value, body);
        assert.equal(JSON.stringify(body).includes('instructionsMessages'), false);
        if (provider === 'jev') {
          assert.equal(body.state, '');
          assert.equal(headers!.get('TypeSafe-Danger-Zone-Images'), 'true');
          const references = Object.keys(body.assets);
          assert.equal(references.length, 1);
          assert.equal(body.assets[references[0]!].data_base64, bytes.toString('base64'));
          assert.equal(body.questions.q.instructions, `Before\n${references[0]}\nAfter`);
          assert.equal(body.questions.other.instructions, 'Text only');
          assert.deepEqual(body.questions.q.criteria, q.criteria);
        } else {
          assert.equal(body.input, '');
          assert.deepEqual(body.questions[0].instructions.slice(0, 3), [
            { type: 'input_text', text: 'Before' },
            { type: 'input_image', image_url: dataUrl },
            { type: 'input_text', text: 'After' },
          ]);
          assert.equal(body.questions[1].instructions, 'Text only');
          if (type === 'noul')
            assert.match(body.questions[0].instructions[3].text, /True criterion: Matches\nFalse criterion: Different/);
        }
      }
});

test('Unsupported models/providers and malformed content fail before HTTP without promoting or dropping images', async () => {
  const q = await makeQuestion({ type: 'image', value: image });
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    return response('jev', [q]);
  };
  const args = { apiKey: 'fixture', state: '', questions: [q], signal: context().signal, fetchImplementation };
  for (const id of ['liquid', 'subq', 'perplexity', 'openrouter']) {
    const provider = getClassifierProvider(id);
    await assert.rejects(
      provider.evaluate({ ...args, model: provider.defaultModel }),
      /does not support images in question instructions/,
    );
  }
  for (const id of ['jev', 'openai'])
    await assert.rejects(
      getClassifierProvider(id).evaluate({ ...args, model: 'unverified-model' }),
      /does not support images in question instructions/,
    );
  for (const role of ['assistant', 'system', 'function'])
    await assert.rejects(
      makeQuestion({ type: 'chat-message', value: { type: role, message: 'text' } } as DataValue),
      /only user messages/,
    );
  const provider = getClassifierProvider('openai');
  for (const changed of [
    { ...q, instructions: 'Conflicting evidence' },
    { ...q, instructionsMessages: [{ parts: [{ type: 'image', dataUrl: 'data:image/png;base64,AQID' }] }] },
    { ...q, instructionsMessages: [{ parts: [{ type: 'text', text: '  ' }] }] },
  ])
    await assert.rejects(provider.evaluate({ ...args, model: provider.defaultModel, questions: [changed] } as any));
  const dangerous = { ...q };
  Object.defineProperty(dangerous, 'instructionsMessages', {
    enumerable: true,
    get() {
      throw new Error('Getter executed');
    },
  });
  await assert.rejects(
    provider.evaluate({ ...args, model: provider.defaultModel, questions: [dangerous] }),
    /own, enumerable data field/,
  );
  const smallBytes = Buffer.from(bytes);
  smallBytes.writeUInt32BE(1, 16);
  const smallQuestion = await makeQuestion({ type: 'image', value: { mediaType: 'image/png', data: smallBytes } });
  await assert.rejects(
    getClassifierProvider('jev').evaluate({
      ...args,
      model: 'jev-latest',
      questions: [smallQuestion],
    }),
    /between 280 and 1568/,
  );
  assert.equal(calls, 0);
});

test('Question content stays detached through retries; Jev deduplicates assets across shared State and question scopes', async () => {
  const q = await makeQuestion({ type: 'image', value: image });
  let first: string | undefined;
  let calls = 0;
  const provider = getClassifierProvider('jev');
  const result = await provider.evaluate({
    apiKey: 'fixture',
    model: provider.defaultModel,
    signal: context().signal,
    state: '',
    stateMessages: q.instructionsMessages,
    questions: [q],
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    fetchImplementation: async (_url, init) => {
      calls++;
      if (calls === 1) {
        first = String(init?.body);
        q.instructionsMessages![0]!.parts[0] = { type: 'text', text: 'MUTATED' };
        return new Response('', { status: 503 });
      }
      assert.equal(String(init?.body), first);
      return response('jev', [q]);
    },
  });
  assert.equal(calls, 2);
  const body = result.requestBody as any;
  assert.equal(Object.keys(body.assets).length, 1);
  assert.equal(body.questions.q.instructions, body.state);
  const legacy = await makeQuestion({ type: 'object', value: { text: 'Data', image: dataUrl } });
  assert.deepEqual(legacy.instructions, { text: 'Data', image: dataUrl });
  assert.equal(legacy.instructionsMessages, undefined);
});

test('Complete graph routes Assemble Message/Prompt into Question Instructions once, with no duplicate evaluation', async () => {
  const input = GraphInputNodeImpl.create();
  Object.assign(input.data, { id: 'photo', dataType: 'image' });
  const text = GraphInputNodeImpl.create();
  Object.assign(text.data, { id: 'text', dataType: 'string' });
  const message = AssembleMessageNodeImpl.create();
  const prompt = AssemblePromptNodeImpl.create();
  const q = ClassifierQuestionNodeImpl.create();
  Object.assign(q.data, { questionType: 'noul', questionId: 'q', useInstructionsInput: true });
  const evaluate = ClassifierEvaluateNodeImpl.create();
  Object.assign(evaluate.data, { provider: 'openai', outputRequestBody: true });
  const output = GraphOutputNodeImpl.create();
  Object.assign(output.data, { id: 'request', dataType: 'object' });
  const wire = (from: string, port: string, to: string, inputId: string) =>
    ({
      outputNodeId: from,
      outputId: port,
      inputNodeId: to,
      inputId,
    }) as NodeConnection;
  for (const withPrompt of [false, true]) {
    const graph = {
      metadata: { id: 'main', name: 'Question image', description: '' },
      nodes: [input, text, message, ...(withPrompt ? [prompt] : []), q, evaluate, output],
      connections: [
        wire(text.id, 'data', message.id, 'part1'),
        wire(input.id, 'data', message.id, 'part2'),
        ...(withPrompt
          ? [wire(message.id, 'message', prompt.id, 'message1'), wire(prompt.id, 'prompt', q.id, 'instructions')]
          : [wire(message.id, 'message', q.id, 'instructions')]),
        wire(q.id, 'question', evaluate.id, 'question1'),
        wire(evaluate.id, 'requestBody', output.id, 'value'),
      ],
    };
    const project = {
      metadata: { id: 'project', title: 'Question images', mainGraphId: 'main' },
      graphs: { main: graph },
      plugins: [],
    } as unknown as Project;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response('openai', [{ questionId: 'q', type: 'noul', instructions: '' }]);
    };
    const processor = new GraphProcessor(project, 'main' as never, createBuiltInRegistry());
    const result = await processor.processGraph(
      { ...testProcessContext(), settings: context().settings },
      {
        photo: { type: 'image', value: image },
        text: { type: 'string', value: 'Identify this' },
      },
    );
    assert.equal(calls, 1);
    const body = result.request!.value as any;
    assert.equal(body.input, '');
    assert.deepEqual(body.questions[0].instructions, [
      { type: 'input_text', text: 'Identify this' },
      { type: 'input_image', image_url: dataUrl },
    ]);
  }
});

test('Incompatible profile falls back without discarding question images; request-wide image budget includes questions', async () => {
  const q = await makeQuestion({ type: 'image', value: image });
  const profiles = [];
  for (const provider of ['liquid', 'openai']) {
    const node = ClassifierProfileNodeImpl.create();
    Object.assign(node.data, { provider });
    const result = await new ClassifierProfileNodeImpl(node).process(
      {},
      {
        ...context(),
        node,
        settings: { classifierProviders: { liquid: { apiKey: 'fixture' }, openai: { apiKey: 'fixture' } } },
      },
    );
    profiles.push(result.profile!.value);
  }
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response('openai', [q]);
  };
  const node = ClassifierEvaluateNodeImpl.create();
  Object.assign(node.data, { configurationMode: 'profile', outputRequestBody: true });
  const result = await new ClassifierEvaluateNodeImpl(node).process(
    {
      question1: { type: 'object', value: q },
      classifierProfile: { type: 'any[]', value: profiles },
    },
    context(),
  );
  assert.equal(calls, 1);
  assert.equal((result.requestBody!.value as any).questions[0].instructions[0].image_url, dataUrl);
  await assert.rejects(
    getClassifierProvider('openai').evaluate({
      apiKey: 'fixture',
      model: 'gpt-6-luna',
      state: '',
      stateMessages: q.instructionsMessages,
      questions: Array.from({ length: 128 }, (_, index) => ({ ...q, questionId: String(index) })),
      signal: context().signal,
    }),
    /together must contain at most 128 images/,
  );
  assert.equal(calls, 1);
});

test('Distinct question images stay isolated across questions and independent requests on both adapters', async () => {
  const otherBytes = Buffer.from(bytes);
  otherBytes.writeUInt32BE(281, 20);
  const otherUrl = `data:image/png;base64,${otherBytes.toString('base64')}`;
  const first = await makeQuestion({ type: 'image', value: image });
  const second = {
    ...(await makeQuestion({ type: 'image', value: { mediaType: 'image/png', data: otherBytes } })),
    questionId: 'second',
  };
  for (const id of ['jev', 'openai']) {
    const provider = getClassifierProvider(id);
    for (const questions of [[first, second], [second]]) {
      let calls = 0;
      const result = await provider.evaluate({
        apiKey: 'fixture',
        model: provider.defaultModel,
        state: '',
        questions,
        signal: context().signal,
        fetchImplementation: async () => {
          calls++;
          return response(id, questions);
        },
      });
      assert.equal(calls, 1);
      const body = result.requestBody as any;
      const expected = questions.length === 2 ? [dataUrl, otherUrl] : [otherUrl];
      if (id === 'openai') {
        assert.equal(body.input, '');
        assert.deepEqual(
          body.questions.map((q: any) => q.name),
          questions.map((q) => q.questionId),
        );
        assert.deepEqual(
          body.questions.map((q: any) => q.instructions),
          expected.map((image_url) => [
            { type: 'input_image', image_url },
            { type: 'input_text', text: '\n\nTrue criterion: Matches\nFalse criterion: Different' },
          ]),
        );
      } else {
        assert.equal(body.state, '');
        assert.equal(Object.keys(body.assets).length, expected.length);
        assert.deepEqual(
          Object.keys(body.questions),
          questions.map((q) => q.questionId),
        );
        assert.deepEqual(
          questions.map((q) => body.assets[body.questions[q.questionId].instructions].data_base64),
          expected.map((url) => url.split(',')[1]),
        );
      }
    }
  }
});

test('Question message envelopes reject hidden content, getters, sparse parts, serialization hooks and excess work before HTTP', async () => {
  const q = await makeQuestion({ type: 'image', value: image });
  let calls = 0;
  let getters = 0;
  const imagePart = {
    type: 'image',
    get dataUrl() {
      getters++;
      return dataUrl;
    },
  };
  const message = {
    get parts() {
      getters++;
      return [{ type: 'image', dataUrl }];
    },
  };
  const hooks = [{ parts: [{ type: 'image', dataUrl }] }];
  Object.defineProperty(hooks, 'toJSON', {
    value: () => {
      getters++;
      return [];
    },
  });
  const hidden = { ...q };
  Object.defineProperty(hidden, 'instructionsMessages', { enumerable: false, value: q.instructionsMessages });
  const cases = [
    hidden,
    { ...q, instructionsMessages: [message] },
    { ...q, instructionsMessages: [{ parts: [imagePart] }] },
    { ...q, instructionsMessages: [{ parts: new Array(1) }] },
    { ...q, instructionsMessages: hooks },
  ];
  const provider = getClassifierProvider('openai');
  const args = {
    apiKey: 'fixture',
    model: provider.defaultModel,
    state: '',
    signal: context().signal,
    fetchImplementation: async () => {
      calls++;
      return response('openai', [q]);
    },
  };
  for (const bad of cases)
    await assert.rejects(provider.evaluate({ ...args, questions: [bad] } as any), /own|JSON|serialization/);
  for (const instructionsMessages of [
    Array.from({ length: 1025 }, () => ({ parts: [] })),
    [{ parts: Array.from({ length: 4097 }, () => ({ type: 'text', text: 'x' })) }],
  ])
    await assert.rejects(
      provider.evaluate({ ...args, questions: [{ ...q, instructionsMessages }] } as any),
      /too many messages|too many content parts/,
    );
  const abort = new AbortController();
  abort.abort(new Error('Question audit cancellation'));
  await assert.rejects(provider.evaluate({ ...args, questions: [q], signal: abort.signal }), /cancel|abort/i);
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});
