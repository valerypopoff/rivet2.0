import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryRivetLLMProfileHealthStore,
  type ProjectId,
  type RivetLLMProfileCircuitBreakerPolicy,
  type RivetLLMProfileHealthIdentity,
} from '@valerypopoff/rivet2-core';
import {
  createLLMProfileHealthAdminProvider,
  resolveLLMProfileHealthProviders,
  type LLMProfileHealthAdminProvider,
} from './ProvidersContext.js';

const projectId = 'project-1' as ProjectId;
const otherProjectId = 'project-2' as ProjectId;
const policy: RivetLLMProfileCircuitBreakerPolicy = {
  failureThreshold: 1,
  failureWindowMs: 60_000,
  openDurationMs: 60_000,
  halfOpenLeaseMs: 5_000,
};

function createIdentity(key: string, owner: ProjectId): RivetLLMProfileHealthIdentity {
  return {
    key,
    projectId: owner,
    provider: 'openai',
    model: 'test-model',
    configurationFingerprint: `fingerprint-${key}`,
  };
}

function recordFailure(store: InMemoryRivetLLMProfileHealthStore, identity: RivetLLMProfileHealthIdentity): void {
  const permit = store.begin({ identity, policy });
  assert.equal(permit.disposition, 'allow');
  assert.ok(permit.permitId);
  store.finish({ identity, policy, permitId: permit.permitId, outcome: 'unhealthy' });
}

test('standalone providers do not activate LLM profile health', () => {
  const resolved = resolveLLMProfileHealthProviders();

  assert.equal(resolved.llmProfileHealthStore, undefined);
  assert.equal(resolved.llmProfileHealthAdmin, undefined);
});

test('a local admin adapter lists and atomically resets one project', async () => {
  const store = new InMemoryRivetLLMProfileHealthStore();
  const owned = createIdentity('owned', projectId);
  const foreign = createIdentity('foreign', otherProjectId);
  recordFailure(store, owned);
  recordFailure(store, foreign);

  const admin = createLLMProfileHealthAdminProvider(store);
  assert.deepEqual(
    (await admin.list({ projectId })).map((entry) => entry.identity.key),
    ['owned'],
  );

  await admin.reset({ projectId });
  assert.deepEqual(await store.list({ projectId }), []);
  assert.equal((await store.list({ projectId: otherProjectId })).length, 1);
});

test('a host-supplied store does not implicitly expose health administration', () => {
  const store = new InMemoryRivetLLMProfileHealthStore();
  const resolved = resolveLLMProfileHealthProviders({ llmProfileHealthStore: store });

  assert.equal(resolved.llmProfileHealthStore, store);
  assert.equal(resolved.llmProfileHealthAdmin, undefined);
});

test('the local admin refuses a key outside the active project', async () => {
  const store = new InMemoryRivetLLMProfileHealthStore();
  recordFailure(store, createIdentity('foreign', otherProjectId));
  const admin = createLLMProfileHealthAdminProvider(store);

  await assert.rejects(admin.reset({ projectId, key: 'foreign' }), /does not belong to the active project/);
  assert.equal((await store.list({ projectId: otherProjectId })).length, 1);
});

test('an admin-only host does not activate Browser health execution', () => {
  const admin: LLMProfileHealthAdminProvider = {
    list: async () => [],
    reset: async () => undefined,
  };
  const resolved = resolveLLMProfileHealthProviders({ llmProfileHealthAdmin: admin });

  assert.equal(resolved.llmProfileHealthAdmin, admin);
  assert.equal(resolved.llmProfileHealthStore, undefined);
});
