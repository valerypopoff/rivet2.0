import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ProjectId } from '../../../src/model/Project.js';
import type { NodeId } from '../../../src/model/NodeBase.js';
import {
  InMemoryRivetLLMProfileHealthStore,
  createRivetLLMProfileHealthIdentity,
  resolveRivetLLMProfileCircuitBreakerPolicy,
  type RivetLLMProfileHealthIdentity,
} from '../../../src/model/chat-v2/llmProfileHealthStore.js';
import { createLLMChatV2NodeData } from '../../../src/model/chat-v2/llmChatV2NodeData.js';
import { createLLMProfileNodeData } from '../../../src/model/chat-v2/llmProfileTypes.js';
import { resolveLLMProfileNodeValue } from '../../../src/model/chat-v2/llmProfileNodeRuntime.js';

const identity = (suffix: string, projectId = 'project-a' as ProjectId): RivetLLMProfileHealthIdentity => ({
  key: `profile-${suffix}`,
  projectId,
  profileNodeId: `node-${suffix}` as NodeId,
  provider: 'custom',
  model: `model-${suffix}`,
  customProviderApi: 'completions',
  configurationFingerprint: `sha256:${suffix}`,
});

const policy = {
  failureThreshold: 2,
  failureWindowMs: 1_000,
  openDurationMs: 500,
  halfOpenLeaseMs: 100,
};

describe('InMemoryRivetLLMProfileHealthStore', () => {
  it('opens after the configured logical failures and admits one renewable half-open probe', () => {
    let now = 1_000;
    const store = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('primary');

    const first = store.begin({ identity: profile, policy });
    const afterFirst = store.finish({
      identity: profile,
      policy,
      permitId: first.permitId!,
      outcome: 'unhealthy',
    });
    assert.equal(afterFirst.state, 'closed');
    assert.equal(afterFirst.failureCount, 1);
    const second = store.begin({ identity: profile, policy });
    assert.equal(second.disposition, 'allow');
    const opened = store.finish({ identity: profile, policy, permitId: second.permitId!, outcome: 'unhealthy' });
    assert.equal(opened.state, 'open');
    assert.equal(store.begin({ identity: profile, policy }).disposition, 'deny');

    now = opened.openUntil!;
    const probe = store.begin({ identity: profile, policy });
    assert.equal(probe.state, 'half-open');
    assert.equal(store.begin({ identity: profile, policy }).disposition, 'deny');

    now += 50;
    const renewed = store.renew({ identity: profile, permitId: probe.permitId!, leaseDurationMs: 100 });
    assert.equal(renewed.halfOpenLeaseUntil, now + 100);
    now += 75;
    assert.equal(store.begin({ identity: profile, policy }).disposition, 'deny');

    const closed = store.finish({ identity: profile, policy, permitId: probe.permitId!, outcome: 'healthy' });
    assert.equal(closed.state, 'closed');
    assert.equal(closed.failureCount, 0);
  });

  it('does not let late concurrent closed failures extend an already-open circuit', () => {
    let now = 10_000;
    const store = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('concurrent');
    const first = store.begin({ identity: profile, policy });
    const second = store.begin({ identity: profile, policy });
    const third = store.begin({ identity: profile, policy });
    store.finish({ identity: profile, policy, permitId: first.permitId!, outcome: 'unhealthy' });
    const opened = store.finish({ identity: profile, policy, permitId: second.permitId!, outcome: 'unhealthy' });
    const openUntil = opened.openUntil;

    now += 100;
    const stale = store.finish({ identity: profile, policy, permitId: third.permitId!, outcome: 'unhealthy' });
    assert.equal(stale.openUntil, openUntil);
  });

  it('ignores pre-open closed results after a healthy half-open probe recovers the circuit', () => {
    let now = 20_000;
    const store = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('recovered-generation');
    const stale = store.begin({ identity: profile, policy });
    const first = store.begin({ identity: profile, policy });
    const second = store.begin({ identity: profile, policy });
    store.finish({ identity: profile, policy, permitId: first.permitId!, outcome: 'unhealthy' });
    const opened = store.finish({ identity: profile, policy, permitId: second.permitId!, outcome: 'unhealthy' });

    now = opened.openUntil!;
    const probe = store.begin({ identity: profile, policy });
    store.finish({ identity: profile, policy, permitId: probe.permitId!, outcome: 'healthy' });
    const late = store.finish({ identity: profile, policy, permitId: stale.permitId!, outcome: 'unhealthy' });

    assert.equal(late.state, 'closed');
    assert.equal(late.failureCount, 0);
  });

  it('never resurrects state after reset and resets one project atomically', () => {
    const store = new InMemoryRivetLLMProfileHealthStore();
    const projectA = 'project-a' as ProjectId;
    const projectB = 'project-b' as ProjectId;
    const a1 = identity('a1', projectA);
    const a2 = identity('a2', projectA);
    const b1 = identity('b1', projectB);
    const pending = store.begin({ identity: a1, policy });
    store.begin({ identity: a2, policy });
    store.begin({ identity: b1, policy });

    store.reset({ projectId: projectA });
    assert.deepEqual(store.list({ projectId: projectA }), []);
    assert.equal(store.list({ projectId: projectB }).length, 1);

    const ignored = store.finish({
      identity: a1,
      policy,
      permitId: pending.permitId!,
      outcome: 'unhealthy',
    });
    assert.equal(ignored.state, 'closed');
    assert.equal(ignored.failureCount, 0);
    assert.deepEqual(store.list({ projectId: projectA }), []);
  });

  it('never rebinds one health key to a different project scope', () => {
    const store = new InMemoryRivetLLMProfileHealthStore();
    const projectA = identity('shared-key', 'project-a' as ProjectId);
    const projectB = identity('shared-key', 'project-b' as ProjectId);
    const permit = store.begin({ identity: projectA, policy });

    assert.throws(() => store.begin({ identity: projectB, policy }), /belongs to a different project scope/);
    assert.throws(
      () =>
        store.renew({
          identity: projectB,
          permitId: permit.permitId!,
          leaseDurationMs: 100,
        }),
      /belongs to a different project scope/,
    );
    assert.throws(
      () =>
        store.finish({
          identity: projectB,
          policy,
          permitId: permit.permitId!,
          outcome: 'healthy',
        }),
      /belongs to a different project scope/,
    );

    assert.equal(store.list({ projectId: 'project-a' as ProjectId }).length, 1);
    assert.deepEqual(store.list({ projectId: 'project-b' as ProjectId }), []);
  });

  it('expires abandoned closed permits instead of counting late results', () => {
    let now = 0;
    const store = new InMemoryRivetLLMProfileHealthStore({ now: () => now });
    const profile = identity('abandoned');
    const pending = store.begin({ identity: profile, policy });

    now = 24 * 60 * 60 * 1_000 + 1;
    const stale = store.finish({
      identity: profile,
      policy,
      permitId: pending.permitId!,
      outcome: 'unhealthy',
    });
    assert.equal(stale.failureCount, 0);
    assert.deepEqual(store.list(), []);
  });

  it('derives the default half-open lease from request deadlines, not cooldown', () => {
    const configuration = {
      ...createLLMChatV2NodeData(),
      enableCircuitBreaker: true,
      firstOutputTimeoutMs: 30_000,
      streamInactivityTimeoutMs: 20_000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerFailureWindowMs: 300_000,
      circuitBreakerOpenDurationMs: 900_000,
    };
    const resolved = resolveRivetLLMProfileCircuitBreakerPolicy(configuration)!;
    assert.equal(resolved.halfOpenLeaseMs, 35_000);
  });

  it('defaults circuit-breaker fields missing from legacy serialized profiles', () => {
    const legacyConfiguration = {
      ...createLLMChatV2NodeData(),
      enableCircuitBreaker: true,
      firstOutputTimeoutMs: undefined,
      streamInactivityTimeoutMs: undefined,
      circuitBreakerFailureThreshold: undefined,
      circuitBreakerFailureWindowMs: undefined,
      circuitBreakerOpenDurationMs: undefined,
    };

    assert.deepEqual(resolveRivetLLMProfileCircuitBreakerPolicy(legacyConfiguration), {
      failureThreshold: 3,
      failureWindowMs: 300_000,
      openDurationMs: 300_000,
      halfOpenLeaseMs: 35_000,
    });
  });

  it('keys health by provider route and credentials, not generation or breaker policy', () => {
    const baseConfiguration = {
      ...createLLMChatV2NodeData(),
      provider: 'custom' as const,
      model: 'route-model',
      customProviderApi: 'responses' as const,
      customProviderBaseURL: 'https://provider.example/v1',
      headers: [{ key: 'X-Deployment', value: 'primary' }],
      enableCircuitBreaker: true,
    };
    const makeIdentity = (configuration: typeof baseConfiguration, credentialValue = 'secret-a') =>
      createRivetLLMProfileHealthIdentity({
        configuration,
        credential: { value: credentialValue, reference: { source: 'settings' } },
        projectId: 'project' as ProjectId,
        profileNodeId: 'profile' as NodeId,
      });

    const original = makeIdentity(baseConfiguration);
    const behaviorOnly = makeIdentity({
      ...baseConfiguration,
      temperature: 0.9,
      firstOutputTimeoutMs: 5_000,
      circuitBreakerFailureThreshold: 9,
      circuitBreakerOpenDurationMs: 60_000,
    });
    assert.equal(behaviorOnly.key, original.key);
    assert.equal(behaviorOnly.configurationFingerprint, original.configurationFingerprint);

    assert.notEqual(makeIdentity({ ...baseConfiguration, model: 'other-model' }).key, original.key);
    assert.notEqual(
      makeIdentity({ ...baseConfiguration, customProviderBaseURL: 'https://backup.example/v1' }).key,
      original.key,
    );
    assert.notEqual(makeIdentity(baseConfiguration, 'secret-b').key, original.key);
  });

  it('keys health by effective project-wide and profile request headers without exposing values', () => {
    const configuration = {
      ...createLLMChatV2NodeData(),
      provider: 'custom' as const,
      model: 'route-model',
      customProviderBaseURL: 'https://provider.example/v1',
      headers: [{ key: 'X-Profile-Route', value: 'profile-secret' }],
    };
    const makeIdentity = (chatNodeHeaders: Record<string, string>, nextConfiguration = configuration) =>
      createRivetLLMProfileHealthIdentity({
        configuration: nextConfiguration,
        credential: { value: 'credential-secret', reference: { source: 'settings' } },
        chatNodeHeaders,
        projectId: 'project' as ProjectId,
        profileNodeId: 'profile' as NodeId,
      });

    const original = makeIdentity({ 'X-Global-Route': 'global-secret-a' });
    const changedGlobal = makeIdentity({ 'x-global-route': 'global-secret-b' });
    assert.notEqual(changedGlobal.key, original.key);

    const equivalentCase = makeIdentity({ 'x-GLOBAL-route': 'global-secret-a' });
    assert.equal(equivalentCase.key, original.key);

    const profileOverride = makeIdentity({ 'x-profile-route': 'overridden-global-secret' }, configuration);
    const otherOverriddenGlobal = makeIdentity(
      { 'X-Profile-Route': 'different-overridden-global-secret' },
      configuration,
    );
    assert.equal(profileOverride.key, otherOverriddenGlobal.key);

    const serializedIdentity = JSON.stringify(original);
    assert.doesNotMatch(serializedIdentity, /global-secret|profile-secret|credential-secret/);
  });

  it('includes project-wide Chat headers when an LLM Profile node creates its runtime identity', () => {
    const data = {
      ...createLLMProfileNodeData(),
      provider: 'openai' as const,
      model: 'gpt-test',
      enableCircuitBreaker: true,
    };
    const resolveWithHeader = (headerValue: string) =>
      resolveLLMProfileNodeValue({
        data,
        inputs: {},
        context: {
          settings: {
            openAiApiKey: 'credential-secret',
            chatNodeHeaders: { 'X-Global-Route': headerValue },
          },
          getPluginConfig: () => '',
          project: { metadata: { id: 'project' as ProjectId } },
          node: { id: 'profile' as NodeId },
        } as any,
      });

    const first = resolveWithHeader('route-a');
    const second = resolveWithHeader('route-b');
    assert.notEqual(first.healthIdentity?.key, second.healthIdentity?.key);
    assert.doesNotMatch(JSON.stringify(first.healthIdentity), /route-a|credential-secret/);
  });
});
