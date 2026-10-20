import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runHaControlTopologyTransition } from './lib/ha-control-topology.mjs';
import { runHaRollingUpgrade, assertHaRolloutPlan } from './lib/ha-rolling-upgrade.mjs';

function fixture(from = 'replicated') {
  let journal,
    version = 0,
    clock = 0;
  const operations = [],
    pods = new Map();
  const inventory = [
    { name: 'rivet-backend', uid: 'control-uid', role: 'backend', replicas: from === 'replicated' ? 2 : 1 },
    ...(from === 'replicated'
      ? [{ name: 'rivet-maintenance', uid: 'maintenance-uid', role: 'maintenance', replicas: 1 }]
      : []),
  ];
  for (const w of inventory)
    for (let i = 0; i < w.replicas; i++) {
      const name = `${w.name}-${i}`;
      pods.set(name, {
        name,
        uid: randomUUID(),
        incarnation: randomUUID(),
        protocol: 1,
        withdrawalProtocol: 1,
        state: 'serving',
      });
    }
  const options = {
    identity: {
      release: 'rivet',
      namespace: 'rivet-fixture',
      manifestDigest: 'bridge',
      topologyProtocol: 1,
      from,
      to: from === 'replicated' ? 'singleton' : 'replicated',
      configurationDigest: 'config',
      claimUid: 'same-claim',
    },
    inventory,
    now: () => clock,
    wait: async () => {
      clock += 10;
    },
    timeoutMs: 20,
    setHeartbeat: () => 0,
    clearHeartbeat() {},
    readJournal: async () => journal && structuredClone(journal),
    saveJournal: async (next, rv) => {
      assert.equal(rv, journal?.resourceVersion);
      journal = structuredClone({ ...next, resourceVersion: String(++version) });
      return journal;
    },
    preflight: async () => operations.push('preflight'),
    prepareRuntimeEdge: async () => operations.push('runtime-edge'),
    waitForRuntimeEdge: async () => {
      assert.ok(operations.includes('runtime-edge'));
    },
    observePod: async (name) => structuredClone(pods.get(name)),
    status: async (p) => structuredClone(pods.get(p.name)),
    withdraw: async (p, op, incarnation) => {
      assert.equal(journal.owner.withdrawIssued, true);
      assert.equal(p.incarnation, incarnation);
      Object.assign(pods.get(p.name), { state: 'withdrawing', operationId: op });
      operations.push(`withdraw:${p.name}`);
    },
    waitForRoutingWithdrawal: async (p) => operations.push(`routing:${p.name}`),
    begin: async (p, op) => {
      assert.equal(journal.owner.beginIssued, true);
      Object.assign(pods.get(p.name), { state: 'drained', operationId: op });
      operations.push(`drain:${p.name}`);
    },
    scaleToZero: async (w, drained) => {
      for (let i = 0; i < w.replicas; i++) {
        const name = `${w.name}-${i}`,
          p = pods.get(name);
        assert.equal(p?.state, 'drained');
        assert.ok(drained.some((d) => d.name === name && d.uid === p.uid));
        pods.delete(name);
      }
      operations.push(`stop:${w.name}`);
    },
    waitForNoOwners: async (w) => {
      assert.ok(![...pods.keys()].some((n) => n.startsWith(w.name)));
    },
    waitForVolumeRelease: async (uid) => {
      assert.equal(pods.size, 0);
      assert.equal(uid, 'same-claim');
      operations.push('detached');
    },
    applyTemplates: async () => {
      assert.equal(pods.size, 0);
      operations.push('templates');
    },
    templatesApplied: async () => operations.includes('templates'),
    verify: async () => operations.push('verified'),
  };
  return {
    options,
    operations,
    pods,
    get journal() {
      return journal;
    },
    advance() {
      clock += 120001;
    },
  };
}

for (const from of ['replicated', 'singleton'])
  test(`same-image ${from} ownership transfer drains only developers and preserves claim`, async () => {
    const f = fixture(from);
    const result = await runHaControlTopologyTransition(f.options);
    assert.equal(result.phase, 'complete');
    assert.equal(result.claimUid, 'same-claim');
    assert.ok(f.operations.indexOf('detached') < f.operations.indexOf('templates'));
    assert.ok(f.operations.indexOf('runtime-edge') < f.operations.findIndex((o) => o.startsWith('withdraw:')));
    assert.equal(f.operations.at(-1), 'verified');
    assert.equal(f.operations.filter((o) => o === 'templates').length, 1);
    assert.ok(f.operations.every((o) => !o.includes('execution')));
  });

for (const stage of ['edge', 'withdraw', 'begin', 'templates'])
  test(`lost ${stage} acknowledgement resumes by observation without replay`, async () => {
    const f = fixture();
    const key = stage === 'templates' ? 'applyTemplates' : stage === 'edge' ? 'prepareRuntimeEdge' : stage;
    const original = f.options[key];
    let calls = 0;
    f.options[key] = async (...args) => {
      calls++;
      await original(...args);
      if (calls === 1) throw Error('lost acknowledgement');
    };
    await assert.rejects(runHaControlTopologyTransition(f.options), /lost acknowledgement/);
    const before = calls;
    f.advance();
    const result = await runHaControlTopologyTransition({ ...f.options, resumeToken: f.journal.token });
    assert.equal(result.phase, 'complete');
    assert.equal(
      calls,
      ['templates', 'edge'].includes(stage) ? before : f.options.inventory.reduce((n, w) => n + w.replicas, 0),
    );
  });

test('active accepted work, changed incarnation or UID cannot be removed to meet a deadline', async () => {
  for (const fault of ['busy', 'incarnation', 'uid']) {
    const f = fixture();
    f.options.begin = async (p) => {
      if (fault === 'uid') f.pods.get(p.name).uid = randomUUID();
      else if (fault === 'incarnation') f.pods.get(p.name).incarnation = randomUUID();
    };
    await assert.rejects(runHaControlTopologyTransition(f.options), /active|changed|unconfirmed/);
    assert.ok(!f.operations.some((o) => o.startsWith('stop:')));
    assert.ok(!f.operations.includes('templates'));
  }
});

test('unknown template result, changed configuration and CAS conflict fail closed', async () => {
  const f = fixture();
  f.options.applyTemplates = async () => {
    throw Error('unknown');
  };
  await assert.rejects(runHaControlTopologyTransition(f.options), /unknown/);
  f.advance();
  await assert.rejects(
    runHaControlTopologyTransition({ ...f.options, resumeToken: f.journal.token }),
    /outcome unknown/,
  );
  await assert.rejects(
    runHaControlTopologyTransition({
      ...f.options,
      resumeToken: f.journal.token,
      identity: { ...f.options.identity, claimUid: 'different' },
    }),
    /exact recorded/,
  );
  const conflict = fixture();
  conflict.options.saveJournal = async () => {
    throw Error('CAS conflict');
  };
  await assert.rejects(runHaControlTopologyTransition(conflict.options), /CAS conflict/);
  assert.deepEqual(conflict.operations, ['preflight']);
});

test('singleton normal upgrades never surge the RWO developer owner but keep runtime surge and drain', async () => {
  const image = `api@sha256:${'b'.repeat(64)}`;
  const workloads = ['backend', 'execution'].map((role) => ({
    name: `rivet-${role}`,
    role,
    replicas: role === 'backend' ? 1 : 2,
    updateStrategy: 'OnDelete',
    image,
  }));
  assert.doesNotThrow(() => assertHaRolloutPlan(workloads, 'singleton'));
  assert.throws(() => assertHaRolloutPlan(workloads));
  assert.throws(() => assertHaRolloutPlan([{ ...workloads[0], replicas: 2 }, workloads[1]], 'singleton'));
  let journal,
    rv = 0;
  const pods = new Map(),
    operations = [];
  const create = (name, current) =>
    pods.set(name, {
      name,
      uid: randomUUID(),
      incarnation: randomUUID(),
      image: current,
      ready: true,
      protocol: 1,
      withdrawalProtocol: 1,
      state: 'serving',
    });
  for (const w of workloads) for (let i = 0; i < w.replicas; i++) create(`${w.name}-${i}`, 'old');
  await runHaRollingUpgrade({
    identity: { release: 'rivet', namespace: 'fixture', manifestDigest: 'new', controlPlaneMode: 'singleton' },
    workloads,
    readJournal: async () => journal,
    saveJournal: async (next, version) => {
      assert.equal(version, journal?.resourceVersion);
      return (journal = { ...next, resourceVersion: String(++rv) });
    },
    snapshotCapacity: async () => {},
    applyTemplates: async () => {},
    restoreAutoscalers: async () => {},
    observePod: async (name) => pods.get(name),
    status: async (p) => ({ ...pods.get(p.name) }),
    withdraw: async (p, op) => Object.assign(pods.get(p.name), { operationId: op, state: 'withdrawing', ready: false }),
    begin: async (p) => {
      pods.get(p.name).state = 'drained';
    },
    waitForRoutingWithdrawal: async () => {},
    waitForWithdrawal: async () => {},
    removePod: async (p) => {
      if (p.name.includes('execution'))
        assert.ok([...pods.values()].filter((p) => p.name.includes('execution') && p.ready).length >= 2);
      create(p.name, image);
      operations.push(`replace:${p.name}`);
    },
    scale: async (name, count) => {
      assert.ok(!name.includes('backend'), 'RWO backend must never surge');
      if (count === 3) create(`${name}-2`, image);
      else {
        assert.equal(pods.get(`${name}-2`).state, 'drained');
        pods.delete(`${name}-2`);
      }
      operations.push(`scale:${name}:${count}`);
    },
    waitForReady: async (name) => assert.equal(pods.get(name)?.ready, true),
    waitForScaleDown: async (_w, owner) => assert.equal(pods.has(owner.name), false),
  });
  assert.equal(journal.phase, 'complete');
  assert.equal(operations.filter((o) => o.startsWith('replace:rivet-backend')).length, 1);
});
