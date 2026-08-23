import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  InMemoryRivetLLMProfileHealthStore,
  type ProjectId,
  type RivetLLMProfileCircuitBreakerPolicy,
  type RivetLLMProfileHealthIdentity,
} from '@valerypopoff/rivet2-core';
import { InMemoryEvaluationRunStore } from '@valerypopoff/rivet2-evaluations';
import {
  createLLMProfileHealthAdminProvider,
  resolveLLMProfileHealthProviders,
  resolveEvaluationStoreProvider,
  type LLMProfileHealthAdminProvider,
  type PathPolicyProvider,
  ProvidersProvider,
  useEvaluationStore,
} from './ProvidersContext.js';

test('a hosted wrapper can replace the complete evaluation persistence boundary', () => {
  const evaluationStore = new InMemoryEvaluationRunStore();
  assert.equal(resolveEvaluationStoreProvider({ evaluationStore }), evaluationStore);
});

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

test('host override rerenders retain the resolved evaluation store when their store inputs do not change', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const observedStores: ReturnType<typeof useEvaluationStore>[] = [];
  const firstPathPolicy: PathPolicyProvider = {
    allowDataFileNeighbor: async () => undefined,
  };
  const secondPathPolicy: PathPolicyProvider = {
    allowDataFileNeighbor: async () => undefined,
  };

  const Probe = () => {
    observedStores.push(useEvaluationStore());
    return null;
  };
  const firstDataRefs = { get: () => undefined };
  const secondDataRefs = { get: () => undefined };
  const render = (pathPolicy: PathPolicyProvider, dataRefs: typeof firstDataRefs) =>
    root.render(
      React.createElement(ProvidersProvider, { providers: { dataRefs, pathPolicy } }, React.createElement(Probe)),
    );

  try {
    await act(async () => render(firstPathPolicy, firstDataRefs));
    // A fresh wrapper object with equivalent values and a later change to an
    // unrelated runtime adapter must not recreate the persistent store.
    await act(async () => render(firstPathPolicy, firstDataRefs));
    await act(async () => render(firstPathPolicy, secondDataRefs));
    await act(async () => render(secondPathPolicy, secondDataRefs));

    assert.equal(observedStores.length, 4);
    assert.equal(observedStores[1], observedStores[0]);
    assert.equal(observedStores[2], observedStores[0]);
    assert.equal(observedStores[3], observedStores[0]);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

test('an explicit evaluation store remains stable across wrapper rerenders and changes only when replaced', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  const observedStores: ReturnType<typeof useEvaluationStore>[] = [];
  const firstStore = new InMemoryEvaluationRunStore();
  const secondStore = new InMemoryEvaluationRunStore();

  const Probe = () => {
    observedStores.push(useEvaluationStore());
    return null;
  };
  const render = (evaluationStore: InMemoryEvaluationRunStore) =>
    root.render(
      React.createElement(ProvidersProvider, { providers: { evaluationStore } }, React.createElement(Probe)),
    );

  try {
    await act(async () => render(firstStore));
    await act(async () => render(firstStore));
    await act(async () => render(secondStore));

    assert.equal(observedStores.length, 3);
    assert.equal(observedStores[0], firstStore);
    assert.equal(observedStores[1], firstStore);
    assert.equal(observedStores[2], secondStore);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ['document', 'Element', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previousDescriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Element: { configurable: true, value: dom.window.Element },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
