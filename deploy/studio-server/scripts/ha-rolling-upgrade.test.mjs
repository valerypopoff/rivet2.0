import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runHaRollingUpgrade, assertHaRolloutPlan, assertHaRetirement } from './lib/ha-rolling-upgrade.mjs';
import {
  resolveHaWorkloadCapacity,
  hasSameHaOwnerIdentity,
  runHaKubernetesRollout,
} from './lib/ha-kubernetes-rollout.mjs';
import { journalForReleaseOperation, releaseOperationJournalName } from './lib/release-operation-journal.mjs';

test('API-server field ordering does not resemble a Secret identity change', () => {
  const current = {
    env: [
      { name: 'RIVET_KEY', valueFrom: { secretKeyRef: { key: 'key', name: 'auth' } } },
      { name: 'PORT', value: '1234' },
    ],
  };
  const candidate = {
    env: [
      { name: 'PORT', value: '1234' },
      { name: 'RIVET_KEY', valueFrom: { secretKeyRef: { name: 'auth', key: 'key' } } },
    ],
  };
  assert.equal(hasSameHaOwnerIdentity(current, candidate), true);
  candidate.env[1].valueFrom.secretKeyRef.name = 'other';
  assert.equal(hasSameHaOwnerIdentity(current, candidate), false);
  assert.equal(hasSameHaOwnerIdentity(current, { env: [] }), false);
});

function fixture() {
  let journal,
    revision = 0,
    time = 0;
  const operations = [],
    pods = new Map();
  const workloads = [
    {
      name: 'fixture-backend',
      role: 'backend',
      replicas: 2,
      updateStrategy: 'OnDelete',
      image: `api@sha256:${'b'.repeat(64)}`,
    },
  ];
  const create = (name, image) =>
    pods.set(name, {
      name,
      uid: randomUUID(),
      image,
      ready: true,
      incarnation: randomUUID(),
      state: 'serving',
      operationId: null,
    });
  for (let i = 0; i < 2; i++) create(`fixture-backend-${i}`, `api@sha256:${'a'.repeat(64)}`);
  const options = {
    identity: { release: 'fixture', namespace: 'fixture', manifestDigest: 'candidate' },
    workloads,
    now: () => time,
    wait: async () => {
      time += 100;
    },
    timeoutMs: 500,
    setHeartbeat: () => 0,
    clearHeartbeat: () => {},
    readJournal: async () => journal && structuredClone(journal),
    saveJournal: async (next, rv) => {
      assert.equal(rv, journal?.resourceVersion);
      return (journal = structuredClone({ ...next, resourceVersion: String(++revision) }));
    },
    snapshotCapacity: async () => operations.push('capacity'),
    observePod: async (name) => structuredClone(pods.get(name)),
    status: async (pod) => ({ protocol: 1, withdrawalProtocol: 1, ...pods.get(pod.name) }),
    withdraw: async (pod, op) => {
      assert.equal(journal.owner.withdrawIssued, true);
      Object.assign(pods.get(pod.name), { state: 'withdrawing', operationId: op, ready: false });
      operations.push(`withdraw-command:${pod.name}`);
    },
    waitForRoutingWithdrawal: async (pod) => {
      assert.equal(pods.get(pod.name).ready, false);
      assert.ok(['withdrawing', 'draining', 'drained'].includes(pods.get(pod.name).state));
      operations.push(`routing-withdrawn:${pod.name}`);
    },
    begin: async (pod, op, inc) => {
      const current = pods.get(pod.name);
      assert.equal(current.incarnation, inc);
      assert.equal(current.uid, pod.uid);
      assert.equal(journal.owner.beginIssued, true);
      current.state = 'drained';
      current.operationId = op;
      current.ready = false;
      operations.push(`begin:${pod.name}`);
    },
    removePod: async (pod) => {
      const current = pods.get(pod.name);
      assert.equal(current.uid, pod.uid);
      assert.equal(current.state, 'drained');
      assert.ok([...pods.values()].filter((p) => p.ready).length >= 2);
      operations.push(`delete:${pod.name}`);
      create(pod.name, workloads[0].image);
    },
    scale: async (name, count) => {
      if (count === 3) {
        if (!pods.has(`${name}-2`)) create(`${name}-2`, workloads[0].image);
      } else {
        assert.equal(pods.get(`${name}-2`).state, 'drained');
        pods.delete(`${name}-2`);
      }
      operations.push(`scale:${count}`);
    },
    waitForScaleDown: async (workload, owner) => {
      assert.equal(owner.name, `${workload.name}-2`);
      assert.equal(owner.scaleDownIssued, true);
      assert.equal(pods.has(owner.name), false);
      operations.push('surge-removed');
    },
    applyTemplates: async () => operations.push('templates'),
    restoreAutoscalers: async () => operations.push('autoscalers'),
    waitForReady: async (name, image) => {
      assert.equal(pods.get(name)?.image, image);
      assert.equal(pods.get(name)?.ready, true);
    },
    waitForWithdrawal: async (pod) => {
      assert.equal(pods.get(pod.name).ready, false);
      operations.push(`withdraw:${pod.name}`);
    },
  };
  return {
    options,
    operations,
    pods,
    get journal() {
      return journal;
    },
    advance(ms) {
      time += ms;
    },
  };
}
test('maintenance and HA use one CAS journal and cannot take an unfinished or leased foreign operation', () => {
  const identity = { release: 'fixture', namespace: 'fixture' };
  const ownership = { token: randomUUID(), runner: randomUUID(), manifestDigest: 'candidate' };
  const ha = { ...identity, ...ownership, protocol: 1, phase: 'owners', resourceVersion: '7', leaseExpiresAt: 1 };
  const cutover = {
    ...identity,
    ...ownership,
    formatVersion: 1,
    phase: 'quiescing',
    resourceVersion: '8',
    leaseExpiresAt: 1,
  };
  assert.match(releaseOperationJournalName('fixture'), /-cutover$/);
  assert.throws(() => journalForReleaseOperation(ha, 'cutover', identity, () => 100), /owns this release/);
  assert.throws(() => journalForReleaseOperation(cutover, 'ha', identity, () => 100), /owns this release/);
  assert.throws(
    () => journalForReleaseOperation({ ...ha, phase: 'complete', leaseExpiresAt: 200 }, 'cutover', identity, () => 100),
    /owns this release/,
  );
  assert.equal(
    journalForReleaseOperation({ ...ha, phase: 'complete' }, 'cutover', identity, () => 100),
    null,
  );
  assert.throws(
    () =>
      journalForReleaseOperation(
        { ...ha, phase: 'complete', manifestDigest: undefined },
        'cutover',
        identity,
        () => 100,
      ),
    /unconfirmed/,
  );
  assert.equal(
    journalForReleaseOperation(ha, 'ha', identity, () => 100),
    ha,
  );
});

test('recovery retains original capacity when the recorded rollout has already created a surge', () => {
  const candidate = { metadata: { name: 'fixture-backend' } };
  const existing = { spec: { replicas: 3 } };
  const journal = {
    token: 'owned-token',
    phase: 'owners',
    workloads: [{ name: 'fixture-backend', role: 'backend', replicas: 2 }],
  };
  assert.equal(resolveHaWorkloadCapacity(candidate, existing, journal, 'owned-token'), 2);
  assert.throws(() => resolveHaWorkloadCapacity(candidate, existing, journal, 'wrong'), /token changed/);
  assert.throws(
    () => resolveHaWorkloadCapacity(candidate, { spec: { replicas: 4 } }, journal, 'owned-token'),
    /capacity/,
  );
  assert.equal(resolveHaWorkloadCapacity(candidate, existing, null), 3);
});

test('unknown initial ownership acknowledgement exposes its recovery token without touching workloads', async () => {
  const f = fixture();
  f.options.saveJournal = async () => {
    throw new Error('lost response');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /ownership write is unconfirmed.*journal token [a-f0-9-]+/);
  assert.ok(!f.operations.includes('templates'));
  assert.ok(!f.operations.some((o) => o.startsWith('begin:')));
});

test('HA replaces each exact drained UID while two ready owners serve, including accepted surge work', async () => {
  const f = fixture();
  const result = await runHaRollingUpgrade(f.options);
  assert.equal(result.phase, 'complete');
  assert.equal(f.pods.size, 2);
  assert.deepEqual(
    f.operations.filter((x) => x.startsWith('begin')),
    ['begin:fixture-backend-0', 'begin:fixture-backend-1', 'begin:fixture-backend-2'],
  );
  for (const name of ['fixture-backend-0', 'fixture-backend-1'])
    assert.ok(f.operations.indexOf(`withdraw:${name}`) < f.operations.indexOf(`delete:${name}`));
  for (const name of ['fixture-backend-0', 'fixture-backend-1', 'fixture-backend-2'])
    assert.ok(f.operations.indexOf(`routing-withdrawn:${name}`) < f.operations.indexOf(`begin:${name}`));
});

test('routing withdrawal failure leaves admission unfenced and never deletes an owner', async () => {
  const f = fixture();
  f.options.waitForRoutingWithdrawal = async () => {
    throw Error('endpoints still ready');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /endpoints still ready/);
  assert.equal(f.journal.owner.withdrawIssued, true);
  assert.equal(f.journal.owner.beginIssued, false);
  assert.equal(f.pods.get('fixture-backend-0').state, 'withdrawing');
  assert.ok(!f.operations.some((o) => o.startsWith('begin:') || o.startsWith('delete:')));
});

test('a lost withdrawal acknowledgement is observed on recovery without repeating the command', async () => {
  const f = fixture(),
    send = f.options.withdraw;
  f.options.withdraw = async (...args) => {
    await send(...args);
    throw Error('lost withdrawal acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost withdrawal/);
  const token = f.journal.token;
  f.options.withdraw = send;
  await runHaRollingUpgrade({ ...f.options, resumeToken: token });
  assert.equal(f.operations.filter((o) => o === 'withdraw-command:fixture-backend-0').length, 1);
});

test('failed fixture preparation cannot record a command that was never attempted', async () => {
  const f = fixture();
  f.options.prepareRetirement = async () => {
    throw Error('probe setup failed');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /probe setup failed/);
  assert.equal(f.journal.owner.beginIssued, false);
  assert.ok(!f.operations.some((o) => o.startsWith('begin:') || o.startsWith('delete:')));
  delete f.options.prepareRetirement;
  const result = await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(result.phase, 'complete');
});
test('missing protocol, readiness or spare capacity stops before templates, commands and journal ownership', async () => {
  for (const mode of ['protocol', 'withdrawal-protocol', 'readiness', 'capacity']) {
    const f = fixture();
    if (mode === 'protocol') f.options.status = async () => ({ protocol: 0 });
    if (mode === 'withdrawal-protocol') {
      const status = f.options.status;
      f.options.status = async (pod) => ({ ...(await status(pod)), withdrawalProtocol: undefined });
    }
    if (mode === 'readiness') f.pods.get('fixture-backend-1').ready = false;
    if (mode === 'capacity')
      f.options.snapshotCapacity = async () => {
        throw Error('capacity');
      };
    await assert.rejects(runHaRollingUpgrade(f.options));
    assert.equal(f.journal, undefined);
    assert.ok(!f.operations.includes('templates'));
  }
});

test('a same-image template change still retires stale-revision owners', async () => {
  const f = fixture();
  const originalUids = new Set([...f.pods.values()].map((p) => p.uid));
  for (const pod of f.pods.values()) pod.image = f.options.workloads[0].image;
  f.options.isCurrentPod = (pod, workload) => pod.image === workload.image && !originalUids.has(pod.uid);
  await runHaRollingUpgrade(f.options);
  assert.deepEqual(
    f.operations.filter((o) => o.startsWith('begin:')),
    ['begin:fixture-backend-0', 'begin:fixture-backend-1', 'begin:fixture-backend-2'],
  );
});
test('a long accepted run times out without deleting, scaling down, replaying or rolling back', async () => {
  const f = fixture();
  f.options.begin = async (pod, op) => {
    Object.assign(f.pods.get(pod.name), { state: 'draining', operationId: op });
    f.operations.push('begin');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /still active/);
  assert.equal(f.pods.size, 3);
  assert.equal(f.operations.filter((x) => x === 'begin').length, 1);
  assert.ok(!f.operations.some((x) => x.startsWith('delete') || x === 'scale:2'));
});
test('a lost begin acknowledgement is observed on explicit recovery and never sent twice', async () => {
  const f = fixture(),
    begin = f.options.begin;
  f.options.begin = async (...args) => {
    await begin(...args);
    throw Error('lost begin acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost begin/);
  f.options.resumeToken = f.journal.token;
  f.options.begin = begin;
  await runHaRollingUpgrade(f.options);
  assert.equal(f.operations.filter((x) => x === 'begin:fixture-backend-0').length, 1);
});

test('lost surge scale-down acknowledgement is observed without recreating or commanding another owner', async () => {
  const f = fixture(),
    scale = f.options.scale;
  f.options.scale = async (...args) => {
    await scale(...args);
    if (args[1] === 2) throw Error('lost scale acknowledgement');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost scale acknowledgement/);
  assert.equal(f.journal.owner.scaleDownIssued, true);
  assert.equal(f.pods.size, 2);
  assert.ok(!f.operations.includes('autoscalers'));
  f.options.scale = scale;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:3').length, 1);
  assert.equal(f.operations.filter((o) => o === 'scale:2').length, 1);
  assert.equal(f.operations.filter((o) => o === 'begin:fixture-backend-2').length, 1);
  assert.ok(f.operations.indexOf('surge-removed') < f.operations.indexOf('autoscalers'));
});

test('surge drain recovery retains its UID and observes a lost begin instead of replaying it', async () => {
  const f = fixture(),
    begin = f.options.begin;
  f.options.begin = async (...args) => {
    await begin(...args);
    if (args[0].name.endsWith('-2')) throw Error('lost surge begin');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /lost surge begin/);
  f.options.begin = begin;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:3').length, 1);
  assert.equal(f.operations.filter((o) => o === 'begin:fixture-backend-2').length, 1);
});

test('pending surge deletion blocks completion and autoscaler restoration without replaying scale-down', async () => {
  const f = fixture(),
    waitForScaleDown = f.options.waitForScaleDown;
  f.options.waitForScaleDown = async () => {
    throw Error('deletion still pending');
  };
  await assert.rejects(runHaRollingUpgrade(f.options), /deletion still pending/);
  assert.equal(f.journal.phase, 'owners');
  assert.ok(!f.operations.includes('autoscalers'));
  f.options.waitForScaleDown = waitForScaleDown;
  await runHaRollingUpgrade({ ...f.options, resumeToken: f.journal.token });
  assert.equal(f.operations.filter((o) => o === 'scale:2').length, 1);
});
test('lease loss and stale incarnation stop deletion; unknown template outcomes never replay migrations', async () => {
  for (const mode of ['lease', 'incarnation', 'template']) {
    const f = fixture(),
      begin = f.options.begin;
    if (mode === 'template')
      f.options.applyTemplates = async () => {
        throw Error('template unknown');
      };
    else
      f.options.begin = async (...args) => {
        await begin(...args);
        if (mode === 'lease') f.advance(130_000);
        else f.pods.get(args[0].name).incarnation = randomUUID();
      };
    await assert.rejects(runHaRollingUpgrade(f.options));
    assert.ok(!f.operations.some((x) => x.startsWith('delete')));
    if (mode === 'template') {
      f.options.resumeToken = f.journal.token;
      await assert.rejects(runHaRollingUpgrade(f.options), /template acknowledgement is unknown/);
    }
  }
});
test('HA rejects unbounded plans, automatic replacement and malformed ownership', () => {
  assert.throws(() => assertHaRolloutPlan([{ name: 'x', role: 'backend', replicas: 1 }]));
  assert.throws(() => assertHaRetirement({ protocol: 1, incarnation: '-'.repeat(36), state: 'drained' }));
});

for (const fault of [
  'none',
  'lost-acknowledgement',
  'changed-capacity',
  'changed-uid',
  'missing-readiness',
  'null-readiness',
])
  test(`Kubernetes surge removal is capacity/UID guarded and recoverable: ${fault}`, async () => {
    const f = fixture(),
      calls = [];
    const name = f.options.workloads[0].name;
    const candidate = {
      kind: 'StatefulSet',
      metadata: { name, labels: { 'app.kubernetes.io/component': 'backend' } },
      spec: {
        replicas: 2,
        updateStrategy: { type: 'OnDelete' },
        template: {
          spec: {
            containers: [
              { name: 'backend', image: f.options.workloads[0].image, env: [{ name: 'RIVET_KEY', value: 'fixture' }] },
            ],
          },
        },
      },
    };
    const current = structuredClone(candidate);
    current.metadata.generation = 1;
    current.status = { readyReplicas: 2, observedGeneration: 1, updateRevision: 'candidate' };
    let cm,
      revision = 0,
      pendingRemoval = false,
      restored = false;
    const kube = async (args, extra) => {
      calls.push(args);
      const result = (value) => ({ stdout: value == null ? '' : JSON.stringify(value) });
      if (args[0] === 'get' && args[1] === 'configmap') return result(cm);
      if (['create', 'replace'].includes(args[0])) {
        const next = JSON.parse(extra.input);
        assert.equal(next.metadata.resourceVersion, cm?.metadata.resourceVersion);
        cm = { ...next, metadata: { ...next.metadata, resourceVersion: String(++revision) } };
        return result(cm);
      }
      if (args[0] === 'get' && args[1] === 'statefulset') {
        if (cm && JSON.parse(cm.data.record).owner?.scaleDownIssued) {
          if (fault === 'changed-capacity') current.spec.replicas = 4;
          if (fault === 'changed-uid') f.pods.get(`${name}-2`).uid = 'unexpected-replacement';
        }
        return result(args.includes('-l') ? { items: [current] } : current);
      }
      if (args[0] === 'get' && args[1] === 'endpointslice')
        return result({
          items: [
            {
              metadata: { labels: { 'kubernetes.io/service-name': 'public' } },
              endpoints: [...f.pods.values()].map((pod) => ({
                targetRef: { uid: pod.uid },
                ...(fault === 'missing-readiness'
                  ? {}
                  : { conditions: { ready: fault === 'null-readiness' ? null : pod.ready } }),
              })),
            },
          ],
        });
      if (args[0] === 'get' && args[1] === 'pod') {
        const pod = f.pods.get(args[2]);
        if (!pod) return result(null);
        const value = {
          metadata: {
            name: pod.name,
            uid: pod.uid,
            labels: { 'app.kubernetes.io/instance': 'fixture', 'controller-revision-hash': 'candidate' },
          },
          spec: { containers: [{ name: 'backend', image: pod.image }] },
          status: { conditions: [{ type: 'Ready', status: pod.ready ? 'True' : 'False' }] },
        };
        if (pendingRemoval && args[2] === `${name}-2`) {
          // The first read still sees the terminating pod after spec.replicas changed.
          f.pods.delete(args[2]);
          pendingRemoval = false;
        }
        return result(value);
      }
      if (args[0] === 'exec') {
        const pod = f.pods.get(args[1]);
        if (args.includes('--withdraw-only'))
          Object.assign(pod, { state: 'withdrawing', operationId: args[7], ready: false });
        if (args.includes('--begin-only')) Object.assign(pod, { state: 'drained', operationId: args[7], ready: false });
        return result({ protocol: 1, withdrawalProtocol: 1, ...pod });
      }
      if (args[0] === 'delete') {
        const podName = args[2].split('/').at(-1);
        assert.equal(JSON.parse(extra.input).preconditions.uid, f.pods.get(podName).uid);
        await f.options.removePod(f.pods.get(podName));
        return result({});
      }
      if (args[0] === 'scale') {
        assert.ok(args.includes(`--current-replicas=${current.spec.replicas}`));
        const replicas = Number(args.find((a) => a.startsWith('--replicas=')).split('=')[1]);
        current.spec.replicas = replicas;
        if (replicas === 3) await f.options.scale(name, replicas);
        else {
          pendingRemoval = true;
          if (fault === 'lost-acknowledgement') throw Error('lost scale acknowledgement');
        }
        return result({});
      }
      throw Error(`Unexpected Kubernetes command: ${args}`);
    };
    const options = {
      kube,
      release: 'fixture',
      namespace: 'fixture',
      manifestDigest: 'candidate',
      resources: [candidate, { kind: 'Service', metadata: { name: 'public' }, spec: {} }],
      timeoutMs: 1000,
      applyTemplates: async () => {},
      restoreAutoscalers: async () => {
        assert.equal(pendingRemoval, false);
        assert.equal(f.pods.has(`${name}-2`), false);
        assert.equal(current.spec.replicas, 2);
        restored = true;
      },
    };
    if (fault === 'missing-readiness' || fault === 'null-readiness') {
      await assert.rejects(runHaKubernetesRollout(options), /endpoint withdrawal/);
      assert.equal(calls.filter((a) => a.includes('--begin-only')).length, 0);
      assert.equal(calls.filter((a) => a[0] === 'delete').length, 0);
      assert.equal(restored, false);
      return;
    }
    if (fault === 'changed-capacity' || fault === 'changed-uid') {
      await assert.rejects(runHaKubernetesRollout(options), /capacity changed|identity changed/);
      assert.equal(calls.filter((a) => a[0] === 'scale').length, 1);
      assert.equal(restored, false);
      assert.equal(f.pods.has(`${name}-2`), true);
      return;
    }
    if (fault === 'lost-acknowledgement') {
      await assert.rejects(runHaKubernetesRollout(options), /lost scale acknowledgement/);
      assert.equal(restored, false);
      await runHaKubernetesRollout({ ...options, resumeToken: JSON.parse(cm.data.record).token });
    } else await runHaKubernetesRollout(options);
    assert.equal(restored, true);
    assert.equal(calls.filter((a) => a[0] === 'scale').length, 2);
  });
