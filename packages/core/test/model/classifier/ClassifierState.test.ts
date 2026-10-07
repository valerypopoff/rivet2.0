import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArrayNodeImpl,
  AssembleMessageNodeImpl,
  AssemblePromptNodeImpl,
  ClassifierEvaluateNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  createBuiltInRegistry,
  type DataValue,
  type GraphId,
  type InternalProcessContext,
  type NodeConnection,
  type NodeGraph,
  type PortId,
  type Project,
  type ProjectId,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';
import { normalizeClassifierState, systemOneState } from '../../../src/model/classifier/state.js';
import { getClassifierProvider } from '../../../src/model/classifier/providers.js';
import { classifierImageFromText, inspectClassifierImage } from '../../../src/model/classifier/images.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const url = `data:image/png;base64,${png}`;
const native = () => ({ mediaType: 'image/png' as const, data: Uint8Array.from(Buffer.from(png, 'base64')) });
const questions = [{ questionId: 'q', type: 'noul' as const, instructions: 'Does the image match the description?' }];
const context = {
  executor: 'nodejs',
  signal: new AbortController().signal,
  settings: {
    classifierProviders: { openai: { apiKey: 'test' }, liquid: { apiKey: 'test' }, jev: { apiKey: 'test' } },
  },
} as InternalProcessContext;

test('State accepts native images, data URLs and recognizable bare base64 without interpreting ordinary base64 text', () => {
  for (const input of [
    { type: 'image', value: native() },
    { type: 'string', value: url },
    { type: 'string', value: png },
    { type: 'any', value: native() },
  ] as DataValue[]) {
    assert.deepEqual(normalizeClassifierState(input), {
      state: '',
      stateMessages: [{ parts: [{ type: 'image', dataUrl: url }] }],
    });
  }
  for (const text of ['test', 'AQID', 'data:application/json;base64,e30=', 'https://example.com/image.png']) {
    assert.deepEqual(normalizeClassifierState({ type: 'string', value: text }), { state: text });
  }
  assert.equal(classifierImageFromText(png), url);
});

test('Structured objects and legacy JSON arrays are not reinterpreted as multimodal content', () => {
  for (const input of [
    { type: 'object', value: { image: url, type: 'user', message: 'data, not a message' } },
    { type: 'object[]', value: [{ type: 'image', data: png }] },
    { type: 'any[]', value: ['one', 'two'] },
    { type: 'any', value: [1, true, null, { mediaType: 'text/plain', data: 'data' }] },
  ] as DataValue[])
    assert.deepEqual(normalizeClassifierState(input), { state: input.value });
  assert.deepEqual(normalizeClassifierState({ type: 'string[]', value: ['one', 'two'] }), {
    state: '',
    stateMessages: [
      {
        parts: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
    ],
  });
  assert.deepEqual(normalizeClassifierState({ type: 'image[]', value: [] }), { state: '' });
});

test('Real Assemble Message and Array nodes retain multimodal ordering and message boundaries through both adapters', async () => {
  const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Reference' },
    part2: { type: 'image', value: native() },
    part3: { type: 'string', value: 'Caption' },
  });
  const candidateNode = AssembleMessageNodeImpl.create();
  candidateNode.data.useTypeInput = true;
  const candidate = await new AssembleMessageNodeImpl(candidateNode).process({
    type: { type: 'string', value: 'user' },
    part1: { type: 'string', value: 'Candidate' },
    part2: { type: 'image', value: native() },
  });
  const combined = await new ArrayNodeImpl(ArrayNodeImpl.create()).process({
    input1: assembled.message,
    input2: candidate.message,
  });
  const normalized = normalizeClassifierState(combined.output);
  assert.deepEqual(
    normalizeClassifierState({ type: 'chat-message[]', value: combined.output!.value as any }),
    normalized,
  );
  assert.deepEqual(systemOneState(normalized), {
    state: 'Reference\n[Image 1]\nCaption\n\nCandidate\n[Image 2]',
    images: [url, url],
  });
  for (const provider of ['openai', 'liquid']) {
    const node = ClassifierEvaluateNodeImpl.create();
    const evaluate = new ClassifierEvaluateNodeImpl({
      ...node,
      data: { ...node.data, provider, outputRequestBody: true },
    });
    const original = globalThis.fetch;
    let sent: any;
    globalThis.fetch = async (_endpoint, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json(
        provider === 'openai'
          ? {
              model: 'gpt-6-luna',
              answers: [{ name: 'q', type: 'predicate', probability: 0.8 }],
              usage: { input_tokens: 1, output_tokens: 0 },
            }
          : { model: 'd1', answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 0 } },
      );
    };
    try {
      const output = await evaluate.process(
        {
          state:
            provider === 'openai' ? { type: 'chat-message[]', value: combined.output!.value as any } : combined.output,
          question1: { type: 'object[]', value: questions },
        },
        context,
      );
      assert.deepEqual(output['requestBody' as PortId]!.value, sent);
      if (provider === 'openai')
        assert.deepEqual(sent.input, [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Reference' },
              { type: 'input_image', image_url: url },
              { type: 'input_text', text: 'Caption' },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Candidate' },
              { type: 'input_image', image_url: url },
            ],
          },
        ]);
      else {
        assert.equal(sent.state, 'Reference\n[Image 1]\nCaption\n\nCandidate\n[Image 2]');
        assert.deepEqual(sent.images, [url, url]);
      }
      assert.equal((output.answers!.value as any).q.noul, 0.8);
    } finally {
      globalThis.fetch = original;
    }
  }
});

test('Assemble Prompt combines scalar and array messages in port order without losing image-only evidence', async () => {
  const assembled = await new AssembleMessageNodeImpl(AssembleMessageNodeImpl.create()).process({
    part1: { type: 'string', value: 'Reference' },
    part2: { type: 'image', value: native() },
  });
  const reference = assembled.message!;
  assert.equal(reference.type, 'chat-message');
  const node = AssemblePromptNodeImpl.create();
  node.data.filterEmptyPrompts = true;
  node.data.isLastMessageCacheBreakpoint = true;
  const prompt = await new AssemblePromptNodeImpl(node).process(
    {
      message10: { type: 'chat-message', value: { type: 'user', message: 'Last' } },
      message2: {
        type: 'chat-message[]',
        value: [
          { type: 'user', message: '   ' },
          { type: 'user', message: [{ type: 'image', ...native() }] },
        ],
      },
      message1: reference,
      message3: { type: 'control-flow-excluded', value: undefined },
    },
    context,
  );
  assert.equal(prompt.prompt!.type, 'chat-message[]');
  assert.equal((prompt.prompt!.value as any[]).length, 3);
  assert.equal((prompt.prompt!.value as any[])[2].isCacheBreakpoint, true);
  const normalized = normalizeClassifierState(prompt.prompt);
  assert.deepEqual(normalized, {
    state: '',
    stateMessages: [
      {
        parts: [
          { type: 'text', text: 'Reference' },
          { type: 'image', dataUrl: url },
        ],
      },
      { parts: [{ type: 'image', dataUrl: url }] },
      { parts: [{ type: 'text', text: 'Last' }] },
    ],
  });
  assert.deepEqual(systemOneState(normalized), {
    state: 'Reference\n[Image 1]\n\n[Image 2]\n\nLast',
    images: [url, url],
  });
  const empty = await new AssemblePromptNodeImpl(node).process(
    {
      message1: { type: 'chat-message[]', value: [{ type: 'user', message: '  ' }] },
    },
    context,
  );
  assert.deepEqual(normalizeClassifierState(empty.prompt), { state: '' });
});

test('Unsupported State messages and evidence fail rather than losing information', () => {
  for (const role of ['system', 'developer', 'assistant', 'function'])
    assert.throws(
      () =>
        normalizeClassifierState({
          type: 'chat-message',
          value: { type: role, message: 'text' },
        } as DataValue),
      /only user messages/,
    );
  for (const part of [
    { type: 'url', url: 'https://example.com/image.png' },
    { type: 'document', data: new Uint8Array([1]) },
    null,
    undefined,
  ]) {
    assert.throws(
      () => normalizeClassifierState({ type: 'chat-message', value: { type: 'user', message: [part] } } as DataValue),
      /Multimodal State/,
    );
  }
  for (const image of [
    'data:image/png;base64,AQID',
    url.replace('image/png', 'image/jpeg'),
    'data:image/svg+xml;base64,PHN2Zz4=',
  ]) {
    assert.throws(() => normalizeClassifierState({ type: 'string', value: image }), /State images/);
  }
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => normalizeClassifierState({ type: 'any[]', value: cyclic }), /circular/);
  assert.throws(() => normalizeClassifierState({ type: 'any[]', value: new Array(1) }), /JSON-compatible/);
});

test('State rejects mismatched declared types before interpreting the value', () => {
  for (const input of [
    { type: 'string', value: ['text'] },
    { type: 'object', value: 'text' },
    { type: 'image', value: [native()] },
    { type: 'chat-message', value: [{ type: 'user', message: 'text' }] },
    { type: 'object[]', value: { text: 'text' } },
    { type: 'any[]', value: 'text' },
    { type: 'number', value: 'text' },
  ])
    assert.throws(() => normalizeClassifierState(input as DataValue), /State.*(?:type|array|string)/);
});

test('State header inspection avoids decoding entire PNG payloads while validating the complete base64 string', () => {
  const payload = png.slice(0, 48) + 'A'.repeat(4 * 1024 * 1024);
  const original = globalThis.atob;
  let decodedCharacters = 0;
  globalThis.atob = (value) => {
    decodedCharacters += value.length;
    return original(value);
  };
  try {
    assert.equal(classifierImageFromText(payload), `data:image/png;base64,${payload}`);
    assert.equal(inspectClassifierImage(`data:image/png;base64,${payload}`).width, 1);
    assert.equal(decodedCharacters, 96);
    assert.throws(() => inspectClassifierImage(`data:image/png;base64,${payload.slice(0, -1)}!`), /State images/);
  } finally {
    globalThis.atob = original;
  }
});

test('JPEG inspection skips large metadata and pixel payloads with one shared native/base64 parser', () => {
  const bytes = new Uint8Array(65_549 + 4 * 1024 * 1024);
  bytes.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
  bytes.set([0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1], 65_539);
  const base64 = Buffer.from(bytes).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;
  const original = globalThis.atob;
  let decodedCharacters = 0;
  globalThis.atob = (value) => {
    decodedCharacters += value.length;
    return original(value);
  };
  try {
    assert.deepEqual(inspectClassifierImage(dataUrl), { mediaType: 'image/jpeg', width: 3, height: 2 });
    assert.equal(classifierImageFromText(base64), dataUrl);
    assert.ok(decodedCharacters <= 16_384, `Decoded ${decodedCharacters} characters`);
    assert.deepEqual(normalizeClassifierState({ type: 'image', value: { mediaType: 'image/jpeg', data: bytes } }), {
      state: '',
      stateMessages: [{ parts: [{ type: 'image', dataUrl }] }],
    });
    const truncated = Buffer.from(bytes.subarray(0, 65_540)).toString('base64');
    assert.throws(() => inspectClassifierImage(`data:image/jpeg;base64,${truncated}`), /State images/);
    const fill = new Uint8Array(8204 + 4 * 1024 * 1024);
    fill.set([0xff, 0xd8]);
    fill.fill(0xff, 2, 8194);
    fill.set([0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1], 8194);
    decodedCharacters = 0;
    assert.equal(inspectClassifierImage(`data:image/jpeg;base64,${Buffer.from(fill).toString('base64')}`).width, 3);
    assert.ok(decodedCharacters <= 16_384, 'Fill bytes caused repeated decoding of the same window');
  } finally {
    globalThis.atob = original;
  }
});

test('Mixed State content stops at the image limit before encoding the excess image', () => {
  const images = Array.from({ length: 129 }, (_, index) => ({
    type: 'image',
    data: native().data,
    // If the excess image were inspected/encoded before the count check,
    // its mismatched MIME type would throw an image error instead.
    mediaType: index < 128 ? 'image/png' : 'image/jpeg',
  }));
  for (const state of [
    { type: 'any[]', value: images },
    { type: 'chat-message', value: { type: 'user', message: images } },
  ])
    assert.throws(() => normalizeClassifierState(state as DataValue), /at most 128 images/);
});

test('Serialization hooks and disappearing question image fields cannot replace or discard evidence', async () => {
  const rewritten = Object.assign(['original'], { toJSON: () => ['replacement'] });
  assert.throws(() => normalizeClassifierState({ type: 'any[]', value: rewritten }), /serialization hooks/);
  const state = { original: 'text' };
  Object.defineProperty(state, 'toJSON', { value: () => ({ replacement: 'text' }) });
  assert.throws(() => normalizeClassifierState({ type: 'object', value: state }), /serialization hooks/);
  assert.deepEqual(normalizeClassifierState({ type: 'object', value: { toJSON: 'ordinary data' } }), {
    state: { toJSON: 'ordinary data' },
  });
  let calls = 0;
  const args = {
    apiKey: 'test',
    state: '',
    questions,
    signal: context.signal,
    timeoutMs: 1000,
    fetchImplementation: async () => {
      calls++;
      throw new Error('Unexpected network');
    },
  };
  for (const provider of ['openai', 'liquid', 'jev']) {
    const descriptor = getClassifierProvider(provider);
    for (const images of [undefined, () => [url]])
      await assert.rejects(
        descriptor.evaluate({
          ...args,
          model: descriptor.defaultModel,
          questions: [{ ...questions[0]!, images } as any],
        }),
        /Question-level images/,
      );
    const message = { parts: [{ type: 'image' as const, dataUrl: url }] };
    Object.defineProperty(message, 'toJSON', { value: () => ({ parts: [{ type: 'text', text: 'replacement' }] }) });
    await assert.rejects(
      descriptor.evaluate({ ...args, model: descriptor.defaultModel, stateMessages: [message] }),
      /serialization hooks/,
    );
  }
  assert.equal(calls, 0);
});

test('State preparation consumes the node timeout before any provider request', async () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  let now = 1000;
  let calls = 0;
  Date.now = () => {
    const current = now;
    now += 50;
    return current;
  };
  globalThis.fetch = async () => {
    calls++;
    throw new Error('Unexpected network');
  };
  const state: DataValue = { type: 'image', value: native() };
  const node = ClassifierEvaluateNodeImpl.create();
  try {
    await assert.rejects(
      new ClassifierEvaluateNodeImpl({
        ...node,
        data: { ...node.data, provider: 'openai', timeoutMs: 100 },
      }).process({ state, question1: { type: 'object[]', value: questions } }, context),
      /timed out after 100 ms/,
    );
    assert.equal(calls, 0);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test('Provider deadlines may shorten but never extend the timeout and reject non-finite budgets', async () => {
  const args = {
    apiKey: 'test',
    model: 'gpt-6-luna',
    state: 'text',
    questions,
    signal: context.signal,
    timeoutMs: 100,
  };
  let calls = 0;
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    now += 101;
    return Response.json({
      model: 'gpt-6-luna',
      answers: [{ name: 'q', type: 'predicate', probability: 0.8 }],
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
  try {
    const provider = getClassifierProvider('openai');
    await assert.rejects(provider.evaluate({ ...args, fetchImplementation, deadline: 999 }), /timed out/);
    assert.equal(calls, 0);
    for (const invalid of [NaN, Infinity, -1, 0])
      await assert.rejects(
        provider.evaluate({ ...args, fetchImplementation, timeoutMs: invalid }),
        /timeout and deadline/,
      );
    await assert.rejects(
      provider.evaluate({ ...args, fetchImplementation, deadline: Infinity }),
      /timeout and deadline/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      provider.evaluate({ ...args, fetchImplementation, deadline: 100_000 }),
      /timed out after 100 ms/,
    );
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

for (const combiner of ['Array', 'Assemble Prompt'] as const) {
  test(`A complete ${combiner} graph preserves mixed State without split runs and rejects removed Images wires`, async () => {
    const input = (id: string, dataType: string) => {
      const node = GraphInputNodeImpl.create();
      return { ...node, data: { ...node.data, id, dataType } };
    };
    const text = input('text', 'string');
    const candidate = input('candidate', 'string');
    const role = input('role', 'string');
    const image = input('image', 'image');
    const question = input('questions', 'object[]');
    const assembled = AssembleMessageNodeImpl.create();
    const candidateMessage = AssembleMessageNodeImpl.create();
    candidateMessage.data.useTypeInput = true;
    const array = combiner === 'Array' ? ArrayNodeImpl.create() : AssemblePromptNodeImpl.create();
    const messageList = AssemblePromptNodeImpl.create();
    const evaluate = ClassifierEvaluateNodeImpl.create();
    evaluate.data.provider = 'openai';
    evaluate.data.outputRequestBody = true;
    const output = GraphOutputNodeImpl.create();
    output.data.id = 'request';
    output.data.dataType = 'object';
    const wire = (from: string, outputId: string, to: string, inputId: string) =>
      ({
        outputNodeId: from,
        outputId,
        inputNodeId: to,
        inputId,
      }) as NodeConnection;
    const graph: NodeGraph = {
      metadata: { id: 'classifier-state' as GraphId, name: 'Classifier State', description: '' },
      nodes: [
        text,
        candidate,
        role,
        image,
        question,
        assembled,
        candidateMessage,
        ...(combiner === 'Assemble Prompt' ? [messageList] : []),
        array,
        evaluate,
        output,
      ],
      connections: [
        wire(text.id, 'data', assembled.id, 'part1'),
        wire(image.id, 'data', assembled.id, 'part2'),
        wire(candidate.id, 'data', candidateMessage.id, 'part1'),
        wire(image.id, 'data', candidateMessage.id, 'part2'),
        wire(role.id, 'data', candidateMessage.id, 'type'),
        ...(combiner === 'Array'
          ? [wire(assembled.id, 'message', array.id, 'input1')]
          : [
              wire(assembled.id, 'message', messageList.id, 'message1'),
              wire(messageList.id, 'prompt', array.id, 'message1'),
            ]),
        wire(candidateMessage.id, 'message', array.id, combiner === 'Array' ? 'input2' : 'message2'),
        wire(array.id, combiner === 'Array' ? 'output' : 'prompt', evaluate.id, 'state'),
        wire(question.id, 'data', evaluate.id, 'question1'),
        wire(evaluate.id, 'requestBody', output.id, 'value'),
      ],
    };
    const project: Project = {
      metadata: {
        id: 'classifier-project' as ProjectId,
        title: 'Classifier',
        description: '',
        mainGraphId: graph.metadata!.id,
      },
      graphs: { [graph.metadata!.id]: graph },
      plugins: [],
    };
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json(
        evaluate.data.provider === 'openai'
          ? {
              model: 'gpt-6-luna',
              answers: [{ name: 'q', type: 'predicate', probability: 0.8 }],
              usage: { input_tokens: 1, output_tokens: 0 },
            }
          : { model: 'd1', answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 0 } },
      );
    };
    let nodeError = '';
    const run = (messageRole = 'user') => {
      const processor = new GraphProcessor(project, graph.metadata!.id, createBuiltInRegistry());
      processor.on('nodeError', ({ error }) => {
        nodeError = String(error);
      });
      return processor.processGraph(
        { ...testProcessContext(), settings: context.settings },
        {
          text: { type: 'string', value: 'Caption' },
          candidate: { type: 'string', value: 'Candidate' },
          role: { type: 'string', value: messageRole },
          image: { type: 'image', value: native() },
          questions: { type: 'object[]', value: questions },
        },
      );
    };
    try {
      const openai = await run();
      assert.deepEqual((openai.request!.value as any).input, [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Caption' },
            { type: 'input_image', image_url: url },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Candidate' },
            { type: 'input_image', image_url: url },
          ],
        },
      ]);
      evaluate.data.provider = 'liquid';
      const liquid = await run();
      assert.equal((liquid.request!.value as any).state, 'Caption\n[Image 1]\n\nCandidate\n[Image 2]');
      assert.deepEqual((liquid.request!.value as any).images, [url, url]);
      for (const provider of ['openai', 'liquid', 'jev']) {
        evaluate.data.provider = provider;
        for (const unsupportedRole of ['system', 'developer', 'assistant', 'function']) {
          await assert.rejects(run(unsupportedRole), /failed to process/);
          assert.match(nodeError, /only user messages/);
        }
      }
      graph.connections.push(wire(image.id, 'data', evaluate.id, 'images'));
      await assert.rejects(run(), /failed to process/);
      assert.match(nodeError, /Connect images.*State/);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = original;
    }
  });
}

test('Provider-specific image count, complete UTF-8 request bytes, dimensions and capability are checked before IO', async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    throw new Error('Unexpected network');
  };
  const args = {
    apiKey: 'test',
    state: '',
    questions,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    fetchImplementation,
  };
  const content = (count: number) => [
    { parts: Array.from({ length: count }, () => ({ type: 'image' as const, dataUrl: url })) },
  ];
  await assert.rejects(
    getClassifierProvider('liquid').evaluate({ ...args, model: 'd1', stateMessages: content(9) }),
    /at most 8/,
  );
  await assert.rejects(
    getClassifierProvider('openai').evaluate({ ...args, model: 'gpt-6-luna', stateMessages: content(129) }),
    /at most 128/,
  );
  await assert.rejects(
    getClassifierProvider('jev').evaluate({ ...args, model: 'jev-latest', stateMessages: content(1) }),
    /does not support/,
  );
  await assert.rejects(
    getClassifierProvider('liquid').evaluate({ ...args, model: 'd1', state: '界'.repeat(1_500_000) }),
    /4.5 MB/,
  );
  await assert.rejects(
    getClassifierProvider('liquid').evaluate({
      ...args,
      model: 'd1',
      questions: [{ ...questions[0]!, instructions: 'a'.repeat(4_500_000) }],
    }),
    /4.5 MB/,
  );
  for (const [width, height, error] of [
    [101, 1, /100:1/],
    [3201, 3201, /10,000 patches/],
  ] as const) {
    const bytes = native().data;
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    await assert.rejects(
      getClassifierProvider('liquid').evaluate({
        ...args,
        model: 'd1',
        stateMessages: [{ parts: [{ type: 'image', dataUrl }] }],
      }),
      error,
    );
  }
  assert.equal(calls, 0);
});

test('Image header inspection recognizes JPEG, GIF and all WebP dimension layouts', () => {
  const fixtures: [string, Uint8Array, number, number][] = [
    ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 3, 1]), 3, 2],
    [
      'image/gif',
      Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')),
      1,
      1,
    ],
  ];
  for (const chunk of ['VP8X', 'VP8 ', 'VP8L']) {
    const bytes = new Uint8Array(30);
    bytes.set(Buffer.from('RIFF'), 0);
    bytes.set(Buffer.from('WEBP'), 8);
    bytes.set(Buffer.from(chunk), 12);
    if (chunk === 'VP8X') {
      bytes[24] = 2;
      bytes[27] = 1;
    } else if (chunk === 'VP8 ') {
      bytes.set([0x9d, 1, 0x2a, 3, 0, 2, 0], 23);
    } else {
      bytes[20] = 0x2f;
      new DataView(bytes.buffer).setUint32(21, 2 | (1 << 14), true);
    }
    fixtures.push(['image/webp', bytes, 3, 2]);
  }
  for (const [mediaType, bytes, width, height] of fixtures) {
    const base64 = Buffer.from(bytes).toString('base64');
    assert.deepEqual(inspectClassifierImage(`data:${mediaType};base64,${base64}`), { mediaType, width, height });
    assert.equal(classifierImageFromText(base64), `data:${mediaType};base64,${base64}`);
  }
});

test('Ambiguous provider evidence and the removed Images input fail before network rather than discarding data', async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls++;
    throw new Error('Unexpected network');
  };
  const args = {
    apiKey: 'test',
    model: 'gpt-6-luna',
    state: 'do not discard me',
    questions,
    signal: context.signal,
    timeoutMs: 1000,
    fetchImplementation,
  };
  await assert.rejects(
    getClassifierProvider('openai').evaluate({
      ...args,
      stateMessages: [{ parts: [{ type: 'image', dataUrl: url }] }],
    }),
    /cannot be supplied together/,
  );
  await assert.rejects(
    getClassifierProvider('openai').evaluate({ ...args, images: [url] } as any),
    /not a separate images field/,
  );
  const node = ClassifierEvaluateNodeImpl.create();
  const evaluate = new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, provider: 'openai' } });
  await assert.rejects(
    evaluate.process(
      { images: { type: 'image', value: native() }, question1: { type: 'object[]', value: questions } },
      context,
    ),
    /Connect images.*State/,
  );
  assert.equal(calls, 0);
});

test('Text-only user messages work for Jev and multimodal failures use ordinary node failure outputs', async () => {
  const original = globalThis.fetch;
  let sent: any;
  globalThis.fetch = async (_endpoint, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({
      model: 'jev-latest',
      answers: { q: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
  try {
    const node = ClassifierEvaluateNodeImpl.create();
    const evaluate = new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, catchRequestFailed: true } });
    await evaluate.process(
      {
        state: {
          type: 'chat-message[]',
          value: [
            { type: 'user', message: ['One', 'Two'] },
            { type: 'user', message: 'Three' },
          ],
        },
        question1: { type: 'object[]', value: questions },
      },
      context,
    );
    assert.equal(sent.state, 'One\nTwo\n\nThree');
    const output = await evaluate.process(
      { state: { type: 'image', value: native() }, question1: { type: 'object[]', value: questions } },
      context,
    );
    assert.equal(output.runFailed?.value, true);
    assert.match(String(output.runError?.value), /does not support classifier images/);
    assert.equal(output.answers?.type, 'control-flow-excluded');
  } finally {
    globalThis.fetch = original;
  }
});
