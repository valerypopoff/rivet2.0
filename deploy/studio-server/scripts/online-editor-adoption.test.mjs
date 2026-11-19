import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixtureDeploymentSafety } from './fixtures/deployment-safety.mjs';
import { assertSeparatedEditorExecutionSurges } from './lib/ha-kubernetes-rollout.mjs';
import { runOnlineEditorAdoption } from './lib/online-editor-adoption.mjs';
import {
  assertOnlineAdoptionObservations,
  assertOnlineEditorHelmSettlement,
  onlineEditorHelmDescription,
} from './lib/online-editor-adoption-receipt.mjs';
import { onlineEditorAdoptionEvidence } from './fixtures/online-editor-adoption-evidence.mjs';

function fixture() {
  const identity = { release: 'rivet', namespace: 'fixture', manifestDigest: 'images', configurationDigest: 'config' };
  const safety = fixtureDeploymentSafety('topology', identity);
  const changes = [],
    accepted = [];
  let journal,
    time = 0,
    guardHeld = false,
    template = 'source',
    route = 'normal',
    replicas = 1,
    standbyDeletionAt = null;
  const state = { pauseDrain: false, standbyReady: true, failAt: null, onStage: null, recreateOnShrink: false };
  const make = (ordinal, revision, housekeeping) => ({
    ordinal,
    name: `rivet-backend-${ordinal}`,
    uid: randomUUID(),
    incarnation: randomUUID(),
    revision,
    housekeeping,
    admitted: false,
    ready: true,
    state: 'serving',
    operationId: null,
    async isTemplate(...expected) {
      return expected.includes(this.revision);
    },
    hasAdmission(token) {
      return this.admissionToken === token;
    },
  });
  const pods = [make(0, 'source', 'inline'), null];
  const visible = (pod) =>
    pod?.ready &&
    (route === 'normal' || (route === 'source' && pod.ordinal === 0) || (route === 'overlap' && pod.admitted));
  const assertServing = () => {
    assert.ok(pods.some(visible), 'Every mutation must retain a routed editor');
    assert.ok(
      pods.filter((pod) => ['inline', 'owner'].includes(pod?.housekeeping)).length <= 1,
      'Legacy and locked housekeeping must never overlap',
    );
  };
  const changed = (name) => {
    assert.ok(guardHeld, 'Mutation ran without the restore coordinator');
    changes.push(name);
    assertServing();
    if (state.failAt === name) {
      state.failAt = null;
      throw Error('Lost mutation acknowledgement');
    }
  };
  const run = (options = {}) =>
    runOnlineEditorAdoption({
      identity,
      safety,
      readJournal: async () => journal,
      saveJournal: async (saved) => (journal = structuredClone(saved)),
      preflight: assertServing,
      acquireRestoreGuard: async () => {
        guardHeld = true;
        return {
          check() {
            assert.ok(guardHeld, 'Restore guard lost');
          },
          close() {
            guardHeld = false;
          },
        };
      },
      observe: async (ordinal) => pods[ordinal] && { ...pods[ordinal] },
      setRoute: async (next, _token, survivor) => {
        assert.equal(pods[survivor.ordinal].uid, survivor.uid);
        if (route !== next) {
          if (next === 'normal') assert.equal(pods[1], null, 'Widening the selector would route an unverified standby');
          route = next;
          changed(`route:${next}`);
        }
      },
      setTemplate: async (next) => {
        if (template === next) return;
        if (next === 'source') assert.equal(pods[1], null, 'Restoring the source template could start two workers');
        template = next;
        changed(`template:${next}`);
      },
      setReplicas: async (count, _pod, { verifyOnly } = {}) => {
        if (replicas === count) return;
        assert.ok(!verifyOnly);
        replicas = count;
        pods[1] = count === 2 ? make(1, 'bootstrap', 'standby') : null;
        if (pods[1]) pods[1].ready = state.standbyReady;
        else if (state.recreateOnShrink) {
          pods[1] = make(1, 'final', 'standby');
          standbyDeletionAt = time + 3;
        }
        changed(`replicas:${count}`);
      },
      setAdmission: async (pod, token) => {
        assert.equal(pods[pod.ordinal]?.uid, pod.uid);
        if (pods[pod.ordinal].admitted === !!token) return;
        if (token && pod.ordinal === 1) assert.ok(accepted.includes(pod.incarnation));
        pods[pod.ordinal].admitted = !!token;
        pods[pod.ordinal].admissionToken = token;
        changed(`admit:${pod.ordinal}:${!!token}`);
      },
      status: async ({ ordinal }) => {
        const { state, operationId, incarnation, uid, housekeeping } = pods[ordinal];
        return {
          protocol: 1,
          withdrawalProtocol: 1,
          state,
          operationId,
          incarnation,
          housekeeping: { state: housekeeping, podUid: uid, incarnation },
        };
      },
      withdraw: async ({ ordinal, uid }, id, incarnation) => {
        assert.deepEqual([uid, incarnation], [pods[ordinal].uid, pods[ordinal].incarnation]);
        Object.assign(pods[ordinal], { state: 'withdrawing', operationId: id, ready: false });
        changed(`withdraw:${ordinal}`);
      },
      waitForWithdrawal: async (source, target, check) => {
        await check();
        assert.ok(!visible(pods[source.ordinal]) && visible(pods[target.ordinal]));
      },
      begin: async ({ ordinal }, operationId) => {
        assert.equal(pods[ordinal].operationId, operationId);
        pods[ordinal].state = state.pauseDrain && ordinal === 0 ? 'draining' : 'drained';
        changed(`drain:${ordinal}`);
      },
      remove: async ({ ordinal, uid }) => {
        const pod = pods[ordinal];
        assert.equal(pod.uid, uid);
        assert.ok(pod.revision === 'fenced' || pod.state === 'drained');
        assert.ok(!visible(pod));
        pods[ordinal] = make(ordinal, template, { final: 'owner', bootstrap: 'inline', fenced: 'stopped' }[template]);
        if (template === 'fenced') pods[ordinal].ready = false;
        changed(`remove:${pod.revision}`);
      },
      accept: async (pod) => {
        assert.deepEqual([pod.uid, pod.incarnation], [pods[pod.ordinal].uid, pods[pod.ordinal].incarnation]);
        accepted.push(pod.incarnation);
      },
      observeTraffic: async (stage, owner) => {
        if (owner) assert.ok(visible(pods[owner.ordinal]), 'The verified owner must be routed');
        assertServing();
        state.onStage?.(stage, {
          pods,
          dropGuard: () => {
            guardHeld = false;
          },
        });
      },
      verify: async (_operation, beforeWrite) => {
        await beforeWrite?.();
        assert.equal(replicas, 1);
        assert.equal(route, 'normal');
        assert.equal(pods[0].housekeeping, 'owner');
        assert.equal(pods[0].admitted, false);
      },
      now: () => time,
      wait: async () => {
        time++;
        if (time === standbyDeletionAt) pods[1] = null;
      },
      timeoutMs: 20,
      ...options,
    });
  return {
    run,
    changes,
    pods,
    state,
    accepted,
    recreate(ordinal, revision, housekeeping) {
      return (pods[ordinal] = make(ordinal, revision, housekeeping));
    },
    get journal() {
      return journal;
    },
  };
}

test('online adoption changes only editor ownership and never withdraws the last routed editor', async () => {
  const flow = fixture();
  const withdrawn = [];
  flow.state.onStage = (name, { pods }) => {
    if (name !== 'source-withdrawn' && name !== 'standby-withdrawn') return;
    const ordinal = name === 'source-withdrawn' ? 0 : 1;
    assert.equal(pods[ordinal].state, 'drained');
    withdrawn.push(name);
  };
  const result = await flow.run();
  assert.deepEqual(withdrawn, ['source-withdrawn', 'standby-withdrawn']);
  assert.equal(result.phase, 'complete');
  assert.deepEqual(flow.changes, [
    'route:source',
    'template:bootstrap',
    'replicas:2',
    'admit:1:true',
    'admit:0:true',
    'route:overlap',
    'template:fenced',
    'admit:0:false',
    'withdraw:0',
    'drain:0',
    'remove:source',
    'template:final',
    'remove:fenced',
    'admit:0:true',
    'admit:1:false',
    'withdraw:1',
    'drain:1',
    'replicas:1',
    'route:normal',
    'admit:0:false',
  ]);
});

test('failed standby acceptance leaves the source eligible and a guarded abort removes the standby', async () => {
  const flow = fixture();
  flow.state.standbyReady = false;
  await assert.rejects(flow.run(), /did not become a serving bootstrap/);
  assert.deepEqual(flow.changes, ['route:source', 'template:bootstrap', 'replicas:2']);
  assert.equal(flow.pods[0].state, 'serving');
  const result = await flow.run({ resumeToken: flow.journal.token, abort: true });
  assert.equal(result.phase, 'complete');
  assert.equal(flow.pods[0].revision, 'source');
  assert.equal(flow.pods[1], null);
});

test('a slow editor drain holds the old owner and resumes on the same recorded operation', async () => {
  const flow = fixture();
  flow.state.pauseDrain = true;
  await assert.rejects(flow.run(), /work has not finished/);
  assert.equal(flow.pods[0].state, 'draining');
  await assert.rejects(flow.run({ resumeToken: flow.journal.token, abort: true }), /withdrawal has started/);
  flow.pods[0].state = 'drained';
  assert.equal((await flow.run({ resumeToken: flow.journal.token })).phase, 'complete');
  assert.equal(flow.changes.filter((change) => change === 'drain:0').length, 1);
});

test('committed selector, Pod deletion and scale writes are observed on explicit resume', async () => {
  for (const change of ['route:overlap', 'remove:source', 'replicas:1']) {
    const flow = fixture();
    flow.state.failAt = change;
    await assert.rejects(flow.run(), /Lost mutation acknowledgement/);
    await assert.rejects(flow.run({ resumeToken: 'unrelated' }), /exact editor adoption journal/);
    assert.equal((await flow.run({ resumeToken: flow.journal.token })).phase, 'complete');
    assert.equal(flow.changes.filter((entry) => entry === change).length, 1);
    assert.equal(flow.accepted.length, 2, 'Each unchanged replacement is accepted just once');
  }
});

test('resume admits a recreated serving editor before continuing either handoff', async () => {
  for (const { lostWrite, ordinal, revision, housekeeping } of [
    { lostWrite: 'drain:0', ordinal: 1 },
    { lostWrite: 'remove:source', ordinal: 1, revision: 'fenced', housekeeping: 'standby' },
    { lostWrite: 'withdraw:1', ordinal: 0, revision: 'final', housekeeping: 'owner' },
  ]) {
    const flow = fixture();
    flow.state.failAt = lostWrite;
    await assert.rejects(flow.run(), /Lost mutation acknowledgement/);
    const replacement = revision ? flow.recreate(ordinal, revision, housekeeping) : flow.pods[ordinal];
    replacement.incarnation = randomUUID();
    await assert.rejects(flow.run({ resumeToken: 'unrelated' }), /exact editor adoption journal/);
    assert.equal(flow.accepted.includes(replacement.incarnation), false);
    const result = await flow.run({ resumeToken: flow.journal.token });
    assert.equal(result.phase, 'complete');
    assert.equal(flow.accepted.filter((incarnation) => incarnation === replacement.incarnation).length, 1);
    assert.equal(flow.changes.filter((entry) => entry === lostWrite).length, 1);
  }
});

test('abort can return to a recreated source while the standby still serves', async () => {
  const flow = fixture();
  flow.state.failAt = 'route:overlap';
  await assert.rejects(flow.run(), /Lost mutation acknowledgement/);
  const source = flow.recreate(0, 'bootstrap', 'inline');
  assert.equal((await flow.run({ resumeToken: flow.journal.token, abort: true })).phase, 'complete');
  assert.equal(flow.pods[0].uid, source.uid);
  assert.equal(flow.pods[1], null);
});

test('abort disarms the ordinal fence and removes its placeholder without starting another legacy worker', async () => {
  const flow = fixture();
  flow.state.failAt = 'template:fenced';
  await assert.rejects(flow.run(), /Lost mutation acknowledgement/);
  flow.recreate(0, 'fenced', 'stopped').ready = false;
  assert.equal((await flow.run({ resumeToken: flow.journal.token, abort: true })).phase, 'complete');
  assert.equal(flow.pods[0].housekeeping, 'inline');
  assert.equal(flow.pods[1], null);
});

test('normal routing waits for the standby ordinal to disappear after scale-down', async () => {
  const flow = fixture();
  flow.state.recreateOnShrink = true;
  assert.equal((await flow.run()).phase, 'complete');
  assert.equal(flow.pods[1], null);
});

test('settlement rechecks the restore guard at the metadata write boundary', async () => {
  const flow = fixture();
  flow.state.onStage = (name, { dropGuard }) => {
    if (name === 'settlement-write') dropGuard();
  };
  await assert.rejects(flow.run(), /Restore guard lost/);
  assert.equal(flow.pods[0].ready, true);
  assert.equal(flow.pods[1], null);
  assert.equal(flow.journal.phase, 'owners');
  flow.state.onStage = null;
  assert.equal((await flow.run({ resumeToken: flow.journal.token })).phase, 'complete');
});

test('lost restore lock and a changed process incarnation fence destructive actions', async () => {
  const lost = fixture();
  lost.state.onStage = (name, { dropGuard }) => {
    if (name === 'source-replace') dropGuard();
  };
  await assert.rejects(lost.run(), /Restore guard lost/);
  assert.ok(!lost.changes.includes('remove:source'));

  const restarted = fixture();
  restarted.state.onStage = (name, { pods }) => {
    if (name === 'source-replace') pods[0].incarnation = randomUUID();
  };
  await assert.rejects(restarted.run(), /draining editor changed/);
  restarted.state.onStage = null;
  await assert.rejects(restarted.run({ resumeToken: restarted.journal.token }), /draining editor changed/);
  assert.ok(!restarted.changes.includes('remove:source'));
});

test('qualification requires connection reuse and full protected requests across the actual handoff', () => {
  const evidence = onlineEditorAdoptionEvidence('images');
  assert.doesNotThrow(() => assertOnlineAdoptionObservations(evidence, 'images'));
  const window = evidence.observed['editor-source-withdrawal'];
  for (const patch of [
    { finishedAt: window.at },
    { acceptedAt: new Date(Date.parse(window.startedAt) + 1).toISOString() },
  ]) {
    const late = structuredClone(evidence);
    Object.assign(late.protectedRequests[0], patch);
    assert.throws(() => assertOnlineAdoptionObservations(late, 'images'), /did not cross editor-source-withdrawal/);
  }
  for (const request of evidence.protectedRequests) request.reusedConnection = false;
  assert.throws(() => assertOnlineAdoptionObservations(evidence, 'images'), /did not observe HTTP\/1 connection reuse/);
});

test('the deployed Helm revision binds acceptance independently of the shared autoscaling journal', () => {
  const operationId = randomUUID();
  const receipt = { digest: 'reviewed-receipt', installedRevision: 55 };
  const policy = 'reviewed-policy';
  const entry = {
    revision: 56,
    status: 'deployed',
    description: onlineEditorHelmDescription(operationId, receipt, policy),
  };
  assert.equal(assertOnlineEditorHelmSettlement([entry], receipt, policy), operationId);
  for (const entryMismatch of [{ status: 'failed' }, { revision: 57 }, { description: 'Upgrade complete' }])
    assert.throws(
      () => assertOnlineEditorHelmSettlement([{ ...entry, ...entryMismatch }], receipt, policy),
      /settlement is unconfirmed/,
    );
  assert.throws(
    () => assertOnlineEditorHelmSettlement([entry], receipt, 'another-policy'),
    /settlement is unconfirmed/,
  );
  assert.throws(
    () => assertOnlineEditorHelmSettlement([entry], receipt, policy, randomUUID()),
    /settlement is unconfirmed/,
  );
});

test('ordinary paired pool surges account for terminating Pods on either side', () => {
  const workload = (name, role, replicas) => ({
    metadata: { name, uid: name, labels: { 'app.kubernetes.io/component': role } },
    spec: { replicas },
  });
  const pod = (parent, ordinal, deleting = false) => ({
    metadata: {
      ...parent.metadata,
      name: `${parent.metadata.name}-${ordinal}`,
      ownerReferences: [{ controller: true, uid: parent.metadata.uid }],
      ...(deleting ? { deletionTimestamp: 'now' } : {}),
    },
  });
  const editor = workload('editor', 'backend', 1);
  const active = workload('execution-a', 'execution', 2);
  const retired = workload('execution-b', 'execution', 0);
  const layout = {
    controllers: [editor, active, retired],
    pods: [pod(editor, 0), pod(active, 0), pod(active, 1)],
    active: active.metadata.name,
  };
  for (const role of ['backend', 'execution'])
    assert.doesNotThrow(() => assertSeparatedEditorExecutionSurges({ ...layout, role }));
  assert.throws(
    () =>
      assertSeparatedEditorExecutionSurges({
        ...layout,
        role: 'execution',
        pods: [...layout.pods, pod(editor, 1, true)],
      }),
    /extra editor/,
  );
  assert.throws(
    () =>
      assertSeparatedEditorExecutionSurges({
        ...layout,
        role: 'backend',
        pods: [...layout.pods, pod(retired, 0, true)],
      }),
    /retiring execution pool/,
  );
});
