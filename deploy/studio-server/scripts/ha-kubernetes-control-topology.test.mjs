import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { runHaKubernetesControlTopology, matchesTopologyTemplate } from './lib/ha-kubernetes-control-topology.mjs';
import { hasSameHaOwnerIdentity } from './lib/ha-kubernetes-rollout.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const component = (r) => r.metadata?.labels?.['app.kubernetes.io/component'];
function render(singleton, compact = false) {
  return parseAllDocuments(
    execFileSync(
      resolveHelmBinOrThrow(root),
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
        ...(singleton ? ['-f', 'deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'] : []),
        ...(compact ? ['-f', 'deploy/studio-server/helm/overlays/gke-compact-edge.yaml'] : []),
        '--set',
        'objectStorage.bucket=fixture',
        '--set',
        'postgres.maxConnections=250',
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  )
    .map((d) => {
      assert.equal(d.errors.length, 0);
      return d.toJS();
    })
    .filter(Boolean);
}
function fixture(from = false, compact = false) {
  const resources = render(!from, compact),
    live = render(from, compact),
    pods = new Map(),
    states = new Map(),
    commands = [];
  let journal,
    revision = 0;
  for (const r of live) {
    r.metadata.uid = randomUUID();
    r.metadata.resourceVersion = String(++revision);
    r.metadata.generation = 1;
    if (r.spec?.template?.metadata.annotations === null) delete r.spec.template.metadata.annotations;
  }
  const createPods = (r) => {
    for (let i = 0; i < r.spec.replicas; i++) {
      const name = r.kind === 'StatefulSet' ? `${r.metadata.name}-${i}` : `${r.metadata.name}-fixture-${i}`;
      if (pods.has(name)) continue;
      const p = {
        metadata: {
          name,
          uid: randomUUID(),
          labels: r.spec.template.metadata.labels,
          ownerReferences: [{ uid: r.metadata.uid }],
        },
        spec: r.spec.template.spec,
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      pods.set(name, p);
      states.set(name, { protocol: 1, withdrawalProtocol: 1, incarnation: randomUUID(), state: 'serving' });
    }
    r.status = {
      readyReplicas: r.spec.replicas,
      availableReplicas: r.spec.replicas,
      observedGeneration: r.metadata.generation,
    };
  };
  for (const r of live.filter((r) => ['StatefulSet', 'Deployment'].includes(r.kind))) createPods(r);
  const claim = live.find((r) => r.kind === 'PersistentVolumeClaim' && r.metadata.name.endsWith('legacy-restore'));
  claim.spec.volumeName = 'fixture-disk';
  const volume = {
    metadata: { name: 'fixture-disk', uid: randomUUID() },
    spec: { claimRef: { uid: claim.metadata.uid } },
  };
  const runtimeUids = [...pods.values()].filter((p) => component(p) === 'execution').map((p) => p.metadata.uid);
  const options = {
    release: 'rivet',
    namespace: 'fixture',
    manifestDigest: 'same-bridge',
    resources,
    timeoutMs: 5,
    kube: async (args, extra = {}) => {
      commands.push(args.join(' '));
      const respond = (value) => ({ stdout: JSON.stringify(value) });
      if (args[0] === 'get') {
        const kind = args[1],
          name = args[2];
        if (kind === 'configmap') return journal ? respond(journal) : { stdout: '' };
        if (kind === 'pvc') {
          assert.equal(name, claim.metadata.name);
          return respond(claim);
        }
        if (kind === 'pv') {
          assert.equal(name, volume.metadata.name);
          return respond(volume);
        }
        if (kind === 'volumeattachments')
          return respond({
            items: options.attached
              ? [{ spec: { source: { persistentVolumeName: volume.metadata.name } }, status: { attached: true } }]
              : [],
          });
        if (kind === 'pod') return pods.has(name) ? respond(pods.get(name)) : { stdout: '' };
        if (kind === 'pods') return respond({ items: [...pods.values()] });
        if (kind === 'endpointslice') return respond({ items: [] });
        const normalized = { statefulset: 'StatefulSet', service: 'Service', deployment: 'Deployment' }[kind];
        if (name && !name.startsWith('-'))
          return respond(live.find((r) => r.kind === normalized && r.metadata.name === name));
        return respond({ items: live.filter((r) => r.kind === normalized) });
      }
      if (['create', 'replace'].includes(args[0])) {
        const cm = JSON.parse(extra.input);
        assert.equal(cm.metadata.resourceVersion, journal?.metadata.resourceVersion);
        cm.metadata.resourceVersion = String(++revision);
        journal = cm;
        return respond(cm);
      }
      if (args[0] === 'exec') {
        const p = pods.get(args[1]);
        assert.ok(p);
        if (args.includes('wget')) return respond({ ok: !options.edgeUnhealthy, profile: 'execution' });
        if (args.includes('--input-type=module'))
          return respond({
            protocol: options.missingBridge ? 0 : 1,
            executionOwnedProxySettings: component(p) === 'execution',
            scheduledRunScope:
              component(p) === 'execution' ? 'published' : component(p) === 'backend' ? 'latest' : null,
          });
        const state = states.get(args[1]);
        if (args.includes('--withdraw-only') || args.includes('--begin-only')) {
          assert.equal(args.at(-2), state.incarnation);
          Object.assign(state, {
            operationId: args.at(-3),
            state: args.includes('--begin-only') ? 'drained' : 'withdrawing',
          });
        }
        return respond(state);
      }
      if (args[0] === 'patch') {
        const w = live.find((r) => r.kind === 'Deployment' && r.metadata.name === args[2]);
        assert.equal(component(w), 'proxy');
        const patch = JSON.parse(args.at(-1));
        assert.deepEqual(patch[0], { op: 'test', path: '/metadata/uid', value: w.metadata.uid });
        assert.deepEqual(patch[1], {
          op: 'test',
          path: '/metadata/resourceVersion',
          value: w.metadata.resourceVersion,
        });
        w.spec.template = structuredClone(patch.at(-1).value);
        for (const [name, p] of pods) if (component(p) === 'proxy') pods.delete(name);
        createPods(w);
        if (options.edgeControllerStale) w.status.observedGeneration = 0;
        if (options.edgeNegUnready)
          for (const p of pods.values())
            if (component(p) === 'proxy') {
              p.spec.readinessGates = [{ conditionType: 'cloud.google.com/load-balancer-neg-ready' }];
              p.status.conditions.push({
                type: 'cloud.google.com/load-balancer-neg-ready',
                status: 'True',
                reason: 'LoadBalancerNegWithoutHealthCheck',
              });
            }
        return { stdout: '' };
      }
      if (args[0] === 'scale') {
        const w = live.find((r) => r.kind === 'StatefulSet' && `statefulset/${r.metadata.name}` === args[1]);
        assert.ok(['backend', 'maintenance'].includes(component(w)));
        assert.ok(args.includes(`--resource-version=${w.metadata.resourceVersion}`));
        for (const [name, p] of pods)
          if (p.metadata.ownerReferences[0].uid === w.metadata.uid) {
            assert.equal(states.get(name).state, 'drained');
            pods.delete(name);
          }
        w.spec.replicas = 0;
        w.metadata.resourceVersion = String(++revision);
        return { stdout: '' };
      }
      if (args[0] === 'delete') {
        assert.ok(args[2].includes('/statefulsets/'));
        const name = args[2].split('/').at(-1),
          w = live.find((r) => r.kind === 'StatefulSet' && r.metadata.name === name);
        const deletion = JSON.parse(extra.input);
        assert.equal(deletion.preconditions.uid, w.metadata.uid);
        assert.equal(deletion.preconditions.resourceVersion, w.metadata.resourceVersion);
        assert.equal(component(w), 'maintenance');
        assert.equal(w.spec.replicas, 0);
        live.splice(live.indexOf(w), 1);
        return { stdout: '' };
      }
      throw Error(`Unexpected fixture command ${args.join(' ')}`);
    },
    applyTemplates: async (values) => {
      assert.equal(values.workflowSchema.migrationJob.enabled, false);
      assert.ok(values.ha.rolloutResourceVersions);
      assert.equal([...pods.values()].filter((p) => ['backend', 'maintenance'].includes(component(p))).length, 0);
      for (const t of resources) {
        const index = live.findIndex((r) => r.kind === t.kind && r.metadata.name === t.metadata.name),
          old = live[index];
        const copy = structuredClone(t);
        if (copy.spec?.template?.metadata.annotations === null) delete copy.spec.template.metadata.annotations;
        copy.metadata.uid = old?.metadata.uid ?? randomUUID();
        copy.metadata.resourceVersion = String(++revision);
        if (index < 0) live.push(copy);
        else live[index] = copy;
        if (['StatefulSet', 'Deployment'].includes(copy.kind)) {
          for (const [name, p] of pods)
            if (copy.kind === 'Deployment' && component(p) === component(copy)) pods.delete(name);
          createPods(copy);
        }
      }
      for (const t of resources.filter((r) => r.kind === 'StatefulSet')) {
        const l = live.find((r) => r.kind === t.kind && r.metadata.name === t.metadata.name);
        assert.equal(hasSameHaOwnerIdentity(l.spec.template, t.spec.template), true, `identity ${t.metadata.name}`);
        assert.deepEqual(l.spec.template, t.spec.template);
        assert.equal(matchesTopologyTemplate(l.spec.template, t.spec.template), true, `template ${t.metadata.name}`);
      }
    },
  };
  return {
    options,
    commands,
    pods,
    runtimeUids,
    claim,
    volume,
    live,
    expireLease() {
      const record = JSON.parse(journal.data.record);
      record.leaseExpiresAt = 0;
      journal.data.record = JSON.stringify(record);
      return record.token;
    },
  };
}

for (const reverse of [false, true])
  for (const failure of ['template-ack', 'verification'])
    test(`${reverse ? 'reverse' : 'forward'} transfer resumes after lost ${failure} without replaying Helm`, async () => {
      const f = fixture(reverse);
      const apply = f.options.applyTemplates;
      let applications = 0;
      f.options.applyTemplates = async (...args) => {
        applications++;
        await apply(...args);
        if (failure === 'template-ack') throw new Error('lost template acknowledgement');
      };
      f.options.artifact = async (name) => {
        if (failure === 'verification' && name === 'ha-control-topology-verified.json')
          throw new Error('lost verification acknowledgement');
      };
      await assert.rejects(runHaKubernetesControlTopology(f.options), /lost .*acknowledgement/);
      const resumeToken = f.expireLease();
      f.options.artifact = async () => {};
      f.commands.length = 0;
      assert.equal((await runHaKubernetesControlTopology({ ...f.options, resumeToken })).phase, 'complete');
      assert.equal(applications, 1);
      assert.ok(!f.commands.some((c) => /^(patch|scale|delete) |--withdraw-only|--begin-only/.test(c)));
    });

for (const reverse of [false, true])
  test(`${reverse ? 'reverse' : 'forward'} recovery refuses a recreated backend controller after Helm`, async () => {
    const f = fixture(reverse);
    const apply = f.options.applyTemplates;
    f.options.applyTemplates = async (...args) => {
      await apply(...args);
      throw new Error('lost template acknowledgement');
    };
    await assert.rejects(runHaKubernetesControlTopology(f.options), /lost template acknowledgement/);
    const backend = f.live.find((r) => r.kind === 'StatefulSet' && component(r) === 'backend');
    const oldUid = backend.metadata.uid;
    backend.metadata.uid = randomUUID();
    for (const p of f.pods.values())
      if (p.metadata.ownerReferences.some((o) => o.uid === oldUid))
        p.metadata.ownerReferences = [{ uid: backend.metadata.uid }];
    const resumeToken = f.expireLease();
    f.commands.length = 0;
    await assert.rejects(runHaKubernetesControlTopology({ ...f.options, resumeToken }), /outcome unknown|UID changed/);
    assert.ok(!f.commands.some((c) => /^(patch|scale|delete) |--withdraw-only|--begin-only/.test(c)));
  });

test('reverse owner-phase recovery still requires execution health after the edge-prepared checkpoint', async () => {
  const f = fixture(true);
  const kube = f.options.kube;
  f.options.kube = async (args, options) => {
    if (args.includes('--withdraw-only')) throw new Error('withdrawal unavailable');
    return kube(args, options);
  };
  await assert.rejects(runHaKubernetesControlTopology(f.options), /withdrawal unavailable/);
  const proxy = f.live.find((r) => r.kind === 'Deployment' && component(r) === 'proxy');
  proxy.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_PROXY_HEALTH_OWNER').value = 'control';
  const resumeToken = f.expireLease();
  f.commands.length = 0;
  await assert.rejects(runHaKubernetesControlTopology({ ...f.options, resumeToken }), /execution-owned proxy health/);
  assert.ok(!f.commands.some((c) => /^(create|replace|patch|scale|delete|exec) /.test(c)));
});

for (const reverse of [false, true])
  test(`Kubernetes ${reverse ? 'reverse' : 'forward'} adapter preserves runtime, PVC/PV and UID/RV fences`, async () => {
    const f = fixture(reverse),
      claim = f.claim.metadata.uid,
      volume = f.volume.metadata.uid;
    const result = await runHaKubernetesControlTopology(f.options);
    assert.equal(result.phase, 'complete');
    assert.equal(f.claim.metadata.uid, claim);
    assert.equal(f.volume.metadata.uid, volume);
    assert.deepEqual(
      [...f.pods.values()].filter((p) => component(p) === 'execution').map((p) => p.metadata.uid),
      f.runtimeUids,
    );
    assert.ok(f.commands.every((c) => !/get secret|scale statefulset\/.*execution|delete.*persistentvolume/.test(c)));
  });

for (const reverse of [false, true])
  test(`compact edge ${reverse ? 'reverse' : 'forward'} transfer retains both proxies and execution owners`, async () => {
    const f = fixture(reverse, true);
    assert.equal((await runHaKubernetesControlTopology(f.options)).phase, 'complete');
    assert.equal([...f.pods.values()].filter((p) => component(p) === 'proxy').length, 2);
    assert.deepEqual(
      [...f.pods.values()].filter((p) => component(p) === 'execution').map((p) => p.metadata.uid),
      f.runtimeUids,
    );
  });

test('edge capacity cannot be reduced inside a maintenance ownership transfer', async () => {
  const f = fixture();
  f.options.resources = render(true, true);
  await assert.rejects(runHaKubernetesControlTopology(f.options), /change edge capacity separately/);
  assert.ok(!f.commands.some((c) => /^(create|replace|patch|scale|delete) /.test(c)));
});

test('Kubernetes transfer refuses a missing bridge or attached disk before starting the new owner', async () => {
  for (const fault of ['missingBridge', 'attached']) {
    const f = fixture();
    f.options[fault] = true;
    const apply = f.options.applyTemplates;
    let applied = false;
    f.options.applyTemplates = async (...args) => {
      applied = true;
      await apply(...args);
    };
    await assert.rejects(
      runHaKubernetesControlTopology(f.options),
      fault === 'missingBridge' ? /contract/ : /still owned\/attached/,
    );
    assert.equal(applied, false);
    if (fault === 'missingBridge') assert.ok(!f.commands.some((c) => c.startsWith('scale')));
  }
});

test('missing volume-attachment read permission fails before changing the edge or developer owners', async () => {
  const f = fixture();
  const kube = f.options.kube;
  f.options.kube = async (args, options) => {
    if (args[0] === 'get' && args[1] === 'volumeattachments') throw new Error('volumeattachments: Forbidden');
    return kube(args, options);
  };
  await assert.rejects(runHaKubernetesControlTopology(f.options), /volumeattachments: Forbidden/);
  assert.ok(!f.commands.some((c) => /patch deployment|--withdraw-only|scale statefulset/.test(c)));
});

test('a foreign developer pod cannot be retired merely because its name and release labels match', async () => {
  const f = fixture();
  const kube = f.options.kube;
  let changed = false;
  f.options.kube = async (args, options) => {
    // The source is valid at preflight, but a same-name pod changes ownership
    // after the edge handoff and before the first retirement command.
    if (args[0] === 'patch') {
      const result = await kube(args, options);
      const p = [...f.pods.values()].find((p) => component(p) === 'backend' && p.metadata.name.endsWith('-1'));
      p.metadata.ownerReferences = [{ uid: randomUUID() }];
      changed = true;
      return result;
    }
    return kube(args, options);
  };
  await assert.rejects(runHaKubernetesControlTopology(f.options), /developer pod ownership/);
  assert.equal(changed, true);
  assert.ok(!f.commands.some((c) => /--withdraw-only|--begin-only|scale statefulset/.test(c)));
});

test('missing or foreign source developers fail preflight without mutating the release', async () => {
  for (const fault of ['missing', 'owner', 'role']) {
    const f = fixture();
    const p = [...f.pods.values()].find((p) => component(p) === 'maintenance');
    if (fault === 'missing') f.pods.delete(p.metadata.name);
    if (fault === 'owner') p.metadata.ownerReferences = [];
    if (fault === 'role') p.metadata.labels = { ...p.metadata.labels, 'app.kubernetes.io/component': 'backend' };
    await assert.rejects(runHaKubernetesControlTopology(f.options), /developer.*ownership|missing or not ready/);
    assert.ok(!f.commands.some((c) => /^(create|replace|patch|scale|delete) |--withdraw-only|--begin-only/.test(c)));
  }
});

test('template acknowledgement preserves repeated volume mounts and ordered commands', () => {
  assert.equal(matchesTopologyTemplate({ metadata: {} }, { metadata: { annotations: {} } }), true);
  assert.equal(matchesTopologyTemplate({ metadata: {} }, { metadata: { annotations: null } }), true);
  assert.equal(
    matchesTopologyTemplate({ metadata: { annotations: { owner: 'active' } } }, { metadata: { annotations: null } }),
    false,
  );
  assert.equal(matchesTopologyTemplate({ metadata: {} }, { metadata: { annotations: { owner: 'required' } } }), false);
  const mounts = [
    { name: 'app-data', mountPath: '/data' },
    { name: 'app-data', mountPath: '/home' },
  ];
  assert.equal(matchesTopologyTemplate(mounts, structuredClone(mounts)), true);
  assert.equal(matchesTopologyTemplate(mounts.slice(0, 1), mounts), false);
  assert.equal(matchesTopologyTemplate(['node', 'main.js'], ['main.js', 'node']), false);
  assert.equal(
    matchesTopologyTemplate(
      { valueFrom: { secretKeyRef: { name: 'foreign', key: 'key' } } },
      { valueFrom: { secretKeyRef: { name: 'expected', key: 'key' } } },
    ),
    false,
  );
});

test('missing/stale execution readiness and storage changes block transfer before withdrawing developers', async () => {
  for (const fault of ['missing-status', 'stale-status', 'storage-change']) {
    const f = fixture();
    if (fault === 'missing-status')
      f.live.find((r) => r.kind === 'StatefulSet' && component(r) === 'execution').status = {};
    if (fault === 'stale-status') {
      const p = [...f.pods.values()].find((p) => component(p) === 'execution');
      p.status.conditions[0].status = 'False';
    }
    if (fault === 'storage-change')
      f.options.resources.find(
        (r) => r.kind === 'PersistentVolumeClaim' && r.metadata.name.endsWith('legacy-restore'),
      ).spec.resources.requests.storage = '9Gi';
    await assert.rejects(runHaKubernetesControlTopology(f.options), /execution|ready|storage configuration/);
    assert.ok(!f.commands.some((c) => /scale|--withdraw-only/.test(c)));
  }
});

test('unknown secret-derived control mode is rejected without reading the secret or changing owners', async () => {
  const f = fixture();
  const backend = f.live.find((r) => r.kind === 'StatefulSet' && component(r) === 'backend');
  const mode = backend.spec.template.spec.containers
    .find((c) => c.name === 'backend')
    .env.find((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE');
  delete mode.value;
  mode.valueFrom = { secretKeyRef: { name: 'unknown-mode', key: 'mode' } };
  await assert.rejects(runHaKubernetesControlTopology(f.options), /deployment-owned literal/);
  assert.ok(!f.commands.some((c) => /get secret|patch|scale|--withdraw-only/.test(c)));
});

test('terminating restore storage cannot lose its remaining mount through topology transfer', async () => {
  for (const resource of ['claim', 'volume']) {
    const f = fixture();
    f[resource].metadata.deletionTimestamp = new Date().toISOString();
    await assert.rejects(runHaKubernetesControlTopology(f.options), /Restore claim|Restore volume/);
    assert.ok(!f.commands.some((c) => /patch|scale|--withdraw-only/.test(c)));
  }
});

test('node-local RWO storage requires the same single hostname in every PV affinity alternative', async () => {
  for (const hosts of [[], [null], ['host-a', null], ['host-a', 'host-b'], ['host-a', 'host-a']]) {
    const f = fixture();
    f.volume.spec.hostPath = { path: '/owned-fixture' };
    f.volume.spec.nodeAffinity = {
      required: {
        nodeSelectorTerms: hosts.map((host) => ({
          matchExpressions: host ? [{ key: 'kubernetes.io/hostname', operator: 'In', values: [host] }] : [],
        })),
      },
    };
    if (hosts.length && hosts.every((h) => h === 'host-a')) {
      assert.equal((await runHaKubernetesControlTopology(f.options)).phase, 'complete');
    } else {
      await assert.rejects(runHaKubernetesControlTopology(f.options), /single-host PV affinity/);
      assert.ok(!f.commands.some((c) => /scale|--withdraw-only/.test(c)));
    }
  }
});

test('a same-UID PV source or affinity change during handoff cannot start the new owner', async () => {
  for (const fault of ['source', 'affinity']) {
    const f = fixture();
    const kube = f.options.kube;
    let reads = 0,
      applied = false;
    f.options.kube = async (args, options) => {
      if (args[0] === 'get' && args[1] === 'pv' && ++reads === 3) {
        if (fault === 'source') f.volume.spec.csi = { driver: 'other', volumeHandle: 'changed' };
        else f.volume.spec.nodeAffinity = { required: { nodeSelectorTerms: [] } };
      }
      return kube(args, options);
    };
    f.options.applyTemplates = async () => {
      applied = true;
    };
    await assert.rejects(runHaKubernetesControlTopology(f.options), /PV identity changed/);
    assert.equal(applied, false);
  }
});

for (const fault of ['edgeUnhealthy', 'edgeControllerStale', 'edgeNegUnready'])
  test(`forward transfer refuses ${fault} before any developer withdrawal`, async () => {
    const f = fixture();
    f.options[fault] = true;
    await assert.rejects(runHaKubernetesControlTopology(f.options), /Execution-owned proxy health/);
    assert.ok(f.commands.some((c) => c.startsWith('patch deployment')));
    assert.ok(!f.commands.some((c) => /--withdraw-only|scale statefulset/.test(c)));
  });
