import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionPoolKubernetes } from './lib/execution-pool-kubernetes.mjs';
import { haCandidateReady } from './lib/ha-kubernetes-rollout.mjs';

function fixture({ timeoutMs = 5000, read = () => {} } = {}) {
  const image = 'registry/api@sha256:fixture';
  const previous = { metadata: { name: 'execution', uid: 'previous' }, spec: { replicas: 0 } };
  const candidate = {
    metadata: {
      name: 'execution-next',
      uid: 'candidate',
      generation: 2,
      labels: { 'app.kubernetes.io/instance': 'rivet' },
    },
    spec: { replicas: 3, updateStrategy: { type: 'OnDelete' } },
    status: { observedGeneration: 2, updateRevision: 'revision' },
  };
  const pending = new Set(),
    calls = [];
  let verified = 0,
    candidateReads = 0;
  const operation = {
    record: {
      executionPool: {
        candidateUid: 'candidate',
        owners: [{ name: 'execution-0' }, { name: 'execution-1' }],
        legacyHttp: { protocol: 1, required: false },
      },
    },
    assertLease() {},
    checkpoint() {
      throw Error('Verification must not write the journal');
    },
  };
  const pool = createExecutionPoolKubernetes({
    plan: { previous: { name: 'execution', uid: 'previous', replicas: 2 }, candidate: { name: 'execution-next' } },
    config: { policy: { maxReplicas: 7 } },
    release: 'rivet',
    namespace: 'fixture',
    timeoutMs,
    kube: async (args) => {
      calls.push(args);
      assert.equal(args[0], 'get');
      assert.equal(args[1], 'statefulset');
      const controller = args[2] === previous.metadata.name ? previous : candidate;
      if (controller === candidate) candidateReads++;
      await read({ controller, candidate, previous, candidateReads, pending });
      return { stdout: JSON.stringify(controller) };
    },
    observePod: async (name) =>
      name.startsWith('execution-next-')
        ? { name, uid: name, image, revision: 'revision', ready: !pending.has(name), terminating: false }
        : null,
    status: async () => ({ state: 'serving', operationId: null }),
    bindCandidate: (uid) => assert.equal(uid, 'candidate', 'Candidate identity changed'),
    isCurrent: (pod, revision) => haCandidateReady(pod.name, pod, image, revision),
    verifyProxy: async () => {
      verified++;
    },
    service: { metadata: { name: 'execution' }, spec: { selector: { role: 'execution' } } },
    candidateTemplate: { metadata: { labels: { 'rivet.dev/execution-pool': 'b' } } },
  });
  return { pool, operation, pending, calls, candidate, previous, verified: () => verified };
}

test('pool completion waits for permitted candidate growth without repeating workload commands', async () => {
  const f = fixture({
    read: ({ candidateReads, pending }) => {
      if (candidateReads >= 2) pending.clear();
    },
  });
  f.pending.add('execution-next-2');
  const result = await f.pool.verify(f.operation);
  assert.equal(result.count, 3);
  assert.equal(f.verified(), 1);
  assert.ok(f.calls.every((args) => args[0] === 'get'));
});

test('pool completion reobserves a confirmed transient controller GET', async () => {
  const f = fixture({
    read: ({ controller, candidate, candidateReads }) => {
      if (controller === candidate && candidateReads === 1)
        throw Error('Error from server (TooManyRequests): fixture read throttled');
    },
  });
  await f.pool.verify(f.operation);
  assert.equal(f.verified(), 1);
  assert.ok(f.calls.filter((args) => args[2] === 'execution-next').length >= 2);
});

test('pool completion reobserves a controller generation that changed during its Pod reads', async () => {
  const f = fixture({
    read: ({ controller, candidate, candidateReads }) => {
      if (controller !== candidate) return;
      if (candidateReads === 2) candidate.metadata.generation++;
      if (candidateReads >= 3) candidate.status.observedGeneration = candidate.metadata.generation;
    },
  });
  await f.pool.verify(f.operation);
  assert.equal(f.candidate.status.observedGeneration, f.candidate.metadata.generation);
  assert.equal(f.verified(), 1);
});

test('pool completion keeps hard identity/removal failures and lease loss fenced', async () => {
  for (const fault of ['candidate', 'previous', 'old-replicas', 'retiring', 'lease', 'lease-during-read']) {
    let expired = false;
    const f = fixture({
      read: () => {
        if (fault === 'lease-during-read') expired = true;
      },
    });
    if (fault === 'candidate') f.candidate.metadata.uid = 'foreign';
    if (fault === 'previous') f.previous.metadata.uid = 'foreign';
    if (fault === 'old-replicas') f.previous.spec.replicas = 2;
    if (fault === 'retiring') f.candidate.metadata.deletionTimestamp = new Date().toISOString();
    f.operation.assertLease = () => {
      if (expired || fault === 'lease') throw Error('Lease expired');
    };
    await assert.rejects(f.pool.verify(f.operation));
    assert.equal(f.verified(), 0);
    if (fault !== 'lease-during-read') assert.ok(f.calls.length <= 2);
  }
});

test('pool completion cannot pass indefinitely unready capacity', async () => {
  const f = fixture({ timeoutMs: 30 });
  f.pending.add('execution-next-2');
  await assert.rejects(f.pool.verify(f.operation), /still becoming ready/);
  assert.equal(f.verified(), 0);
  assert.ok(f.calls.every((args) => args[0] === 'get'));
});

test('pool completion never waits away a lost serving floor', async () => {
  const f = fixture({ timeoutMs: 30 });
  f.pending.add('execution-next-0').add('execution-next-1');
  await assert.rejects(f.pool.verify(f.operation), /serving floor was lost/);
  assert.equal(f.verified(), 0);
  assert.equal(f.calls.filter((args) => args[2] === 'execution-next').length, 1);
});
