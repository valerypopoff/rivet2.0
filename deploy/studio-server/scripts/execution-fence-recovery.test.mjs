import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createFenceRecoveryIO } from './repair-execution-startup-fence.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  prepareExecutionFenceRepair,
  applyExecutionFenceRepair,
  fenceRepairDigest,
} from './lib/execution-fence-recovery.mjs';

function fixture() {
  const policy = autoscalerPolicy({ maxReplicas: 7 });
  const binding = {
    context: 'fixture',
    namespace: 'fixture',
    namespaceUid: 'namespace-uid',
    release: 'rivet',
    controller: 'rivet-autoscaler',
    controllerUid: 'controller-uid',
    workload: 'rivet-execution',
    image: `test.invalid/api@sha256:${'a'.repeat(64)}`,
    manifestDigest: `sha256:${'b'.repeat(64)}`,
    policyDigest: autoscalerPolicyDigest(policy),
  };
  const target = {
    name: 'rivet-execution-4',
    uid: 'pod-uid',
    workloadUid: 'workload-uid',
    incarnation: 'process-uid',
    operationId: 'retirement-id',
    withdrawnAt: 1000,
  };
  let clock = 1000,
    version = 1;
  const key = 'rivet.dev/execution-retirement-fence';
  const state = {
    namespace: { metadata: { uid: binding.namespaceUid } },
    deployment: {
      metadata: { uid: binding.controllerUid, labels: { 'app.kubernetes.io/instance': binding.release } },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'autoscaler',
                image: binding.image,
                env: [{ name: 'RIVET_AUTOSCALER_CONFIG', value: JSON.stringify({ ...binding, policy }) }],
              },
            ],
          },
        },
      },
    },
    statefulset: {
      metadata: {
        uid: target.workloadUid,
        resourceVersion: '1',
        generation: 1,
        labels: { 'app.kubernetes.io/instance': binding.release },
      },
      status: { observedGeneration: 1 },
      spec: {
        updateStrategy: { type: 'OnDelete' },
        template: {
          metadata: { annotations: { [key]: target.name } },
          spec: { containers: [{ name: 'api', image: binding.image }] },
        },
      },
    },
    pod: {
      metadata: {
        name: target.name,
        uid: target.uid,
        resourceVersion: '2',
        annotations: { [key]: 'rivet-execution-2', retained: 'yes' },
        ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: target.workloadUid, name: binding.workload }],
      },
    },
    status: { protocol: 1, incarnation: target.incarnation, state: 'serving', operationId: null },
    record: {
      autoscalingProtocol: 1,
      phase: 'fencing',
      release: binding.release,
      namespace: binding.namespace,
      manifestDigest: binding.manifestDigest,
      policyDigest: binding.policyDigest,
      target,
      token: 'operation-token',
      runner: 'old-controller',
      leaseExpiresAt: clock,
      resourceVersion: '1',
    },
  };
  state.peers = [0, 1].map((ordinal) => ({
    metadata: {
      name: `rivet-execution-${ordinal}`,
      uid: `peer-${ordinal}`,
      ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: target.workloadUid, name: binding.workload }],
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  }));
  const calls = [];
  const kube = (args, body, text) => {
    calls.push(args);
    state.onCall?.(args);
    if (args[0] === 'get') {
      if (args[1] === 'pods') return { items: [structuredClone(state.pod), ...structuredClone(state.peers)] };
      if (args[1] === 'pod' && args[2] !== target.name)
        return structuredClone(state.peers.find((p) => p.metadata.name === args[2]));
      if (args[1] === 'configmap')
        return { metadata: { resourceVersion: String(version) }, data: { record: JSON.stringify(state.record) } };
      return structuredClone(state[args[1]]);
    }
    if (args[0] === 'replace') {
      assert.equal(body.metadata.resourceVersion, String(version));
      state.record = JSON.parse(body.data.record);
      version++;
      return { ...body, metadata: { ...body.metadata, resourceVersion: String(version) } };
    }
    if (args[0] === 'patch') {
      const patch = JSON.parse(args[args.indexOf('-p') + 1]);
      assert.equal(args[1], 'pod');
      assert.equal(args[2], target.name);
      assert.equal(patch[0].value, state.pod.metadata.uid);
      assert.equal(patch[1].value, state.pod.metadata.resourceVersion);
      state.pod.metadata.annotations = patch[2].value;
      state.pod.metadata.resourceVersion = '3';
      return structuredClone(state.pod);
    }
    assert.equal(args[0], 'exec');
    assert.equal(text, true);
    assert.deepEqual(args.slice(-2), ['node', '/opt/rivet/retire-backend.mjs']);
    return JSON.stringify(
      args[1] === target.name
        ? state.status
        : {
            protocol: 1,
            incarnation: `inc-${args[1]}`,
            state: 'serving',
            operationId: state.peerOperation ?? null,
          },
    );
  };
  return {
    binding,
    state,
    calls,
    io: createFenceRecoveryIO({ binding, kube }),
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('operator adapter repairs only exact metadata, preserving identity, other annotations and journal state', async () => {
  const f = fixture();
  const plan = await prepareExecutionFenceRepair(f);
  assert.ok(f.calls.every((c) => ['get', 'exec'].includes(c[0])));
  const result = await applyExecutionFenceRepair({ ...f, plan, confirmation: fenceRepairDigest(plan) });
  assert.equal(result.outcome, 'metadata-confirmed');
  assert.equal(f.state.record.phase, 'fencing');
  assert.equal(f.state.record.token, 'operation-token');
  assert.equal(f.state.pod.metadata.annotations.retained, 'yes');
  assert.equal(f.state.pod.metadata.annotations['rivet.dev/execution-retirement-fence'], plan.target.name);
  assert.equal(f.calls.filter((c) => c[0] === 'patch').length, 1);
  assert.equal(
    f.calls.some((c) => ['scale', 'delete', 'create'].includes(c[0])),
    false,
  );
});

test('operator recovery rejects changed installation, workload, journal, process and expired approval without metadata writes', async (t) => {
  for (const change of [
    'namespace',
    'controller',
    'image',
    'policy',
    'workload',
    'pod',
    'incarnation',
    'busy',
    'token',
    'lease',
    'expiry',
    'annotation',
    'foreign',
    'version',
    'peer',
  ])
    await t.test(change, async () => {
      const f = fixture();
      const plan = await prepareExecutionFenceRepair(f);
      if (change === 'namespace') f.state.namespace.metadata.uid = 'other';
      if (change === 'controller') f.state.deployment.metadata.uid = 'other';
      if (change === 'image') f.state.deployment.spec.template.spec.containers[0].image = 'other';
      if (change === 'policy') f.state.record.policyDigest = 'other';
      if (change === 'workload') f.state.statefulset.metadata.uid = 'other';
      if (change === 'pod') f.state.pod.metadata.uid = 'other';
      if (change === 'incarnation') f.state.status.incarnation = 'other';
      if (change === 'busy') f.state.status.operationId = 'another-retirement';
      if (change === 'token') f.state.record.token = 'other';
      if (change === 'lease') f.state.record.leaseExpiresAt = f.now() + 10000;
      if (change === 'expiry') f.advance(900001);
      if (change === 'annotation')
        f.state.pod.metadata.annotations['rivet.dev/execution-retirement-fence'] = 'rivet-execution-3';
      if (change === 'foreign') f.state.pod.metadata.annotations['rivet.dev/execution-retirement-fence'] = 'foreign-2';
      if (change === 'version') f.state.record.fenceRepair = { protocol: 9 };
      if (change === 'peer') f.state.peerOperation = 'foreign-retirement';
      await assert.rejects(applyExecutionFenceRepair({ ...f, plan, confirmation: fenceRepairDigest(plan) }));
      assert.equal(
        f.calls.some((c) => c[0] === 'patch'),
        false,
      );
    });
});

test('CLI help is read-only and documents explicit private plans and separate apply confirmation', () => {
  const help = execFileSync(
    process.execPath,
    ['deploy/studio-server/scripts/repair-execution-startup-fence.mjs', '--help'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.match(help, /Dry-run/);
  assert.match(help, /separate approval/);
  assert.match(help, /No scale/);
});

test('the final pod inspection cannot outlive the recovery lease and still authorize a patch', async () => {
  const f = fixture();
  const plan = await prepareExecutionFenceRepair(f);
  let reads = 0;
  f.state.onCall = (args) => {
    if (args[0] === 'get' && args[1] === 'pod' && args[2] === plan.target.name && ++reads === 6) f.advance(120001);
  };
  await assert.rejects(
    applyExecutionFenceRepair({ ...f, plan, confirmation: fenceRepairDigest(plan) }),
    /lease changed or expired/,
  );
  assert.equal(reads, 6, 'expire during the last identity read before patch authorization');
  assert.equal(
    f.calls.some((args) => args[0] === 'patch'),
    false,
  );
});

test('slow peer verification cannot renew an already expired lease', async () => {
  const f = fixture();
  const plan = await prepareExecutionFenceRepair(f);
  f.state.onCall = (args) => {
    if (args[0] === 'get' && args[1] === 'pods') f.advance(120001);
  };
  await assert.rejects(
    applyExecutionFenceRepair({ ...f, plan, confirmation: fenceRepairDigest(plan) }),
    /lease changed or expired/,
  );
  assert.equal(
    f.calls.some((args) => args[0] === 'patch'),
    false,
  );
});

test('approval expiry during initial installation inspection cannot acquire a journal lease', async () => {
  const f = fixture();
  const plan = await prepareExecutionFenceRepair(f);
  f.state.onCall = (args) => {
    if (args[0] === 'get' && args[1] === 'deployment') f.advance(900001);
  };
  await assert.rejects(
    applyExecutionFenceRepair({ ...f, plan, confirmation: fenceRepairDigest(plan) }),
    /plan expired/,
  );
  assert.equal(
    f.calls.some((args) => ['replace', 'patch'].includes(args[0])),
    false,
  );
});

test('an expired intent requires a fresh read-only plan and exact approval, retaining prior confirmation', async () => {
  for (const confirmed of [false, true]) {
    const f = fixture();
    const plan = await prepareExecutionFenceRepair(f);
    const digest = fenceRepairDigest(plan);
    f.state.record.fenceRepair = {
      protocol: 1,
      target: plan.target,
      before: plan.before,
      planDigest: digest,
      confirmed,
    };
    if (confirmed) f.state.pod.metadata.annotations['rivet.dev/execution-retirement-fence'] = plan.target.name;
    f.advance(900001);
    const before = f.calls.length;
    await assert.rejects(
      applyExecutionFenceRepair({ ...f, plan, confirmation: digest }),
      /current exact recovery plan/,
    );
    assert.equal(f.calls.length, before, 'expired approval performs no cluster access');
    const renewed = await prepareExecutionFenceRepair(f);
    assert.equal(renewed.supersedes, digest);
    assert.equal(renewed.before, plan.before);
    assert.ok(f.calls.slice(before).every((args) => ['get', 'exec'].includes(args[0])));
    await assert.rejects(applyExecutionFenceRepair({ ...f, plan: renewed, confirmation: digest }), /confirmation/);
    const result = await applyExecutionFenceRepair({ ...f, plan: renewed, confirmation: fenceRepairDigest(renewed) });
    assert.equal(result.outcome, 'metadata-confirmed');
    assert.equal(f.state.record.fenceRepair.previousPlanDigest, digest);
    assert.equal(f.calls.filter((args) => args[0] === 'patch').length, confirmed ? 0 : 1);
  }
});

test('renewal cannot adopt changed intents or discard confirmed metadata', async () => {
  for (const change of ['digest', 'before', 'missing', 'confirmed-divergence']) {
    const f = fixture();
    const plan = await prepareExecutionFenceRepair(f);
    f.state.record.fenceRepair = {
      protocol: 1,
      target: plan.target,
      before: plan.before,
      planDigest: fenceRepairDigest(plan),
      confirmed: false,
    };
    const renewed = await prepareExecutionFenceRepair(f);
    if (change === 'digest') f.state.record.fenceRepair.planDigest = 'another-plan';
    if (change === 'before') f.state.record.fenceRepair.before = 'rivet-execution-3';
    if (change === 'missing') delete f.state.record.fenceRepair;
    if (change === 'confirmed-divergence') f.state.record.fenceRepair.confirmed = true;
    await assert.rejects(applyExecutionFenceRepair({ ...f, plan: renewed, confirmation: fenceRepairDigest(renewed) }));
    assert.equal(
      f.calls.some((args) => args[0] === 'patch'),
      false,
    );
  }
});

test('lease-release failures preserve the original recovery failure', async () => {
  const f = fixture();
  const plan = await prepareExecutionFenceRepair(f);
  const primary = new Error('metadata response lost');
  const cleanup = new Error('journal unavailable during release');
  const io = {
    ...f.io,
    convergeFence: async () => {
      throw primary;
    },
  };
  let reads = 0;
  io.readJournal = async () => {
    if (++reads === 2) throw cleanup;
    return f.io.readJournal();
  };
  await assert.rejects(
    applyExecutionFenceRepair({ ...f, io, plan, confirmation: fenceRepairDigest(plan) }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      return true;
    },
  );
});

test('CLI refuses ambiguous approval and installation overrides before loading plans or contacting Kubernetes', () => {
  for (const args of [
    ['--confirm', 'sha256:unused'],
    ['--apply', 'absent-plan.json'],
    ...['namespace', 'namespace-uid', 'release', 'controller'].map((key) => [
      '--apply',
      'absent-plan.json',
      '--confirm',
      'sha256:unused',
      `--${key}`,
      'ignored',
    ]),
  ]) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            'deploy/studio-server/scripts/repair-execution-startup-fence.mjs',
            '--context',
            'never-contact',
            '--output',
            'never-created-receipt.json',
            ...args,
          ],
          { encoding: 'utf8', windowsHide: true, stdio: 'pipe' },
        ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(
          error.stderr,
          /--confirm requires --apply|explicit --confirm digest|identity overrides are not allowed/,
        );
        assert.doesNotMatch(error.stderr, /ENOENT|kubectl/);
        return true;
      },
    );
  }
});
