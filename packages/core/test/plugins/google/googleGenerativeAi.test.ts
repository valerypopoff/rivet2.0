import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  generativeAiGoogleModels as coreFacadeModels,
  googleModelsDeprecated as coreFacadeDeprecatedModels,
  streamChatCompletions,
  streamGenerativeAi as coreFacadeStream,
} from '../../../src/plugins/google/google.js';
import {
  generativeAiGoogleModels,
  generativeAiOptions,
  googleModelsDeprecated,
  googleModelOptionsDeprecated,
  streamGenerativeAi,
} from '../../../src/plugins/google/googleGenerativeAi.js';
import { ChatGoogleNodeImpl } from '../../../src/plugins/google/nodes/ChatGoogleNode.js';

type GoogleGenAiFixture = {
  constructorOptions: unknown[];
  requests: unknown[];
  createStream: (request: unknown) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
};

type GoogleGenAiFixtureGlobal = typeof globalThis & {
  __rivetGoogleGenAiFixture?: GoogleGenAiFixture;
};

const fixtureGlobal = globalThis as GoogleGenAiFixtureGlobal;
const fixtureModuleUrl = `data:text/javascript;base64,${Buffer.from(
  `export class GoogleGenAI {
    constructor(options) { globalThis.__rivetGoogleGenAiFixture.constructorOptions.push(options); }
    models = { generateContentStream: (request) => {
      globalThis.__rivetGoogleGenAiFixture.requests.push(request);
      return globalThis.__rivetGoogleGenAiFixture.createStream(request);
    }};
  }`,
).toString('base64')}`;

type VertexAiFixture = {
  constructorOptions: unknown[];
  modelOptions: unknown[];
  requests: unknown[];
  stream: AsyncIterable<unknown>;
};

type VertexAiFixtureGlobal = typeof globalThis & {
  __rivetVertexAiFixture?: VertexAiFixture;
};

const vertexFixtureGlobal = globalThis as VertexAiFixtureGlobal;
const vertexFixtureModuleUrl = `data:text/javascript;base64,${Buffer.from(
  `export class VertexAI {
    constructor(options) { globalThis.__rivetVertexAiFixture.constructorOptions.push(options); }
    preview = { getGenerativeModel: (options) => {
      globalThis.__rivetVertexAiFixture.modelOptions.push(options);
      return { generateContentStream: async (request) => {
        globalThis.__rivetVertexAiFixture.requests.push(request);
        return { stream: globalThis.__rivetVertexAiFixture.stream };
      }};
    }};
  }`,
).toString('base64')}`;

const requireFromTest = createRequire(import.meta.url);

async function withGoogleGenAiFixture<T>(fixture: GoogleGenAiFixture, action: () => Promise<T>): Promise<T> {
  const previousFixture = fixtureGlobal.__rivetGoogleGenAiFixture;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google/genai') {
        return { url: fixtureModuleUrl, shortCircuit: true };
      }

      return nextResolve(specifier, context);
    },
  });
  fixtureGlobal.__rivetGoogleGenAiFixture = fixture;

  try {
    return await action();
  } finally {
    fixtureGlobal.__rivetGoogleGenAiFixture = previousFixture;
    hooks.deregister();
  }
}

async function withVertexAiFixture<T>(fixture: VertexAiFixture, action: () => Promise<T>): Promise<T> {
  const previousFixture = vertexFixtureGlobal.__rivetVertexAiFixture;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@google-cloud/vertexai') {
        return { url: vertexFixtureModuleUrl, shortCircuit: true };
      }

      return nextResolve(specifier, context);
    },
  });
  vertexFixtureGlobal.__rivetVertexAiFixture = fixture;

  try {
    return await action();
  } finally {
    vertexFixtureGlobal.__rivetVertexAiFixture = previousFixture;
    hooks.deregister();
  }
}

test('Core facade retains the shared Google catalog exports and unpriced legacy entries', () => {
  assert.equal(coreFacadeStream, streamGenerativeAi);
  assert.equal(coreFacadeModels, generativeAiGoogleModels);
  assert.equal(coreFacadeDeprecatedModels, googleModelsDeprecated);
  assert.deepEqual(generativeAiGoogleModels, {
    'gemini-2.5-pro': {
      maxTokens: 1048576,
      cost: { prompt: 1.25 / 1000, completion: 10 / 1000 },
      displayName: 'Gemini 2.5 Pro',
    },
    'gemini-2.5-flash': {
      maxTokens: 1048576,
      cost: { prompt: 0.3 / 1000, completion: 2.5 / 1000 },
      displayName: 'Gemini 2.5 Flash',
    },
    'gemini-2.5-flash-lite-preview-06-17': {
      maxTokens: 1000000,
      cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
      displayName: 'Gemini 2.5 Flash Lite Preview',
    },
    'gemini-2.0-flash': {
      maxTokens: 1048576,
      cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
      displayName: 'Gemini 2.0 Flash',
    },
    'gemini-2.0-flash-lite': {
      maxTokens: 1048576,
      cost: { prompt: 0.075 / 1000, completion: 0.3 / 1000 },
      displayName: 'Gemini 2.0 Flash Lite',
    },
    'gemini-1.5-pro': {
      maxTokens: 2097152,
      displayName: 'Gemini 1.5 Pro',
      pricing: 'unpriced',
    },
    'gemini-1.5-flash': {
      maxTokens: 1048576,
      displayName: 'Gemini 1.5 Flash',
      pricing: 'unpriced',
    },
  });
  assert.deepEqual(generativeAiOptions, [
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite-preview-06-17', label: 'Gemini 2.5 Flash Lite Preview' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
  ]);
  assert.deepEqual(googleModelOptionsDeprecated, [
    { value: 'gemini-pro', label: 'Gemini Pro' },
    { value: 'gemini-pro-vision', label: 'Gemini Pro Vision' },
  ]);
  assert.ok(Number.isNaN(googleModelsDeprecated['gemini-pro'].cost.prompt));
  assert.ok(Number.isNaN(googleModelsDeprecated['gemini-pro-vision'].cost.completion));
});

test('shared Google stream preserves request data, chunk filtering, and lazy SDK loading', async () => {
  const signal = new AbortController().signal;
  const functionCalls = [{ name: 'lookup', args: { city: 'Tbilisi' } }];
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {
      yield {};
      yield { candidates: [{ content: { parts: [{ text: 'first' }] }, finishReason: 'FINISH_REASON_STOP' }] };
      yield { functionCalls };
      yield { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'FINISH_REASON_STOP' }] };
    },
  };

  await withGoogleGenAiFixture(fixture, async () => {
    const iterator = streamGenerativeAi({
      apiKey: 'synthetic-key',
      model: 'gemini-2.5-flash',
      systemPrompt: 'System prompt',
      prompt: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      maxOutputTokens: 321,
      temperature: 0,
      topP: 0.7,
      topK: undefined,
      signal,
      tools: [],
      thinkingBudget: 64,
      additionalHeaders: { 'X-Test': 'value' },
    });

    assert.deepEqual(fixture.constructorOptions, []);
    assert.deepEqual(fixture.requests, []);

    assert.deepEqual(await iterator.next(), {
      value: {
        completion: 'first',
        finish_reason: 'FINISH_REASON_STOP',
        function_calls: undefined,
        model: 'gemini-2.5-flash',
      },
      done: false,
    });
    assert.deepEqual(await iterator.next(), {
      value: {
        completion: undefined,
        finish_reason: undefined,
        function_calls: functionCalls,
        model: 'gemini-2.5-flash',
      },
      done: false,
    });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  assert.deepEqual(fixture.constructorOptions, [{ apiKey: 'synthetic-key' }]);
  assert.deepEqual(fixture.requests, [
    {
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      config: {
        systemInstruction: 'System prompt',
        maxOutputTokens: 321,
        temperature: 0,
        topP: 0.7,
        topK: undefined,
        tools: [],
        abortSignal: signal,
        thinkingConfig: { thinkingBudget: 64 },
        httpOptions: { headers: { 'X-Test': 'value' } },
      },
    },
  ]);
});

test('shared Google stream preserves explicit empty headers and undefined optional configuration', async () => {
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {},
  };

  await withGoogleGenAiFixture(fixture, async () => {
    await streamGenerativeAi({
      apiKey: 'empty-header-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 0,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
      thinkingBudget: undefined,
      additionalHeaders: {},
    }).next();
  });

  assert.deepEqual(fixture.requests, [
    {
      model: 'gemini-2.0-flash',
      contents: [],
      config: {
        systemInstruction: undefined,
        maxOutputTokens: 0,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        tools: undefined,
        abortSignal: undefined,
        thinkingConfig: { thinkingBudget: undefined },
        httpOptions: { headers: {} },
      },
    },
  ]);
});

test('shared Google stream preserves first-next failures and disposes an unfinished SDK iterator', async () => {
  const expectedError = new Error('provider failed');
  const failingFixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async createStream() {
      throw expectedError;
    },
  };

  await withGoogleGenAiFixture(failingFixture, async () => {
    await assert.rejects(
      streamGenerativeAi({
        apiKey: 'synthetic-key',
        model: 'gemini-2.0-flash',
        systemPrompt: undefined,
        prompt: [],
        maxOutputTokens: 1,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
        tools: undefined,
      }).next(),
      (error) => error === expectedError,
    );
  });

  let disposed = 0;
  const iteratorFixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {
      try {
        yield { candidates: [{ content: { parts: [{ text: 'first' }] } }] };
        yield { candidates: [{ content: { parts: [{ text: 'late' }] } }] };
      } finally {
        disposed += 1;
      }
    },
  };

  await withGoogleGenAiFixture(iteratorFixture, async () => {
    const iterator = streamGenerativeAi({
      apiKey: 'synthetic-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 1,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
    });
    await iterator.next();
    await iterator.return(undefined);
  });

  assert.equal(disposed, 1);
});

test('shared Google stream preserves tool-only empty arrays and errors after partial output', async () => {
  const expectedError = new Error('stream stopped after a partial response');
  let functionCallReads = 0;
  const toolOnlyChunk = {};
  Object.defineProperty(toolOnlyChunk, 'functionCalls', {
    enumerable: true,
    get() {
      functionCallReads += 1;
      return [];
    },
  });
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {
      // An empty array is still truthy in the pre-refactor implementation and
      // must remain a visible tool-call chunk rather than being filtered out.
      yield toolOnlyChunk;
      yield { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
      throw expectedError;
    },
  };

  await withGoogleGenAiFixture(fixture, async () => {
    const iterator = streamGenerativeAi({
      apiKey: 'synthetic-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 1,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
    });

    assert.deepEqual(await iterator.next(), {
      value: {
        completion: undefined,
        finish_reason: undefined,
        function_calls: [],
        model: 'gemini-2.0-flash',
      },
      done: false,
    });
    assert.equal(functionCallReads, 1);
    assert.deepEqual(await iterator.next(), {
      value: {
        completion: 'partial',
        finish_reason: undefined,
        function_calls: undefined,
        model: 'gemini-2.0-flash',
      },
      done: false,
    });
    await assert.rejects(iterator.next(), (error) => error === expectedError);
  });
});

test('shared Google stream keeps its first-candidate contract for empty and multi-part provider chunks', async () => {
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {
      yield { candidates: [] };
      yield { candidates: [{ content: { parts: [] } }] };
      yield {
        candidates: [
          { content: { parts: [{ text: 'first part' }, { text: 'ignored part' }] }, finishReason: 'STOP' },
          { content: { parts: [{ text: 'ignored candidate' }] }, finishReason: 'MAX_TOKENS' },
        ],
      };
    },
  };

  await withGoogleGenAiFixture(fixture, async () => {
    const iterator = streamGenerativeAi({
      apiKey: 'synthetic-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 1,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
    });

    assert.deepEqual(await iterator.next(), {
      value: {
        completion: 'first part',
        finish_reason: 'STOP',
        function_calls: undefined,
        model: 'gemini-2.0-flash',
      },
      done: false,
    });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
});

test('shared Google stream forwards pre-aborted signals, propagates later aborts, and permits an empty stream', async () => {
  const preAborted = new AbortController();
  preAborted.abort(new Error('already cancelled'));
  const laterAbort = new AbortController();
  const laterAbortError = new Error('cancelled after partial output');
  let observedPreAbortedSignal: AbortSignal | undefined;
  let observedLaterSignal: AbortSignal | undefined;

  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    createStream(request) {
      const signal = (request as { config: { abortSignal?: AbortSignal } }).config.abortSignal;

      if (signal === preAborted.signal) {
        observedPreAbortedSignal = signal;
        return (async function* () {})();
      }

      observedLaterSignal = signal;
      return (async function* () {
        yield { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      })();
    },
  };

  await withGoogleGenAiFixture(fixture, async () => {
    const preAbortedIterator = streamGenerativeAi({
      apiKey: 'pre-aborted-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 1,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      signal: preAborted.signal,
      tools: undefined,
    });
    assert.deepEqual(await preAbortedIterator.next(), { value: undefined, done: true });

    const laterAbortIterator = streamGenerativeAi({
      apiKey: 'later-abort-key',
      model: 'gemini-2.5-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 1,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      signal: laterAbort.signal,
      tools: undefined,
    });
    assert.equal((await laterAbortIterator.next()).value?.completion, 'partial');
    laterAbort.abort(laterAbortError);
    await assert.rejects(laterAbortIterator.next(), (error) => error === laterAbortError);
  });

  assert.equal(observedPreAbortedSignal, preAborted.signal);
  assert.equal(observedLaterSignal, laterAbort.signal);
});

test('shared Google streams keep concurrent request state isolated', async () => {
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream(request) {
      const typedRequest = request as { model: string; config: { maxOutputTokens: number } };
      yield {
        candidates: [
          { content: { parts: [{ text: `${typedRequest.model}:${typedRequest.config.maxOutputTokens}` }] } },
        ],
      };
    },
  };

  await withGoogleGenAiFixture(fixture, async () => {
    const first = streamGenerativeAi({
      apiKey: 'first-key',
      model: 'gemini-2.0-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 11,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
    });
    const second = streamGenerativeAi({
      apiKey: 'second-key',
      model: 'gemini-2.5-flash',
      systemPrompt: undefined,
      prompt: [],
      maxOutputTokens: 22,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      tools: undefined,
    });

    const [firstResult, secondResult] = await Promise.all([first.next(), second.next()]);
    assert.equal(firstResult.value?.completion, 'gemini-2.0-flash:11');
    assert.equal(secondResult.value?.completion, 'gemini-2.5-flash:22');
  });

  assert.deepEqual(fixture.constructorOptions, [{ apiKey: 'first-key' }, { apiKey: 'second-key' }]);
  assert.deepEqual(
    fixture.requests.map((request) => (request as { model: string }).model),
    ['gemini-2.0-flash', 'gemini-2.5-flash'],
  );
});

test('Core Vertex facade remains lazy and keeps its credential file path client-scoped', async () => {
  const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const fixture: VertexAiFixture = {
    constructorOptions: [],
    modelOptions: [],
    requests: [],
    stream: (async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'vertex result' }] }, finishReason: 'STOP' }] };
    })(),
  };

  try {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'ambient-credentials';
    await withVertexAiFixture(fixture, async () => {
      const iterator = streamChatCompletions({
        project: 'synthetic-project',
        location: 'synthetic-location',
        applicationCredentials: 'synthetic-credentials',
        model: 'gemini-pro',
        systemPrompt: 'Vertex system prompt',
        prompt: [],
        max_output_tokens: 123,
        temperature: 0,
        top_p: 0.5,
        top_k: 7,
      });

      assert.deepEqual(fixture.constructorOptions, []);
      assert.deepEqual(await iterator.next(), {
        value: { completion: 'vertex result', finish_reason: 'STOP', model: 'gemini-pro' },
        done: false,
      });
    });

    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'ambient-credentials');
    assert.deepEqual(fixture.constructorOptions, [
      {
        project: 'synthetic-project',
        location: 'synthetic-location',
        googleAuthOptions: { keyFilename: 'synthetic-credentials' },
      },
    ]);
    assert.deepEqual(fixture.modelOptions, [
      {
        model: 'gemini-pro',
        systemInstruction: 'Vertex system prompt',
        generationConfig: { maxOutputTokens: 123, temperature: 0, topP: 0.5, topK: 7 },
      },
    ]);
    assert.deepEqual(fixture.requests, [{ contents: [] }]);
  } finally {
    if (previousCredentials === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
    }
  }
});

test('Core Vertex facade isolates credential paths across consecutive runs', async () => {
  const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const fixture: VertexAiFixture = {
    constructorOptions: [],
    modelOptions: [],
    requests: [],
    stream: (async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'first result' }] }, finishReason: 'STOP' }] };
      yield { candidates: [{ content: { parts: [{ text: 'second result' }] }, finishReason: 'STOP' }] };
    })(),
  };

  try {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'ambient-credentials';
    await withVertexAiFixture(fixture, async () => {
      const first = streamChatCompletions({
        project: 'first-project',
        location: 'first-location',
        applicationCredentials: 'first-credentials.json',
        model: 'gemini-pro',
        prompt: [],
        max_output_tokens: 1,
      });
      const second = streamChatCompletions({
        project: 'second-project',
        location: 'second-location',
        applicationCredentials: 'second-credentials.json',
        model: 'gemini-pro',
        prompt: [],
        max_output_tokens: 1,
      });

      await first.next();
      await second.next();
    });

    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'ambient-credentials');
    assert.deepEqual(fixture.constructorOptions, [
      {
        project: 'first-project',
        location: 'first-location',
        googleAuthOptions: { keyFilename: 'first-credentials.json' },
      },
      {
        project: 'second-project',
        location: 'second-location',
        googleAuthOptions: { keyFilename: 'second-credentials.json' },
      },
    ]);
  } finally {
    if (previousCredentials === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
    }
  }
});

test('Core Vertex facade keeps empty and non-text completion behavior distinct from aborted streams', async () => {
  const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const createOptions = () => ({
    project: 'synthetic-project',
    location: 'synthetic-location',
    applicationCredentials: 'synthetic-credentials',
    model: 'gemini-pro' as const,
    prompt: [],
    max_output_tokens: 1,
  });

  try {
    const emptyFixture: VertexAiFixture = {
      constructorOptions: [],
      modelOptions: [],
      requests: [],
      stream: (async function* () {})(),
    };
    await withVertexAiFixture(emptyFixture, async () => {
      await assert.rejects(streamChatCompletions(createOptions()).next(), new Error('No chunks received.'));
    });

    const nonTextFixture: VertexAiFixture = {
      constructorOptions: [],
      modelOptions: [],
      requests: [],
      stream: (async function* () {
        yield { candidates: [{ content: { parts: [{}] }, finishReason: 'STOP' }] };
      })(),
    };
    await withVertexAiFixture(nonTextFixture, async () => {
      assert.deepEqual(await streamChatCompletions(createOptions()).next(), { value: undefined, done: true });
    });

    const abort = new AbortController();
    const abortedFixture: VertexAiFixture = {
      constructorOptions: [],
      modelOptions: [],
      requests: [],
      stream: (async function* () {
        yield { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'STOP' }] };
        yield { candidates: [{ content: { parts: [{ text: 'late' }] }, finishReason: 'STOP' }] };
      })(),
    };
    await withVertexAiFixture(abortedFixture, async () => {
      const iterator = streamChatCompletions({ ...createOptions(), signal: abort.signal });
      assert.equal((await iterator.next()).value?.completion, 'partial');
      abort.abort(new Error('stop'));
      assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    });
  } finally {
    if (previousCredentials === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
    }
  }
});

test('compiled CJS plugin executes the API-key path with the real SDK transport', async () => {
  const cjsCore = requireFromTest(resolve('dist/cjs/bundle.cjs')) as {
    googlePlugin: {
      register: (register: (node: { impl: { process: (...args: any[]) => Promise<any> } }) => void) => void;
    };
  };
  let chatGoogleNode: { impl: { process: (...args: any[]) => Promise<any> } } | undefined;
  cjsCore.googlePlugin.register((node) => {
    chatGoogleNode = node;
  });
  assert.ok(chatGoogleNode, 'compiled Google plugin should register its legacy chat node');

  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"compiled result"}]},"finishReason":"STOP"}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' }, status: 200 },
    );
  };

  try {
    const partialOutputs: unknown[] = [];
    const result = await chatGoogleNode.impl.process(
      {
        model: 'gemini-2.5-flash',
        temperature: 0,
        useTopP: false,
        maxTokens: 32,
        thinkingBudget: undefined,
        useModelInput: false,
        useTemperatureInput: false,
        useTopPInput: false,
        useTopKInput: false,
        useUseTopPInput: false,
        useMaxTokensInput: false,
        useToolCalling: false,
        useThinkingBudgetInput: false,
        cache: false,
      },
      {
        prompt: { type: 'chat-message', value: { type: 'user', message: 'Synthetic request' } },
      },
      {
        node: { id: 'compiled-google' },
        settings: { chatNodeHeaders: {}, throttleChatNode: 0 },
        signal: new AbortController().signal,
        tokenizer: {
          getTokenCountForMessages: async () => 0,
          getTokenCountForString: async () => 0,
        },
        getPluginConfig: (key: string) => (key === 'googleApiKey' ? 'compiled-synthetic-key' : undefined),
        onPartialOutputs: (outputs: unknown) => partialOutputs.push(outputs),
        trace: () => {},
      },
    );

    assert.equal(result.response.value, 'compiled result');
    assert.ok(partialOutputs.length >= 1);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /generativelanguage\.googleapis\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Google cache is credential-scoped and never replays tool-capable requests', async () => {
  const fixture: GoogleGenAiFixture = {
    constructorOptions: [],
    requests: [],
    async *createStream() {
      yield { candidates: [{ content: { parts: [{ text: 'cached result' }] }, finishReason: 'STOP' }] };
    },
  };

  const editorExecutionCache = new Map<string, unknown>();
  const requestData = {
    ...ChatGoogleNodeImpl.create().data,
    cache: true,
    maxTokens: 32,
    model: 'gemini-2.5-flash' as const,
  };
  const inputs = {
    prompt: { type: 'chat-message', value: { type: 'user', message: 'Synthetic request' } },
  } as any;
  let cacheHits = 0;
  const createContext = (apiKey: string) =>
    ({
      node: { id: 'legacy-google-cache', type: 'chatGoogle' },
      settings: { chatNodeHeaders: { Authorization: 'Bearer synthetic-header' }, throttleChatNode: 0 },
      signal: new AbortController().signal,
      tokenizer: {
        getTokenCountForMessages: async () => 0,
        getTokenCountForString: async () => 0,
      },
      getPluginConfig: (key: string) => (key === 'googleApiKey' ? apiKey : undefined),
      onPartialOutputs: () => {},
      trace: () => {},
      editorExecutionCache,
      executionCache: new Map<string, unknown>(),
      markResultAsEditorCacheHit: () => {
        cacheHits += 1;
      },
    }) as any;

  await withGoogleGenAiFixture(fixture, async () => {
    const first = await ChatGoogleNodeImpl.process(requestData, inputs, createContext('google-key-a'));
    const repeated = await ChatGoogleNodeImpl.process(requestData, inputs, createContext('google-key-a'));
    const otherCredential = await ChatGoogleNodeImpl.process(requestData, inputs, createContext('google-key-b'));

    assert.equal(first.response.value, 'cached result');
    assert.equal(repeated.response.value, 'cached result');
    assert.equal(otherCredential.response.value, 'cached result');
    assert.equal(fixture.requests.length, 2);
    assert.equal(cacheHits, 1);

    await ChatGoogleNodeImpl.process({ ...requestData, useToolCalling: true }, inputs, createContext('google-key-a'));
    await ChatGoogleNodeImpl.process({ ...requestData, useToolCalling: true }, inputs, createContext('google-key-a'));
    assert.equal(fixture.requests.length, 4);
  });
});

test('compiled CJS plugin retains the deferred Vertex execution path', async () => {
  const cjsCore = requireFromTest(resolve('dist/cjs/bundle.cjs')) as {
    googlePlugin: {
      register: (register: (node: { impl: { process: (...args: any[]) => Promise<any> } }) => void) => void;
    };
  };
  let chatGoogleNode: { impl: { process: (...args: any[]) => Promise<any> } } | undefined;
  cjsCore.googlePlugin.register((node) => {
    chatGoogleNode = node;
  });
  assert.ok(chatGoogleNode, 'compiled Google plugin should register its legacy chat node');

  const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const fixture: VertexAiFixture = {
    constructorOptions: [],
    modelOptions: [],
    requests: [],
    stream: (async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'compiled Vertex result' }] }, finishReason: 'STOP' }] };
    })(),
  };

  try {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'ambient-credentials';
    await withVertexAiFixture(fixture, async () => {
      const result = await chatGoogleNode!.impl.process(
        {
          model: 'gemini-2.0-flash',
          temperature: 0,
          useTopP: false,
          maxTokens: 32,
          thinkingBudget: undefined,
          useModelInput: false,
          useTemperatureInput: false,
          useTopPInput: false,
          useTopKInput: false,
          useUseTopPInput: false,
          useMaxTokensInput: false,
          useToolCalling: false,
          useThinkingBudgetInput: false,
          cache: false,
        },
        {
          prompt: { type: 'chat-message', value: { type: 'user', message: 'Synthetic request' } },
        },
        {
          node: { id: 'compiled-vertex' },
          settings: { chatNodeHeaders: {}, throttleChatNode: 0 },
          signal: new AbortController().signal,
          tokenizer: {
            getTokenCountForMessages: async () => 0,
            getTokenCountForString: async () => 0,
          },
          getPluginConfig: (key: string) =>
            (
              ({
                googleProjectId: 'compiled-project',
                googleRegion: 'compiled-region',
                googleApplicationCredentials: 'compiled-credentials',
              }) as Record<string, string>
            )[key],
          onPartialOutputs: () => {},
          trace: () => {},
        },
      );

      assert.equal(result.response.value, 'compiled Vertex result');
    });

    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'ambient-credentials');
    assert.deepEqual(fixture.constructorOptions, [
      {
        project: 'compiled-project',
        location: 'compiled-region',
        googleAuthOptions: { keyFilename: 'compiled-credentials' },
      },
    ]);
  } finally {
    if (previousCredentials === undefined) {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
    }
  }
});
