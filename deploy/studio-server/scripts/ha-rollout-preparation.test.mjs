import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { prepareHaReplacements, rolloutPreparationJobs } from './lib/ha-rollout-preparation.mjs';
import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
import { podResourceRequest } from './lib/pod-resource-requests.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';

const token = '11111111-1111-4111-8111-111111111111',
  namespace = 'fixture',
  release = 'fixture';
const resource = (role) => ({
  kind: role === 'execution' ? 'StatefulSet' : 'Deployment',
  metadata: {
    name: `fixture-${role}`,
    labels: { 'app.kubernetes.io/instance': release, 'app.kubernetes.io/component': role },
  },
  spec: {
    selector: { matchLabels: { 'app.kubernetes.io/component': role } },
    template: {
      metadata: {
        labels: {
          'app.kubernetes.io/name': 'rivet',
          'app.kubernetes.io/instance': release,
          'app.kubernetes.io/component': role,
        },
        annotations: { 'vault.hashicorp.com/agent-inject': 'true' },
      },
      spec: {
        containers: [
          {
            name: role,
            image: `registry/${role}@sha256:${'a'.repeat(64)}`,
            env: [{ name: 'PRIVATE', value: 'must-not-copy' }],
            volumeMounts: [{ name: 'saved-data', mountPath: '/data' }],
            resources: { requests: { cpu: '500m', memory: '128Mi' } },
          },
        ],
        volumes: [{ name: 'saved-data', persistentVolumeClaim: { claimName: 'production' } }],
        imagePullSecrets: [{ name: 'registry-only' }],
        topologySpreadConstraints: [
          {
            topologyKey: 'topology.kubernetes.io/zone',
            maxSkew: 1,
            whenUnsatisfiable: 'DoNotSchedule',
            labelSelector: { matchLabels: { 'app.kubernetes.io/component': role } },
          },
        ],
        affinity: {
          podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              {
                topologyKey: 'kubernetes.io/hostname',
                labelSelector: { matchLabels: { 'app.kubernetes.io/component': role } },
              },
            ],
          },
        },
      },
    },
  },
});
const resources = [resource('proxy'), resource('web'), resource('execution')];

async function fixture(t, fault, selectedResources = resources) {
  const faults = new Set(Array.isArray(fault) ? fault : [fault]);
  const jobs = new Map(),
    pods = new Map(),
    calls = [];
  let revision = 1,
    activeCreates = 0,
    maximumCreates = 0,
    consumed = false,
    clock = 0,
    namespaceUid = 'ns-uid',
    unknownJobUid;
  const record = { token, controlPlaneMode: 'singleton', deploymentSafety: { namespaceUid: 'ns-uid' } };
  const operation = {
    record,
    assertLease() {
      assert.ok(!operation.expired, 'lease expired');
    },
    async checkpoint(changes) {
      this.assertLease();
      Object.assign(record, structuredClone(changes));
      if (faults.has('namespace-change') && record.preparation?.jobs.some((j) => j.createIssued))
        namespaceUid = 'replacement-ns';
      if (faults.has('namespace-change-delete') && record.preparation?.jobs.some((j) => j.deleteIssued))
        namespaceUid = 'replacement-ns';
      if (faults.has('expiry-after-intent') && record.preparation?.jobs.some((j) => j.createIssued)) clock = 1001;
    },
  };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://fixture.invalid');
    calls.push({ method: req.method, url: url.pathname, body });
    res.setHeader('content-type', 'application/json');
    const send = (value) => res.end(JSON.stringify(value));
    const name = url.pathname.split('/').at(-1);
    if (req.method === 'GET') {
      if (url.pathname === '/api/v1/namespaces/fixture')
        return send({ metadata: { name: namespace, uid: namespaceUid } });
      if (url.pathname.includes('/configmaps/'))
        return send({ metadata: { uid: 'journal-uid' }, data: { record: JSON.stringify(record) } });
      if (url.pathname.includes('/nodes/')) {
        if (faults.has('admission-expiry')) clock = 1001;
        return send({
          metadata: { name, uid: `uid-${name}` },
          status: {
            conditions: [{ type: 'Ready', status: faults.has('node-loss-at-cleanup') && consumed ? 'False' : 'True' }],
          },
        });
      }
      if (url.pathname.endsWith('/pods')) {
        const selected = url.searchParams.get('labelSelector')?.split('=')[1];
        return send({
          items: [...pods.values()].filter((p) => !selected || p.metadata.labels['job-name'] === selected),
        });
      }
      if (jobs.has(name)) {
        const job = structuredClone(jobs.get(name));
        if (faults.has('replaced-job') && !consumed) {
          consumed = true;
          job.metadata.uid = 'foreign';
          jobs.set(name, job);
        }
        return send(job);
      }
      res.statusCode = 404;
      return send({ kind: 'Status' });
    }
    if (req.method === 'POST') {
      assert.equal(body.kind, 'Job');
      assert.ok(
        record.preparation.jobs.find((j) => j.name === body.metadata.name)?.createIssued,
        'Intent must precede CREATE',
      );
      activeCreates++;
      maximumCreates = Math.max(activeCreates, maximumCreates);
      const job = structuredClone(body);
      // batch/v1 omits an empty initContainers list when encoding a stored Job.
      // Model the API round trip, not an echo of our submitted JSON.
      if (job.spec.template.spec.initContainers.length === 0) delete job.spec.template.spec.initContainers;
      const podSpec = job.spec.template.spec;
      if (faults.has('changed-image')) podSpec.containers[0].image = `registry/foreign@sha256:${'b'.repeat(64)}`;
      if (faults.has('changed-command')) podSpec.containers[0].command = ['/bin/sh', '-ec', 'sleep 999'];
      if (faults.has('changed-resources')) podSpec.containers[0].resources.requests.cpu = '900m';
      if (faults.has('missing-containers')) delete podSpec.containers;
      if (faults.has('missing-init')) delete podSpec.initContainers;
      if (faults.has('null-init')) podSpec.initContainers = null;
      if (faults.has('nonempty-init')) podSpec.initContainers = [structuredClone(podSpec.containers[0])];
      // Real Kubernetes canonicalizes 1000m to 1; configuration comparisons
      // must preserve its meaning rather than reject an equivalent API value.
      for (const container of [
        ...(job.spec.template.spec.containers ?? []),
        ...(job.spec.template.spec.initContainers ?? []),
      ])
        for (const kind of ['requests', 'limits']) {
          if (container.resources[kind].cpu === '1000m') container.resources[kind].cpu = '1';
          if (container.resources[kind].cpu === '500m') container.resources[kind].cpu = '0.5';
        }
      job.metadata.uid = `job-${++revision}`;
      job.metadata.resourceVersion = String(revision);
      if (!faults.has('no-capacity'))
        job.status = { conditions: [{ type: faults.has('image-pull') ? 'Failed' : 'Complete', status: 'True' }] };
      jobs.set(job.metadata.name, job);
      pods.set(job.metadata.uid, {
        metadata: {
          name: job.metadata.name + '-pod',
          uid: `pod-${revision}`,
          labels: { 'job-name': job.metadata.name },
          ownerReferences: [{ controller: true, uid: job.metadata.uid }],
        },
        spec: { ...structuredClone(job.spec.template.spec), nodeName: 'node-a' },
        status: { phase: 'Succeeded' },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCreates--;
      if (faults.has('namespace-change-response')) namespaceUid = 'replacement-ns';
      if (faults.has('lease-loss')) operation.expired = true;
      if (faults.has('lost-create') && !consumed) {
        consumed = true;
        unknownJobUid = job.metadata.uid;
        req.socket.destroy();
        return;
      }
      return send(job);
    }
    if (req.method === 'DELETE') {
      const job = jobs.get(name);
      assert.equal(body.propagationPolicy, 'Foreground');
      assert.equal(body.preconditions.uid, job.metadata.uid);
      assert.equal(body.preconditions.resourceVersion, job.metadata.resourceVersion);
      assert.ok(record.preparation.jobs.find((j) => j.name === name)?.deleteIssued);
      jobs.delete(name);
      if (faults.has('node-loss-at-cleanup')) consumed = true;
      if (!faults.has('orphan-pod') || (faults.has('lost-create') && job.metadata.uid !== unknownJobUid))
        pods.delete(job.metadata.uid);
      if (faults.has('lost-delete') && !consumed) {
        consumed = true;
        req.socket.destroy();
        return;
      }
      return send({ kind: 'Status' });
    }
    res.statusCode = 501;
    send({ error: 'not modeled' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const transport = createKubernetesTransport({
    origin: `http://127.0.0.1:${server.address().port}`,
    allowLoopbackHttp: true,
    token: () => 'fixture-only',
  });
  const kube = async (args, options) => {
    let value;
    if (args[0] === 'create')
      value = await transport.json('POST', '/apis/batch/v1/namespaces/fixture/jobs', JSON.parse(options.input));
    else if (args[0] === 'delete') value = await transport.json('DELETE', args[2], JSON.parse(options.input));
    else {
      const [kind, name] = args.slice(1);
      const selector = args.includes('-l') ? `?labelSelector=${encodeURIComponent(args[args.indexOf('-l') + 1])}` : '';
      const pathname =
        kind === 'namespace'
          ? '/api/v1/namespaces/fixture'
          : kind === 'node'
            ? `/api/v1/nodes/${name}`
            : kind === 'configmap'
              ? `/api/v1/namespaces/fixture/configmaps/${name}`
              : kind === 'pods'
                ? `/api/v1/namespaces/fixture/pods${selector}`
                : `/apis/batch/v1/namespaces/fixture/jobs/${name}`;
      value = await transport.json('GET', pathname);
    }
    return { stdout: value === null ? '' : JSON.stringify(value) };
  };
  return {
    jobs,
    pods,
    calls,
    operation,
    maximumCreates: () => maximumCreates,
    run: () =>
      prepareHaReplacements({
        operation,
        kube,
        resources: selectedResources,
        namespace,
        release,
        timeoutMs: 1000,
        now: () => clock,
        pause: async () => {
          clock += 1001;
        },
      }),
  };
}

test('preparation preserves placement and complete requests without application selectors, data, auth or entrypoints', () => {
  const jobs = rolloutPreparationJobs(resources, {
    token,
    namespace,
    journalUid: 'journal-uid',
    controlPlaneMode: 'singleton',
    originalPods: [],
    timeoutMs: 10000,
  });
  for (const job of jobs) {
    const pod = job.spec.template;
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(pod.spec.volumes, undefined);
    assert.equal(pod.metadata.annotations, undefined);
    assert.ok(pod.metadata.labels['app.kubernetes.io/component'].startsWith('prepare-'));
    assert.equal(pod.spec.containers[0].env, undefined);
    assert.deepEqual(pod.spec.containers[0].command, ['/bin/sh', '-ec', 'exit 0']);
    assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'registry-only' }]);
    assert.equal(podResourceRequest(pod.spec, 'cpu'), 0.5);
    assert.equal(podResourceRequest(pod.spec, 'memory'), 128 * 1024 ** 2);
    assert.equal(job.spec.backoffLimit, 0);
    assert.ok(!JSON.stringify(job).includes('must-not-copy'));
  }
  const spec = {
    containers: [{ resources: { requests: { cpu: '1' } } }],
    initContainers: [
      { restartPolicy: 'Always', resources: { requests: { cpu: '200m' } } },
      { resources: { requests: { cpu: '2' } } },
    ],
    overhead: { cpu: '100m' },
  };
  assert.ok(Math.abs(podResourceRequest(spec, 'cpu') - 2.3) < 1e-12);
});

test('real HTTP preparation overlaps independent image jobs, records exact ownership and cleans before templates', async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.ok(f.maximumCreates() > 1 && f.maximumCreates() <= 3);
  assert.equal(f.operation.record.preparation.state, 'complete');
  assert.ok(f.operation.record.preparation.jobs.every((j) => j.warmed && j.uid && j.podUid && j.nodeUid && j.absent));
  assert.equal(f.jobs.size + f.pods.size, 0);
  const writes = f.calls.filter((c) => c.method !== 'GET').length;
  await f.run();
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes, 'Acknowledged preparation is not replayed');
  const confirmed = structuredClone(f.operation.record.preparation);
  for (const corrupt of [
    (p) => p.jobs.pop(),
    (p) => {
      p.jobs[0].warmed = false;
    },
  ]) {
    f.operation.record.preparation = structuredClone(confirmed);
    corrupt(f.operation.record.preparation);
    await assert.rejects(f.run(), /receipt lost|completion facts/);
  }
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes);
  f.operation.record.preparation = confirmed;
});

test('serial preparation checks only additional replacement resources without overlapping a storage owner', () => {
  const backend = resource('backend');
  backend.kind = 'StatefulSet';
  backend.spec.template.spec.containers[0].resources.requests.cpu = '2';
  const original = {
    metadata: {
      name: backend.metadata.name + '-0',
      ownerReferences: [
        { controller: true, kind: 'StatefulSet', name: backend.metadata.name, uid: 'original-controller' },
      ],
    },
    spec: { ...structuredClone(backend.spec.template.spec), nodeName: 'old-node' },
  };
  original.spec.containers[0].resources.requests.cpu = '1';
  const impostor = structuredClone(original);
  impostor.metadata.name = backend.metadata.name + '-job-pod';
  impostor.metadata.ownerReferences[0].kind = 'Job';
  impostor.metadata.ownerReferences[0].uid = 'other-controller';
  impostor.spec.nodeName = 'wrong-node';
  const [job] = rolloutPreparationJobs([backend], {
    token,
    namespace,
    journalUid: 'cm',
    controlPlaneMode: 'singleton',
    originalPods: [impostor, original],
    workloads: [{ name: backend.metadata.name, uid: 'original-controller' }],
    timeoutMs: 1000,
  });
  assert.equal(podResourceRequest(job.spec.template.spec, 'cpu'), 1);
  assert.deepEqual(
    job.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0]
      .matchFields,
    [{ key: 'metadata.name', operator: 'In', values: ['old-node'] }],
  );
  assert.equal(job.spec.template.spec.volumes, undefined);
});

test('API omission of empty lists preserves nonempty init containers and remains safe during lost CREATE recovery', async (t) => {
  const selected = structuredClone(resources);
  selected[0].spec.template.spec.initContainers = [
    {
      name: 'other-image',
      image: `registry/helper@sha256:${'b'.repeat(64)}`,
    },
  ];
  for (const fault of [undefined, 'lost-create']) {
    const f = await fixture(t, fault, selected);
    if (fault) await assert.rejects(f.run());
    else await f.run();
    assert.ok(f.operation.record.preparation.jobs.every((j) => j.uid && j.absent));
    assert.equal(f.jobs.size + f.pods.size, 0);
    const submitted = f.calls.filter((c) => c.method === 'POST');
    assert.ok(submitted.some((c) => c.body.spec.template.spec.initContainers.length === 1));
    assert.ok(submitted.some((c) => c.body.spec.template.spec.initContainers.length === 0));
    if (fault) {
      const writes = f.calls.filter((c) => c.method !== 'GET').length;
      await assert.rejects(f.run());
      assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes);
    }
  }
});

test('API normalization never authorizes changed images, commands, requests or nonempty lists', async (t) => {
  for (const fault of [
    'changed-image',
    'changed-command',
    'changed-resources',
    'missing-containers',
    'missing-init',
    'null-init',
    'nonempty-init',
  ]) {
    const selected = structuredClone(resources);
    if (fault === 'missing-init')
      selected[0].spec.template.spec.initContainers = [
        {
          name: 'required-image',
          image: `registry/helper@sha256:${'b'.repeat(64)}`,
        },
      ];
    const f = await fixture(t, fault, fault === 'missing-init' ? [selected[0]] : selected);
    await assert.rejects(f.run());
    assert.notEqual(f.operation.record.preparation.state, 'complete', fault);
    assert.ok(f.jobs.size > 0, 'Changed configuration must be retained for inspected recovery.');
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0, fault);
    const writes = f.calls.filter((c) => c.method !== 'GET').length;
    await assert.rejects(f.run());
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes, fault);
  }
});

test('lost CREATE recovery retains the recovered Job UID when checking orphaned children', async (t) => {
  const f = await fixture(t, ['lost-create', 'orphan-pod']);
  await assert.rejects(f.run());
  assert.equal(f.jobs.size, 0);
  assert.equal(f.pods.size, 1);
  assert.equal(
    f.operation.record.preparation.state,
    'preparing',
    'An exact surviving child must block cleanup completion',
  );
  const orphan = [...f.pods.values()][0];
  const item = f.operation.record.preparation.jobs.find((j) => j.uid === orphan.metadata.ownerReferences[0].uid);
  assert.ok(item?.uid && !item.absent);
});

test('a failed preparation stops new admissions while accepted children settle and clean up', async (t) => {
  const f = await fixture(t, 'image-pull', [...resources, resource('evaluation')]);
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(f.jobs.size + f.pods.size, 0);
});

test('completed preparation recovery rechecks Job absence, not just absent children', async (t) => {
  const f = await fixture(t);
  await f.run();
  const created = f.calls.find((c) => c.method === 'POST').body;
  const item = f.operation.record.preparation.jobs.find((j) => j.name === created.metadata.name);
  f.jobs.set(item.name, { ...structuredClone(created), metadata: { ...created.metadata, uid: item.uid } });
  const writes = f.calls.filter((c) => c.method !== 'GET').length;
  await assert.rejects(f.run(), /Job.*still exists/);
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, writes);
});

test('node loss during cleanup blocks preparation success after exact children are removed', async (t) => {
  const f = await fixture(t, 'node-loss-at-cleanup');
  await assert.rejects(f.run(), /Prepared node identity\/readiness changed/);
  assert.equal(f.jobs.size + f.pods.size, 0);
  assert.notEqual(f.operation.record.preparation.state, 'complete');
});

test('the preparation deadline closes admission without replaying or abandoning accepted Jobs', async (t) => {
  const f = await fixture(t, 'admission-expiry', [...resources, resource('evaluation')]);
  await assert.rejects(f.run(), /deadline/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(f.jobs.size + f.pods.size, 0);
  assert.equal(f.operation.record.preparation.state, 'cleaned-failed');
});

test('expiry after a CREATE intent blocks the request and preserves uncertainty rather than replaying it', async (t) => {
  const f = await fixture(t, 'expiry-after-intent', [resources[0]]);
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(f.operation.record.preparation.state, 'preparing');
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('namespace replacement after the CREATE intent fences all preparation writes', async (t) => {
  const f = await fixture(t, 'namespace-change');
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('namespace changes during CREATE or before DELETE never authorize cleanup in the replacement namespace', async (t) => {
  for (const fault of ['namespace-change-response', 'namespace-change-delete']) {
    const f = await fixture(t, fault);
    await assert.rejects(f.run());
    assert.ok(f.calls.some((c) => c.method === 'POST'));
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
    assert.equal(f.operation.record.preparation.state, 'preparing');
  }
});

test('lease loss fences cleanup; exact recovery observes accepted Jobs without creating them again', async (t) => {
  const f = await fixture(t, 'lease-loss');
  await assert.rejects(f.run());
  const creates = f.calls.filter((c) => c.method === 'POST').length;
  assert.ok(creates > 0 && f.jobs.size > 0);
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 0);
  f.operation.expired = false; // Stand-in for explicit recovery of this same token.
  await f.run();
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, creates);
  assert.equal(f.jobs.size + f.pods.size, 0);
});

for (const fault of ['no-capacity', 'image-pull', 'lost-create', 'lost-delete', 'replaced-job', 'orphan-pod'])
  test(`real HTTP ${fault} cannot retire an owner or replay a preparation write`, async (t) => {
    const f = await fixture(t, fault);
    await assert.rejects(f.run());
    assert.ok(f.calls.filter((c) => c.method !== 'GET').every((c) => c.url.includes('/jobs')));
    const creates = f.calls.filter((c) => c.method === 'POST').length;
    const deletes = f.calls.filter((c) => c.method === 'DELETE').length;
    await assert.rejects(f.run());
    assert.equal(f.calls.filter((c) => c.method === 'POST').length, creates);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, deletes);
    if (fault === 'replaced-job' || fault === 'orphan-pod')
      assert.ok(f.jobs.size + f.pods.size, 'Unconfirmed child/replacement must be preserved');
    else assert.equal(f.jobs.size + f.pods.size, 0);
  });
