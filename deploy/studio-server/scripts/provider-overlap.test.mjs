import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse, parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import {
  overlapQualificationProfile,
  overlapProfileDigest,
  applyOverlapQualificationProfile,
} from './lib/qualification-overlap-profile.mjs';
import { assertOrdinaryRuntimeResources } from './lib/ha-release-evidence.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { rollWithHandoverInterruption, startProviderOverlapProbe } from './qualification/provider-overlap.mjs';
import { prepareOverlapBundle } from './qualification/overlap-bundle-fixture.mjs';
import { executeProviderPhase } from './qualification/provider-entry.mjs';
import { ReusableProviderGate } from './qualification/provider-gate.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

const profile = () => ({
  protocol: 1,
  maxConnections: 200,
  reservedConnections: 30,
  poolMaxPerApiPod: 9,
  backendResources: {
    requests: { cpu: '750m', memory: '1536Mi', 'ephemeral-storage': '256Mi' },
    limits: { memory: '3Gi', 'ephemeral-storage': '2Gi' },
  },
});

test('concrete provider rollout persists each journal before observing it and propagates observer failures', async () => {
  const manifest = promoteStudioServerReleaseManifest(
    createStudioServerReleaseManifest({
      rootDir: process.cwd(),
      source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'a'.repeat(40) },
      images: Object.fromEntries(
        ['api', 'executor', 'proxy', 'web'].map((name, i) => [
          name,
          {
            repository: `registry.test/${name}`,
            digest: `sha256:${String(i + 1).repeat(64)}`,
          },
        ]),
      ),
      candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    }),
    { promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 } },
  );
  const calls = [],
    failure = Error('housekeeping observation failed');
  const gate = Object.assign(Object.create(ReusableProviderGate.prototype), {
    operation: { previous: manifest, candidate: manifest },
    currentManifest: manifest,
    config: { namespace: 'isolated', release: 'fixture' },
    values: () => ({}),
    resources: async () => [],
    deploymentSafety: () => ({}),
    artifact: async (name, contents) => {
      calls.push(['persist', name, contents]);
    },
    runRollout: async (options) => {
      await options.artifact('ha-rollout.json', 'exact journal');
      return { phase: 'complete' };
    },
  });
  await gate.roll(manifest.images, true, {
    artifact: async (...args) => {
      calls.push(['observe', ...args]);
    },
  });
  assert.deepEqual(calls, [
    ['persist', 'ha-rollout.json', 'exact journal'],
    ['observe', 'ha-rollout.json', 'exact journal'],
  ]);
  const applied = [];
  const originalRollout = gate.runRollout;
  const values = {
    autoscaling: {
      execution: { enabled: false, minReplicas: 2, maxReplicas: 7 },
      executionController: { enabled: true, suspended: false, pollSeconds: 15 },
      proxy: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 75 },
    },
  };
  gate.values = () => values;
  gate.resources = async () => [
    { kind: 'Deployment', metadata: { labels: { 'app.kubernetes.io/component': 'autoscaler' } } },
    { kind: 'HorizontalPodAutoscaler', metadata: { labels: { 'app.kubernetes.io/component': 'proxy' } } },
  ];
  gate.apply = async (value) => applied.push(value);
  gate.runRollout = async (options) => {
    await options.applyTemplates([], { autoscaling: { proxy: { minReplicas: 4, scaleDownPaused: true } } });
    await options.restoreAutoscalers([], {});
    return { phase: 'complete' };
  };
  await gate.roll(manifest.images, true);
  assert.deepEqual(applied[0].autoscaling.proxy, {
    ...values.autoscaling.proxy,
    minReplicas: 4,
    scaleDownPaused: true,
  });
  assert.deepEqual(applied[0].autoscaling.executionController, values.autoscaling.executionController);
  assert.deepEqual(applied[1].autoscaling, values.autoscaling, 'The final apply restores the original HPA policy');
  gate.runRollout = originalRollout;
  await assert.rejects(
    gate.roll(manifest.images, true, {
      artifact: async () => {
        throw failure;
      },
    }),
    (e) => e === failure,
  );
  let observed = false;
  gate.artifact = async () => {
    throw failure;
  };
  await assert.rejects(
    gate.roll(manifest.images, true, {
      artifact: async () => {
        observed = true;
      },
    }),
    (e) => e === failure,
  );
  assert.equal(observed, false);
});

test('explicit overlap target retains seven workers/200 connections; actual Helm rejects the old ten-connection pool', () => {
  const original = {
    postgres: { maxConnections: 200, reservedConnections: 30, poolMaxPerApiPod: 10 },
    resources: {},
    autoscaling: { execution: { maxReplicas: 7 } },
  };
  const target = applyOverlapQualificationProfile(original, profile());
  assert.equal(original.postgres.poolMaxPerApiPod, 10);
  assert.equal(target.autoscaling.execution.maxReplicas, 7);
  assert.equal(target.postgres.maxConnections, 200);
  const canonical = overlapQualificationProfile(profile());
  assert.equal(overlapProfileDigest(canonical), overlapProfileDigest(profile()));
  for (const patch of [{ maxConnections: 250 }, { reservedConnections: 0 }])
    assert.throws(() => applyOverlapQualificationProfile(original, { ...profile(), ...patch }));
  const render = (pool) =>
    spawnSync(
      resolveHelmBinOrThrow(process.cwd()),
      [
        'template',
        'rivet',
        'deploy/studio-server/helm',
        '-n',
        'fixture',
        '-f',
        'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
        '-f',
        'deploy/studio-server/helm/overlays/gke-ha.yaml',
        '-f',
        'deploy/studio-server/helm/overlays/gke-runtime-ha.yaml',
        '-f',
        'deploy/studio-server/helm/overlays/gke-compact-edge.yaml',
        '-f',
        'deploy/studio-server/helm/overlays/gke-runtime-autoscaling.yaml',
        '-f',
        '-',
        '--set',
        'objectStorage.bucket=fixture,ha.controlPlane.mode=singleton-overlap,ha.namespaceUid=f70a25bb-0c5f-44e4-9da4-3b347f87331d',
      ],
      {
        input: JSON.stringify({ ...target, postgres: { ...target.postgres, poolMaxPerApiPod: pool } }),
        encoding: 'utf8',
        windowsHide: true,
      },
    );
  const blocked = render(10);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /requires 201 connections/);
  const passed = render(9);
  assert.equal(passed.status, 0, passed.stderr);
  const resources = parseAllDocuments(passed.stdout)
    .map((d) => d.toJS())
    .filter(Boolean);
  const controller = resources.find(
    (r) => r.metadata?.labels?.['app.kubernetes.io/component'] === 'autoscaler' && r.kind === 'Deployment',
  );
  const policy = JSON.parse(
    controller.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
  ).policy;
  const proof = {
    protocol: 3,
    autoscalerPolicyDigest: autoscalerPolicyDigest(policy),
    developerOverlap: { profile: canonical },
  };
  assert.doesNotThrow(() => assertOrdinaryRuntimeResources(proof, resources));
  const backend = resources.find(
    (r) => r.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'backend',
  );
  assert.equal(backend.spec.replicas, 1);
  assert.equal(backend.spec.template.spec.containers[0].resources.requests.cpu, '750m');
  backend.spec.template.spec.containers[0].resources.requests.memory = '1Gi';
  assert.throws(() => assertOrdinaryRuntimeResources(proof, resources), /qualified sizing/);
});

test('accepted handover acknowledgement loss recovers the same token once; unrelated failures never retry', async () => {
  let attempts = 0,
    acquires = 0;
  const gate = {
    journalName: 'exact-journal',
    artifact: async () => {},
    kube: async (args) => {
      if (args[0] === 'exec') {
        acquires++;
        return {
          stdout: JSON.stringify({
            incarnation: 'inc',
            housekeeping: { state: 'owner', podUid: 'target', operationId: 'same-token', incarnation: 'inc' },
          }),
        };
      }
      assert.deepEqual(args, ['get', 'configmap', 'exact-journal', '-o', 'json']);
      return {
        stdout: JSON.stringify({
          data: {
            record: JSON.stringify({
              token: 'same-token',
              phase: 'paused',
              leaseExpiresAt: 0,
              owner: { housekeeping: { acquireIssued: true, targetUid: 'target', targetIncarnation: 'inc' } },
            }),
          },
        }),
      };
    },
    roll: async (_images, _singleton, options) => {
      attempts++;
      if (attempts === 1) return options.kube(['exec', 'backend-1', '--housekeeping-acquire']);
      assert.equal(options.resumeToken, 'same-token');
      return { token: options.resumeToken, phase: 'complete' };
    },
  };
  const wait = async (_label, check) => {
    const result = await check();
    assert.ok(result);
    return result;
  };
  assert.equal((await rollWithHandoverInterruption(gate, {}, {}, { wait })).phase, 'complete');
  assert.equal(attempts, 2);
  assert.equal(acquires, 1);
  const originalKube = gate.kube;
  for (const patch of [
    (r) => {
      r.token = 'foreign';
    },
    (r) => {
      r.owner.housekeeping.targetUid = 'replacement';
    },
    (r) => {
      r.owner.housekeeping.targetIncarnation = 'restarted';
    },
  ]) {
    attempts = 0;
    const changed = {
      ...gate,
      kube: async (args, options) => {
        const result = await originalKube(args, options);
        if (args[0] === 'get') {
          const object = JSON.parse(result.stdout),
            record = JSON.parse(object.data.record);
          patch(record);
          object.data.record = JSON.stringify(record);
          return { stdout: JSON.stringify(object) };
        }
        return result;
      },
    };
    await assert.rejects(rollWithHandoverInterruption(changed, {}, {}, { wait }));
    assert.equal(attempts, 1, 'Foreign recovery authority must not start a second rollout');
  }
  const failure = Error('unrelated timeout');
  gate.roll = async () => {
    throw failure;
  };
  await assert.rejects(rollWithHandoverInterruption(gate, {}, {}, { wait }), (error) => error === failure);
  await assert.rejects(
    rollWithHandoverInterruption({ ...gate, roll: async () => ({ phase: 'complete' }) }, {}, {}, { wait }),
    /did not exercise/,
  );
});

test('invalid capacity is rejected before janitor arming or cloud calls', async () => {
  const calls = [];
  await assert.rejects(
    executeProviderPhase({
      phase: 'armExpiry',
      operation: { developerOverlapProfile: profile() },
      gate: {
        verifyOverlapCapacity: async () => {
          throw Error('capacity rejected');
        },
      },
      cloud: { project: async () => calls.push('cloud') },
      state: { arm: async () => calls.push('arm') },
    }),
    /capacity rejected/,
  );
  assert.deepEqual(calls, []);
});

test('bundle observer fixture uses final saved IDs and guarded non-retrying writes', async () => {
  const calls = [],
    ids = ['a'.repeat(8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b'.repeat(8) + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const folderId = 'c'.repeat(8) + '-cccc-4ccc-8ccc-cccccccccccc';
  const gate = {
    config: { baseUrl: 'https://isolated.test' },
    requestWorkflow: async (_base, route, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ route, body, headers: options?.headers });
      if (route.endsWith('/folders')) return { folder: { namespaceId: folderId, relativePath: 'new' } };
      if (route.endsWith('/upload'))
        return {
          project: {
            id: ids[calls.filter((c) => c.route.endsWith('/upload')).length - 1],
            relativePath: 'new/root.rivet-project',
          },
        };
      if (route.endsWith('/kind')) return { folder: { bundleId: 'new-bundle' } };
      return { projectId: ids[1], draftRevisionId: 'revision', publicationVersion: 'version' };
    },
  };
  const template =
    'data:\n  metadata: { id: original, mainGraphId: main }\n  graphs:\n    main: { metadata: { id: main }, nodes: {} }\n';
  const result = await prepareOverlapBundle(gate, template);
  assert.deepEqual(result.projectIds, [ids[1], ids[0]]);
  const uploads = calls.filter((c) => c.route.endsWith('/upload'));
  assert.equal(uploads.length, 2);
  const root = parse(uploads[1].body.contents);
  assert.equal(root.data.graphs.main.nodes['[child]:subGraph "Child"'].data.targetProjectId, ids[0]);
  assert.ok(uploads.every((c) => c.body.mutation.expectedDestinationId === folderId));
  // Exercise the concrete observer/roll adapter with exact UID/node/claim status
  // stand-ins as well, not only preconstructed publication facts.
  const pod = (name, uid) => ({
    metadata: { name, uid, labels: { 'app.kubernetes.io/component': 'backend' } },
    spec: {
      nodeName: 'same-node',
      volumes: [{ name: 'legacy-restore', persistentVolumeClaim: { claimName: 'restore' } }],
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  });
  const old = pod('fixture-ha-backend-0', 'old'),
    temporary = pod('fixture-ha-backend-1', 'temporary'),
    replacement = pod('fixture-ha-backend-0', 'new');
  let current = [old],
    rolls = 0,
    stopped = false,
    closed = false;
  const states = new Map();
  const set = (p, state, housekeeping) =>
    states.set(p.metadata.name, {
      state,
      incarnation: p.metadata.uid,
      housekeeping: {
        state: housekeeping,
        protocol: 1,
        podUid: p.metadata.uid,
        incarnation: p.metadata.uid,
        operationId: 'same-token',
      },
    });
  set(old, 'draining', 'owner');
  const wait = async (_label, check) => {
    const value = await check();
    assert.ok(value);
    return value;
  };
  Object.assign(gate.config, { namespace: 'isolated', release: 'fixture' });
  Object.assign(gate, {
    operation: { developerOverlapProfile: profile() },
    journalName: 'journal',
    pods: async () => current,
    artifact: async () => {},
    verifyDeveloperAcceptance: async () => {},
    kube: async (args) => {
      let value;
      if (args[0] === 'exec') value = states.get(args[1]);
      else if (args[1] === 'pod') value = current.find((p) => p.metadata.name === args[2]);
      else if (args[1] === 'pvc')
        value = {
          metadata: { uid: 'claim' },
          status: { phase: 'Bound' },
          spec: { volumeName: 'volume', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '8Gi' } } },
        };
      else if (args[1] === 'pv')
        value = {
          metadata: { uid: 'volume-uid', name: 'volume' },
          spec: { claimRef: { uid: 'claim', namespace: 'isolated' } },
        };
      else
        value = {
          data: {
            record: JSON.stringify({
              phase: 'paused',
              token: 'same-token',
              leaseExpiresAt: 0,
              owner: { housekeeping: { acquireIssued: true, targetUid: 'temporary', targetIncarnation: 'temporary' } },
            }),
          },
        };
      return { stdout: JSON.stringify(value) };
    },
    roll: async (_images, _singleton, callbacks) => {
      current = [old, temporary];
      set(old, 'draining', 'released');
      set(temporary, 'serving', 'owner');
      if (++rolls === 1) return callbacks.kube(['exec', temporary.metadata.name, '--housekeeping-acquire']);
      assert.equal(callbacks.resumeToken, 'same-token');
      const transfer = async (source, target) =>
        callbacks.artifact(
          'ha-rollout.json',
          JSON.stringify({
            token: 'same-token',
            owner: {
              housekeeping: {
                complete: true,
                sourceUid: source.metadata.uid,
                targetUid: target.metadata.uid,
                sourceIncarnation: source.metadata.uid,
                targetIncarnation: target.metadata.uid,
              },
            },
          }),
        );
      await callbacks.verifyDeveloperReady({
        name: temporary.metadata.name,
        uid: 'temporary',
        incarnation: 'temporary',
      });
      await transfer(old, temporary);
      await callbacks.beforeRetirement({ name: old.metadata.name, uid: 'old' });
      current = [replacement, temporary];
      set(replacement, 'serving', 'owner');
      set(temporary, 'draining', 'released');
      await transfer(temporary, replacement);
      await callbacks.beforeRetirement({ name: temporary.metadata.name, uid: 'temporary' });
      current = [replacement];
      return { phase: 'complete', token: 'same-token' };
    },
  });
  const probes = {
    template,
    editors: [],
    startEditor: async (p) =>
      probes.editors.push({ uid: p.uid, error: null, receipt: { phase: 'passed' }, completed: Promise.resolve() }),
  };
  calls.length = 0;
  const observer = await startProviderOverlapProbe(
    gate,
    probes,
    { images: { web: 'old' } },
    { images: { web: 'new' } },
    {
      wait,
      startTraffic: () => ({
        report: { samples: 100, failures: [] },
        stop: async () => {
          stopped = true;
        },
      }),
      startBrowser: async () => ({
        resumeAfterFrontendReplacement: async () => {},
        finish: async (_before, options) => {
          assert.equal(options.frontendReplacement, true);
          return { passed: true };
        },
        close: async () => {
          closed = true;
        },
      }),
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await observer.roll({ beforeRetirement: async () => {} });
    const observed = await observer.finish();
    assert.equal(observed.handoverCount, 2);
    assert.equal(observed.editorRuns.length, 2);
    assert.equal(observed.finalOwnerCount, 1);
    assert.deepEqual(observed.maintenanceClaim.after, observed.maintenanceClaim.before);
  } finally {
    await observer.close();
  }
  assert.equal(stopped && closed, true);
  const failure = Error('accepted upload response lost');
  let writes = 0;
  gate.requestWorkflow = async () => {
    writes++;
    throw failure;
  };
  await assert.rejects(prepareOverlapBundle(gate, template), (e) => e === failure);
  assert.equal(writes, 1);
});

test('per-backend acceptance requires the exact UID and process incarnation, not a health-only acknowledgement', async () => {
  const pod = { name: 'backend-1', uid: 'expected-uid', incarnation: 'expected-incarnation' };
  for (const changed of [
    {},
    { podUid: 'other' },
    { incarnation: 'old' },
    { editorSession: false },
    { developerApi: false },
  ]) {
    const gate = {
      kube: async (args) => {
        assert.deepEqual(args.slice(-2), [pod.uid, pod.incarnation]);
        return {
          stdout: JSON.stringify({
            podUid: pod.uid,
            incarnation: pod.incarnation,
            editorSession: true,
            developerApi: true,
            ...changed,
          }),
        };
      },
    };
    const check = ReusableProviderGate.prototype.verifyDeveloperAcceptance.call(gate, pod);
    if (Object.keys(changed).length) await assert.rejects(check);
    else assert.equal((await check).editorSession, true);
  }
});

test('provider managed-fixture command rejects mutable images before any Docker setup', () => {
  const result = spawnSync(
    process.execPath,
    ['deploy/studio-server/scripts/verify-housekeeping-managed.mjs', '--provider-fixture'],
    {
      env: { ...process.env, RIVET_HOUSEKEEPING_TEST_IMAGE: 'unreviewed:latest' },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit immutable cached API image/);
});
