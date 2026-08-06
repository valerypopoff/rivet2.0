import { describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ChatV2CallFinishedEvent, GraphExecutionMetadata } from '../../../src/model/ProcessContext.js';
import { buildAgentResponseTrace, isAgentResponseTrace } from '../../../src/model/AgentResponseTrace.js';
import {
  createLLMProfileFallbackRunner,
  LLMProfileFallbackExhaustedError,
} from '../../../src/model/chat-v2/llmProfileFallback.js';
import { createDefaultLLMProfileValue, normalizeLLMProfileChainInput } from '../../../src/model/chat-v2/llmProfile.js';
import { resolveLLMChatV2RuntimeConfig } from '../../../src/model/chat-v2/llmChatV2NodeRuntime.js';
import type { ChatV2Model, RunChatV2PipelineOptions } from '../../../src/model/chat-v2/chatV2Types.js';
import { LLMChatV2NodeImpl } from '../../../src/model/nodes/LLMChatV2Node.js';
import type { PortId } from '../../../src/model/NodeBase.js';

function baseRoundOptions(overrides: Partial<RunChatV2PipelineOptions> = {}): RunChatV2PipelineOptions {
  return {
    provider: 'custom',
    model: {} as ChatV2Model,
    modelId: 'placeholder',
    prompt: { type: 'string', value: 'Hello' },
    emitPartialOutputs: false,
    context: {
      signal: new AbortController().signal,
    },
    ...overrides,
  };
}

describe('LLM Profile fallback chain', () => {
  it('accepts one profile or an ordered array and identifies malformed members by index', () => {
    const first = createDefaultLLMProfileValue();
    const second = {
      ...createDefaultLLMProfileValue(),
      configuration: {
        ...createDefaultLLMProfileValue().configuration,
        model: 'backup-model',
      },
    };

    assert.deepEqual(
      normalizeLLMProfileChainInput(first).map((profile) => profile.configuration.model),
      ['gpt-5'],
    );
    assert.deepEqual(
      normalizeLLMProfileChainInput([first, second]).map((profile) => profile.configuration.model),
      ['gpt-5', 'backup-model'],
    );
    assert.throws(() => normalizeLLMProfileChainInput([]), /at least one LLM Profile/);
    assert.throws(() => normalizeLLMProfileChainInput([first, { version: 1 }]), /item 1 is invalid/);
  });

  it('exposes one profile-or-chain input, universal attempt history, and preserves the chain during Many-runs', () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        outputLLMAttempts: true,
      },
    });
    const profileInput = node.getInputDefinitions().find((input) => input.id === 'llmProfile');
    const attemptsOutput = node.getOutputDefinitions().find((output) => output.id === 'llmAttempts');
    const summaryOutput = node.getOutputDefinitions().find((output) => output.id === 'llmProfileSummary');

    assert.deepEqual(profileInput?.dataType, ['llm-config', 'llm-config[]']);
    assert.equal(profileInput?.splitRunBehavior, 'preserve-array');
    assert.deepEqual(attemptsOutput?.dataType, 'object[]');
    assert.deepEqual(summaryOutput?.dataType, 'string');
  });

  it('reports no LLM attempts on an editor-cache hit instead of replaying stale history', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        cache: true,
        outputLLMAttempts: true,
      },
    });
    const inputs = {
      prompt: { type: 'string', value: 'Hello' },
      llmProfile: {
        type: 'llm-config[]',
        value: [createDefaultLLMProfileValue(), createDefaultLLMProfileValue()],
      },
    } as any;
    let cacheHitMarks = 0;
    const context = {
      signal: new AbortController().signal,
      editorExecutionCache: new Map<string, unknown>(),
      markResultAsEditorCacheHit: () => {
        cacheHitMarks += 1;
      },
    } as any;
    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs,
      context,
    });

    assert.ok(runtime.cacheKey);
    context.editorExecutionCache.set(runtime.cacheKey!, {
      response: { type: 'string', value: 'cached answer' },
      llmAttempts: {
        type: 'object[]',
        value: [{ profileIndex: 0, status: 500 }],
      },
    });

    const outputs = await node.process(inputs, context);

    assert.equal(outputs.response?.value, 'cached answer');
    assert.deepEqual(outputs.llmAttempts, { type: 'object[]', value: [] });
    assert.deepEqual(outputs.llmProfileSummary, {
      type: 'string',
      value: 'Editor cache hit — no LLM Profile calls were made for this run.',
    });
    assert.equal('requestStatus' in outputs, false);
    assert.equal('requestError' in outputs, false);
    assert.equal(cacheHitMarks, 1);
  });

  it('does not cache a profile chain when any candidate enables a provider-native tool', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        cache: true,
      },
    });
    const profile = createDefaultLLMProfileValue();
    profile.configuration = { ...profile.configuration, enableOpenAIWebSearch: true };

    const runtime = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        prompt: { type: 'string', value: 'Hello' },
        llmProfile: { type: 'llm-config', value: profile },
      } as any,
      context: {
        signal: new AbortController().signal,
        editorExecutionCache: new Map<string, unknown>(),
        settings: { openAiKey: 'test-key', chatNodeHeaders: {} },
        getPluginConfig: () => '',
      } as any,
    });

    assert.equal(runtime.editorCache, undefined);
    assert.equal(runtime.cacheKey, undefined);
  });

  it('keys the editor cache by fallback order without storing profile secrets', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        cache: true,
      },
    });
    const primary = {
      ...createDefaultLLMProfileValue(),
      credential: { value: 'primary-cache-secret', reference: { source: 'input' as const } },
    };
    const backup = {
      ...createDefaultLLMProfileValue(),
      configuration: {
        ...createDefaultLLMProfileValue().configuration,
        model: 'backup-model',
      },
      credential: { value: 'backup-cache-secret', reference: { source: 'input' as const } },
    };
    const context = {
      signal: new AbortController().signal,
      editorExecutionCache: new Map<string, unknown>(),
    } as any;

    const first = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        prompt: { type: 'string', value: 'Hello' },
        llmProfile: { type: 'llm-config[]', value: [primary, backup] },
      } as any,
      context,
    });
    const second = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        prompt: { type: 'string', value: 'Hello' },
        llmProfile: { type: 'llm-config[]', value: [backup, primary] },
      } as any,
      context,
    });

    assert.ok(first.cacheKey);
    assert.ok(second.cacheKey);
    assert.notEqual(first.cacheKey, second.cacheKey);
    assert.doesNotMatch(first.cacheKey!, /primary-cache-secret|backup-cache-secret/);
    assert.doesNotMatch(second.cacheKey!, /primary-cache-secret|backup-cache-secret/);
  });

  it('shares a profile cache entry between a scalar profile and an equivalent one-item profile array', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        cache: true,
        outputLLMAttempts: true,
      },
    });
    const profile = createDefaultLLMProfileValue();
    const context = {
      signal: new AbortController().signal,
      editorExecutionCache: new Map<string, unknown>(),
    } as any;

    const scalar = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        prompt: { type: 'string', value: 'Hello' },
        llmProfile: { type: 'llm-config', value: profile },
      } as any,
      context,
    });
    const chain = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs: {
        prompt: { type: 'string', value: 'Hello' },
        llmProfile: { type: 'llm-config[]', value: [profile] },
      } as any,
      context,
    });

    assert.equal(scalar.cacheKey, chain.cacheKey);
  });

  it('keys profile-mode editor cache entries by global Chat headers without storing raw header values', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        cache: true,
      },
    });
    const inputs = {
      prompt: { type: 'string', value: 'Hello' },
      llmProfile: { type: 'llm-config', value: createDefaultLLMProfileValue() },
    } as any;

    const first = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs,
      context: {
        signal: new AbortController().signal,
        editorExecutionCache: new Map<string, unknown>(),
        settings: { chatNodeHeaders: { 'x-feature': 'first-header-secret' } },
      } as any,
    });
    const second = await resolveLLMChatV2RuntimeConfig({
      data: node.data,
      nodeId: node.chartNode.id,
      inputs,
      context: {
        signal: new AbortController().signal,
        editorExecutionCache: new Map<string, unknown>(),
        settings: { chatNodeHeaders: { 'x-feature': 'second-header-secret' } },
      } as any,
    });

    assert.ok(first.cacheKey);
    assert.ok(second.cacheKey);
    assert.notEqual(first.cacheKey, second.cacheKey);
    assert.doesNotMatch(first.cacheKey!, /first-header-secret|second-header-secret/);
    assert.doesNotMatch(second.cacheKey!, /first-header-secret|second-header-secret/);
  });

  it('retries one profile before advancing to the next and preserves physical attempt history', async () => {
    const calls: number[] = [];
    const observed: ChatV2CallFinishedEvent[] = [];
    const journalObserved: Array<[number, number | undefined, string]> = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      onAttempt: (attempt) => journalObserved.push([attempt.profileIndex, attempt.attemptIndex, attempt.outcome]),
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'primary' : 'backup',
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 1,
        retryOnNon200CooldownMs: 0,
        context: {
          ...roundOptions.context,
          node: { id: 'chat' as any },
          processId: 'process' as any,
          onChatV2CallFinished: (event) => observed.push(event),
        },
        executeGenerate: async () => {
          calls.push(profileIndex);
          return {
            text: profileIndex === 0 ? 'primary error response' : 'backup answer',
            requestStatus: profileIndex === 0 ? 503 : 200,
          };
        },
      }),
    });

    const result = await runner.run(baseRoundOptions());

    assert.equal(result.response, 'backup answer');
    assert.deepEqual(calls, [0, 0, 1]);
    assert.deepEqual(
      runner.attempts.map((attempt) => [attempt.profileIndex, attempt.attemptIndex, attempt.status, attempt.outcome]),
      [
        [0, 0, 503, 'failure'],
        [0, 1, 503, 'failure'],
        [1, 0, 200, 'success'],
      ],
    );
    assert.deepEqual(
      observed.map((event) => [event.profileIndex, event.roundIndex, event.attemptIndex, event.outcome]),
      [
        [0, 0, 0, 'provider-failure'],
        [0, 0, 1, 'provider-failure'],
        [1, 0, 0, 'success'],
      ],
    );
    assert.deepEqual(journalObserved, [
      [0, 0, 'failure'],
      [0, 1, 'failure'],
      [1, 0, 'success'],
    ]);
    assert.equal(
      runner.summary(),
      'Profile 0 (Custom Completions/primary): failed after 2 provider attempts; last status 503.\n' +
        'Profile 1 (Custom Completions/backup): succeeded in model 1 round (0).',
    );
  });

  it('keeps Completions and Responses identities distinct across a mixed fallback chain', async () => {
    const observed: ChatV2CallFinishedEvent[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'shared-model', customProviderApi: 'completions' },
        { provider: 'custom', model: 'shared-model', customProviderApi: 'responses' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => {
        const customProviderApi = profileIndex === 0 ? 'completions' : 'responses';
        return {
          ...roundOptions,
          provider: 'custom',
          customProviderApi,
          model: {} as ChatV2Model,
          modelId: 'shared-model',
          context: {
            ...roundOptions.context,
            node: { id: 'chat' as any },
            processId: 'process' as any,
            onChatV2CallFinished: (event) => observed.push(event),
          },
          executeGenerate: async () => ({
            text: profileIndex === 0 ? 'failed' : 'recovered',
            requestStatus: profileIndex === 0 ? 503 : 200,
          }),
        };
      },
    });

    const result = await runner.run(baseRoundOptions());

    assert.equal(result.response, 'recovered');
    assert.deepEqual(
      runner.attempts.map(({ profileIndex, customProviderApi, outcome }) => ({
        profileIndex,
        customProviderApi,
        outcome,
      })),
      [
        { profileIndex: 0, customProviderApi: 'completions', outcome: 'failure' },
        { profileIndex: 1, customProviderApi: 'responses', outcome: 'success' },
      ],
    );
    assert.deepEqual(
      observed.map(({ profileIndex, customProviderApi, outcome }) => ({ profileIndex, customProviderApi, outcome })),
      [
        { profileIndex: 0, customProviderApi: 'completions', outcome: 'provider-failure' },
        { profileIndex: 1, customProviderApi: 'responses', outcome: 'success' },
      ],
    );
    assert.equal(
      runner.summary(),
      'Profile 0 (Custom Completions/shared-model): failed after 1 provider attempt; last status 503.\n' +
        'Profile 1 (Custom Responses/shared-model): succeeded in model 1 round (0).',
    );
  });

  it('falls through an invalid Custom URL before any request reaches a valid Responses profile', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        useAsGraphPartialOutput: false,
        outputLLMAttempts: true,
      },
    });
    const malformed = createDefaultLLMProfileValue();
    malformed.configuration = {
      ...malformed.configuration,
      provider: 'custom',
      model: 'shared-model',
      customProviderApi: 'completions',
      customProviderBaseURL: 'not a URL',
    };
    malformed.credential = { value: 'primary-key', reference: { source: 'input' } };
    const backup = createDefaultLLMProfileValue();
    backup.configuration = {
      ...backup.configuration,
      provider: 'custom',
      model: 'shared-model',
      customProviderApi: 'responses',
      customProviderBaseURL: 'https://backup.example.test/v1/responses?api-version=2026-08-01',
    };
    backup.credential = { value: 'backup-key', reference: { source: 'input' } };
    const attempts: Array<Record<string, unknown>> = [];
    const requestedURLs: string[] = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (input) => {
      requestedURLs.push(String(input));
      return new Response(
        JSON.stringify({
          id: 'resp_backup',
          created_at: 1_700_000_000,
          model: 'shared-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg_backup',
              content: [{ type: 'output_text', text: 'Recovered', annotations: [] }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const runtime = await resolveLLMChatV2RuntimeConfig({
        data: node.data,
        nodeId: node.chartNode.id,
        inputs: {
          prompt: { type: 'string', value: 'Hello' },
          llmProfile: { type: 'llm-config[]', value: [malformed, backup] },
        } as any,
        context: {
          signal: new AbortController().signal,
          settings: { chatNodeHeaders: {} },
          getPluginConfig: () => '',
        } as any,
        onLLMAttempt: (attempt) => attempts.push(attempt),
      });
      const result = await runtime.runPipeline(runtime.runOptions);

      assert.equal(result.response, 'Recovered');
      assert.deepEqual(requestedURLs, ['https://backup.example.test/v1/responses?api-version=2026-08-01']);
      assert.equal(attempts[0]?.stage, 'configuration');
      assert.match(String(attempts[0]?.error), /valid absolute HTTP or HTTPS URL/);
      assert.equal(attempts[1]?.customProviderApi, 'responses');
      assert.equal(attempts[1]?.outcome, 'success');
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('parses Custom Responses JSON schema output and advances immediately after invalid structured output', async () => {
    const created = LLMChatV2NodeImpl.create();
    const node = new LLMChatV2NodeImpl({
      ...created,
      data: {
        ...created.data,
        configurationMode: 'profile',
        responseFormat: 'json_schema',
        responseSchemaName: 'answer_schema',
        useAsGraphPartialOutput: false,
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 3,
        retryOnNon200CooldownMs: 0,
        outputLLMAttempts: true,
      },
    });
    const profile = (host: string) => {
      const value = createDefaultLLMProfileValue();
      value.configuration = {
        ...value.configuration,
        provider: 'custom',
        model: 'shared-model',
        customProviderApi: 'responses',
        customProviderBaseURL: `https://${host}.example.test/v1`,
      };
      value.credential = { value: `${host}-key`, reference: { source: 'input' } };
      return value;
    };
    const requestedHosts: string[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    const fetchMock = mock.method(globalThis, 'fetch', async (input) => {
      const host = new URL(String(input)).hostname.split('.')[0]!;
      requestedHosts.push(host);
      const text = host === 'primary' ? 'not-json' : '{"answer":"Recovered"}';
      return new Response(
        JSON.stringify({
          id: `resp_${host}`,
          created_at: 1_700_000_000,
          model: 'shared-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: `msg_${host}`,
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    try {
      const runtime = await resolveLLMChatV2RuntimeConfig({
        data: node.data,
        nodeId: node.chartNode.id,
        inputs: {
          prompt: { type: 'string', value: 'Return JSON.' },
          responseSchema: {
            type: 'object',
            value: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
          llmProfile: { type: 'llm-config[]', value: [profile('primary'), profile('backup')] },
        } as any,
        context: {
          signal: new AbortController().signal,
          settings: { chatNodeHeaders: {} },
          getPluginConfig: () => '',
        } as any,
        onLLMAttempt: (attempt) => attempts.push(attempt),
      });
      const result = await runtime.runPipeline(runtime.runOptions);

      assert.deepEqual(result.commonOutputs['response' as PortId], {
        type: 'object',
        value: { answer: 'Recovered' },
      });
      assert.deepEqual(requestedHosts, ['primary', 'backup']);
      assert.deepEqual(
        attempts.map(({ profileIndex, stage, outcome }) => ({ profileIndex, stage, outcome })),
        [
          { profileIndex: 0, stage: 'request', outcome: 'success' },
          { profileIndex: 0, stage: 'response-validation', outcome: 'failure' },
          { profileIndex: 1, stage: 'request', outcome: 'success' },
        ],
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it('makes unused fallback profiles explicit in the human-readable summary', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (_profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        executeGenerate: async () => ({ text: 'primary answer', requestStatus: 200 }),
      }),
    });

    await runner.run(baseRoundOptions());

    assert.equal(
      runner.summary(),
      'Profile 0 (Custom Completions/primary): succeeded in model 1 round (0).\n' +
        'Profile 1 (Custom Completions/backup): not attempted.',
    );
  });

  it('advances immediately after parsed Response validation fails without non-200 retries', async () => {
    const calls: number[] = [];
    let primaryCalls = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'invalid-json' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'invalid-json' : 'backup',
        responseOutput: { name: 'answer_schema' },
        responseFormat: 'json_schema',
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 3,
        retryOnNon200CooldownMs: 0,
        executeGenerate: async () => {
          calls.push(profileIndex);
          if (profileIndex === 0) {
            primaryCalls += 1;
          }
          return {
            text: profileIndex === 0 ? (primaryCalls === 1 ? 'temporary error' : 'not json') : '{"answer":"backup"}',
            requestStatus: profileIndex === 0 && primaryCalls === 1 ? 503 : 200,
          };
        },
      }),
    });

    const result = await runner.run(baseRoundOptions());

    assert.deepEqual(calls, [0, 0, 1]);
    assert.deepEqual(result.commonOutputs.response, {
      type: 'object',
      value: { answer: 'backup' },
    });
    assert.deepEqual(
      runner.attempts.map((attempt) => [attempt.profileIndex, attempt.stage, attempt.outcome, attempt.status]),
      [
        [0, 'request', 'failure', 503],
        [0, 'request', 'success', 200],
        [0, 'response-validation', 'failure', undefined],
        [1, 'request', 'success', 200],
      ],
    );
    assert.equal(
      runner.summary(),
      'Profile 0 (Custom Completions/invalid-json): had 1 failed provider attempt; last status 503; failed response validation in 1 model round.\n' +
        'Profile 1 (Custom Completions/backup): succeeded in model 1 round (0).',
    );
  });

  it('preserves the detailed parsed Response validation error for a scalar profile', async () => {
    let calls = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [{ provider: 'custom', model: 'only-profile' }],
      resolveCandidate: async (_profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'only-profile',
        responseOutput: { name: 'answer_schema' },
        responseFormat: 'json_schema',
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 2,
        retryOnNon200CooldownMs: 0,
        executeGenerate: async () => {
          calls += 1;
          return { text: 'not json', requestStatus: 200 };
        },
      }),
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions()),
      (error) => {
        assert.match(String(error), /Parsed Response type: string/);
        assert.match(String(error), /Retry on non-200 does not apply/);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      runner.attempts.map((attempt) => [attempt.stage, attempt.outcome, attempt.status]),
      [
        ['request', 'success', 200],
        ['response-validation', 'failure', undefined],
      ],
    );
  });

  it('explains successful requests and response-validation failures when every profile is exhausted', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'first-invalid' },
        { provider: 'custom', model: 'second-invalid' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'first-invalid' : 'second-invalid',
        responseOutput: { name: 'answer_schema' },
        responseFormat: 'json_schema',
        executeGenerate: async () => ({ text: 'not json', requestStatus: 200 }),
      }),
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions()),
      (error) => {
        assert.ok(error instanceof LLMProfileFallbackExhaustedError);
        assert.match(
          error.message,
          /Profile 0 \(Custom Completions\/first-invalid\), round 0, request attempt 0 success \(200\)/,
        );
        assert.match(
          error.message,
          /Profile 0 \(Custom Completions\/first-invalid\), round 0, response validation failure:/,
        );
        assert.match(
          error.message,
          /response validation failure: LLM profile response validation failed\.\n  Response format:/,
        );
        assert.match(
          error.message,
          /Profile 1 \(Custom Completions\/second-invalid\), round 0, request attempt 0 success \(200\)/,
        );
        assert.match(
          error.message,
          /Profile 1 \(Custom Completions\/second-invalid\), round 0, response validation failure:/,
        );
        return true;
      },
    );
    assert.equal(runner.wasExhausted(), true);
  });

  it('moves forward permanently after a profile succeeds in a prior model round', async () => {
    const calls: number[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'primary' : 'backup',
        executeGenerate: async () => {
          calls.push(profileIndex);
          return {
            text: profileIndex === 0 ? 'unavailable' : 'backup answer',
            requestStatus: profileIndex === 0 ? 503 : 200,
          };
        },
      }),
    });

    await runner.run(baseRoundOptions());
    await runner.run(baseRoundOptions());

    assert.deepEqual(calls, [0, 1, 1]);
    assert.deepEqual(
      runner.attempts.map((attempt) => [attempt.roundIndex, attempt.profileIndex]),
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
    );
  });

  it('records configuration failures verbatim and advances without making a provider call', async () => {
    const observed: ChatV2CallFinishedEvent[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'broken' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => {
        if (profileIndex === 0) {
          throw new Error('The configured key do-not-leak is invalid.');
        }

        return {
          ...roundOptions,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'backup',
          context: {
            ...roundOptions.context,
            node: { id: 'chat' as any },
            processId: 'process' as any,
            onChatV2CallFinished: (event) => observed.push(event),
          },
          executeGenerate: async () => ({ text: 'backup answer', requestStatus: 200 }),
        };
      },
    });

    const result = await runner.run(baseRoundOptions());

    assert.equal(result.response, 'backup answer');
    assert.deepEqual(runner.attempts[0], {
      roundIndex: 0,
      profileIndex: 0,
      provider: 'custom',
      model: 'broken',
      stage: 'configuration',
      outcome: 'failure',
      error: 'The configured key do-not-leak is invalid.',
    });
    assert.deepEqual(
      observed.map((event) => [event.profileIndex, event.roundIndex, event.outcome]),
      [[1, 0, 'success']],
    );

    const execution = {
      graphId: 'graph',
      graphRunId: 'graph-run',
      rootRunId: 'root-run',
    } as GraphExecutionMetadata;
    const trace = buildAgentResponseTrace({
      scope: 'llm-invocation',
      execution,
      nodeId: 'chat' as any,
      processId: 'process' as any,
      events: observed.map((event) => ({ type: 'llm-call-finished' as const, execution, ...event })),
      status: 'completed',
    });
    assert.equal(trace.summary.fallbackCount, 1);
    assert.equal(isAgentResponseTrace(trace), true);
  });

  it('retains full configuration failure text in fallback attempts', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => {
        if (profileIndex === 0) {
          throw new Error(
            'Credentials profile-api-key-secret, profile-header-secret, and global-header-secret were rejected.',
          );
        }
        return {
          ...roundOptions,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'backup',
          executeGenerate: async () => ({ text: 'backup answer', requestStatus: 200 }),
        };
      },
    });

    await runner.run(baseRoundOptions());

    assert.equal(
      runner.attempts[0]?.error,
      'Credentials profile-api-key-secret, profile-header-secret, and global-header-secret were rejected.',
    );
  });

  it('advances when a candidate fails while building its provider request', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'unsupported' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'unsupported' : 'backup',
        ...(profileIndex === 0
          ? {
              // Tool/schema planning happens after candidate resolution. A
              // fallback chain must still be able to try the next provider.
              functions: [
                {
                  get name() {
                    throw new Error('Primary tool definition cannot be planned.');
                  },
                } as any,
              ],
            }
          : {
              executeGenerate: async () => ({ text: 'backup answer', requestStatus: 200 }),
            }),
      }),
    });

    const result = await runner.run(baseRoundOptions());

    assert.equal(result.response, 'backup answer');
    assert.deepEqual(
      runner.attempts.map((attempt) => [attempt.profileIndex, attempt.stage, attempt.outcome]),
      [
        [0, 'configuration', 'failure'],
        [1, 'request', 'success'],
      ],
    );
  });

  it('preserves the legacy scalar-profile error for setup failures', async () => {
    const originalError = new Error('The configured profile cannot be prepared.');
    const runner = createLLMProfileFallbackRunner({
      candidates: [{ provider: 'custom', model: 'only-profile' }],
      resolveCandidate: async () => {
        throw originalError;
      },
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions()),
      (error) => error === originalError,
    );
    assert.equal(runner.wasExhausted(), true);
    assert.deepEqual(
      runner.attempts.map((attempt) => attempt.stage),
      ['configuration'],
    );
  });

  it('does not start a backup candidate when the graph is cancelled between profiles', async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'primary' : 'backup',
        executeGenerate: async () => {
          calls.push(profileIndex);
          if (profileIndex === 0) {
            controller.abort(new Error('Stopped by user.'));
            return { text: 'primary failure', requestStatus: 503 };
          }
          return { text: 'backup answer', requestStatus: 200 };
        },
      }),
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions({ context: { signal: controller.signal } })),
      /Stopped by user/,
    );
    assert.deepEqual(calls, [0]);
    assert.deepEqual(
      runner.attempts.map((attempt) => attempt.profileIndex),
      [0],
    );
  });

  it('does not start a provider call when cancellation occurs during candidate configuration', async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [{ provider: 'custom', model: 'primary' }],
      resolveCandidate: async (_profileIndex, roundOptions) => {
        controller.abort(new Error('Stopped during profile setup.'));
        return {
          ...roundOptions,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'primary',
          executeGenerate: async () => {
            calls += 1;
            return { text: 'should not run', requestStatus: 200 };
          },
        };
      },
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions({ context: { signal: controller.signal } })),
      /Stopped during profile setup/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(runner.attempts, []);
  });

  it('throws one aggregate failure after every profile is exhausted', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => ({
        ...roundOptions,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: profileIndex === 0 ? 'primary' : 'backup',
        executeGenerate: async () => ({ text: 'failed', requestStatus: 503 }),
      }),
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions()),
      (error) => {
        assert.ok(error instanceof LLMProfileFallbackExhaustedError);
        assert.match(error.message, /Profile 0 \(Custom Completions\/primary\)/);
        assert.match(error.message, /Profile 1 \(Custom Completions\/backup\)/);
        assert.equal((error as Error & { cause?: unknown }).cause, undefined);
        return true;
      },
    );
    assert.equal(runner.wasExhausted(), true);
  });

  it('does not report an earlier provider failure as terminal diagnostics after a later setup failure', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        { provider: 'custom', model: 'primary' },
        { provider: 'custom', model: 'broken-backup' },
      ],
      resolveCandidate: async (profileIndex, roundOptions) => {
        if (profileIndex === 1) {
          throw new Error('Backup provider configuration is invalid.');
        }

        return {
          ...roundOptions,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'primary',
          executeGenerate: async () => ({ text: 'primary failed', requestStatus: 503 }),
        };
      },
    });

    await assert.rejects(
      () => runner.run(baseRoundOptions()),
      (error) => {
        assert.ok(error instanceof LLMProfileFallbackExhaustedError);
        assert.match(error.message, /primary/);
        assert.match(error.message, /broken-backup/);
        assert.match(error.message, /Backup provider configuration is invalid/);
        return true;
      },
    );
  });
});
