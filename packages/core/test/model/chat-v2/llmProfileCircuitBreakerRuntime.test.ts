import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { NodeId } from '../../../src/model/NodeBase.js';
import type { ProjectId } from '../../../src/model/Project.js';
import type { ChatV2Model, RunChatV2PipelineOptions } from '../../../src/model/chat-v2/chatV2Types.js';
import {
  buildLLMProfileFallbackSummary,
  createLLMProfileFallbackRunner,
  isUnhealthyLLMProfileProviderFailure,
  LLMProfileFallbackExhaustedError,
  type LLMProfileFallbackCandidate,
} from '../../../src/model/chat-v2/llmProfileFallback.js';
import {
  InMemoryRivetLLMProfileHealthStore,
  type RivetLLMProfileHealthIdentity,
} from '../../../src/model/chat-v2/llmProfileHealthStore.js';

const policy = {
  failureThreshold: 1,
  failureWindowMs: 1_000,
  openDurationMs: 1_000,
  halfOpenLeaseMs: 100,
};

function identity(key: string): RivetLLMProfileHealthIdentity {
  return {
    key,
    projectId: 'project' as ProjectId,
    profileNodeId: key as NodeId,
    provider: 'custom',
    model: key,
    customProviderApi: 'completions',
    configurationFingerprint: `fingerprint-${key}`,
  };
}

function candidate(key: string): LLMProfileFallbackCandidate {
  return {
    provider: 'custom',
    model: key,
    health: {
      identity: identity(key),
      policy,
      firstOutputTimeoutMs: 20,
      streamInactivityTimeoutMs: 20,
    },
  };
}

function roundOptions(): RunChatV2PipelineOptions {
  return {
    provider: 'custom',
    model: {} as ChatV2Model,
    modelId: 'placeholder',
    prompt: { type: 'string', value: 'Hello' },
    emitPartialOutputs: false,
    context: { signal: new AbortController().signal },
  };
}

function open(store: InMemoryRivetLLMProfileHealthStore, profile: RivetLLMProfileHealthIdentity): void {
  const begin = store.begin({ identity: profile, policy });
  store.finish({ identity: profile, policy, permitId: begin.permitId!, outcome: 'unhealthy' });
}

describe('LLM Profile circuit-breaker fallback integration', () => {
  it('leaves saved Reliability policy inert when the host does not provide a health store', async () => {
    const resolved: number[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [
        {
          ...candidate('primary'),
          health: {
            ...candidate('primary').health!,
            firstOutputTimeoutMs: 5,
            streamInactivityTimeoutMs: 5,
          },
        },
        candidate('backup'),
      ],
      resolveCandidate: async (profileIndex, options) => {
        resolved.push(profileIndex);
        return {
          ...options,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: profileIndex === 0 ? 'primary' : 'backup',
          executeGenerate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { text: 'primary', requestStatus: 200 };
          },
        };
      },
    });

    const result = await runner.run(roundOptions());

    assert.equal(result.response, 'primary');
    assert.deepEqual(resolved, [0]);
    assert.equal(
      runner.attempts.some((attempt) => attempt.stage === 'health-gate'),
      false,
    );
    assert.equal(
      runner.attempts.some((attempt) => attempt.stage === 'health-update'),
      false,
    );
  });

  it('skips an open profile without resolving it and runs the next candidate', async () => {
    const store = new InMemoryRivetLLMProfileHealthStore();
    open(store, identity('primary'));
    const resolved: number[] = [];
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary'), candidate('backup')],
      healthStore: store,
      resolveCandidate: async (profileIndex, options) => {
        resolved.push(profileIndex);
        return {
          ...options,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: profileIndex === 0 ? 'primary' : 'backup',
          executeGenerate: async () => ({ text: 'backup', requestStatus: 200 }),
        };
      },
    });

    const result = await runner.run(roundOptions());
    assert.equal(result.response, 'backup');
    assert.deepEqual(resolved, [1]);
    assert.equal(runner.attempts[0]?.stage, 'health-gate');
    assert.equal(runner.attempts[0]?.outcome, 'skipped');
  });

  it('fails immediately when every profile circuit is open', async () => {
    const store = new InMemoryRivetLLMProfileHealthStore();
    open(store, identity('primary'));
    open(store, identity('backup'));
    let resolutions = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary'), candidate('backup')],
      healthStore: store,
      resolveCandidate: async () => {
        resolutions += 1;
        throw new Error('must not resolve');
      },
    });

    await assert.rejects(() => runner.run(roundOptions()), LLMProfileFallbackExhaustedError);
    assert.equal(resolutions, 0);
    assert.deepEqual(
      runner.attempts.map((attempt) => attempt.outcome),
      ['skipped', 'skipped'],
    );
  });

  it('keeps the circuit closed after the first timeout when the failure threshold is two', async () => {
    const store = new InMemoryRivetLLMProfileHealthStore();
    const primary = {
      ...candidate('primary'),
      health: {
        ...candidate('primary').health!,
        policy: { ...policy, failureThreshold: 2 },
        firstOutputTimeoutMs: 15,
      },
    };
    const backup: LLMProfileFallbackCandidate = { provider: 'custom', model: 'backup' };

    const runWorkflow = () => {
      const runner = createLLMProfileFallbackRunner({
        candidates: [primary, backup],
        healthStore: store,
        resolveCandidate: async (profileIndex, options) => ({
          ...options,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: profileIndex === 0 ? 'primary' : 'backup',
          executeGenerate:
            profileIndex === 0
              ? (args) =>
                  new Promise((_resolve, reject) => {
                    args.abortSignal?.addEventListener(
                      'abort',
                      () => {
                        const error = new Error('primary timed out');
                        error.name = 'AbortError';
                        reject(error);
                      },
                      { once: true },
                    );
                  })
              : async () => ({ text: 'backup', requestStatus: 200 }),
        }),
      });
      return runner.run(roundOptions());
    };

    assert.equal((await runWorkflow()).response, 'backup');
    assert.deepEqual(
      store.list({ projectId: 'project' as ProjectId }).map(({ state, failureCount }) => ({
        state,
        failureCount,
      })),
      [{ state: 'closed', failureCount: 1 }],
    );

    assert.equal((await runWorkflow()).response, 'backup');
    assert.deepEqual(
      store.list({ projectId: 'project' as ProjectId }).map(({ state, failureCount }) => ({
        state,
        failureCount,
      })),
      [{ state: 'open', failureCount: 2 }],
    );
  });

  it('counts only availability failures as unhealthy', () => {
    const unavailable = new Error('Unavailable') as Error & { statusCode?: number };
    unavailable.name = 'AI_APICallError';
    unavailable.statusCode = 503;
    const auth = new Error('Unauthorized') as Error & { statusCode?: number };
    auth.name = 'AI_APICallError';
    auth.statusCode = 401;
    const validation = new Error('Local type validation failed');
    validation.name = 'TypeValidationError';
    const fetchError = new TypeError('fetch failed');
    const networkError = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const unsupported = new Error('Not supported');
    unsupported.name = 'UnsupportedFunctionalityError';

    assert.equal(isUnhealthyLLMProfileProviderFailure(unavailable), true);
    assert.equal(isUnhealthyLLMProfileProviderFailure(fetchError), true);
    assert.equal(isUnhealthyLLMProfileProviderFailure(networkError), true);
    assert.equal(isUnhealthyLLMProfileProviderFailure(auth), false);
    assert.equal(isUnhealthyLLMProfileProviderFailure(validation), false);
    assert.equal(isUnhealthyLLMProfileProviderFailure(unsupported), false);
  });

  it('fails open when the health store is unavailable', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthStore: {
        begin: () => {
          throw new Error('health backend unavailable');
        },
        finish: () => {
          throw new Error('not used');
        },
        renew: () => {
          throw new Error('not used');
        },
        reset: () => undefined,
        list: () => [],
      },
      resolveCandidate: async (_profileIndex, options) => ({
        ...options,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        executeGenerate: async () => ({ text: 'ok', requestStatus: 200 }),
      }),
    });

    const result = await runner.run(roundOptions());
    assert.equal(result.response, 'ok');
    assert.equal(runner.attempts[0]?.healthDisposition, 'fail-open');
  });

  it('fails open when a health gate never settles', async () => {
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthOperationTimeoutMs: 10,
      healthStore: {
        begin: () => new Promise(() => undefined),
        finish: () => {
          throw new Error('not used');
        },
        renew: () => {
          throw new Error('not used');
        },
        reset: () => undefined,
        list: () => [],
      },
      resolveCandidate: async (_profileIndex, options) => ({
        ...options,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        executeGenerate: async () => ({ text: 'ok', requestStatus: 200 }),
      }),
    });

    const result = await runner.run(roundOptions());
    assert.equal(result.response, 'ok');
    assert.match(runner.attempts[0]?.error ?? '', /LLM profile reliability service begin timed out/);
    assert.equal(runner.attempts[0]?.healthDisposition, 'fail-open');
  });

  it('releases a half-open permit returned after the local health-store deadline', async () => {
    let now = 0;
    const profile = identity('primary');
    const backingStore = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    open(backingStore, profile);
    now = policy.openDurationMs;
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthOperationTimeoutMs: 5,
      healthStore: {
        begin: (request) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(backingStore.begin(request)), 15);
          }),
        finish: (request) => backingStore.finish(request),
        renew: (request) => backingStore.renew(request),
        reset: (request) => backingStore.reset(request),
        list: (request) => backingStore.list(request),
      },
      resolveCandidate: async (_profileIndex, options) => ({
        ...options,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        executeGenerate: async () => ({ text: 'ok', requestStatus: 200 }),
      }),
    });

    assert.equal((await runner.run(roundOptions())).response, 'ok');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(backingStore.begin({ identity: profile, policy }).disposition, 'allow');
  });

  it('does not let a never-settling health update delay a successful response', async () => {
    const profile = identity('primary');
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthOperationTimeoutMs: 10,
      healthStore: {
        begin: () => ({
          disposition: 'allow',
          state: 'closed',
          permitId: 'permit',
          snapshot: { identity: profile, state: 'closed', failureCount: 0, updatedAt: Date.now() },
        }),
        finish: () => new Promise(() => undefined),
        renew: () => ({ identity: profile, state: 'closed', failureCount: 0, updatedAt: Date.now() }),
        reset: () => undefined,
        list: () => [],
      },
      resolveCandidate: async (_profileIndex, options) => ({
        ...options,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        executeGenerate: async () => ({ text: 'ok', requestStatus: 200 }),
      }),
    });

    const result = await runner.run(roundOptions());
    assert.equal(result.response, 'ok');
    assert.match(runner.attempts.at(-1)?.error ?? '', /LLM profile reliability service finish timed out/);
    assert.equal(runner.attempts.at(-1)?.healthDisposition, 'fail-open');
  });

  it('does not start a provider after cancellation during candidate resolution', async () => {
    const controller = new AbortController();
    const finishedOutcomes: string[] = [];
    let providerCalls = 0;
    const profile = identity('primary');
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthOperationTimeoutMs: 10,
      healthStore: {
        begin: () => ({
          disposition: 'allow',
          state: 'closed',
          permitId: 'permit',
          snapshot: { identity: profile, state: 'closed', failureCount: 0, updatedAt: Date.now() },
        }),
        finish: (request) => {
          finishedOutcomes.push(request.outcome);
          return { identity: profile, state: 'closed', failureCount: 0, updatedAt: Date.now() };
        },
        renew: () => ({ identity: profile, state: 'closed', failureCount: 0, updatedAt: Date.now() }),
        reset: () => undefined,
        list: () => [],
      },
      resolveCandidate: async (_profileIndex, options) => {
        controller.abort(new Error('cancelled while resolving'));
        return {
          ...options,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'primary',
          executeGenerate: async () => {
            providerCalls += 1;
            return { text: 'must not run', requestStatus: 200 };
          },
        };
      },
    });

    await assert.rejects(
      () => runner.run({ ...roundOptions(), context: { signal: controller.signal } }),
      /cancelled while resolving/,
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(finishedOutcomes, ['ignored']);
    assert.equal(runner.attempts.at(-1)?.stage, 'health-update');
    assert.equal(runner.attempts.at(-1)?.outcome, 'success');
    assert.equal(runner.attempts.at(-1)?.healthOutcome, 'ignored');
  });

  it('keeps a half-open probe exclusive while candidate configuration resolves', async () => {
    let now = 0;
    const backingStore = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('primary');
    open(backingStore, profile);
    now = policy.openDurationMs;

    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let markRenewed!: () => void;
    const renewed = new Promise<void>((resolve) => {
      markRenewed = resolve;
    });
    let renewalCount = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthStore: {
        begin: (request) => backingStore.begin(request),
        finish: (request) => backingStore.finish(request),
        renew: (request) => {
          const snapshot = backingStore.renew(request);
          renewalCount += 1;
          if (renewalCount >= 2) markRenewed();
          return snapshot;
        },
        reset: (request) => backingStore.reset(request),
        list: (request) => backingStore.list(request),
      },
      resolveCandidate: async (_profileIndex, options) => {
        await resolutionGate;
        return {
          ...options,
          provider: 'custom',
          model: {} as ChatV2Model,
          modelId: 'primary',
          executeGenerate: async () => ({ text: 'recovered', requestStatus: 200 }),
        };
      },
    });

    const running = runner.run(roundOptions());
    now += policy.halfOpenLeaseMs + 1;
    await Promise.race([
      renewed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('half-open heartbeat did not renew the lease')), 250),
      ),
    ]);
    assert.equal(backingStore.begin({ identity: profile, policy }).disposition, 'deny');
    releaseResolution();
    assert.equal((await running).response, 'recovered');
  });

  it('keeps a half-open probe exclusive across non-200 retry cooldowns', async () => {
    let now = 0;
    const backingStore = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('primary');
    open(backingStore, profile);
    now = policy.openDurationMs;

    let markRenewed!: () => void;
    const renewed = new Promise<void>((resolve) => {
      markRenewed = resolve;
    });
    let renewalCount = 0;
    let calls = 0;
    const runner = createLLMProfileFallbackRunner({
      candidates: [candidate('primary')],
      healthStore: {
        begin: (request) => backingStore.begin(request),
        finish: (request) => backingStore.finish(request),
        renew: (request) => {
          const snapshot = backingStore.renew(request);
          renewalCount += 1;
          if (renewalCount >= 2) markRenewed();
          return snapshot;
        },
        reset: (request) => backingStore.reset(request),
        list: (request) => backingStore.list(request),
      },
      resolveCandidate: async (_profileIndex, options) => ({
        ...options,
        provider: 'custom',
        model: {} as ChatV2Model,
        modelId: 'primary',
        retryOnNon200: true,
        retryOnNon200RepeatTimes: 1,
        retryOnNon200CooldownMs: 30,
        executeGenerate: async () => {
          calls += 1;
          return calls === 1 ? { text: '', requestStatus: 503 } : { text: 'recovered', requestStatus: 200 };
        },
      }),
    });

    const running = runner.run(roundOptions());
    await renewed;
    now += policy.halfOpenLeaseMs + 1;
    assert.equal(backingStore.begin({ identity: profile, policy }).disposition, 'deny');
    const result = await running;
    assert.equal(result.response, 'recovered');
    assert.equal(calls, 2);
  });

  it('summarizes provider deadlines and the suspension they produced without exposing circuit terminology', () => {
    const summary = buildLLMProfileFallbackSummary(
      [candidate('primary')],
      [
        {
          roundIndex: 0,
          profileIndex: 0,
          provider: 'custom',
          model: 'primary',
          stage: 'request',
          outcome: 'failure',
          attemptIndex: 0,
          timeoutKind: 'first-output',
        },
        {
          roundIndex: 0,
          profileIndex: 0,
          provider: 'custom',
          model: 'primary',
          stage: 'health-update',
          outcome: 'success',
          healthOutcome: 'unhealthy',
          healthState: 'open',
        },
      ],
    );

    assert.match(summary, /timed out waiting for first useful output/);
    assert.match(summary, /profile is suspended/);
    assert.doesNotMatch(summary, /circuit/i);
  });
});
