import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { root, role, ready, until, sleep } from './provider-gate.mjs';
import { publishBackground, startOwnedBackground, settleOwnedBackground } from './load-fixtures.mjs';
import { installFaultTransport } from './provider-faults.mjs';
import { runCooperativeProvider } from './provider-cooperative.mjs';
const load = (relative) => import(pathToFileURL(path.join(root, relative)));
const { releaseOperationJournalName } = await load('deploy/studio-server/scripts/lib/release-operation-journal.mjs');
const { createKubernetesTransport, createExecutionAutoscalerIO } = await load(
  'deploy/studio-server/scripts/lib/execution-autoscaler-kubernetes.mjs',
);
const { autoscalerPolicy, autoscalerPolicyDigest } = await load(
  'deploy/studio-server/scripts/lib/execution-autoscaler.mjs',
);
const WebSocketClass = createRequire(path.join(root, 'packages/studio-server-api/package.json'))('ws');
export async function runProviderAutoscaling(gate, owned, { phase, checkpoint }) {
  const policy = gate.operation.policy;
  assert.equal(gate.singleton, true);
  assert.equal(gate.profile, 'compact');
  assert.equal(gate.controllerEnabled, true);
  const report = {
    startedAt: new Date().toISOString(),
    source: gate.manifest.source.sha,
    policy,
    policyDigest: autoscalerPolicyDigest(policy),
    accepted: [],
    phases: [],
  };
  const workload = gate.config.release + '-ha-execution',
    controller = gate.config.release + '-autoscaler';
  const journal = async () =>
    JSON.parse(
      JSON.parse(
        (await gate.kube(['get', 'configmap', releaseOperationJournalName(gate.config.release), '-o', 'json'])).stdout,
      ).data.record,
    );
  const workers = async () => (await gate.pods()).filter((p) => role(p) === 'execution');
  const io = createExecutionAutoscalerIO({
    transport: createKubernetesTransport({ origin: gate.identity.clusterServer, WebSocketClass }),
    release: gate.config.release,
    namespace: gate.config.namespace,
    workload,
    service: gate.config.release + '-execution',
    image: gate.config.images.api.repository + '@' + gate.config.images.api.digest,
    policy,
  });
  const step = async (name, work) => {
    phase(name);
    await checkpoint({ name, state: 'started', at: new Date().toISOString() });
    const result = await work();
    report.phases.push({ name, result, finishedAt: new Date().toISOString() });
    await checkpoint({ name, state: 'completed', at: new Date().toISOString() });
    return result;
  };
  const settledTwo = async () =>
    until(
      'canonical automatic return to two healthy workers',
      async () => {
        const current = await workers(),
          record = await journal();
        return (
          current.length === 2 &&
          current.every(ready) &&
          record.autoscalingProtocol === 1 &&
          record.phase === 'complete' &&
          !record.target &&
          Number.isFinite(record.lastSampleAt) &&
          Date.now() - record.lastSampleAt < 45000
        );
      },
      5400000,
    );
  const snapshot = async () => {
    await gate.assertProofContext();
    return until(
      'fresh direct real-GKE execution snapshot',
      async () => {
        try {
          return await io.snapshot();
        } catch {
          return false;
        }
      },
      180000,
    );
  };
  await step('enable-canonical-independent-controller', async () => {
    await settledTwo();
    const deployment = JSON.parse((await gate.kube(['get', 'deployment', controller, '-o', 'json'])).stdout);
    const actual = JSON.parse(
      deployment.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
    );
    assert.deepEqual(actual.policy, policy);
    return { deploymentUid: deployment.metadata.uid, actualPolicy: actual.policy };
  });
  report.cooperative = await step('active-and-paused-upgrade-growth-without-shrink', () =>
    runCooperativeProvider(gate, {
      policy,
      policyDigest: report.policyDigest,
      accepted: report.accepted,
      readJournal: journal,
      workers,
      snapshot,
      settledTwo,
    }),
  );
  report.capacity = await step('real-slot-demand-through-reviewed-seven-worker-ceiling', async () => {
    const project = await publishBackground(gate, 'slots', 900000, 'slot-capacity'),
      loaded = new Set();
    const startedAt = Date.now();
    await until(
      'seven real Ready provider workers',
      async () => {
        const current = (await workers()).filter(ready);
        if (current.length === policy.maxReplicas) return true;
        for (const pod of current)
          if (!loaded.has(pod.metadata.uid)) {
            await startOwnedBackground(gate, pod, project, 3, report.accepted);
            loaded.add(pod.metadata.uid);
          }
        return false;
      },
      720000,
    );
    const readyLatencyMs = Date.now() - startedAt;
    const peak = await snapshot();
    assert.equal(peak.replicas, policy.maxReplicas);
    assert.equal(peak.pods.length, policy.maxReplicas);
    assert.ok(peak.pods.every((p) => p.sampleFresh && p.ready && p.state === 'serving'));
    const pods = await workers(),
      nodes = JSON.parse((await gate.kubectl(['get', 'nodes', '-o', 'json'], { capture: true })).stdout).items;
    assert.equal(
      new Set(pods.map((p) => p.spec.nodeName)).size,
      policy.maxReplicas,
      'real required anti-affinity capacity must exist',
    );
    for (const pod of pods) {
      const node = nodes.find((n) => n.metadata.name === pod.spec.nodeName);
      assert.ok(node?.metadata.uid);
      assert.ok(
        node.spec.providerID.startsWith('gce://' + gate.operation.projectId + '/') ||
          node.spec.providerID.startsWith('gce://' + gate.operation.projectNumber + '/'),
      );
    }
    await settleOwnedBackground(gate, report.accepted);
    await settledTwo();
    return {
      readyLatencyMs,
      peak,
      actualProviderHosts: pods.map((p) => ({
        podUid: p.metadata.uid,
        node: p.spec.nodeName,
        providerId: nodes.find((n) => n.metadata.name === p.spec.nodeName).spec.providerID,
      })),
      automaticallyReturnedToTwo: true,
    };
  });
  await step('long-work-retirement-restart-serialization-and-returning-demand', async () => {
    const surge = await publishBackground(gate, 'slots', 240000, 'regrowth-seed');
    for (const worker of (await workers()).filter(ready))
      await startOwnedBackground(gate, worker, surge, 3, report.accepted);
    await until('third Ready worker', async () => (await workers()).filter(ready).length === 3, 600000);
    const tail = (await workers()).find((p) => p.metadata.name === workload + '-2');
    assert.ok(ready(tail));
    const long = await publishBackground(gate, 'slots', 900000, 'long-drain');
    const longRequest = await startOwnedBackground(gate, tail, long, 1, report.accepted);
    const draining = await until(
      'real stabilized busy-tail drain',
      async () => {
        const record = await journal();
        return record.phase === 'draining' && record.target?.uid === tail.metadata.uid ? record : null;
      },
      840000,
    );
    const busy = (await snapshot()).pods.find((p) => p.uid === tail.metadata.uid);
    assert.ok(busy.active >= 1);
    assert.equal(busy.state, 'draining');
    assert.ok(
      Date.now() - draining.target.withdrawnAt >= 60000,
      'real routing withdrawal interval must not be shortened',
    );
    const eviction = await gate.kube(
      ['create', '--raw', `/api/v1/namespaces/${gate.config.namespace}/pods/${tail.metadata.name}/eviction`, '-f', '-'],
      {
        input: JSON.stringify({
          apiVersion: 'policy/v1',
          kind: 'Eviction',
          metadata: { name: tail.metadata.name, namespace: gate.config.namespace },
          deleteOptions: { preconditions: { uid: tail.metadata.uid } },
        }),
        allowFailure: true,
      },
    );
    assert.notEqual(eviction.exitCode, 0);
    assert.match(eviction.stderr, /disruption budget|TooManyRequests|cannot evict/i);
    const before = (await gate.pods()).find((p) => role(p) === 'autoscaler');
    assert.ok(ready(before));
    await gate.scaleExact('deployment', controller, 1, 0);
    await until(
      'old controller fully stopped',
      async () => !(await gate.pods()).some((p) => p.metadata.uid === before.metadata.uid),
      180000,
    );
    await gate.scaleExact('deployment', controller, 0, 1);
    await until(
      'new controller Ready and same operation resumed',
      async () => {
        const record = await journal();
        assert.equal(record.target?.uid, draining.target.uid);
        assert.equal(record.target?.operationId, draining.target.operationId);
        return (await gate.pods()).some(
          (p) => role(p) === 'autoscaler' && ready(p) && p.metadata.uid !== before.metadata.uid,
        );
      },
      180000,
    );
    await assert.rejects(gate.roll(gate.config.images, true), /autoscaling operation owns this release/);
    const still = await journal();
    assert.equal(still.target.uid, tail.metadata.uid);
    assert.equal(still.target.operationId, draining.target.operationId);
    const returning = await publishBackground(gate, 'slots', 240000, 'returned-demand');
    for (const worker of (await workers()).filter((p) => ready(p) && p.metadata.uid !== tail.metadata.uid))
      await startOwnedBackground(gate, worker, returning, 3, report.accepted);
    const raised = await until(
      'returning traffic adds a higher ordinal during owned drain',
      async () => {
        const current = await workers();
        return current.length >= 4 && current.some((p) => p.metadata.name === workload + '-3' && ready(p))
          ? current
          : null;
      },
      600000,
    );
    const higher = raised.find((p) => p.metadata.name === workload + '-3');
    await until(
      'drained interior UID replaced without deleting the newer capacity',
      async () => {
        const current = await workers(),
          replacement = current.find((p) => p.metadata.name === tail.metadata.name);
        assert.ok(
          current.some((p) => p.metadata.uid === higher.metadata.uid),
          'new higher ordinal was removed to reach the old tail',
        );
        return (
          replacement &&
          replacement.metadata.uid !== tail.metadata.uid &&
          ready(replacement) &&
          (await journal()).phase === 'complete'
        );
      },
      1500000,
    );
    await settleOwnedBackground(gate, report.accepted);
    return {
      originalTailUid: tail.metadata.uid,
      retirementOperationId: draining.target.operationId,
      incarnation: draining.target.incarnation,
      busyEvictionRejected: true,
      originalControllerUid: before.metadata.uid,
      sameOperationRecovered: true,
      concurrentDeploymentRejected: true,
      higherUidPreserved: higher.metadata.uid,
      longCorrelation: longRequest.responses[0].correlationId,
    };
  });
  let faults;
  try {
    faults = await installFaultTransport(gate, owned);
    await step('missing-and-stale-metrics-never-mean-idle', async () => {
      const results = [];
      for (const [mode, field] of [
        ['metrics-missing', 'missingResponses'],
        ['metrics-stale', 'staleResponses'],
      ]) {
        await faults.mode(mode);
        await until(
          'negative observation really resets the low-load window',
          async () => (await journal()).lowSince === null && (await faults.read()).state[field] >= 1,
          60000,
        );
        const before = await workers();
        assert.ok(before.length >= 3 && before.every(ready));
        const heldMs = policy.stabilizationSeconds * 1000 + 30000;
        const untilAt = Date.now() + heldMs;
        while (Date.now() < untilAt) {
          const record = await journal(),
            current = await workers();
          assert.equal(record.phase, 'complete');
          assert.equal(record.lowSince, null);
          assert.deepEqual(current.map((p) => p.metadata.uid).sort(), before.map((p) => p.metadata.uid).sort());
          await sleep(5000);
        }
        const observation = (await faults.read()).state;
        assert.ok(observation[field] >= 2);
        results.push({
          mode,
          observations: observation[field],
          capacityUnchangedForMs: heldMs,
          lowDemandWindowReset: true,
        });
      }
      return results;
    });
    report.lostAck = await step('actual-lost-scale-ack-reconciles-without-replay', async () => {
      await faults.mode('lose-scale-ack-once');
      const before = await workers();
      assert.ok(before.length >= 3 && before.length <= 5 && before.every(ready));
      const demand = await publishBackground(gate, 'slots', 300000, 'lost-scale-ack');
      for (const worker of before) await startOwnedBackground(gate, worker, demand, 3, report.accepted);
      const observed = await until(
        'scale API accepted but acknowledgement actually suppressed',
        async () => {
          const state = (await faults.read()).state;
          return state.scaleAttempt?.state === 'accepted-response-suppressed' ? state : null;
        },
        180000,
      );
      await until(
        'real controller observes scale intent and releases it',
        async () => {
          const record = await journal();
          return record.phase === 'complete' && !record.scale && !record.target;
        },
        180000,
      );
      const final = (await faults.read()).state,
        intent = observed.scaleWrites[0];
      assert.equal(
        final.scaleWrites.filter((w) => w.uid === intent.uid && w.from === intent.from && w.to === intent.to).length,
        1,
      );
      assert.equal(observed.scaleAttempt.identity.replicas, intent.to);
      await faults.mode('pass');
      await settleOwnedBackground(gate, report.accepted);
      return { acceptedScale: observed.scaleAttempt, sourceTransition: intent, sameTransitionDispatches: 1 };
    });
  } finally {
    if (faults) await faults.restore();
  }
  await settledTwo();
  report.cpu = await step('separate-real-cpu-pressure-grows-runtime-not-developers', async () => {
    const from = (await workers()).length;
    const project = await publishBackground(gate, 'cpu', 300000, 'cpu-demand');
    const originals = (await workers()).filter(ready);
    assert.equal(originals.length, 2);
    for (const worker of originals) await startOwnedBackground(gate, worker, project, 1, report.accepted);
    const pressure = await until(
      'CPU above target while slots alone fit two workers',
      async () => {
        const current = await snapshot();
        const active = current.pods.reduce((sum, p) => sum + p.active, 0);
        const cpu = current.pods.reduce((sum, p) => sum + p.cpuRatio, 0);
        return active <= 4 && cpu > 1.5 ? { active, cpu, observedAt: new Date().toISOString() } : null;
      },
      180000,
    );
    await until(
      'third runtime worker Ready under real CPU pressure',
      async () => (await workers()).filter(ready).length >= 3,
      360000,
    );
    const developers = (await gate.pods()).filter((p) => ['backend', 'web'].includes(role(p)));
    assert.equal(developers.length, 2);
    assert.ok(developers.every(ready));
    const to = (await workers()).length;
    await settleOwnedBackground(gate, report.accepted);
    await settledTwo();
    return { ...pressure, from, to, separateCpuGrowth: true, developerReplicasUnchanged: true };
  });
  const final = (await gate.pods()).filter((p) => !p.metadata.deletionTimestamp);
  assert.equal(final.length, 7);
  assert.ok(final.every(ready));
  report.finishedAt = new Date().toISOString();
  report.finalApplicationPods = 7;
  return report;
}
