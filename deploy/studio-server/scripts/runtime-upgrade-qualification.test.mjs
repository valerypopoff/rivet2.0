import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeControlLocalGate } from './kubernetes-runtime-control-local.mjs';
import { ManagedReleaseGate } from './kubernetes-managed-release-gate.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import {
  runOrdinaryRuntimeUpgrade,
  assertRuntimeUpgradePair,
  runtimeQualificationPurpose,
  assertOrdinaryRuntimePods,
  waitForOrdinaryRuntime,
} from './lib/runtime-upgrade-qualification.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';
import { assertOrdinaryRuntimeResources } from './lib/ha-release-evidence.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
function pair() {
  const make = (letter, predecessorRelease = null) =>
    createStudioServerReleaseManifest({
      rootDir,
      source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: letter.repeat(40) },
      images: Object.fromEntries(
        ['proxy', 'web', 'api', 'executor'].map((role) => [
          role,
          { repository: `example.test/${role}`, digest: `sha256:${letter.repeat(64)}` },
        ]),
      ),
      candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
      predecessorRelease,
    });
  const previous = promoteStudioServerReleaseManifest(make('a'), {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  return { previous, candidate: make('b', previous) };
}
function pods(images) {
  return Object.entries({ proxy: 2, web: 1, backend: 1, execution: 2, autoscaler: 1 }).flatMap(([role, count]) =>
    Array.from({ length: count }, (_, ordinal) => ({
      metadata: { uid: `${role}-${ordinal}`, labels: { 'app.kubernetes.io/component': role } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
      spec: {
        containers: [
          {
            name: role === 'execution' ? 'api' : role,
            image: `${images[['backend', 'execution', 'autoscaler'].includes(role) ? 'api' : role].repository}@${images[['backend', 'execution', 'autoscaler'].includes(role) ? 'api' : role].digest}`,
          },
        ],
      },
    })),
  );
}

test('ordinary default pins predecessor/schema/policy; adoption remains a separate explicit purpose', () => {
  const { previous, candidate } = pair();
  assert.equal(runtimeQualificationPurpose(), 'ordinary-upgrade');
  assert.equal(runtimeQualificationPurpose('adoption'), 'adoption');
  assert.throws(() => runtimeQualificationPurpose('typo'));
  assertRuntimeUpgradePair(previous, candidate);
  const wrong = structuredClone(candidate);
  wrong.lineage.predecessor.manifestDigest = 'sha256:' + 'c'.repeat(64);
  assert.throws(() => assertRuntimeUpgradePair(previous, wrong));
  const gate = Object.create(RuntimeControlLocalGate.prototype);
  gate.config = {
    images: candidate.images,
    previousManifest: previous,
    candidateManifest: candidate,
    managedWorkflowSchema: candidate.database.managedWorkflowSchema,
    runtimeEdgeProfile: 'compact',
    runtimeQualificationPurpose: 'ordinary-upgrade',
    registry: { secretName: 'fixture' },
  };
  const values = gate.values(Object.fromEntries(Object.entries(previous.images).reverse()));
  assert.deepEqual(values.replicaCount, { proxy: 2, web: 1, backend: 1, execution: 2 });
  assert.equal(values.ha.controlPlane.mode, 'singleton');
  assert.equal(values.autoscaling.executionController.enabled, true);
  assert.deepEqual(values.resources.execution.requests, { cpu: '500m', memory: '1Gi' });
  assert.deepEqual(values.resources.backend.requests, { cpu: '500m', memory: '1Gi' });
  values.resources.execution.requests.cpu = '1m';
  assert.equal(
    gate.values(previous.images).resources.execution.requests.cpu,
    '500m',
    'fixture overrides must not mutate the cached chart defaults',
  );
  assert.deepEqual(values.autoscaling.proxy, {
    enabled: true,
    minReplicas: 2,
    maxReplicas: 4,
    targetCPUUtilizationPercentage: 75,
  });
  assert.equal(values.workflowSchema.compatibility.maximumVersion, previous.database.managedWorkflowSchema.version);
  assert.throws(() => gate.values({ ...candidate.images, api: previous.images.api }), /exact ordinary/);
  for (const policy of [{ minReplicas: 3 }, { maxReplicas: 2 }]) {
    gate.config.runtimeAutoscalerPolicy = policy;
    assert.throws(() => gate.values(previous.images), /baseline|surge/);
  }
  assertOrdinaryRuntimePods(pods(previous.images), previous.images, { baseline: true });
  const incomplete = pods(previous.images).slice(1);
  assert.throws(() => assertOrdinaryRuntimePods(incomplete), /floor/);
  assert.throws(() =>
    assertOrdinaryRuntimePods([...pods(previous.images), pods(previous.images)[0]], previous.images, {
      baseline: true,
    }),
  );
});

test('rendered ordinary scope rejects topology, suspended controller and proxy HPA drift', () => {
  const counts = { backend: 1, web: 1, proxy: 2, execution: 2, autoscaler: 1 };
  const resources = Object.entries(counts).map(([role, count]) => ({
    kind: ['backend', 'execution'].includes(role) ? 'StatefulSet' : 'Deployment',
    metadata: { name: role, labels: { 'app.kubernetes.io/component': role } },
    spec: {
      replicas: count,
      template: {
        spec: {
          containers: [
            {
              name: role,
              env:
                role === 'backend'
                  ? [{ name: 'RIVET_HA_CONTROL_PLANE_MODE', value: 'singleton' }]
                  : role === 'autoscaler'
                    ? [{ name: 'RIVET_AUTOSCALER_CONFIG', value: JSON.stringify({ policy: {} }) }]
                    : [],
            },
          ],
        },
      },
    },
  }));
  resources.push({
    kind: 'HorizontalPodAutoscaler',
    spec: {
      scaleTargetRef: { name: 'proxy', kind: 'Deployment', apiVersion: 'apps/v1' },
      minReplicas: 2,
      maxReplicas: 4,
      metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 75 } } },
      ],
    },
  });
  const proof = { protocol: 2, autoscalerPolicyDigest: autoscalerPolicyDigest({}) };
  assertOrdinaryRuntimeResources(proof, resources);
  const grown = structuredClone(resources);
  grown.find((r) => r.metadata?.name === 'execution').spec.replicas = 7;
  grown.find((r) => r.metadata?.name === 'proxy').spec.replicas = 4;
  assertOrdinaryRuntimeResources(proof, grown);
  grown.find((r) => r.metadata?.name === 'execution').spec.replicas = 11;
  assert.throws(() => assertOrdinaryRuntimeResources(proof, grown), /policy/);
  const suspended = structuredClone(resources);
  suspended[4].spec.replicas = 0;
  assert.throws(() => assertOrdinaryRuntimeResources(proof, suspended), /baseline/);
  const drift = structuredClone(resources);
  drift.at(-1).spec.maxReplicas = 6;
  assert.throws(() => assertOrdinaryRuntimeResources(proof, drift), /HPA/);
  assert.throws(() => assertOrdinaryRuntimeResources(proof, resources.slice(0, -1)), /HPA/);
  for (const role of ['backend', 'autoscaler']) {
    const misleading = structuredClone(resources);
    const containers = misleading.find((r) => r.metadata?.name === role).spec.template.spec.containers;
    containers.push({ ...structuredClone(containers[0]), name: 'unrelated-sidecar' });
    containers[0].env = [];
    assert.throws(() => assertOrdinaryRuntimeResources(proof, misleading), /topology|policy/);
  }
});

test('fixture admission waits for the actual predecessor owners, not Helm completion or an unrelated sidecar image', async () => {
  const { previous, candidate } = pair();
  let reads = 0;
  const gate = {
    pods: async () => {
      const result = pods(previous.images);
      if (++reads === 1) result[0].status.conditions[0].status = 'False';
      return result;
    },
  };
  await waitForOrdinaryRuntime(gate, previous.images, async (_name, check) => {
    assert.equal(await check(), false);
    assert.equal(await check(), true);
  });
  assert.equal(reads, 2);
  const wrong = pods(previous.images);
  wrong[0].spec.containers.push({ name: 'sidecar', image: wrong[0].spec.containers[0].image });
  wrong[0].spec.containers[0].image = `${candidate.images.proxy.repository}@${candidate.images.proxy.digest}`;
  assert.throws(() => assertOrdinaryRuntimePods(wrong, previous.images, { baseline: true }), /image/);
});

test('real Helm render keeps seven owners, live autoscalers and installed schema bounds', async (t) => {
  const { previous, candidate } = pair();
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ordinary-render-'));
  t.after(() => fs.rm(artifactsDir, { recursive: true, force: true }));
  const gate = Object.create(RuntimeControlLocalGate.prototype);
  gate.config = {
    release: 'rivet-ordinary-test',
    namespace: 'rivet-runtime-control-test',
    artifactsDir,
    images: candidate.images,
    previousManifest: previous,
    candidateManifest: candidate,
    managedWorkflowSchema: candidate.database.managedWorkflowSchema,
    runtimeEdgeProfile: 'compact',
    runtimeQualificationPurpose: 'ordinary-upgrade',
    registry: { secretName: 'registry' },
  };
  gate.helmBin = resolveHelmBinOrThrow(rootDir);
  const proof = { protocol: 2, autoscalerPolicyDigest: autoscalerPolicyDigest({}) };
  for (const manifest of [previous, candidate]) {
    const resources = await gate.resources(gate.values(manifest.images), manifest.source.sha);
    assertOrdinaryRuntimeResources(proof, resources);
  }
});

// This crosses real HTTP plus the rollout/probe adapter boundary, not real
// Kubernetes. The local cluster command remains the separate continuity proof.
for (const scenario of ['pass', '502', 'missing-recording', 'storage-drift', 'aborted', 'overlap', 'overlap-failure']) {
  test(`ordinary observation keeps a single truthful window: ${scenario}`, async (t) => {
    const { previous, candidate } = pair();
    const overlap = scenario.startsWith('overlap'),
      developerCalls = [];
    const archive = Buffer.from('immutable-fixture-archive');
    let failing = false,
      images = previous.images,
      storageUid = 'original',
      rolls = 0,
      independence = 0;
    const requests = [],
      artifacts = new Map(),
      captures = [];
    const controller = new AbortController();
    const server = createServer((req, res) => {
      requests.push({ id: req.headers['x-rivet-ha-probe-id'], method: req.method, route: req.url });
      if (req.url.endsWith('/download')) return res.end(archive);
      if (failing && req.method === 'POST') {
        res.writeHead(502, { server: 'nginx', 'content-type': 'text/html' });
        return res.end('<html>Bad gateway</html>');
      }
      res.end(req.method === 'POST' ? JSON.stringify({ output: 'ok' }) : 'Managed release gate app');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const probes = {
      background: [],
      bundle: { id: 'bundle', archiveHash: createHash('sha256').update(archive).digest('hex') },
      prepare: async (options) => assert.equal(options.embeddedMaintenance, overlap ? true : 'singleton'),
      beforeRetirement: async (pod) => probes.background.push({ uid: pod.uid }),
      afterWithdrawal: async (pod) => {
        if (scenario !== 'missing-recording') probes.background.find((p) => p.uid === pod.uid).recordingId = pod.uid;
      },
    };
    const gate = {
      edgeProfile: 'compact',
      purpose: 'ordinary-upgrade',
      config: { images },
      secrets: { rivetKey: 'local-test-only-key' },
      assertLocalContext: async () => {},
      pods: async () => pods(images),
      kube: async () => ({
        stdout: JSON.stringify({
          items: [{ kind: 'PersistentVolumeClaim', metadata: { name: 'restore', uid: storageUid }, spec: {} }],
        }),
      }),
      requestWorkflow: ManagedReleaseGate.prototype.requestWorkflow,
      roll: async (_images, singleton, hooks) => {
        rolls++;
        assert.equal(singleton, true);
        failing = scenario === '502';
        if (failing) await new Promise((r) => setTimeout(r, 60));
        for (const ordinal of [0, 1]) {
          const pod = { name: `fixture-ha-execution-${ordinal}`, uid: `owner-${ordinal}` };
          await hooks.beforeRetirement(pod);
          await hooks.afterWithdrawal(pod);
        }
        images = candidate.images;
        if (scenario === 'storage-drift') storageUid = 'replacement';
        if (scenario === 'aborted') controller.abort(Error('Qualification deadline reached'));
      },
      assertAutoscalerActive: async () => ({ policyDigest: autoscalerPolicyDigest({}) }),
      waitForDeveloperRoute: async () => {},
      isolateRuntime: async () => {
        if (overlap) assert.deepEqual(developerCalls, ['adopt', 'roll', 'finish', 'close']);
        independence++;
        return { browser: true, schedule: true };
      },
      artifact: async (name, value) => artifacts.set(name, value),
      capture: async (name) => captures.push(name),
    };
    const until = async (_name, check) => {
      for (let i = 0; i < 1000; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw Error('fixture timeout');
    };
    const work = runOrdinaryRuntimeUpgrade({
      gate,
      previous,
      candidate,
      probes,
      baseUrl,
      until,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      sampleIntervalMs: 5,
      ...(overlap
        ? {
            prepareDeveloperOverlap: async () => {
              developerCalls.push('adopt');
            },
            startDeveloperOverlap: async () => ({
              roll: async (callbacks) => {
                developerCalls.push('roll');
                await gate.roll(candidate.images, true, callbacks);
              },
              finish: async () => {
                developerCalls.push('finish');
                if (scenario === 'overlap-failure') throw Error('browser continuity failed');
                return { observed: true };
              },
              close: async () => {
                developerCalls.push('close');
              },
            }),
          }
        : {}),
    });
    if (scenario === 'pass' || scenario === 'overlap') {
      const report = await work;
      assert.equal(report.outcome, 'passed');
      assert.equal(report.qualification, 'local-functional-only');
      assert.ok(report.workflow.samples >= 100);
      assert.equal(report.workflow.failures.length, 0);
      assert.equal(independence, 1);
      assert.ok(report.readiness.samples > 0);
      assert.deepEqual(report.readiness.minimumReady, { execution: 2, proxy: 2 });
      assert.equal(probes.background.length, 2);
      if (overlap) assert.deepEqual(report.outcomes.developerOverlap, { observed: true });
    } else {
      await assert.rejects(work);
      const report = JSON.parse(artifacts.get('runtime-ordinary-upgrade-report.json'));
      assert.equal(report.outcome, 'failed');
      assert.equal(rolls, 1);
      assert.equal(independence, 0);
      assert.ok(captures.includes('ordinary-upgrade-failure'));
      if (overlap) assert.deepEqual(developerCalls, ['adopt', 'roll', 'finish', 'close']);
      if (scenario === '502') {
        assert.ok(report.workflow.failedRequests.some((r) => r.error.status === 502));
        assert.ok(report.workflow.failedRequests.some((r) => r.http?.server === 'nginx' && r.http.format === 'html'));
        assert.ok(report.firstFailureDiagnosticsCaptured);
        assert.ok(!JSON.stringify(report).includes('<html>'));
      }
    }
    const ids = requests.filter((r) => r.method === 'POST').map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'no modifying request is replayed');
  });
}
