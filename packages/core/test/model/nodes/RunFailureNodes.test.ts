import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  ClassifierEvaluateNodeImpl,
  LLMChatV2NodeImpl,
  LLMProfileNodeImpl,
  GraphProcessor,
  createBuiltInRegistry,
  type NodeGraph,
  type Project,
} from '../../../src/index.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { Inputs, Outputs } from '../../../src/model/GraphProcessor.js';
import type { PortId } from '../../../src/model/NodeBase.js';
import { createCaughtRunFailureOutputs, shouldCatchRunFailure } from '../../../src/model/nodeRunFailure.js';
import { formatCaughtRunError } from '../../../src/utils/errors.js';
import { testProcessContext } from '../../testUtils.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context(overrides: Partial<InternalProcessContext> = {}): InternalProcessContext {
  return {
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: { classifierProviders: { jev: { apiKey: 'test-key' } }, openAiKey: 'test-key', chatNodeHeaders: {} },
    getPluginConfig: () => '',
    editorExecutionCache: new Map(),
    node: { id: 'node' },
    processId: 'run',
    ...overrides,
  } as unknown as InternalProcessContext;
}

function llm(data: Partial<LLMChatV2NodeImpl['data']> = {}) {
  const node = LLMChatV2NodeImpl.create();
  return new LLMChatV2NodeImpl({
    ...node,
    data: {
      ...node.data,
      provider: 'custom',
      model: 'fixture',
      customProviderBaseURL: 'https://provider.fixture.test/v1',
      customProviderApiKeyEnvVarName: '',
      customProviderApiKeyProgrammaticName: '',
      useAsGraphPartialOutput: false,
      outputUsage: true,
      ...data,
    },
  });
}

function classifier(data: Partial<ClassifierEvaluateNodeImpl['data']> = {}) {
  const node = ClassifierEvaluateNodeImpl.create();
  return new ClassifierEvaluateNodeImpl({ ...node, data: { ...node.data, ...data } });
}

const prompt = { ['prompt' as PortId]: { type: 'string', value: 'Hello' } } as Inputs;
const questions = {
  ['question1' as PortId]: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Question?' } },
} as Inputs;
const get = (outputs: Outputs, key: string) => outputs[key as PortId];

function successfulResponse(type: 'llm' | 'classifier', status = 200) {
  return new Response(
    JSON.stringify(
      type === 'llm'
        ? {
            id: 'chatcmpl-fixture',
            object: 'chat.completion',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }
        : {
            model: 'jev-1.13.0',
            answers: { q: { type: 'noul', noul: 0.5 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
    ),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

test('LLM catches provider AbortError when the graph itself was not cancelled', async () => {
  globalThis.fetch = async () => {
    throw new DOMException('Provider request interrupted', 'AbortError');
  };
  const outputs = await llm({ catchRequestFailed: true }).process(prompt, context());
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /Provider request interrupted/);
});

for (const type of ['llm', 'classifier'] as const) {
  const make = type === 'llm' ? llm : classifier;
  const inputs = type === 'llm' ? prompt : questions;
  for (const errorOnNon200 of [false, true]) {
    for (const catchRequestFailed of [false, true]) {
      test(`${type}: terminal HTTP failure with throw=${errorOnNon200}, catch=${catchRequestFailed}`, async () => {
        const node = make({ errorOnNon200, catchRequestFailed });
        globalThis.fetch = async () =>
          new Response(JSON.stringify({ error: { message: 'Denied' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        const checkpoints: Outputs[] = [];
        const execution = node.process(
          inputs,
          context({
            setFailureOutputs: (outputs) => {
              checkpoints.push(outputs);
            },
          }),
        );
        if (errorOnNon200 && !catchRequestFailed) {
          await assert.rejects(execution, /401|authentication|Denied/);
        } else {
          const outputs = await execution;
          assert.deepEqual(get(outputs, 'runFailed'), { type: 'boolean', value: true });
          assert.match(String(get(outputs, 'runError')?.value), /401|authentication|Denied/);
          assert.equal(get(outputs, type === 'llm' ? 'response' : 'answers')?.type, 'control-flow-excluded');
          assert.equal(get(outputs, 'usage')?.type, 'control-flow-excluded');
          assert.equal(checkpoints.length, 0, 'Caught errors must not publish a nodeError checkpoint.');
        }
      });
    }
  }

  test(`${type}: preparation failures require Catch all failures`, async () => {
    const invalid = type === 'llm' ? { configurationMode: 'profile' as const } : { provider: 'missing' };
    await assert.rejects(make({ ...invalid, errorOnNon200: false }).process(inputs, context()));
    const outputs = await make({ ...invalid, catchRequestFailed: true }).process(inputs, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
  });

  test(`${type}: retries precede catch and a successful repeat clears failure outputs`, async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return requests === 1
        ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
        : successfulResponse(type);
    };
    const outputs = await make({ catchRequestFailed: true, retryOnNon200: true, retryOnNon200RepeatTimes: 1 }).process(
      inputs,
      context(),
    );
    assert.equal(requests, 2);
    assert.equal(get(outputs, 'runFailed')?.value, false);
    assert.equal(get(outputs, 'runError')?.type, 'control-flow-excluded');
    assert.notEqual(get(outputs, type === 'llm' ? 'response' : 'answers')?.type, 'control-flow-excluded');
  });

  test(`${type}: valid 201 responses are not non-2XX failures`, async () => {
    globalThis.fetch = async () => successfulResponse(type, 201);
    const outputs = await make({ catchRequestFailed: true }).process(inputs, context());
    assert.equal(get(outputs, 'runFailed')?.value, false);
  });

  test(`${type}: cancellation escapes Catch all failures`, async () => {
    const controller = new AbortController();
    globalThis.fetch = async () => {
      controller.abort();
      throw new DOMException('Cancelled', 'AbortError');
    };
    await assert.rejects(
      make({ catchRequestFailed: true, errorOnNon200: false }).process(inputs, context({ signal: controller.signal })),
    );
  });

  test(`${type}: a late successful response cannot turn graph cancellation into success`, async () => {
    const controller = new AbortController();
    globalThis.fetch = async () => {
      controller.abort(new Error('Caller cancelled while request completed'));
      return successfulResponse(type);
    };
    await assert.rejects(
      make({ catchRequestFailed: true }).process(inputs, context({ signal: controller.signal })),
      /cancel|abort/i,
    );
  });

  test(`${type}: malformed successful responses require Catch all failures`, async () => {
    globalThis.fetch = async () =>
      new Response('not JSON', { status: 200, headers: { 'content-type': 'application/json' } });
    await assert.rejects(make({ errorOnNon200: false }).process(inputs, context()));
    const outputs = await make({ catchRequestFailed: true }).process(inputs, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
  });

  test(`${type}: ports appear only when a failure can return normally`, () => {
    assert.equal(
      make()
        .getOutputDefinitions()
        .some((port) => port.id === 'runFailed'),
      false,
    );
    for (const settings of [{ errorOnNon200: false }, { catchRequestFailed: true }]) {
      const ports = make(settings).getOutputDefinitions();
      assert.ok(
        ports.some((port) => port.id === 'runFailed' && port.title === 'Run failed' && port.dataType === 'boolean'),
      );
      assert.ok(
        ports.some((port) => port.id === 'runError' && port.title === 'Run error' && port.dataType === 'string'),
      );
    }
  });

  test(`${type}: graph consumers receive caught failure outputs while the answer branch is excluded`, async () => {
    const registry = createBuiltInRegistry();
    const node = make({ catchRequestFailed: true }).chartNode;
    const input = registry.create('graphInput');
    input.data = { ...input.data, id: 'input', dataType: type === 'llm' ? 'string' : 'object' };
    const ports = ['runFailed', 'runError', type === 'llm' ? 'response' : 'answers'];
    const sinks = ports.map((id) => {
      const sink = registry.create('graphOutput');
      sink.data = { ...sink.data, id, dataType: 'any' };
      return sink;
    });
    const graph: NodeGraph = {
      metadata: { id: 'failure' as NodeGraph['metadata']['id'], name: 'Failure', description: '' },
      nodes: [input, node, ...sinks],
      connections: [
        {
          outputNodeId: input.id,
          outputId: 'data' as PortId,
          inputNodeId: node.id,
          inputId: (type === 'llm' ? 'prompt' : 'question1') as PortId,
        },
        ...sinks.map((sink, index) => ({
          outputNodeId: node.id,
          outputId: ports[index] as PortId,
          inputNodeId: sink.id,
          inputId: 'value' as PortId,
        })),
      ],
    };
    const project = {
      metadata: { id: 'failure-project', title: 'Failures', description: '' },
      graphs: { failure: graph },
    } as unknown as Project;
    const processor = new GraphProcessor(project, graph.metadata.id, registry);
    const errors: unknown[] = [];
    processor.on('nodeError', (event) => {
      errors.push(event);
    });
    globalThis.fetch = async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    const outputs = await processor.processGraph(context({ tokenizer: testProcessContext().tokenizer }), {
      ['input' as PortId]: type === 'llm' ? prompt['prompt' as PortId]! : questions['question1' as PortId]!,
    });
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.equal(get(outputs, 'runError')?.type, 'string');
    assert.equal(get(outputs, ports[2]!)?.type, 'control-flow-excluded');
    assert.equal(errors.length, 0);
  });
}

test('LLM caught errors retain enabled diagnostics but exclude partial answers and tool calls', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Denied' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const outputs = await llm({
    catchRequestFailed: true,
    outputRequestBody: true,
    outputResponseBody: true,
    outputLLMAttempts: true,
    useToolCalling: true,
  }).process(prompt, context());
  assert.equal(get(outputs, 'requestBody')?.type, 'object');
  assert.equal(get(outputs, 'responseBody')?.type, 'object');
  assert.equal(get(outputs, 'llmAttempts')?.type, 'object[]');
  assert.equal(get(outputs, 'function-calls')?.type, 'control-flow-excluded');
});

test('LLM successful editor cache hits retain truthful failure outputs', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return successfulResponse('llm');
  };
  const node = llm({ catchRequestFailed: true, cache: true });
  const ctx = context();
  await node.process(prompt, ctx);
  const outputs = await node.process(prompt, ctx);
  assert.equal(requests, 1);
  assert.equal(get(outputs, 'runFailed')?.value, false);
  assert.equal(get(outputs, 'runError')?.type, 'control-flow-excluded');
});

test('LLM profile fallback finishes before Catch all failures handles the terminal result', async () => {
  const ctx = context();
  const profiles = await Promise.all(
    ['first', 'second'].map(async (name) => {
      const node = LLMProfileNodeImpl.create();
      const profile = new LLMProfileNodeImpl({
        ...node,
        data: {
          ...node.data,
          provider: 'custom',
          model: name,
          customProviderBaseURL: `https://${name}.fixture.test/v1`,
          customProviderApiKeyProgrammaticName: '',
          customProviderApiKeyEnvVarName: '',
        },
      });
      return get(await profile.process({}, ctx), 'profile')!.value;
    }),
  );
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url).includes('first')
      ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
      : successfulResponse('llm');
  };
  const outputs = await llm({ configurationMode: 'profile', catchRequestFailed: true }).process(
    {
      ...prompt,
      ['llmProfile' as PortId]: { type: 'llm-config[]', value: profiles },
    } as Inputs,
    ctx,
  );
  assert.equal(requests.length, 2);
  assert.equal(get(outputs, 'runFailed')?.value, false);
  assert.equal(get(outputs, 'response')?.value, 'OK');
});

test('Classifier caught transport errors include their underlying cause after automatic retries', async () => {
  globalThis.fetch = async () => {
    throw new Error('Connection refused');
  };
  const outputs = await classifier({ catchRequestFailed: true }).process(questions, context());
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /Caused by:.*Connection refused/s);
});

test('failure boundary distinguishes typed statuses, cancellation and causal error chains', () => {
  const signal = new AbortController().signal;
  assert.equal(shouldCatchRunFailure({ errorOnNon200: false }, new Error('503 in message only'), signal), false);
  assert.equal(shouldCatchRunFailure({ errorOnNon200: false }, { statusCode: 201 }, signal), false);
  assert.equal(
    shouldCatchRunFailure({ errorOnNon200: false }, new Error('wrapped', { cause: { statusCode: 503 } }), signal),
    true,
  );
  assert.equal(
    shouldCatchRunFailure({ catchRequestFailed: true }, new DOMException('Aborted', 'AbortError'), signal),
    true,
  );
  assert.match(formatCaughtRunError(new Error('outer', { cause: new Error('inner') })), /Caused by:.*Error: inner/s);
  const circular = new Error('circular');
  circular.cause = circular;
  assert.match(formatCaughtRunError(circular), /Circular error reference/);
  assert.equal(get(createCaughtRunFailureOutputs([], 'failed'), 'runError')?.value, 'failed');
});

test('caught error text preserves foreign-realm stacks and nested causes', () => {
  const error: unknown = runInNewContext("new Error('Foreign failure', { cause: new TypeError('Foreign cause') })");
  assert.equal(error instanceof Error, false, 'The fixture must come from another JavaScript realm.');
  assert.match(formatCaughtRunError(error), /Error: Foreign failure.*Caused by:.*TypeError: Foreign cause/s);
});

test('Catch all failures safely handles non-Error thrown values without confusing provider abort with cancellation', () => {
  const signal = new AbortController().signal;
  const record = Object.assign(Object.create(null), { message: 'Rejected' });
  assert.equal(shouldCatchRunFailure({ catchRequestFailed: true }, record, signal), true);
  assert.match(formatCaughtRunError(record), /Rejected/);
  const circular = Object.create(null);
  circular.self = circular;
  assert.equal(shouldCatchRunFailure({ catchRequestFailed: true }, circular, signal), true);
  assert.equal(typeof get(createCaughtRunFailureOutputs([], circular), 'runError')?.value, 'string');
  assert.equal(shouldCatchRunFailure({ catchRequestFailed: true }, { name: 'AbortError' }, signal), true);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(shouldCatchRunFailure({ catchRequestFailed: true }, { name: 'AbortError' }, cancelled.signal), false);
  const inaccessible = new Proxy(
    {},
    {
      get() {
        throw new Error('Inaccessible property');
      },
    },
  );
  assert.equal(shouldCatchRunFailure({ catchRequestFailed: true }, inaccessible, signal), true);
  assert.equal(typeof formatCaughtRunError(inaccessible), 'string');
});

for (const [name, data] of [
  ['endpoint validation', { customProviderBaseURL: 'not a URL' }],
  ['missing credential input', { provider: 'openai', apiKeySource: 'input' }],
  ['invalid numeric setting', { temperature: Infinity }],
] as const) {
  test(`LLM catches ${name} before provider execution`, async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return successfulResponse('llm');
    };
    const settings = data as Partial<LLMChatV2NodeImpl['data']>;
    await assert.rejects(llm({ ...settings, errorOnNon200: false }).process(prompt, context()));
    const outputs = await llm({ ...settings, catchRequestFailed: true }).process(prompt, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.equal(get(outputs, 'response')?.type, 'control-flow-excluded');
    assert.equal(requests, 0);
  });
}

test('LLM catches structured-response validation after a successful HTTP request', async () => {
  globalThis.fetch = async () => successfulResponse('llm');
  await assert.rejects(llm({ responseFormat: 'json_schema', errorOnNon200: false }).process(prompt, context()));
  const outputs = await llm({ responseFormat: 'json_schema', catchRequestFailed: true }).process(prompt, context());
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.equal(get(outputs, 'response')?.type, 'control-flow-excluded');
});

for (const phase of ['headers', 'body'] as const) {
  test(`Classifier rejects late successful ${phase} after its overall deadline`, async () => {
    globalThis.fetch = async () => {
      const response = successfulResponse('classifier');
      if (phase === 'headers') await new Promise((resolve) => setTimeout(resolve, 40));
      else {
        return new Response(
          new ReadableStream({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              try {
                controller.enqueue(new TextEncoder().encode(await response.text()));
                controller.close();
              } catch {
                /* Cancelled reader. */
              }
            },
          }),
        );
      }
      return response;
    };
    const outputs = await classifier({ timeoutMs: 10, catchRequestFailed: true }).process(questions, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.match(String(get(outputs, 'runError')?.value), /timed out/);
    assert.equal(get(outputs, 'answers')?.type, 'control-flow-excluded');
  });
}

test('LLM cancellation racing a successful response reports aborted activity and never writes the cache', async () => {
  const controller = new AbortController();
  const outcomes: string[] = [];
  const ctx = context({
    signal: controller.signal,
    onChatV2CallFinished: (event) => {
      outcomes.push(event.outcome);
    },
  });
  globalThis.fetch = async () => {
    controller.abort(new Error('Caller cancelled'));
    return successfulResponse('llm');
  };
  await assert.rejects(llm({ cache: true, catchRequestFailed: true }).process(prompt, ctx), /cancel|abort/i);
  assert.deepEqual(outcomes, ['aborted']);
  assert.equal(ctx.editorExecutionCache!.size, 0);
});

test('LLM catches a failed response stream and excludes its partial answer without caching it', async () => {
  globalThis.fetch = async () => {
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent) controller.error(new Error('Response stream interrupted'));
          else {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: 'stream',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'fixture',
                  choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }],
                })}\n\n`,
              ),
            );
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const ctx = context();
  const outputs = await llm({ useAsGraphPartialOutput: true, cache: true, catchRequestFailed: true }).process(
    prompt,
    ctx,
  );
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.equal(get(outputs, 'response')?.type, 'control-flow-excluded');
  assert.equal(ctx.editorExecutionCache!.size, 0);
});

test('Classifier caught response-read errors retain the underlying cause', async () => {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('Response connection reset'));
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const outputs = await classifier({ catchRequestFailed: true }).process(questions, context());
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /Caused by:.*Response connection reset/s);
});

for (const phase of ['headers', 'body'] as const) {
  test(`Classifier timeout settles when ${phase} ignores the abort signal`, { timeout: 1_000 }, async () => {
    globalThis.fetch = async () => {
      if (phase === 'headers') return new Promise<Response>(() => undefined);
      return new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }));
    };
    const outputs = await classifier({ timeoutMs: 10, catchRequestFailed: true }).process(questions, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.match(String(get(outputs, 'runError')?.value), /timed out/);
  });
}

test('Classifier disposes a late response after timeout instead of accepting it', async () => {
  let completeRequest!: (response: Response) => void;
  let disposed = false;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      completeRequest = resolve;
    });
  const outputs = await classifier({ timeoutMs: 10, catchRequestFailed: true }).process(questions, context());
  completeRequest(
    new Response(
      new ReadableStream({
        cancel() {
          disposed = true;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, true);
  assert.equal(get(outputs, 'runFailed')?.value, true);
});

test('Classifier body cleanup throwing synchronously cannot mask the HTTP status', async () => {
  globalThis.fetch = async () => {
    const response = new Response('', { status: 418 });
    response.body!.cancel = () => {
      throw new Error('Synchronous cleanup failure');
    };
    return response;
  };
  const outputs = await classifier({ errorOnNon200: false }).process(questions, context());
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /HTTP 418/);
});

test('Classifier catches its own request timeout while the graph signal remains live', async () => {
  globalThis.fetch = async (_url, options) =>
    new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    });
  const ctx = context();
  const outputs = await classifier({ timeoutMs: 20, catchRequestFailed: true }).process(questions, ctx);
  assert.equal(ctx.signal.aborted, false);
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /timed out/);
});

for (const type of ['llm', 'classifier'] as const) {
  for (const failedFirst of [false, true]) {
    test(`${type}: split runs preserve mixed success and caught-failure outputs, failure first=${failedFirst}`, async () => {
      const registry = createBuiltInRegistry();
      const node = (type === 'llm' ? llm : classifier)({ catchRequestFailed: true }).chartNode;
      node.isSplitRun = true;
      if (node.type === 'classifierEvaluate') node.data.useModelInput = true;
      const source = registry.create('graphInput');
      source.data = { ...source.data, id: 'input', dataType: 'string[]' };
      const questionSource = registry.create('graphInput');
      questionSource.data = { ...questionSource.data, id: 'question', dataType: 'object' };
      const portIds = ['runFailed', 'runError', type === 'llm' ? 'response' : 'answers'];
      const sinks = portIds.map((id) => {
        const sink = registry.create('graphOutput');
        sink.data = { ...sink.data, id, dataType: 'any' };
        return sink;
      });
      const graph: NodeGraph = {
        metadata: { id: 'split' as NodeGraph['metadata']['id'], name: 'Split', description: '' },
        nodes: [source, node, ...sinks, ...(type === 'classifier' ? [questionSource] : [])],
        connections: [
          {
            outputNodeId: source.id,
            outputId: 'data' as PortId,
            inputNodeId: node.id,
            inputId: (type === 'llm' ? 'prompt' : 'model') as PortId,
          },
          ...(type === 'classifier'
            ? [
                {
                  outputNodeId: questionSource.id,
                  outputId: 'data' as PortId,
                  inputNodeId: node.id,
                  inputId: 'question1' as PortId,
                },
              ]
            : []),
          ...sinks.map((sink, i) => ({
            outputNodeId: node.id,
            outputId: portIds[i] as PortId,
            inputNodeId: sink.id,
            inputId: 'value' as PortId,
          })),
        ],
      };
      const processor = new GraphProcessor(
        {
          metadata: { id: 'split-project', title: 'Split', description: '' },
          graphs: { split: graph },
        } as unknown as Project,
        graph.metadata.id,
        registry,
      );
      globalThis.fetch = async (_url, options) =>
        String(options!.body).includes('failme')
          ? new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })
          : successfulResponse(type);
      const items = failedFirst ? ['failme', 'success'] : ['success', 'failme'];
      const outputs = await processor.processGraph(context({ tokenizer: testProcessContext().tokenizer }), {
        input: { type: 'string[]', value: items },
        question: questions['question1' as PortId],
      } as Inputs);
      assert.deepEqual(get(outputs, 'runFailed'), { type: 'boolean[]', value: items.map((item) => item === 'failme') });
      assert.equal(get(outputs, 'runError')?.type, 'string[]');
      assert.equal(
        get(outputs, type === 'llm' ? 'response' : 'answers')?.type,
        type === 'llm' ? 'string[]' : 'object[]',
      );
    });
  }
}

for (const [name, data, inputs] of [
  ['missing credential input', { apiKeySource: 'input' }, questions],
  ['missing model input', { useModelInput: true }, questions],
  ['invalid state', {}, { ...questions, state: { type: 'number', value: 4 } }],
  ['duplicate question IDs', {}, { ...questions, question2: questions['question1' as PortId] }],
] as const) {
  test(`Classifier catches ${name} before provider execution`, async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return successfulResponse('classifier');
    };
    await assert.rejects(classifier({ ...data, errorOnNon200: false }).process(inputs as Inputs, context()));
    const outputs = await classifier({ ...data, catchRequestFailed: true }).process(inputs as Inputs, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.equal(get(outputs, 'answers')?.type, 'control-flow-excluded');
    assert.equal(requests, 0);
  });
}

for (const phase of ['has', 'set'] as const) {
  test(`LLM catches cache ${phase} failures across preparation and successful-result processing`, async () => {
    class FailingCache extends Map<string, unknown> {
      override has(key: string) {
        if (phase === 'has') throw new Error('Cache read failed');
        return super.has(key);
      }
      override set(key: string, value: unknown) {
        if (phase === 'set') throw new Error('Cache write failed');
        return super.set(key, value);
      }
    }
    globalThis.fetch = async () => successfulResponse('llm');
    const outputs = await llm({ cache: true, catchRequestFailed: true }).process(
      prompt,
      context({ editorExecutionCache: new FailingCache() }),
    );
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.match(String(get(outputs, 'runError')?.value), /Cache (read|write) failed/);
    assert.equal(get(outputs, 'response')?.type, 'control-flow-excluded');
  });
}

test('LLM catches tool-continuation execution failures, not just failed provider requests', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: 'tool-round',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call', type: 'function', function: { name: 'broken', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const outputs = await llm({ useToolCalling: true, autoContinueToolCalls: true, catchRequestFailed: true }).process(
    {
      ...prompt,
      functions: {
        type: 'gpt-function',
        value: { name: 'broken', description: 'Test tool', parameters: { type: 'object', properties: {} } },
      },
    } as Inputs,
    context({
      toolCallContinuation: {
        run: async () => {
          throw new Error('Tool continuation failed');
        },
        release: () => undefined,
      },
    }),
  );
  assert.equal(get(outputs, 'runFailed')?.value, true);
  assert.match(String(get(outputs, 'runError')?.value), /Tool continuation failed/);
  assert.equal(get(outputs, 'function-calls')?.type, 'control-flow-excluded');
});

for (const status of [400, 401, 418, 429, 503]) {
  test(`Classifier closes every rejected HTTP ${status} response, including terminal failure`, async () => {
    let requests = 0;
    let cancelled = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          status,
          headers: { 'retry-after': '0' },
        },
      );
    };
    const outputs = await classifier({ catchRequestFailed: true }).process(questions, context());
    assert.equal(get(outputs, 'runFailed')?.value, true);
    assert.equal(requests, status === 429 ? 3 : 1, 'Cleanup must preserve the automatic retry policy.');
    assert.equal(cancelled, requests, 'The terminal response must release its body just like a retry response.');
  });
}

test('Classifier body-cleanup errors never replace the HTTP failure', async () => {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error('Body cleanup failed');
        },
      }),
      { status: 418 },
    );
  const outputs = await classifier({ catchRequestFailed: true }).process(questions, context());
  assert.match(String(get(outputs, 'runError')?.value), /HTTP 418/);
  assert.doesNotMatch(String(get(outputs, 'runError')?.value), /Body cleanup failed/);
});

test('Classifier terminal failure does not wait indefinitely for rejected-body cleanup', async () => {
  let cancellationStarted = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancellationStarted = true;
          return new Promise<void>(() => undefined);
        },
      }),
      { status: 418 },
    );
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Caught failure waited for stream cleanup')), 1_000);
  });
  try {
    const outputs = await Promise.race([
      classifier({ catchRequestFailed: true }).process(questions, context()),
      deadline,
    ]);
    assert.equal(cancellationStarted, true);
    assert.equal(get(outputs, 'runFailed')?.value, true);
  } finally {
    clearTimeout(timer!);
  }
});
