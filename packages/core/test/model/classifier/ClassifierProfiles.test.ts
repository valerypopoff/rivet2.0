import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ClassifierEvaluateNodeImpl } from '../../../src/model/nodes/ClassifierEvaluateNode.js';
import { ClassifierProfileNodeImpl } from '../../../src/model/nodes/ClassifierProfileNode.js';
import { InMemoryRivetLLMProfileHealthStore } from '../../../src/model/chat-v2/llmProfileHealthStore.js';
import {
  classifierProfileHealthIdentity,
  classifierProfileHealthPolicy,
  classifierProfileResponseTimeout,
  normalizeClassifierProfiles,
  resolveClassifierProfile,
  type ClassifierProfileValue,
} from '../../../src/model/classifier/profile.js';
import {
  getClassifierProvider,
  calculateClassifierUsageCost,
  classifierErrorMessage,
} from '../../../src/model/classifier/providers.js';
import { classifierProfileSummary, runClassifierProfiles } from '../../../src/model/classifier/profileExecution.js';
import type { InternalProcessContext, LLMProfileAttemptTraceEvent } from '../../../src/model/ProcessContext.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import {
  ArrayNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  SubGraphNodeImpl,
  GraphProcessor,
  createBuiltInRegistry,
  buildAgentResponseTrace,
  isAgentResponseTrace,
  deserializeProject,
  serializeProject,
  validateProjectBundleProjects,
  type ProjectBundleManifest,
  type GraphExecutionMetadata,
  type NodeConnection,
  type Project,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';
import { ExecutionRecorder } from '../../../src/recording/ExecutionRecorder.js';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});
const question = { questionId: 'q', type: 'noul' as const, instructions: 'Check state' };
const context = (overrides: Partial<InternalProcessContext> = {}) =>
  ({
    executor: 'nodejs',
    signal: new AbortController().signal,
    settings: {},
    project: { metadata: { id: 'project-a' }, graphs: {} },
    ...overrides,
  }) as InternalProcessContext;
const profile = (provider = 'jev', configuration: Record<string, unknown> = {}): ClassifierProfileValue => ({
  version: 1,
  configuration: { provider, model: getClassifierProvider(provider).defaultModel, ...configuration },
  credential: { value: 'private-key' },
  sourceNodeId: `profile-${provider}` as never,
});
const reply = (provider: string) =>
  new Response(
    JSON.stringify({
      model: getClassifierProvider(provider).defaultModel,
      answers:
        provider === 'openai'
          ? [{ name: 'q', type: 'predicate', probability: 0.8 }]
          : { q: { type: 'noul', noul: 0.8 } },
      usage: { input_tokens: 1000, output_tokens: 0 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

void test('Chain exhaustion retains every physical retry reason even without optional diagnostic ports', async () => {
  const statuses = [429, 503, 400];
  let calls = 0;
  globalThis.fetch = async () => Response.json({ private: 'response-only-evidence' }, { status: statuses[calls++] });
  await assert.rejects(
    evaluate(
      [{ ...profile('perplexity'), profileName: 'Retry classifier' }],
      context(),
      {},
      {
        retryOnNon200: true,
        outputRequestBody: false,
        outputResponseBody: false,
        outputClassifierAttempts: false,
        outputClassifierProfileSummary: false,
      },
    ),
    (error: Error) => {
      assert.match(error.message, /3 provider attempts/);
      for (const [index, status] of statuses.entries())
        assert.ok(
          error.message.includes(`Profile 1 (Retry classifier), http attempt ${index + 1} failure (HTTP ${status})`),
        );
      assert.doesNotMatch(error.message, /private-key|response-only-evidence/);
      return true;
    },
  );
  assert.equal(calls, 3);
});

void test('Chain exhaustion names each profile in attempt details and preserves unnamed-profile fallback', async () => {
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  await assert.rejects(
    evaluate(
      [
        { ...profile('perplexity'), profileName: 'Some classifier profile' },
        { ...profile('perplexity'), profileName: 'Another classifier profile' },
        profile('perplexity'),
      ],
      context(),
    ),
    (error: Error) => {
      const details = error.message.split('Attempt details:\n')[1]!;
      assert.ok(details.includes('Profile 1 (Some classifier profile), authentication attempt 1 failure (HTTP 401)'));
      assert.ok(
        details.includes('Profile 2 (Another classifier profile), authentication attempt 1 failure (HTTP 401)'),
      );
      assert.ok(details.includes('Profile 3, authentication attempt 1 failure (HTTP 401)'));
      assert.doesNotMatch(details, /private-key/);
      return true;
    },
  );
});

void test('Deadlines expiring before dispatch produce visible typed failure evidence, not only unreached profiles', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('jev');
  };
  const attempts: any[] = [];
  await assert.rejects(
    runClassifierProfiles({
      profiles: [profile()],
      state: { state: 'evidence' },
      questions: [question],
      context: context(),
      nodeId: 'evaluate' as never,
      deadline: Date.now() - 1,
      onAttempt: (event) => attempts.push(event),
    }),
    /Classifier overall deadline expired/,
  );
  assert.equal(calls, 0);
  assert.equal(attempts[0]?.failureKind, 'timeout');
});

void test('Preparation errors are visible, bounded, and credential-redacted even with unreadable metadata', () => {
  assert.equal(
    classifierErrorMessage(new Error('Invalid model private-key'), 'private-key'),
    'Invalid model [redacted]',
  );
  assert.equal(classifierErrorMessage(new Error('x'.repeat(3000))).length, 2000);
  const unreadable = new Error();
  Object.defineProperty(unreadable, 'message', {
    get() {
      throw new Error('private-key');
    },
  });
  assert.equal(classifierErrorMessage(unreadable), 'Classifier request failed with unreadable error metadata.');
});
function evaluate(profiles: ClassifierProfileValue[], ctx = context(), extra: Inputs = {}, data = {}) {
  const node = ClassifierEvaluateNodeImpl.create();
  Object.assign(node.data, {
    configurationMode: 'profile',
    outputRequestBody: true,
    outputResponseBody: true,
    outputClassifierAttempts: true,
    outputClassifierProfileSummary: true,
    ...data,
  });
  return new ClassifierEvaluateNodeImpl(node).process(
    {
      classifierProfile: { type: 'classifier-config[]', value: profiles },
      state: { type: 'string', value: 'Shared evidence' },
      question1: { type: 'object', value: question },
      ...extra,
    },
    ctx,
  );
}

void test('Profile attempt observers cannot overwrite retained failure reasons or usage receipts', async () => {
  globalThis.fetch = async () =>
    Response.json({ model: 'jev-latest', answers: {}, usage: { input_tokens: 1000, output_tokens: 0 } });
  await assert.rejects(
    runClassifierProfiles({
      profiles: [profile()],
      state: { state: 'Evidence' },
      questions: [question],
      context: context(),
      nodeId: 'evaluate' as never,
      deadline: Date.now() + 5000,
      onAttempt: (event) => {
        event.profileIndex = 99;
        event.error = 'tampered';
        if (event.classifierUsage) event.classifierUsage.inputTokens = 999;
      },
    }),
    (error: any) => {
      assert.equal(error.attempts[0].profileIndex, 0);
      assert.equal(error.attempts[0].classifierUsage.inputTokens, 1000);
      assert.doesNotMatch(error.message, /tampered/);
      assert.match(error.summary, /1\..*failed/);
      return true;
    },
  );
});

for (const configurationMode of ['inline', 'profile'] as const) {
  void test(`Execution observers cannot mutate ${configurationMode} attempt receipts`, async () => {
    globalThis.fetch = async () => reply('jev');
    const node = ClassifierEvaluateNodeImpl.create();
    Object.assign(node.data, { configurationMode, outputClassifierAttempts: true });
    const result = await new ClassifierEvaluateNodeImpl(node).process(
      {
        classifierProfile: { type: 'classifier-config', value: profile() },
        state: { type: 'string', value: 'Evidence' },
        question1: { type: 'object', value: question },
      },
      context({
        settings: { classifierProviders: { jev: { apiKey: 'private-key' } } },
        onLLMProfileAttempt: (event) => {
          if (event.classifierUsage) event.classifierUsage.inputTokens = 999;
        },
      }),
    );
    assert.equal((result.classifierAttempts!.value as any[])[0].classifierUsage.inputTokens, 1000);
  });
}

for (const phase of ['fetch', 'body'] as const) {
  void test(`Cancellation during ${phase} emits one aborted request, not a transport outage`, async () => {
    const controller = new AbortController();
    const stop = new Error('operator canceled');
    const store = new InMemoryRivetLLMProfileHealthStore();
    const attempts: LLMProfileAttemptTraceEvent[] = [];
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      if (phase === 'body')
        return new Response(
          new ReadableStream({
            pull() {
              started();
            },
          }),
        );
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        started();
      });
    };
    const run = evaluate(
      [profile('jev', { enableCircuitBreaker: true }), profile('liquid')],
      context({
        llmProfileHealthStore: store,
        signal: controller.signal,
        onLLMProfileAttempt: (event) => attempts.push(event),
      }),
      {},
      { catchRequestFailed: true },
    );
    const rejected = assert.rejects(run, (error) => error === stop);
    await active;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(stop);
    await rejected;
    const requestEvents = attempts.filter((event) => event.stage === 'request');
    assert.equal(requestEvents.length, 1);
    assert.equal(requestEvents[0]!.outcome, 'aborted');
    assert.equal(requestEvents[0]!.failureKind, undefined);
    assert.match(requestEvents[0]!.error!, /canceled/);
    assert.equal(calls, 1);
    assert.equal(store.list()[0]!.failureCount, 0);
  });
}

for (const configurationMode of ['inline', 'profile'] as const) {
  for (const behavior of ['throw', 'catch', 'suppress'] as const) {
    void test(`Decision AI rejected bodies and failure reasons survive ${configurationMode}/${behavior}`, async () => {
      const responseBody = { error: { message: 'Model is unavailable' } };
      globalThis.fetch = async () => Response.json(responseBody, { status: 400 });
      const node = ClassifierEvaluateNodeImpl.create();
      Object.assign(node.data, {
        configurationMode,
        provider: 'perplexity',
        outputRequestBody: true,
        outputResponseBody: true,
        outputClassifierAttempts: true,
        outputClassifierProfileSummary: true,
        catchRequestFailed: behavior === 'catch',
        errorOnNon200: behavior !== 'suppress',
      });
      let evidence: Inputs | undefined;
      const run = new ClassifierEvaluateNodeImpl(node).process(
        {
          classifierProfile: { type: 'classifier-config', value: profile('perplexity') },
          state: { type: 'string', value: 'Shared evidence' },
          question1: { type: 'object', value: question },
        },
        context({
          settings: { classifierProviders: { perplexity: { apiKey: 'private-key' } } },
          setFailureOutputs: (outputs) => {
            evidence = outputs;
          },
        }),
      );
      if (behavior === 'throw') await assert.rejects(run, /Perplexity.*HTTP 400/);
      else {
        evidence = await run;
        assert.equal(evidence.answers!.type, 'control-flow-excluded');
        assert.equal(evidence.usage!.type, 'control-flow-excluded');
        if (behavior === 'catch') assert.match(evidence.runError!.value as string, /Perplexity.*HTTP 400/);
      }
      assert.ok(evidence);
      assert.equal((evidence.requestBody!.value as any).model, 'pplx-decider-v1.1-27b');
      assert.deepEqual(evidence.responseBody!.value, responseBody);
      assert.doesNotMatch(JSON.stringify(evidence), /private-key/);
      assert.match((evidence.classifierAttempts!.value as any[]).at(-1).error, /HTTP 400/);
    });
  }
}

void test('Invalid JSON and invalid answer responses remain inspectable without entering successful outputs', async () => {
  for (const [body, reason, expected] of [
    ['upstream service failed', /invalid JSON/, { raw: 'upstream service failed' }],
    ['{}', /invalid response shape/, {}],
  ] as const) {
    globalThis.fetch = async () => new Response(body);
    const result = await evaluate([profile('perplexity')], context(), {}, { catchRequestFailed: true });
    assert.equal(result.answers!.type, 'control-flow-excluded');
    assert.match(result.runError!.value as string, reason);
    assert.deepEqual(result.responseBody!.value, expected);
  }
});

void test('Cancellation at the health gate is not mislabeled as configuration failure and releases the permit', async () => {
  const controller = new AbortController();
  const stop = new Error('operator canceled');
  const store = new InMemoryRivetLLMProfileHealthStore();
  const attempts: LLMProfileAttemptTraceEvent[] = [];
  globalThis.fetch = async () => assert.fail('Canceled preparation must not dispatch');
  await assert.rejects(
    evaluate(
      [profile('jev', { enableCircuitBreaker: true })],
      context({
        signal: controller.signal,
        llmProfileHealthStore: store,
        onLLMProfileAttempt: (event) => {
          attempts.push(event);
          if (event.stage === 'health-gate' && event.outcome === 'success') controller.abort(stop);
        },
      }),
    ),
    (error) => error === stop,
  );
  const canceled = attempts.find((event) => event.outcome === 'aborted');
  assert.ok(canceled);
  assert.equal(canceled.failureKind, undefined);
  assert.ok(attempts.some((event) => event.healthOutcome === 'ignored'));
  assert.equal(store.list()[0]!.failureCount, 0);
});

void test('Fallback diagnostics pair the final physical request with its response, not an earlier candidate', async () => {
  globalThis.fetch = async (url) =>
    String(url).includes('perplexity')
      ? Response.json({ error: 'first candidate failed' }, { status: 400 })
      : new Response('last candidate failed', { status: 401 });
  const result = await evaluate([profile('perplexity'), profile('jev')], context(), {}, { catchRequestFailed: true });
  assert.equal((result.requestBody!.value as any).model, 'jev-latest');
  assert.deepEqual(result.responseBody!.value, { raw: 'last candidate failed' });
  assert.match(result.runError!.value as string, /1\..*HTTP 400/);
  assert.match(result.runError!.value as string, /2\..*authentication failed.*HTTP 401/);
});

void test('Failure outputs are opt-in and diagnostic observers cannot replace the classifier failure', async () => {
  globalThis.fetch = async () => Response.json({ private: 'provider response' }, { status: 400 });
  const checkpoints: Inputs[] = [];
  await assert.rejects(
    evaluate(
      [profile()],
      context({
        setFailureOutputs: (outputs) => {
          checkpoints.push(outputs);
        },
      }),
      {},
      {
        outputRequestBody: false,
        outputResponseBody: false,
        outputClassifierAttempts: false,
        outputClassifierProfileSummary: false,
      },
    ),
    /HTTP 400/,
  );
  assert.deepEqual(checkpoints, []);
  await assert.rejects(
    evaluate(
      [profile()],
      context({
        setFailureOutputs: () => {
          throw new Error('observer failed');
        },
      }),
    ),
    /HTTP 400/,
  );
});

for (const split of [false, true]) {
  void test(`Decision AI failure bodies reach terminal events and recordings (split=${split})`, async () => {
    const candidate = ClassifierProfileNodeImpl.create();
    candidate.data.provider = 'perplexity';
    const questions = GraphInputNodeImpl.create();
    questions.data.id = 'questions';
    questions.data.dataType = 'object';
    const node = ClassifierEvaluateNodeImpl.create();
    Object.assign(node.data, { configurationMode: 'profile', outputRequestBody: true, outputResponseBody: true });
    node.isSplitRun = split;
    const output = GraphOutputNodeImpl.create();
    output.data.id = 'answer';
    const wire = (from: string, outputId: string, to: string, inputId: string) =>
      ({ outputNodeId: from, outputId, inputNodeId: to, inputId }) as NodeConnection;
    const graph = {
      metadata: { id: 'failure-graph', name: 'Failure', description: '' },
      nodes: [candidate, questions, node, output],
      connections: [
        wire(candidate.id, 'profile', node.id, 'classifierProfile'),
        wire(questions.id, 'data', node.id, 'question1'),
        wire(node.id, 'answers', output.id, 'value'),
      ],
    };
    const project = {
      metadata: { id: 'failure-project', title: 'Failure', description: '' },
      graphs: { 'failure-graph': graph },
      plugins: [],
    } as unknown as Project;
    globalThis.fetch = async () => Response.json({ error: 'Bad request' }, { status: 400 });
    const processor = new GraphProcessor(project, graph.metadata.id as never, createBuiltInRegistry(), {
      executor: 'nodejs',
    });
    const recorder = new ExecutionRecorder();
    recorder.record(processor);
    const failures: any[] = [];
    let answerFinished = false;
    processor.on('nodeError', (event) => {
      if (event.node.id === node.id) failures.push(event);
    });
    processor.on('nodeFinish', (event) => {
      if (event.node.id === output.id) answerFinished = true;
    });
    await assert.rejects(
      processor.processGraph(
        { ...testProcessContext(), settings: { classifierProviders: { perplexity: { apiKey: 'private-key' } } } },
        { questions: { type: 'object', value: question } },
      ),
      /failed to process due to errors in nodes/,
    );
    assert.equal(answerFinished, false);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0].error), /Perplexity.*HTTP 400/);
    const evidence = split ? failures[0].splitOutputs[0] : failures[0].outputs;
    assert.deepEqual(evidence.responseBody.value, { error: 'Bad request' });
    assert.equal(evidence.requestBody.value.model, 'pplx-decider-v1.1-27b');
    const recording = recorder.getRecording();
    const recorded = recording.events.find((event) => event.type === 'nodeError' && event.data.nodeId === node.id);
    assert.ok(recorded?.type === 'nodeError');
    assert.deepEqual(split ? recorded.data.splitOutputs?.[0] : recorded.data.outputs, evidence);
  });
}

void test('Decision AI Profile suspension editors mirror the LLM structure with stored-unit timing defaults', () => {
  const node = ClassifierProfileNodeImpl.create();
  const originalData = structuredClone(node.data);
  assert.equal(node.data.responseTimeoutMs, 500);
  assert.equal(classifierProfileResponseTimeout({}), 500, 'Missing settings must use the same half-second default');
  assert.equal(classifierProfileResponseTimeout({ responseTimeoutMs: 30_000 }), 30_000, 'Keep explicit saved timeouts');
  const editors = new ClassifierProfileNodeImpl(node).getEditors();
  const group = editors.find((editor) => editor.label === 'Decision AI profile suspension');
  assert.ok(group?.type === 'group');
  assert.deepEqual(
    group.editors.map((editor) => editor.label),
    [
      "It's a hosted runtime capability",
      'Enable automatic suspension',
      'Response timeout, seconds',
      'Failures before suspension',
      'Failure window, seconds',
      'Suspension duration, seconds',
    ],
  );
  assert.equal(group.editors[0]!.type, 'info');
  assert.match(group.editors[0]!.helperMessage as string, /Not available in standalone Rivet/);
  assert.deepEqual(
    group.editors.filter((editor) => !(editor.hideIf?.(node.data) ?? false)).map((editor) => editor.label),
    ["It's a hosted runtime capability", 'Enable automatic suspension'],
    'Disabled suspension must display only the same notice and toggle as the LLM section',
  );
  assert.ok(
    group.editors.every((editor) => typeof editor.helperMessage === 'string' && editor.helperMessage.length > 0),
  );
  assert.equal(
    editors.some((editor) => editor.type === 'number' && editor.dataKey === 'responseTimeoutMs'),
    false,
  );
  const policy = classifierProfileHealthPolicy({ enableCircuitBreaker: true })!;
  for (const [key, expectedDefault, expectedMaximum] of [
    ['responseTimeoutMs', classifierProfileResponseTimeout({}), 600_000],
    ['circuitBreakerFailureWindowMs', policy.failureWindowMs, 86_400_000],
    ['circuitBreakerOpenDurationMs', policy.openDurationMs, 86_400_000],
  ] as const) {
    const editor = group.editors.find((editor) => editor.type === 'number' && editor.dataKey === key);
    assert.ok(editor?.type === 'number');
    assert.equal(editor.defaultValue, expectedDefault);
    assert.equal(editor.storageMultiplier, 1_000);
    assert.equal(editor.min, key === 'responseTimeoutMs' ? 1 : 1_000);
    assert.equal(editor.max, expectedMaximum);
    assert.equal(editor.step, key === 'responseTimeoutMs' ? 1 : 1_000);
    assert.equal(editor.hideIf?.(node.data), true);
    assert.equal(editor.hideIf?.({ ...node.data, enableCircuitBreaker: true }), false);
  }
  assert.deepEqual(node.data, originalData, 'Reading editor defaults must not modify stored settings');
  for (const responseTimeoutMs of [1, 250, 500, 1_250]) {
    assert.equal(classifierProfileResponseTimeout({ responseTimeoutMs }), responseTimeoutMs);
  }
  assert.equal(
    classifierProfileHealthPolicy({ enableCircuitBreaker: true, circuitBreakerFailureWindowMs: 300 })!.failureWindowMs,
    300,
    'Explicit saved millisecond values must not be reinterpreted as seconds',
  );
});

void test('Decision AI run overall timeout editor uses milliseconds for defaults and constraints', () => {
  for (const configurationMode of ['inline', 'profile'] as const) {
    const node = ClassifierEvaluateNodeImpl.create();
    node.data.configurationMode = configurationMode;
    const group = new ClassifierEvaluateNodeImpl(node).getEditors().find((editor) => editor.label === 'Advanced');
    assert.ok(group?.type === 'group');
    const editor = group.editors.find((editor) => editor.label === 'Overall timeout (seconds)');
    assert.ok(editor?.type === 'number');
    assert.equal(editor.defaultValue, configurationMode === 'profile' ? 180_000 : 30_000);
    assert.equal(editor.min, 1_000);
    assert.equal(editor.max, 600_000);
    assert.equal(editor.step, 1_000);
    assert.equal(editor.storageMultiplier, 1_000);
  }
});

void test('Every classifier provider has inline/profile request, answer and cost parity', async () => {
  for (const provider of ['jev', 'liquid', 'openai', 'openrouter', 'perplexity']) {
    globalThis.fetch = async () => reply(provider);
    const node = ClassifierEvaluateNodeImpl.create();
    Object.assign(node.data, { provider, outputRequestBody: true, outputResponseBody: true });
    const inline = await new ClassifierEvaluateNodeImpl(node).process(
      {
        state: { type: 'string', value: 'Shared evidence' },
        question1: { type: 'object', value: question },
      },
      context({ settings: { classifierProviders: { [provider]: { apiKey: 'private-key' } } } }),
    );
    const fromProfile = await evaluate([profile(provider)]);
    for (const port of ['answers', 'usage', 'cost', 'requestBody', 'responseBody'])
      assert.deepEqual(fromProfile[port], inline[port]);
    assert.match(fromProfile.classifierProfileSummary!.value as string, /succeeded/);
    assert.equal(
      (fromProfile.classifierAttempts!.value as any[]).find((attempt) => attempt.stage === 'request').attemptIndex,
      0,
    );
    assert.ok(!JSON.stringify(fromProfile.classifierAttempts).includes('private-key'));
  }
});

void test('Actual classifier retry and fallback events remain valid strict recording traces', async () => {
  const execution = { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'root' } as GraphExecutionMetadata;
  for (const mode of ['inline', 'profile'] as const) {
    let calls = 0;
    globalThis.fetch = async () => (++calls === 1 ? new Response('', { status: 503 }) : reply('jev'));
    const events: LLMProfileAttemptTraceEvent[] = [];
    const ctx = context({
      processId: 'process' as never,
      settings: { classifierProviders: { jev: { apiKey: 'private-key' } } },
      onLLMProfileAttempt: (event) => events.push(event),
    });
    const node = ClassifierEvaluateNodeImpl.create();
    node.data.configurationMode = mode;
    node.data.retryOnNon200 = true;
    // Attempt events must remain available without any optional diagnostic outputs.
    await new ClassifierEvaluateNodeImpl(node).process(
      {
        question1: { type: 'object', value: question },
        ...(mode === 'profile'
          ? { classifierProfile: { type: 'classifier-config[]' as const, value: [profile(), profile()] } }
          : {}),
      },
      ctx,
    );
    assert.ok(events.some((event) => event.outcome === 'failure'));
    assert.ok(events.some((event) => event.outcome === 'success'));
    assert.ok(events.every((event) => !Object.hasOwn(event, 'kind')));
    const physicalRequests = events.filter((event) => event.attemptIndex != null);
    assert.ok(physicalRequests.every((event) => typeof event.durationMs === 'number' && event.durationMs >= 0));
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution,
      status: 'response-ready',
      events: events.map((event) => ({ ...event, type: 'llm-profile-attempt', execution })),
    });
    assert.equal(isAgentResponseTrace(trace), true, mode);
    assert.equal(trace.summary.classifierRequestCount, physicalRequests.length);
    assert.equal(trace.summary.modelCallCount, 0);
    assert.ok(!JSON.stringify(trace).includes('private-key'));
  }
});

void test('Decision AI run advertises model activity and Answers as its primary preview', () => {
  const node = new ClassifierEvaluateNodeImpl(ClassifierEvaluateNodeImpl.create());
  assert.deepEqual(node.getRunActivityDescriptor(), { category: 'model', primaryOutputPortId: 'answers' });
});

void test('Unreached profiles are recorded without provider calls or inflating fallback counts', async () => {
  const events: LLMProfileAttemptTraceEvent[] = [];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('jev');
  };
  const output = await evaluate(
    [profile(), profile('liquid'), profile('openai')],
    context({
      processId: 'process' as never,
      onLLMProfileAttempt: (event) => events.push(event),
    }),
  );
  assert.equal(calls, 1);
  assert.equal(events.filter((event) => event.skipReason === 'unreached').length, 2);
  assert.match(
    output.classifierProfileSummary!.value as string,
    /1\..*succeeded[\s\S]*2\..*not reached[\s\S]*3\..*not reached/,
  );
  const execution = { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'root' } as GraphExecutionMetadata;
  const trace = buildAgentResponseTrace({
    scope: 'response',
    execution,
    status: 'response-ready',
    events: events.map((event) => ({ ...event, type: 'llm-profile-attempt', execution })),
  });
  assert.ok(isAgentResponseTrace(trace));
  assert.equal(trace.summary.fallbackCount, 0);
});

void test('Failed answer batches retain safe usage, while unpriced or unavailable failed receipts remain unknown', async () => {
  for (const provider of ['jev', 'liquid', 'openai']) {
    for (const receipt of ['priced', 'unpriced', 'unsafe', 'unreadable']) {
      const events: LLMProfileAttemptTraceEvent[] = [];
      const fallback = provider === 'jev' ? 'liquid' : 'jev';
      let calls = 0;
      globalThis.fetch = async () => {
        if (++calls > 1) return reply(fallback);
        if (receipt === 'unreadable') return new Response('invalid JSON');
        return new Response(
          JSON.stringify({
            model: receipt === 'unpriced' ? 'unpriced-model' : getClassifierProvider(provider).defaultModel,
            answers: provider === 'openai' ? [] : {},
            usage: { input_tokens: receipt === 'unsafe' ? -1 : 1000, output_tokens: 0 },
          }),
        );
      };
      const output = await evaluate(
        [profile(provider), profile(fallback)],
        context({
          processId: 'process' as never,
          onLLMProfileAttempt: (event) => events.push(event),
        }),
      );
      const failed = events.find((event) => event.profileIndex === 0 && event.attemptIndex === 0)!;
      const failedCost =
        receipt === 'priced'
          ? calculateClassifierUsageCost(
              getClassifierProvider(provider),
              { input_tokens: 1000, output_tokens: 0 },
              {
                requestedModel: getClassifierProvider(provider).defaultModel,
                responseModel: getClassifierProvider(provider).defaultModel,
              },
            )!
          : undefined;
      if (receipt === 'unsafe' || receipt === 'unreadable') assert.equal(failed.classifierUsage, undefined);
      else
        assert.deepEqual(failed.classifierUsage, {
          inputTokens: 1000,
          outputTokens: 0,
          ...(failedCost === undefined ? {} : { estimatedCostUsd: failedCost }),
        });
      const winningCost = output.cost!.value as number;
      assert.equal((output.usage!.value as any).totalCost, undefined); // details toggle is disabled
      const execution = { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'root' } as GraphExecutionMetadata;
      const trace = buildAgentResponseTrace({
        scope: 'response',
        execution,
        status: 'response-ready',
        events: events.map((event) => ({ ...event, type: 'llm-profile-attempt', execution })),
      });
      assert.ok(isAgentResponseTrace(trace));
      assert.equal(trace.summary.knownCostUsd, winningCost + (failedCost ?? 0));
      assert.equal(trace.summary.costStatus, receipt === 'priced' ? 'known' : 'partial');
      assert.equal(trace.summary.promptTokens, receipt === 'priced' || receipt === 'unpriced' ? 2000 : 1000);
      assert.equal((output.responseBody!.value as any).model, getClassifierProvider(fallback).defaultModel);
      assert.ok(!JSON.stringify(events).includes('private-key'));
    }
  }
});

void test('Profile resolves dynamic model/key and allows a missing key to reach fallback', async () => {
  const node = ClassifierProfileNodeImpl.create();
  node.data = { provider: 'liquid', apiKeySource: 'input', useModelInput: true };
  const impl = new ClassifierProfileNodeImpl(node);
  assert.equal(impl.getInputDefinitions().find((input) => input.id === 'apiKey')!.required, false);
  const ctx = context({ node });
  const resolved = await impl.process({ model: { type: 'string', value: 'd1' } }, ctx);
  assert.equal((resolved.profile!.value as ClassifierProfileValue).configuration.model, 'd1');
  assert.deepEqual((resolved.profile!.value as ClassifierProfileValue).credential, {});
  const keyed = resolveClassifierProfile(
    node.data,
    { model: { type: 'string', value: 'd1' }, apiKey: { type: 'string', value: ' supplied ' } },
    ctx,
  );
  assert.equal(keyed.credential.value, 'supplied');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('openai');
  };
  const result = await evaluate([resolved.profile!.value as ClassifierProfileValue, profile('openai')]);
  assert.equal(calls, 1);
  assert.match(result.classifierProfileSummary!.value as string, /1\..*failed[\s\S]*2\..*succeeded/);
  assert.throws(
    () =>
      resolveClassifierProfile(
        { provider: 'jev', apiKeyNames: { programmaticName: 'bad name', environmentVariableName: 'KEY' } },
        {},
        ctx,
      ),
    /identifier/,
  );
});

void test('HTTP fallback is ordered, counts unhealthy candidates once, and skips suspended profiles', async () => {
  const store = new InMemoryRivetLLMProfileHealthStore();
  const primary = profile('jev', { enableCircuitBreaker: true, circuitBreakerFailureThreshold: 1 });
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).includes('liquid') ? reply('liquid') : new Response('', { status: 503 });
  };
  const ctx = context({ llmProfileHealthStore: store });
  await evaluate([primary, profile('liquid')], ctx);
  assert.equal(calls.length, 2);
  const entries = store.list({ projectId: 'project-a' as never, family: 'classifier' });
  assert.equal(entries[0]!.state, 'open');
  assert.equal(entries[0]!.failureCount, 1);
  calls.length = 0;
  const second = await evaluate([primary, profile('liquid')], ctx);
  assert.equal(calls.length, 1);
  assert.match(second.classifierProfileSummary!.value as string, /suspended/);
});

void test('Authentication, invalid response and unsupported image failures do not suspend a healthy route', async () => {
  for (const mode of ['auth', 'validation', 'image']) {
    const store = new InMemoryRivetLLMProfileHealthStore();
    const primary = profile('jev', { enableCircuitBreaker: true, circuitBreakerFailureThreshold: 1 });
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (String(url).includes('liquid')) return reply('liquid');
      return mode === 'auth'
        ? new Response('', { status: 401 })
        : new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    };
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
    const result = await evaluate(
      [primary, profile('liquid')],
      context({ llmProfileHealthStore: store }),
      mode === 'image' ? { state: { type: 'chat-message', value: { type: 'user', message: ['Caption', image] } } } : {},
    );
    assert.equal(calls, mode === 'image' ? 1 : 2);
    assert.equal(store.list()[0]!.failureCount, 0);
    assert.match(result.classifierProfileSummary!.value as string, /2\..*succeeded/);
  }
});

void test('Health-service failures are fail-open and never expose service diagnostics in classifier attempts', async () => {
  for (const operation of ['begin', 'finish'] as const) {
    const store = new InMemoryRivetLLMProfileHealthStore();
    store[operation] = () => {
      throw new Error('service failure containing private-key');
    };
    globalThis.fetch = async () => reply('jev');
    const result = await evaluate(
      [profile('jev', { enableCircuitBreaker: true })],
      context({ llmProfileHealthStore: store }),
    );
    assert.equal(result.answers!.type, 'object');
    assert.match(result.classifierProfileSummary!.value as string, /succeeded/);
    assert.match(result.classifierProfileSummary!.value as string, /reliability service unavailable/);
    assert.ok(!JSON.stringify(result.classifierAttempts).includes('private-key'));
    assert.ok((result.classifierAttempts!.value as any[]).some((event) => event.healthDisposition === 'fail-open'));
  }
});

void test('Health completion cannot turn an expired overall deadline into successful node evidence', async () => {
  let now = originalNow();
  Date.now = () => now;
  const store = new InMemoryRivetLLMProfileHealthStore();
  const finish = store.finish.bind(store);
  store.finish = (request) => {
    const result = finish(request);
    now += 100;
    return result;
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('jev');
  };
  const result = await evaluate(
    [profile('jev', { enableCircuitBreaker: true }), profile('liquid')],
    context({ llmProfileHealthStore: store }),
    {},
    { profileChainTimeoutMs: 50, catchRequestFailed: true },
  );
  assert.equal(calls, 1);
  assert.equal(result.runFailed!.value, true);
  assert.equal(result.answers!.type, 'control-flow-excluded');
  assert.match(result.classifierProfileSummary!.value as string, /1\..*failed/);
  assert.match(result.classifierProfileSummary!.value as string, /2\..*not reached/);
});

void test('Fully suspended classifier chains do not call providers and concurrent recovery admits one probe', async () => {
  let now = originalNow();
  Date.now = () => now;
  const store = new InMemoryRivetLLMProfileHealthStore();
  const primary = profile('jev', {
    enableCircuitBreaker: true,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerOpenDurationMs: 100,
  });
  const ctx = context({ llmProfileHealthStore: store });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('', { status: 503 });
  };
  await evaluate([primary], ctx, {}, { catchRequestFailed: true });
  calls = 0;
  const skipped = await evaluate([primary], ctx, {}, { catchRequestFailed: true });
  assert.equal(calls, 0);
  assert.equal(skipped.runFailed!.value, true);
  assert.match(skipped.classifierProfileSummary!.value as string, /suspended/);
  assert.match(skipped.runError!.value as string, /next recovery attempt after/);
  assert.ok((skipped.classifierProfileSummary!.value as string).includes(new Date(now + 100).toISOString()));

  now += 101;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  globalThis.fetch = async () => {
    calls++;
    entered();
    await barrier;
    return reply('jev');
  };
  const probe = evaluate([primary], ctx);
  await started;
  const concurrent = await evaluate([primary], ctx, {}, { catchRequestFailed: true });
  assert.equal(concurrent.runFailed!.value, true);
  assert.equal(calls, 1);
  release();
  await probe;
  assert.equal(store.list()[0]!.state, 'closed');
});

void test('A deadline exhausted during rejected-request cleanup cannot be suppressed as an HTTP-only failure', async () => {
  let now = originalNow();
  Date.now = () => now;
  const store = new InMemoryRivetLLMProfileHealthStore();
  const finish = store.finish.bind(store);
  store.finish = (request) => {
    const result = finish(request);
    now += 100;
    return result;
  };
  globalThis.fetch = async () => new Response('', { status: 401 });
  const run = (caught: boolean) =>
    evaluate(
      [profile('jev', { enableCircuitBreaker: true })],
      context({ llmProfileHealthStore: store }),
      {},
      { profileChainTimeoutMs: 50, errorOnNon200: false, catchRequestFailed: caught },
    );
  await assert.rejects(run(false), (error) => {
    assert.match(String(error), /chain exhausted/);
    assert.equal((error as any).statusCode, undefined);
    assert.match(String((error as Error).cause), /overall deadline expired/);
    return true;
  });
  const caught = await run(true);
  assert.equal(caught.runFailed!.value, true);
  assert.equal(caught.answers!.type, 'control-flow-excluded');
  assert.equal(
    (caught.classifierAttempts!.value as any[]).at(-1).timeoutKind,
    undefined,
    'Overall deadline expiry is not a suspension response timeout',
  );
  assert.equal(store.list()[0]!.failureCount, 0);
});

void test('Cancellation during health completion never returns outputs or reaches another profile', async () => {
  for (const status of [200, 401]) {
    const controller = new AbortController();
    const stop = new Error('Cancelled during cleanup');
    const store = new InMemoryRivetLLMProfileHealthStore();
    const finish = store.finish.bind(store);
    store.finish = (request) => {
      const result = finish(request);
      controller.abort(stop);
      return result;
    };
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return status === 200 ? reply('jev') : new Response('', { status });
    };
    await assert.rejects(
      evaluate(
        [profile('jev', { enableCircuitBreaker: true }), profile('liquid')],
        context({ llmProfileHealthStore: store, signal: controller.signal }),
        {},
        { catchRequestFailed: true, errorOnNon200: false },
      ),
      (error) => error === stop,
    );
    assert.equal(calls, 1);
    assert.equal(store.list()[0]!.failureCount, 0);
  }
});

void test('A health permit arriving after cancellation is released without making a provider call', async () => {
  const controller = new AbortController();
  const store = new InMemoryRivetLLMProfileHealthStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finished!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let finishOutcome: string | undefined;
  const service = {
    begin: async (request: Parameters<typeof store.begin>[0]) => {
      entered();
      await gate;
      return store.begin(request);
    },
    finish: (request: Parameters<typeof store.finish>[0]) => {
      finishOutcome = request.outcome;
      const result = store.finish(request);
      finished();
      return result;
    },
    renew: store.renew.bind(store),
    reset: store.reset.bind(store),
    list: store.list.bind(store),
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('jev');
  };
  const pending = evaluate(
    [profile('jev', { enableCircuitBreaker: true }), profile('liquid')],
    context({ signal: controller.signal, llmProfileHealthStore: service }),
    {},
    { catchRequestFailed: true },
  );
  await started;
  const stop = new Error('Cancelled before health admission');
  controller.abort(stop);
  await assert.rejects(pending, (error) => error === stop);
  release();
  await cleanup;
  assert.equal(calls, 0);
  assert.equal(finishOutcome, 'ignored');
  assert.equal(store.list()[0]!.failureCount, 0);
});

void test('Shared malformed questions fail before health/HTTP, and evidence is snapshotted across fallback', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return reply('jev');
  };
  const store = new InMemoryRivetLLMProfileHealthStore();
  await assert.rejects(
    evaluate([profile('jev', { enableCircuitBreaker: true })], context({ llmProfileHealthStore: store }), {
      question2: { type: 'object', value: question },
    }),
    /duplicated/,
  );
  assert.equal(calls, 0);
  assert.equal(store.list().length, 0);
  const mutableQuestion = { ...question };
  const mutableState = { caption: 'original' };
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('liquid')) {
      mutableQuestion.instructions = 'changed';
      mutableState.caption = 'changed';
      return new Response('', { status: 401 });
    }
    const body = JSON.parse(options!.body as string);
    assert.equal(body.state.caption, 'original');
    assert.equal(body.questions.q.instructions, 'Check state');
    return reply('liquid');
  };
  await evaluate([profile('jev'), profile('liquid')], context(), {
    state: { type: 'object', value: mutableState },
    question1: { type: 'object', value: mutableQuestion },
  });
});

void test('Interrupted response receipt advances fallback and suspends the route, unlike malformed JSON', async () => {
  const store = new InMemoryRivetLLMProfileHealthStore();
  const primary = profile('jev', { enableCircuitBreaker: true, circuitBreakerFailureThreshold: 1 });
  globalThis.fetch = async (url) =>
    String(url).includes('liquid')
      ? reply('liquid')
      : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('Connection reset'));
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
  const result = await evaluate([primary, profile('liquid')], context({ llmProfileHealthStore: store }));
  const entries = store.list({ family: 'classifier' });
  assert.equal(entries[0]!.state, 'open');
  assert.equal(entries[0]!.failureCount, 1);
  const attempts = result.classifierAttempts!.value as Array<{ provider: string; stage: string; outcome: string }>;
  assert.equal(
    attempts.filter(
      (attempt) => attempt.provider === 'jev' && attempt.stage === 'request' && attempt.outcome === 'failure',
    ).length,
    1,
  );
  assert.match(result.classifierProfileSummary!.value as string, /2\..*succeeded/);
});

void test('Decision AI response deadlines are inert without enabled hosted suspension', async () => {
  let now = originalNow();
  Date.now = () => now;
  for (const enableCircuitBreaker of [false, true]) {
    const store = new InMemoryRivetLLMProfileHealthStore();
    let calls = 0;
    globalThis.fetch = async () => {
      now += 10;
      return ++calls === 1 ? new Response('', { status: 503 }) : reply('jev');
    };
    const result = await evaluate(
      [profile('jev', { enableCircuitBreaker, responseTimeoutMs: 1 })],
      context({ llmProfileHealthStore: enableCircuitBreaker ? undefined : store }),
      {},
      { retryOnNon200: true },
    );
    assert.equal(calls, 2, 'Inactive suspension must not apply a 1 ms deadline to requests or retries');
    assert.ok(result.answers?.type !== 'control-flow-excluded');
    assert.equal(store.list({ family: 'classifier' }).length, 0);
  }
});

void test('Evaluate overall deadline still bounds runs with suspension disabled', async () => {
  globalThis.fetch = async () => new Promise<Response>(() => {});
  const result = await evaluate(
    [profile('jev', { enableCircuitBreaker: false, responseTimeoutMs: 1 })],
    context({ llmProfileHealthStore: new InMemoryRivetLLMProfileHealthStore() }),
    {},
    { profileChainTimeoutMs: 30, catchRequestFailed: true },
  );
  assert.equal(result.runFailed!.value, true);
  assert.ok(
    (result.classifierAttempts!.value as Array<{ timeoutKind?: string }>).every((attempt) => !attempt.timeoutKind),
  );
});

void test('Enabled hosted profile timeout advances fallback, but cancellation is never caught or retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? new Promise<Response>(() => {}) : reply('liquid');
  };
  const store = new InMemoryRivetLLMProfileHealthStore();
  await evaluate(
    [
      profile('jev', { enableCircuitBreaker: true, responseTimeoutMs: 30, circuitBreakerFailureThreshold: 1 }),
      profile('liquid'),
    ],
    context({ llmProfileHealthStore: store }),
  );
  assert.equal(calls, 2);
  assert.equal(store.list({ family: 'classifier' })[0]!.state, 'open');
  const controller = new AbortController();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    controller.abort(new Error('Stopped by user'));
    return new Promise<Response>(() => {});
  };
  await assert.rejects(
    evaluate(
      [profile('jev'), profile('liquid')],
      context({ signal: controller.signal }),
      {},
      { catchRequestFailed: true },
    ),
    /Stopped by user/,
  );
  assert.equal(calls, 1);
});

void test('Exhausted chain keeps diagnostic evidence when caught without exposing credentials', async () => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  const result = await evaluate([profile('jev'), profile('liquid')], context(), {}, { catchRequestFailed: true });
  assert.equal(result.runFailed!.value, true);
  assert.equal(result.answers!.type, 'control-flow-excluded');
  assert.match(result.classifierProfileSummary!.value as string, /failed/);
  assert.ok((result.classifierAttempts!.value as unknown[]).length >= 2);
  assert.ok(!JSON.stringify(result).includes('private-key'));
});

void test('Disabling HTTP failures never suppresses mixed profile-chain failures via the final cause', async () => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  const unavailable = { ...profile('jev'), credential: {} };
  for (const profiles of [
    [unavailable, profile('liquid')],
    [profile('liquid'), unavailable],
  ]) {
    await assert.rejects(evaluate(profiles, context(), {}, { errorOnNon200: false }), /chain exhausted/);
    const caught = await evaluate(profiles, context(), {}, { errorOnNon200: false, catchRequestFailed: true });
    assert.equal(caught.runFailed!.value, true);
    assert.match(caught.classifierProfileSummary!.value as string, /failed/);
  }
  const httpOnly = await evaluate([profile('jev'), profile('liquid')], context(), {}, { errorOnNon200: false });
  assert.equal(httpOnly.answers!.type, 'control-flow-excluded');
  assert.equal(httpOnly.runFailed, undefined);

  globalThis.fetch = async (url) =>
    String(url).includes('liquid')
      ? new Response('', { status: 401 })
      : new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(
    evaluate([profile('jev'), profile('liquid')], context(), {}, { errorOnNon200: false }),
    /chain exhausted/,
  );
});

void test('Profile snapshotting obeys preparation cancellation/deadlines without invoking authored hooks', () => {
  const stop = new Error('Preparation cancelled');
  let checks = 0;
  assert.throws(
    () =>
      normalizeClassifierProfiles([profile(), profile()], () => {
        if (++checks === 10) throw stop;
      }),
    (error) => error === stop,
  );
  assert.equal(checks, 10);
  let accessorReads = 0;
  const hostile = Object.defineProperty({ ...profile() }, 'credential', {
    enumerable: true,
    get: () => {
      accessorReads++;
      return { value: 'key' };
    },
  });
  assert.throws(() => normalizeClassifierProfiles([hostile]), /accessors/);
  assert.equal(accessorReads, 0);
  const original = profile();
  const [detached] = normalizeClassifierProfiles([original]);
  original.configuration.model = 'changed';
  original.credential.value = 'changed';
  assert.equal(detached!.configuration.model, 'jev-latest');
  assert.equal(detached!.credential.value, 'private-key');
});

void test('Profile normalization rejects malformed/cyclic/sparse chains and keeps family/identity stable', () => {
  for (const value of [
    [],
    Array(129).fill(profile()),
    Array(1),
    { ...profile(), credential: 'bad' },
    { ...profile(), configuration: [] },
  ])
    assert.throws(() => normalizeClassifierProfiles(value));
  const cycle: any[] = [];
  cycle.push(cycle);
  assert.throws(() => normalizeClassifierProfiles(cycle), /circular/);
  const original = profile('jev');
  const identity = classifierProfileHealthIdentity(original, 'project-a' as never, 'evaluate' as never);
  assert.equal(identity.family, 'classifier');
  assert.equal(
    classifierProfileHealthIdentity({ ...original, profileName: 'renamed' }, 'project-a' as never, 'evaluate' as never)
      .key,
    identity.key,
  );
  assert.notEqual(
    classifierProfileHealthIdentity(
      { ...original, credential: { value: 'rotated' } },
      'project-a' as never,
      'evaluate' as never,
    ).key,
    identity.key,
  );
  assert.notEqual(
    classifierProfileHealthIdentity(original, 'project-b' as never, 'evaluate' as never).key,
    identity.key,
  );
  assert.ok(!JSON.stringify(identity).includes('private-key'));
});

void test('Profile summaries use terminal execution outcomes, not discarded retries or health updates', () => {
  const base = { provider: 'jev', model: 'jev-latest', roundIndex: 0, profileIndex: 0 };
  assert.match(
    classifierProfileSummary(
      [profile()],
      [
        { ...base, stage: 'request', outcome: 'failure', status: 503 },
        { ...base, stage: 'request', outcome: 'success', status: 200 },
        { ...base, stage: 'health-update', outcome: 'failure' },
      ],
    ),
    /succeeded/,
  );
  assert.match(
    classifierProfileSummary(
      [profile()],
      [
        { ...base, stage: 'request', outcome: 'success', status: 200 },
        { ...base, stage: 'request', outcome: 'failure', timeoutKind: 'response' },
        { ...base, stage: 'health-update', outcome: 'success', healthOutcome: 'unhealthy' },
      ],
    ),
    /failed/,
  );
});

for (const variant of ['authored', 'saved', 'prefab', 'bundle', 'cross-project'])
  for (const split of [false, true])
    void test(`Real Profile → Array → Evaluate preserves the chain (${variant}, split=${split})`, async () => {
      const primary = ClassifierProfileNodeImpl.create();
      primary.data = { provider: 'jev', apiKeySource: 'input' }; // deliberately unavailable
      const secondary = ClassifierProfileNodeImpl.create();
      secondary.data = { provider: 'openai' };
      const array = ArrayNodeImpl.create();
      const state = GraphInputNodeImpl.create();
      state.data.id = 'state';
      state.data.dataType = 'string';
      const questions = GraphInputNodeImpl.create();
      questions.data.id = 'questions';
      questions.data.dataType = 'object';
      const evaluateNode = ClassifierEvaluateNodeImpl.create();
      Object.assign(evaluateNode.data, { configurationMode: 'profile', outputRequestBody: true });
      evaluateNode.isSplitRun = split;
      const output = GraphOutputNodeImpl.create();
      output.data.id = 'request';
      output.data.dataType = 'object';
      const wire = (from: string, outputId: string, to: string, inputId: string) =>
        ({ outputNodeId: from, outputId, inputNodeId: to, inputId }) as NodeConnection;
      const graph = {
        metadata: { id: 'profile-graph', name: 'Decision AI profiles', description: '' },
        nodes: [primary, secondary, array, state, questions, evaluateNode, output],
        connections: [
          wire(primary.id, 'profile', array.id, 'input1'),
          wire(secondary.id, 'profile', array.id, 'input2'),
          wire(array.id, 'output', evaluateNode.id, 'classifierProfile'),
          wire(state.id, 'data', evaluateNode.id, 'state'),
          wire(questions.id, 'data', evaluateNode.id, 'question1'),
          wire(evaluateNode.id, 'requestBody', output.id, 'value'),
        ],
      };
      let project = {
        metadata: { id: 'profiles-project', title: 'Profiles', description: '', mainGraphId: graph.metadata.id },
        graphs: { [graph.metadata.id]: graph },
        plugins: [],
      } as unknown as Project;
      let targetProject: Project | undefined;
      if (variant === 'prefab') {
        project.nodePrefabs = { route: { id: 'route' as never, sourceNode: structuredClone(secondary) } };
        graph.nodes[1] = { ...secondary, type: 'nodePrefabInstance', data: { prefabId: 'route' } } as never;
      }
      if (variant === 'cross-project') {
        const profileOutput = GraphOutputNodeImpl.create();
        profileOutput.data = { ...profileOutput.data, id: 'profile', dataType: 'classifier-config' };
        targetProject = {
          metadata: { id: 'profile-library', title: 'Profiles', description: '', mainGraphId: 'profile-source' },
          graphs: {
            'profile-source': {
              metadata: { id: 'profile-source', name: 'Profile', description: '' },
              nodes: [secondary, profileOutput],
              connections: [wire(secondary.id, 'profile', profileOutput.id, 'value')],
            },
          },
          plugins: [],
        } as unknown as Project;
        const call = SubGraphNodeImpl.create();
        call.id = secondary.id;
        Object.assign(call.data, {
          graphId: 'profile-source',
          targetProjectId: 'profile-library',
          targetVersion: 'latest',
        });
        graph.nodes[1] = call as never;
        targetProject = deserializeProject(serializeProject(targetProject))[0];
      }
      if (variant !== 'authored') {
        const serialized = serializeProject(project);
        assert.ok(!JSON.stringify(serialized).includes('private-key'));
        project = deserializeProject(serialized)[0];
      }
      if (variant === 'bundle' || targetProject) {
        const projects = new Map([['root', project], ...(targetProject ? [['library', targetProject] as const] : [])]);
        validateProjectBundleProjects(
          {
            artifacts: [...projects].map(([id, item]) => ({
              id,
              projectId: item.metadata.id!,
              title: item.metadata.title,
              version: 'latest',
              revision: 'fixture',
              project: { path: `${id}.rivet-project`, bytes: 0, sha256: 'fixture' },
            })),
            targets: targetProject
              ? [{ projectId: targetProject.metadata.id!, version: 'latest', artifact: 'library' }]
              : [],
            references: [],
            plugins: [],
          } as ProjectBundleManifest,
          projects,
        );
      }
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return reply('openai');
      };
      const processor = new GraphProcessor(project, graph.metadata.id as never, createBuiltInRegistry(), {
        executor: 'nodejs',
      });
      const errors: string[] = [];
      processor.on('nodeError', ({ error }) => {
        errors.push(String(error));
      });
      const result = await processor.processGraph(
        {
          ...testProcessContext(),
          settings: { classifierProviders: { openai: { apiKey: 'private-key' } } },
          ...(targetProject
            ? { subgraphProjectLoader: { loadTarget: async () => ({ project: targetProject! }) } }
            : {}),
        },
        { state: { type: 'string', value: 'Shared text' }, questions: { type: 'object', value: question } },
      );
      assert.deepEqual(errors, []);
      assert.equal(calls, 1);
      const request = split ? (result.request!.value as any[])[0] : (result.request!.value as any);
      assert.equal(request.input, 'Shared text');
      assert.equal(request.model, 'gpt-6-luna');
    });

void test('Attempt failure kinds distinguish credentials, capabilities, authentication, parsing and validation', async () => {
  const cases = [
    { kind: 'configuration', candidate: { ...profile(), credential: {} }, response: () => reply('jev') },
    { kind: 'capability', candidate: profile(), executor: 'browser', response: () => reply('jev') },
    { kind: 'authentication', candidate: profile(), response: () => new Response('', { status: 401 }) },
    { kind: 'http', candidate: profile(), response: () => new Response('', { status: 503 }) },
    { kind: 'response-parsing', candidate: profile(), response: () => new Response('not JSON') },
    { kind: 'response-validation', candidate: profile(), response: () => new Response('{}') },
  ];
  for (const scenario of cases) {
    const events: LLMProfileAttemptTraceEvent[] = [];
    globalThis.fetch = async () => scenario.response();
    const result = await evaluate(
      [scenario.candidate],
      context({
        processId: 'process' as never,
        ...(scenario.executor ? { executor: scenario.executor as 'browser' } : {}),
        onLLMProfileAttempt: (event) => events.push(event),
      }),
      {},
      { catchRequestFailed: true },
    );
    const attempt = (result.classifierAttempts!.value as any[]).at(-1);
    assert.equal(attempt.failureKind, scenario.kind);
    assert.ok(!JSON.stringify(events).includes('private-key'));
    const execution = { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'root' } as GraphExecutionMetadata;
    assert.ok(
      isAgentResponseTrace(
        buildAgentResponseTrace({
          scope: 'response',
          execution,
          status: 'response-ready',
          events: events.map((event) => ({ ...event, type: 'llm-profile-attempt', execution })),
        }),
      ),
    );
  }
});
