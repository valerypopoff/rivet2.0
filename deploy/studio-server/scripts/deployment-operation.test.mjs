import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runHaRollingUpgrade } from './lib/ha-rolling-upgrade.mjs';
import { runManagedReleaseCutover } from './lib/managed-release-cutover.mjs';
import { runHaControlTopologyTransition } from './lib/ha-control-topology.mjs';
import { fixtureDeploymentSafety } from './fixtures/deployment-safety.mjs';
import { deploymentFailureDetails } from './lib/deployment-diagnostics.mjs';

test('private deployment diagnostics preserve bounded causes without copying arbitrary process/request data', () => {
  const primary = new Error('management observation failed', { cause: new Error('underlying read failure') });
  primary.stdout = 'private stdout must not be serialized';
  primary.request = { password: 'must not be serialized' };
  const aggregate = new AggregateError([primary, new Error('admission cleanup also failed')], 'cutover paused');
  const report = deploymentFailureDetails(aggregate);
  assert.equal(report.error.errors[0].cause.message, 'underlying read failure');
  assert.equal(report.error.errors[1].message, 'admission cleanup also failed');
  assert.ok(!JSON.stringify(report).includes('must not be serialized'));
  primary.cause = aggregate;
  assert.equal(deploymentFailureDetails(aggregate).error.errors[0].cause.circular, true);
  const many = new AggregateError(
    Array.from({ length: 100 }, () => new Error('x'.repeat(50000))),
    'bounded',
  );
  assert.ok(JSON.stringify(deploymentFailureDetails(many)).length < 240000);
});

const modes = ['rolling', 'maintenance', 'topology'];
function fixture(mode) {
  let journal,
    version = 0,
    clock = 1000,
    tick,
    stopped = false;
  const mutations = [];
  const pods = new Map();
  const identity = { release: 'fixture', namespace: 'fixture', manifestDigest: 'fixture-image' };
  const inventory = [
    { name: 'backend', role: 'backend', uid: 'backend-owner', replicas: 2 },
    ...(mode === 'topology'
      ? [{ name: 'maintenance', role: 'maintenance', uid: 'maintenance-owner', replicas: 1 }]
      : []),
  ];
  for (const w of inventory)
    for (let i = 0; i < w.replicas; i++) {
      const name = `${w.name}-${i}`;
      pods.set(name, {
        name,
        uid: randomUUID(),
        incarnation: randomUUID(),
        ready: true,
        protocol: 1,
        withdrawalProtocol: 1,
        state: 'serving',
      });
    }
  const state = {
    failInitial: false,
    failHeartbeat: false,
    failCompletion: false,
    failAbort: false,
    baseline: async () => {},
    get journal() {
      return structuredClone(journal);
    },
    get stopped() {
      return stopped;
    },
    expire() {
      clock += 200_000;
    },
    tick() {
      assert.equal(typeof tick, 'function');
      tick();
    },
  };
  const readJournal = async () => journal && structuredClone(journal);
  const saveJournal = async (next, rv) => {
    if (state.failHeartbeat) throw Error('heartbeat CAS unavailable');
    assert.equal(rv, journal?.resourceVersion);
    journal = structuredClone({ ...next, resourceVersion: String(++version) });
    if (state.failInitial && version === 1) throw Error('lost initial acknowledgement');
    if (
      state.failCompletion &&
      next.phase === 'complete' &&
      !next.abortedBeforeTemplates &&
      !next.abortedBeforeQuiescence &&
      !next.abortedBeforeTopologyChanges
    ) {
      state.failCompletion = false;
      throw Error('lost completion acknowledgement');
    }
    if (
      state.failAbort &&
      (next.abortedBeforeTemplates || next.abortedBeforeQuiescence || next.abortedBeforeTopologyChanges)
    )
      throw Error('lost abort acknowledgement');
    return structuredClone(journal);
  };
  const options = {
    identity:
      mode === 'topology'
        ? {
            ...identity,
            topologyProtocol: 1,
            from: 'replicated',
            to: 'singleton',
            configurationDigest: 'fixture',
            claimUid: 'fixture-claim',
          }
        : identity,
    ...identity,
    now: () => clock,
    timeoutMs: 100,
    setHeartbeat(callback) {
      tick = callback;
      return {};
    },
    clearHeartbeat() {
      stopped = true;
    },
    readJournal,
    saveJournal,
    createJournal: (next) => saveJournal(next, journal?.resourceVersion),
    replaceJournal: saveJournal,
    workloads: [{ ...inventory[0], image: `api@sha256:${'a'.repeat(64)}`, updateStrategy: 'OnDelete' }],
    inventory:
      mode === 'topology'
        ? inventory
        : async () => ({
            workloads: [{ kind: 'deployment', name: 'backend', component: 'backend', replicas: 1 }],
            autoscalers: [],
          }),
    snapshotCapacity: async () => {},
    observePod: async (name) => structuredClone(pods.get(name)),
    status: async (p) => structuredClone(pods.get(p.name)),
    isCurrentPod: async () => true,
    checkHeadroom: async () => {},
    applyTemplates: async () => mutations.push('templates'),
    restoreAutoscalers: async () => mutations.push('restore-autoscalers'),
    settle: async () => {},
    preflight: async () => {},
    prepareRuntimeEdge: async () => mutations.push('edge'),
    waitForRuntimeEdge: async () => {},
    withdraw: async (p, operationId) => {
      mutations.push('withdraw');
      Object.assign(pods.get(p.name), { operationId, state: 'withdrawing' });
    },
    waitForRoutingWithdrawal: async () => {},
    begin: async (p) => {
      mutations.push('drain');
      pods.get(p.name).state = 'drained';
    },
    scaleToZero: async (w) => {
      mutations.push('stop');
      for (let i = 0; i < w.replicas; i++) pods.delete(`${w.name}-${i}`);
    },
    waitForNoOwners: async () => {},
    waitForVolumeRelease: async () => {},
    templatesApplied: async () => mutations.includes('templates'),
    verify: async () => {},
    scale: async (workload, count) => {
      mutations.push('scale');
      if (typeof workload === 'string') {
        for (let i = 0; i < count; i++) {
          const name = `${workload}-${i}`;
          if (!pods.has(name))
            pods.set(name, {
              name,
              uid: randomUUID(),
              incarnation: randomUUID(),
              ready: true,
              protocol: 1,
              withdrawalProtocol: 1,
              state: 'serving',
            });
        }
        for (const name of pods.keys())
          if (name.startsWith(`${workload}-`) && Number(name.split('-').at(-1)) >= count) pods.delete(name);
      }
    },
    waitForReady: async () => {},
    waitForWithdrawal: async () => {},
    waitForScaleDown: async () => {},
    removeAutoscaler: async () => mutations.push('hpa'),
    waitForStopped: async () => {},
    installValidation: async () => mutations.push('install'),
    validate: async () => {},
    resume: async () => mutations.push('resume'),
  };
  const run = (extra = {}) => {
    const runStrategy =
      mode === 'rolling'
        ? runHaRollingUpgrade
        : mode === 'maintenance'
          ? runManagedReleaseCutover
          : runHaControlTopologyTransition;
    return runStrategy({
      ...options,
      safety: fixtureDeploymentSafety(mode, options.identity, { baseline: () => state.baseline() }),
      ...extra,
    });
  };
  return { state, mutations, run, options };
}
const contains = (error, target) =>
  error === target ||
  (error?.cause && contains(error.cause, target)) ||
  error?.errors?.some((item) => contains(item, target));
const failureMessages = (error) =>
  [
    error?.message,
    ...(error?.cause ? [failureMessages(error.cause)] : []),
    ...(error?.errors ?? []).map(failureMessages),
  ].join('\n');

for (const mode of modes) {
  test(`${mode}: a completed journal retains its protocol and releases the shared lease`, async () => {
    const f = fixture(mode);
    await f.run();
    assert.equal(f.state.journal.phase, 'complete');
    assert.equal(f.state.journal.leaseExpiresAt, 1000);
    assert.equal(f.state.journal[mode === 'maintenance' ? 'formatVersion' : 'protocol'], 1);
    assert.equal(f.state.stopped, true);
  });
  test(`${mode}: lost initial ownership acknowledgement never starts workload changes and recovers by exact token`, async () => {
    const f = fixture(mode);
    f.state.failInitial = true;
    await assert.rejects(f.run(), /ownership write is unconfirmed.*journal token/);
    assert.deepEqual(f.mutations, []);
    const original = f.state.journal;
    await assert.rejects(f.run({ resumeToken: original.token }), /owns|active/);
    f.state.expire();
    await assert.rejects(f.run({ resumeToken: randomUUID() }), /exact|unfinished|Recover/);
    assert.deepEqual(f.mutations, []);
    await f.run({ resumeToken: original.token });
    assert.equal(f.state.journal.token, original.token);
    assert.equal(f.state.journal.phase, 'complete');
  });
  test(`${mode}: changed recovery contract is refused before workload changes`, async () => {
    const f = fixture(mode);
    f.state.failInitial = true;
    await assert.rejects(f.run(), /ownership write is unconfirmed/);
    f.state.expire();
    await assert.rejects(
      f.run({
        resumeToken: f.state.journal.token,
        safety: fixtureDeploymentSafety(mode, { ...f.options.identity, workflowIdentity: { policy: 'changed' } }),
      }),
      /original deployment safety|exact recorded/,
    );
    assert.deepEqual(f.mutations, []);
  });
  test(`${mode}: an expired lease cannot be renewed after a long baseline check`, async () => {
    const f = fixture(mode);
    f.state.baseline = async () => f.state.expire();
    await assert.rejects(f.run(), (error) => {
      assert.match(failureMessages(error), /lease expired/);
      return true;
    });
    assert.deepEqual(f.mutations, []);
    assert.notEqual(f.state.journal.phase, 'complete');
  });
  test(`${mode}: a failed heartbeat fences both work and cleanup`, async () => {
    const f = fixture(mode);
    f.state.baseline = async () => {
      f.state.failHeartbeat = true;
      f.state.tick();
      await new Promise((resolve) => setImmediate(resolve));
    };
    await assert.rejects(f.run(), (error) => {
      assert.match(failureMessages(error), /heartbeat CAS unavailable/);
      return true;
    });
    assert.deepEqual(f.mutations, []);
    assert.notEqual(f.state.journal.phase, 'complete');
    assert.equal(f.state.stopped, true);
  });
  test(`${mode}: an untouched baseline failure records an abort without changing workloads`, async () => {
    const f = fixture(mode);
    f.state.baseline = async () => {
      throw Error('baseline changed');
    };
    await assert.rejects(f.run(), (error) => {
      assert.match(error.message, /baseline changed|aborted before workload/);
      assert.deepEqual(error.deploymentOperation, {
        token: f.state.journal.token,
        phase: 'complete',
        acknowledgement: 'confirmed',
        aborted: true,
      });
      return true;
    });
    assert.deepEqual(f.mutations, []);
    assert.equal(f.state.journal.phase, 'complete');
    assert.equal(f.state.journal.leaseExpiresAt, 1000);
  });
  test(`${mode}: an abort-write failure retains both the original and cleanup error`, async () => {
    const f = fixture(mode),
      original = Error('original baseline unavailable');
    f.state.baseline = async () => {
      throw original;
    };
    f.state.failAbort = true;
    await assert.rejects(f.run(), (error) => {
      assert.ok(contains(error, original));
      return true;
    });
    assert.deepEqual(f.mutations, []);
  });
  test(`${mode}: lost completion acknowledgement is never silently reported as success`, async () => {
    const f = fixture(mode);
    f.state.failCompletion = true;
    await assert.rejects(f.run(), /completion acknowledgement|Cutover paused/);
    assert.equal(f.state.journal.phase, 'complete');
    assert.equal(f.state.stopped, true);
  });
}
