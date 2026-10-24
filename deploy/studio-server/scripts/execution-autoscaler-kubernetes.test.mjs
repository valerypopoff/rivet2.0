import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import {
  createKubernetesTransport,
  createExecutionAutoscalerIO,
  cpuQuantity,
} from './lib/execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicy, reconcileExecutionAutoscaling } from './lib/execution-autoscaler.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
import { haFrozenAutoscalingValues, haRolloutAutoscalingValues } from './lib/ha-kubernetes-rollout.mjs';
import { childEnvironments } from '../images/api/backend-supervisor.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');
function render(...overrides) {
  return parseAllDocuments(
    execFileSync(
      resolveHelmBinOrThrow(root),
      [
        'template',
        'rivet',
        'deploy/studio-server/helm',
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
        '--set',
        'objectStorage.bucket=fixture',
        '--set',
        'postgres.maxConnections=500',
        ...overrides.flatMap((v) => ['--set', v]),
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    ),
  )
    .map((d) => {
      if (d.errors.length) throw d.errors[0];
      return d.toJSON();
    })
    .filter(Boolean);
}
test('chart has exactly one execution writer, seven baseline pods, fixed developers and tightly scoped controller capability', () => {
  const resources = render();
  assert.equal(resources.filter((r) => r.kind === 'HorizontalPodAutoscaler').length, 1);
  assert.equal(
    resources.find((r) => r.kind === 'HorizontalPodAutoscaler').metadata.labels['app.kubernetes.io/component'],
    'proxy',
  );
  const workloads = resources.filter((r) => ['Deployment', 'StatefulSet'].includes(r.kind));
  assert.equal(
    workloads.reduce((sum, w) => sum + w.spec.replicas, 0),
    7,
  );
  assert.equal(workloads.find((w) => w.metadata.labels['app.kubernetes.io/component'] === 'backend').spec.replicas, 1);
  assert.equal(workloads.find((w) => w.metadata.labels['app.kubernetes.io/component'] === 'web').spec.replicas, 1);
  const controller = workloads.find((w) => w.metadata.labels['app.kubernetes.io/component'] === 'autoscaler');
  const config = JSON.parse(controller.spec.template.spec.containers[0].env[0].value);
  assert.equal(config.policy.minReplicas, 2);
  assert.equal(config.policy.maxReplicas, 10);
  assert.equal(config.service, 'rivet-rivet-execution');
  assert.equal(controller.spec.strategy.type, 'Recreate');
  assert.equal(controller.spec.template.spec.containers[0].env.length, 1);
  const role = resources.find((r) => r.kind === 'Role' && r.metadata.name.endsWith('-autoscaler'));
  assert.equal(
    role.rules.some((rule) => rule.resources.includes('secrets')),
    false,
  );
  const exec = role.rules.find((rule) => rule.resources.includes('pods/exec'));
  assert.deepEqual(exec.resources, ['pods/exec'], 'Exec CREATE must never grant Pod creation');
  assert.deepEqual(exec.verbs, ['get', 'create'], 'Kubernetes 1.35+ authorizes WebSocket upgrades with CREATE too');
  assert.deepEqual(
    exec.resourceNames,
    Array.from({ length: config.policy.maxReplicas + 1 }, (_, i) => `${config.workload}-${i}`),
  );
  assert.equal(
    role.rules.some((rule) => rule.resources.includes('pods') && rule.verbs.includes('create')),
    false,
  );
  assert.deepEqual(
    role.rules.find((rule) => rule.resources.includes('pods') && rule.verbs.includes('patch')).resourceNames,
    exec.resourceNames,
  );
  assert.deepEqual(
    role.rules.find((rule) => rule.resources.includes('configmaps') && rule.verbs.includes('update')).resourceNames,
    [releaseOperationJournalName('rivet')],
  );
  const pdb = resources.find(
    (r) => r.kind === 'PodDisruptionBudget' && r.metadata.labels['app.kubernetes.io/component'] === 'execution',
  );
  assert.equal(pdb.spec.minAvailable, '100%');
  assert.equal(pdb.spec.maxUnavailable, undefined);
  const changed = render('images.api.digest=sha256:' + 'e'.repeat(64)).find(
    (r) => r.kind === 'Deployment' && r.metadata.labels['app.kubernetes.io/component'] === 'autoscaler',
  );
  assert.notEqual(
    JSON.parse(changed.spec.template.spec.containers[0].env[0].value).manifestDigest,
    config.manifestDigest,
  );
});
test('HA operational pause retains execution retirement protection and fences preserved frontend capacity', () => {
  const overrides = Object.entries(haFrozenAutoscalingValues.autoscaling).flatMap(([role, fields]) =>
    Object.entries(fields).map(([key, value]) => `autoscaling.${role}.${key}=${value}`),
  );
  const resources = render(
    ...overrides,
    'replicaCount.proxy=4',
    'ha.rolloutResourceVersions.rivet-rivet-proxy=42',
    'ha.rolloutResourceVersions.rivet-rivet-web=43',
  );
  const role = (component) =>
    resources.find((r) => r.kind === 'Deployment' && r.metadata.labels['app.kubernetes.io/component'] === component);
  assert.equal(role('autoscaler').spec.replicas, 0);
  assert.equal(role('proxy').spec.replicas, 4);
  assert.equal(role('proxy').metadata.resourceVersion, '42');
  assert.equal(role('web').metadata.resourceVersion, '43');
  assert.equal(
    resources.some((r) => r.kind === 'HorizontalPodAutoscaler'),
    false,
  );
  const execution = resources.find(
    (r) => r.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'execution',
  );
  assert.ok(
    execution.spec.template.spec.containers
      .find((c) => c.name === 'api')
      .env.some((e) => e.name === 'RIVET_EXECUTION_STARTUP_FENCE'),
  );
  assert.equal(
    resources.find(
      (r) => r.kind === 'PodDisruptionBudget' && r.metadata.labels['app.kubernetes.io/component'] === 'execution',
    ).spec.minAvailable,
    '100%',
  );
});

test('cooperative rollout keeps execution and proxy growth active and pauses only proxy downscale', () => {
  const overlay = haRolloutAutoscalingValues(render());
  const overrides = Object.entries(overlay.autoscaling).flatMap(([role, fields]) =>
    Object.entries(fields).map(([key, value]) => `autoscaling.${role}.${key}=${value}`));
  const resources = render(...overrides);
  assert.equal(resources.find(r => r.kind === 'Deployment' && r.metadata.labels['app.kubernetes.io/component'] === 'autoscaler').spec.replicas, 1);
  const hpa = resources.find(r => r.kind === 'HorizontalPodAutoscaler');
  assert.equal(hpa.metadata.labels['app.kubernetes.io/component'], 'proxy');
  assert.equal(hpa.spec.behavior.scaleDown.selectPolicy, 'Disabled');
  assert.notEqual(hpa.spec.behavior.scaleUp?.selectPolicy, 'Disabled');
  assert.equal(render().find(r => r.kind === 'HorizontalPodAutoscaler').spec.behavior.scaleDown.selectPolicy, undefined);
});

test('cooperative scale-up cannot apply a demand sample after the workload configuration version changes', async () => {
  const calls = [];
  const io = createExecutionAutoscalerIO({ release: 'rivet', namespace: 'fixture', workload: 'execution', service: 'execution',
    image: 'candidate', port: 8080, policy: autoscalerPolicy({}), transport: {
      json: async (method, request) => {
        calls.push([method, request]);
        assert.equal(method, 'GET', 'No PATCH is allowed after a stale workload observation');
        return { metadata: { uid: 'workload', resourceVersion: 'new-template' }, spec: { replicas: 3 } };
      },
    } });
  await assert.rejects(io.scale('workload', 3, 4, 'sampled-old-template'), /precondition changed/);
  assert.equal(calls.length, 1);
});

test('chart rejects two replica writers, unsafe floors/targets/metrics and a DB budget below the maximum', () => {
  for (const bad of [
    'ha.enabled=false',
    'autoscaling.executionController.enabled=0',
    'autoscaling.executionController.suspended=0',
    'autoscaling.execution.enabled=true',
    'metrics.enabled=false',
    'autoscaling.execution.minReplicas=1',
    'autoscaling.execution.maxReplicas=1',
    'autoscaling.execution.maxReplicas=101',
    'autoscaling.executionController.targetSlotsPercent=91',
    'autoscaling.executionController.withdrawalSeconds=1',
    'autoscaling.executionController.pollSeconds=0',
    'autoscaling.executionController.stabilizationSeconds=1',
    'autoscaling.executionController.cooldownSeconds=1.5',
    'availability.disruptionBudget.enabled=false',
    'publishedExecutionAdmission.mode=observe',
    'workflowSchema.maintenanceValidation=true',
    'postgres.maxConnections=100',
  ])
    assert.throws(() => render(bad), undefined, bad);
});

test('reviewed execution ceiling fits a shared 200-connection allowance without raising it', () => {
  const resources = render('postgres.maxConnections=200', 'autoscaling.execution.maxReplicas=7');
  const controller = resources.find((r) => r.kind === 'Deployment' && r.metadata.name.endsWith('-autoscaler'));
  assert.equal(JSON.parse(controller.spec.template.spec.containers[0].env[0].value).policy.maxReplicas, 7);
  for (const max of [8, 10])
    assert.throws(() => render('postgres.maxConnections=200', `autoscaling.execution.maxReplicas=${max}`));
});

test('compact HA maintenance validation preserves workload and storage identities while fencing traffic and timers', () => {
  const serving = render();
  const maintenance = [
    'workflowSchema.maintenanceValidation=true',
    'replicaCount.proxy=0', 'replicaCount.web=0', 'replicaCount.evaluation=0',
    'autoscaling.execution.enabled=false', 'autoscaling.executionController.enabled=false',
    'autoscaling.proxy.enabled=false', 'autoscaling.web.enabled=false', 'autoscaling.backend.enabled=false',
  ];
  const validation = render(...maintenance);
  assert.equal(validation.some((resource) => resource.kind === 'HorizontalPodAutoscaler'), false);
  assert.equal(validation.some((resource) => resource.metadata?.labels?.['app.kubernetes.io/component'] === 'autoscaler'), false);
  for (const component of ['backend', 'execution', 'proxy', 'web']) {
    const workload = (resources) => resources.find((resource) => ['StatefulSet', 'Deployment'].includes(resource.kind) &&
      resource.metadata.labels?.['app.kubernetes.io/component'] === component);
    const before = workload(serving), during = workload(validation);
    assert.ok(before && during, component);
    assert.equal(during.metadata.name, before.metadata.name, component);
    assert.equal(during.kind, before.kind, component);
    assert.deepEqual(during.spec.selector, before.spec.selector, component);
    assert.equal(during.spec.serviceName, before.spec.serviceName, component);
    assert.deepEqual(during.spec.template.spec.volumes, before.spec.template.spec.volumes, component);
    assert.equal(during.spec.replicas, ['proxy', 'web'].includes(component) ? 0 : before.spec.replicas, component);
    for (const container of during.spec.template.spec.containers) {
      assert.equal(container.lifecycle.preStop.exec.command.at(-1), 'sleep 0');
      if (['backend', 'execution'].includes(component)) {
        assert.equal(container.env.find((entry) => entry.name === 'RIVET_RELEASE_MAINTENANCE')?.value, 'true');
        assert.equal(container.env.find((entry) => entry.name === 'RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED')?.value, 'false');
        assert.equal(container.env.find((entry) => entry.name === 'RIVET_MANAGED_MAINTENANCE_ENABLED')?.value, 'false');
      }
    }
    for (const container of before.spec.template.spec.containers)
      assert.equal(container.lifecycle.preStop.exec.command.at(-1), 'sleep 120');
  }
  assert.throws(() => render('replicaCount.web=0'), /minimum|singleton control requires/);
  assert.throws(() => render(...maintenance, 'replicaCount.web=1'), /maintenance validation requires/);
  assert.throws(() => render(...maintenance, 'replicaCount.execution=1'), /singleton control requires/);
});

async function clusterFixture(t, policyOverrides = {}) {
  let time = Date.now(),
    journal = null,
    version = 1,
    replicas = 3,
    outputFailure = null,
    fault = null,
    generation = 1;
  let annotations = {};
  let active = 0;
  const image = 'registry.test/api@sha256:' + 'a'.repeat(64),
    workload = 'rivet-ha-execution',
    release = 'rivet',
    namespace = 'proof';
  const policy = autoscalerPolicy({
    stabilizationSeconds: 30,
    cooldownSeconds: 10,
    pollSeconds: 10,
    withdrawalSeconds: 1,
    ...policyOverrides,
  });
  const pods = new Map(),
    logs = [];
  const newPod = (ordinal) => {
    const name = `${workload}-${ordinal}`;
    const value = {
      metadata: {
        name,
        uid: `${name}-uid-${version++}`,
        resourceVersion: String(version++),
        annotations: { ...annotations },
        ownerReferences: [{ controller: true, kind: 'StatefulSet', uid: 'sts-uid', name: workload }],
      },
      spec: { containers: [{ name: 'api', resources: { requests: { cpu: '250m' } } }] },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      retirement: {
        protocol: 1,
        withdrawalProtocol: 1,
        incarnation: `${name}-inc`,
        operationId: null,
        state: 'serving',
      },
    };
    pods.set(name, value);
    return value;
  };
  for (let i = 0; i < replicas; i++) newPod(i);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'),
      path = url.pathname;
    logs.push([req.method, path]);
    if (fault && fault(req, res) !== false) return;
    const json = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    if (path.endsWith('/configmaps') && req.method === 'POST') {
      if (journal) return json(409, {});
      journal = { ...body, metadata: { ...body.metadata, resourceVersion: String(version++) } };
      return json(201, journal);
    }
    if (path.includes('/configmaps/')) {
      if (req.method === 'GET') return journal ? json(200, journal) : json(404, {});
      if (body.metadata.resourceVersion !== journal.metadata.resourceVersion) return json(409, {});
      journal = { ...body, metadata: { ...body.metadata, resourceVersion: String(version++) } };
      return json(200, journal);
    }
    if (path.endsWith(`/statefulsets/${workload}`)) {
      if (req.method === 'PATCH') {
        assert.equal(body[0].value, 'sts-uid');
        assert.equal(body[1].value, String(version));
        annotations = body[2].value;
        version++;
        generation++;
      }
      return json(200, {
        metadata: {
          uid: 'sts-uid',
          resourceVersion: String(version),
          generation,
          labels: { 'app.kubernetes.io/instance': release },
        },
        status: { observedGeneration: generation },
        spec: {
          replicas,
          updateStrategy: { type: 'OnDelete' },
          template: { metadata: { annotations }, spec: { containers: [{ name: 'api', image }] } },
        },
      });
    }
    if (path.endsWith('/scale')) {
      if (req.method === 'GET')
        return json(200, { metadata: { uid: 'sts-uid', resourceVersion: String(version) }, spec: { replicas } });
      assert.equal(req.headers['content-type'], 'application/json-patch+json');
      assert.equal(body[0].value, 'sts-uid');
      assert.equal(body[1].value, String(version));
      assert.equal(body[2].value, replicas);
      const previous = replicas;
      replicas = body[3].value;
      version++;
      for (let i = previous; i < replicas; i++) newPod(i);
      for (let i = replicas; i < previous; i++) pods.delete(`${workload}-${i}`);
      return json(200, { spec: { replicas } });
    }
    if (path.includes('/horizontalpodautoscalers')) return json(200, { items: [] });
    if (path.includes('/endpointslices'))
      return json(200, {
        items: [
          {
            endpoints: [...pods.values()]
              .filter((p) => p.retirement.state === 'serving')
              .map((p) => ({ targetRef: { uid: p.metadata.uid }, conditions: { ready: true } })),
          },
        ],
      });
    if (path.includes('/metrics.k8s.io/'))
      return json(200, {
        items: [...pods.values()].map((p) => ({
          metadata: { name: p.metadata.name },
          timestamp: new Date(time).toISOString(),
          containers: [{ name: 'api', usage: { cpu: '1000000n' } }],
        })),
      });
    if (path.endsWith('/pods')) return json(200, { items: [...pods.values()] });
    if (path.includes('/pods/')) {
      const name = path.split('/').at(-1),
        p = pods.get(name);
      if (req.method === 'PATCH') {
        assert.equal(body[0].value, p.metadata.uid);
        assert.equal(body[1].value, p.metadata.resourceVersion);
        p.metadata.annotations = body[2].value;
        p.metadata.resourceVersion = String(version++);
        return json(200, p);
      }
      if (req.method === 'DELETE') {
        assert.equal(body.preconditions.uid, p.metadata.uid);
        newPod(Number(name.split('-').at(-1)));
        return json(200, {});
      }
      return p ? json(200, p) : json(404, {});
    }
    json(404, {});
  });
  const sockets = new WebSocketServer({ server, handleProtocols: (protocols) => [...protocols][0] });
  sockets.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost'),
      command = url.searchParams.getAll('command');
    logs.push(['EXEC', url.pathname, command.at(-1)]);
    assert.equal(url.searchParams.get('container'), 'api');
    const p = pods.get(url.pathname.split('/').at(-2));
    if (outputFailure === 'hang') return;
    if (command.includes('/opt/rivet/retire-backend.mjs')) {
      if (command.length > 2) {
        assert.equal(command[3], p.retirement.incarnation);
        p.retirement.operationId = command[2];
        p.retirement.state = command[4] === '--withdraw-only' ? 'withdrawing' : 'draining';
        p.status.conditions[0].status = 'False';
      }
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(p.retirement))]));
    } else
      socket.send(
        Buffer.concat([
          Buffer.from([1]),
          Buffer.from(
            `rivet_published_execution_active_runs ${active}\nrivet_published_execution_admission_limit{mode="enforce"} 10\n`,
          ),
        ]),
      );
    if (outputFailure !== 'no-status')
      socket.send(
        Buffer.concat([
          Buffer.from([3]),
          Buffer.from(JSON.stringify({ status: outputFailure === 'exit' ? 'Failure' : 'Success' })),
        ]),
      );
    socket.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = createKubernetesTransport({
    origin,
    allowLoopbackHttp: true,
    WebSocketClass: WebSocket,
    token: () => 'local-test-only',
    timeoutMs: 150,
  });
  const io = createExecutionAutoscalerIO({
    transport,
    release,
    namespace,
    workload,
    service: 'rivet-execution',
    policy,
    image,
    now: () => time,
  });
  const tick = () =>
    reconcileExecutionAutoscaling({
      io,
      release,
      namespace,
      manifestDigest: 'pinned',
      runner: 'fixture',
      policy,
      now: () => time,
    });
  return {
    io,
    tick,
    logs,
    pods,
    transport,
    origin,
    advance: (seconds = 10) => {
      time += seconds * 1000;
    },
    replicas: () => replicas,
    active: (value) => {
      active = value;
    },
    outputFailure: (value) => {
      outputFailure = value;
    },
    fault: (value) => {
      fault = value;
    },
  };
}

test('actual HTTP/exec-WebSocket client observes admission demand, CAS scales, withdraws, drains and shrinks without developer calls', async (t) => {
  const f = await clusterFixture(t);
  f.active(10);
  assert.equal((await f.tick()).state, 'scaled-up');
  assert.equal(f.replicas(), 5);
  f.active(0);
  await f.tick();
  for (let i = 0; i < 4; i++) {
    f.advance();
    await f.tick();
  }
  assert.equal(f.logs.filter((l) => l[0] === 'EXEC' && l[2] === '--withdraw-only').length, 1);
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  f.advance();
  assert.equal((await f.tick()).state, 'draining');
  assert.equal((await f.tick()).state, 'waiting-for-work');
  [...f.pods.values()].at(-1).retirement.state = 'drained';
  assert.equal((await f.tick()).state, 'scaled-down');
  assert.equal((await f.tick()).state, 'unfencing');
  assert.equal((await f.tick()).state, 'settled');
  assert.equal(f.replicas(), 4);
  assert.ok(f.logs.some((l) => l[0] === 'PATCH' && l[1].endsWith('/scale')));
  assert.equal(
    f.logs.some((l) => /backend|secrets/.test(l[1])),
    false,
  );
});

test('issued retirement settles during a metrics outage without load sampling or unrelated exec', async (t) => {
  const f = await clusterFixture(t);
  await f.tick();
  for (let i = 0; i < 4; i++) {
    f.advance();
    await f.tick();
  }
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  f.advance();
  await f.tick();
  [...f.pods.values()].at(-1).retirement.state = 'drained';
  assert.equal((await f.tick()).state, 'scaled-down');
  const priorCalls = f.logs.length;
  f.fault((req, res) => {
    if (req.url.includes('/metrics.k8s.io/')) {
      res.writeHead(503);
      res.end('{}');
      return true;
    }
    return false;
  });
  f.outputFailure('hang');
  assert.equal((await f.tick()).state, 'unfencing');
  assert.equal((await f.tick()).state, 'settled');
  const calls = f.logs.slice(priorCalls);
  assert.equal(
    calls.some((call) => call[1].includes('/metrics.k8s.io/') || call[0] === 'EXEC'),
    false,
  );
  await assert.rejects(f.tick(), /Kubernetes/); // Missing metrics still fence a NEW load decision.
});

test('HTTP EndpointSlice delay and failed observation require a new full propagation window before exec begin', async (t) => {
  const f = await clusterFixture(t, { withdrawalSeconds: 60 });
  const targetUid = [...f.pods.values()].at(-1).metadata.uid;
  f.fault((req, res) => {
    if (!req.url.includes('/endpointslices')) return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ endpoints: [{ targetRef: { uid: targetUid }, conditions: { ready: true } }] }] }));
    return true;
  });
  await f.tick();
  for (let i = 0; i < 4; i++) { f.advance(); await f.tick(); }
  f.advance(61);
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  f.fault(null);
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  for (let i = 0; i < 3; i++) { f.advance(); await f.tick(); }
  f.fault((req, res) => {
    if (!req.url.includes('/endpointslices')) return false;
    res.writeHead(503);
    res.end('{}');
    return true;
  });
  await assert.rejects(f.tick(), /Kubernetes/);
  f.fault(null);
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  for (let i = 0; i < 5; i++) {
    f.advance();
    assert.equal((await f.tick()).state, 'waiting-for-routing');
  }
  assert.equal(f.logs.filter((call) => call[0] === 'EXEC' && call[2] === '--begin-only').length, 0);
  f.advance();
  assert.equal((await f.tick()).state, 'draining');
  assert.equal(f.logs.filter((call) => call[0] === 'EXEC' && call[2] === '--begin-only').length, 1);
});

test('lease expiry during real peer queries prevents subsequent Kubernetes fence writes', async (t) => {
  const f = await clusterFixture(t);
  await f.tick();
  for (let i = 0; i < 2; i++) {
    f.advance();
    await f.tick();
  }
  const peers = f.io.confirmPeers;
  f.io.confirmPeers = async (...args) => {
    await peers(...args);
    f.advance(121);
  };
  f.advance();
  await assert.rejects(f.tick(), /lease|ownership/i);
  assert.equal(
    f.logs.some((call) => call[0] === 'PATCH'),
    false,
  );
});

test('an unrecorded replacement at a removed tail keeps the actual Kubernetes template fence intact', async (t) => {
  const f = await clusterFixture(t);
  await f.tick();
  for (let i = 0; i < 4; i++) {
    f.advance();
    await f.tick();
  }
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  f.advance();
  await f.tick();
  const tail = [...f.pods.values()].at(-1);
  tail.retirement.state = 'drained';
  const recreated = structuredClone(tail);
  recreated.metadata.uid = 'unexpected-tail-uid';
  recreated.status.conditions[0].status = 'False';
  assert.equal((await f.tick()).state, 'scaled-down');
  f.pods.set(recreated.metadata.name, recreated);
  const before = f.logs.length;
  await assert.rejects(f.tick(), /ordinal was recreated/);
  assert.equal(
    f.logs.slice(before).some((call) => call[0] === 'PATCH' || call[0] === 'DELETE'),
    false,
  );
  assert.equal(await f.io.isFenced({ name: tail.metadata.name, workloadUid: 'sts-uid' }), true);
});

test('startup fencing covers same-UID container restarts and is retained until that exact pod disappears', async (t) => {
  const f = await clusterFixture(t);
  const target = { ...(await f.io.snapshot()).pods.at(-1), workloadUid: 'sts-uid' };
  await f.io.fence(target);
  assert.equal(await f.io.fenceObserved(target), true);
  const restartEnv = {
    RIVET_RUNNER_SLOT_ID: target.name,
    RIVET_EXECUTION_STARTUP_FENCE: f.pods.get(target.name).metadata.annotations['rivet.dev/execution-retirement-fence'],
  };
  assert.equal(restartEnv.RIVET_EXECUTION_STARTUP_FENCE, target.name);
  assert.throws(() => childEnvironments(restartEnv), /startup-fenced/);
  await f.io.clearFence(target); // Before an interior UID-precondition delete.
  assert.equal(await f.io.isFenced(target), false);
  assert.equal(f.pods.get(target.name).metadata.annotations['rivet.dev/execution-retirement-fence'], target.name);
  assert.throws(() => childEnvironments(restartEnv), /startup-fenced/);
});

test('an unconfirmed live-pod startup fence cannot authorize withdrawal', async (t) => {
  const f = await clusterFixture(t);
  const target = { ...(await f.io.snapshot()).pods.at(-1), workloadUid: 'sts-uid' };
  f.fault((req, res) => {
    if (req.method === 'PATCH' && req.url.includes('/pods/')) {
      res.writeHead(409);
      res.end('{}');
      return true;
    }
    return false;
  });
  await assert.rejects(f.io.fence(target), /409/);
  await assert.rejects(f.io.fenceObserved(target), /Pod startup fence intent/);
  assert.equal(
    f.logs.some((l) => l[0] === 'EXEC' && l[2] === '--withdraw-only'),
    false,
  );
});

test('exec requires an explicit successful exit status and enforces its deadline', async (t) => {
  const f = await clusterFixture(t);
  for (const failure of ['exit', 'no-status', 'hang']) {
    f.outputFailure(failure);
    await assert.rejects(f.io.snapshot(), /successful exit|deadline/);
  }
});

test('real HTTP JSON, HTML, conflict, permission and timeout failures do not become zero-demand data', async (t) => {
  const f = await clusterFixture(t);
  for (const fault of [
    (_, r) => {
      r.writeHead(503);
      r.end('{"error":"unavailable"}');
    },
    (_, r) => {
      r.writeHead(200);
      r.end('<html>error</html>');
    },
    (_, r) => {
      r.writeHead(409);
      r.end('{}');
    },
    (_, r) => {
      r.writeHead(403);
      r.end('{}');
    },
    () => {},
  ]) {
    f.fault(fault);
    await assert.rejects(f.tick(), /Kubernetes/);
  }
  assert.equal(
    f.logs.some((l) => l[0] === 'PATCH' || l[0] === 'DELETE'),
    false,
  );
});

test('UID and process ownership checks reject foreign execution pods before commands or deletion', async (t) => {
  const f = await clusterFixture(t);
  const p = [...f.pods.values()][0];
  p.metadata.ownerReferences[0].uid = 'foreign';
  await assert.rejects(f.io.snapshot(), /foreign controller/);
  await assert.rejects(
    f.io.remove({ name: p.metadata.name, uid: p.metadata.uid, workloadUid: 'sts-uid' }),
    /UID or controller/,
  );
  assert.equal(
    f.logs.some((l) => l[0] === 'DELETE' || l[0] === 'EXEC'),
    false,
  );
});

test('strict transport rejects remote plaintext and unreachable local connections fail boundedly', async () => {
  assert.throws(() => createKubernetesTransport({ origin: 'http://production.example' }), /HTTPS/);
  assert.throws(
    () => createKubernetesTransport({ origin: 'http://user:pass@127.0.0.1', allowLoopbackHttp: true }),
    /HTTPS/,
  );
  const api = createKubernetesTransport({
    origin: 'http://127.0.0.1:1',
    allowLoopbackHttp: true,
    token: () => 'test',
    timeoutMs: 50,
  });
  await assert.rejects(api.json('GET', '/version'));
  assert.equal(cpuQuantity('250m'), 0.25);
  assert.equal(cpuQuantity('1000000n'), 0.001);
  assert.throws(() => cpuQuantity('garbage'));
});

test(
  'optional Postman simulation exercises the same real transport and distinct dependency failures',
  { skip: !process.env.RIVET_AUTOSCALER_SIMULATION },
  async () => {
    const api = createKubernetesTransport({
      origin: process.env.RIVET_AUTOSCALER_SIMULATION,
      allowLoopbackHttp: true,
      token: () => 'test',
      timeoutMs: 500,
    });
    assert.deepEqual(await api.json('GET', '/kube/ok'), { kind: 'APIResourceList' });
    assert.equal(await api.json('GET', '/kube/missing'), null);
    for (const path of ['/kube/json-error', '/kube/html-error', '/kube/hang'])
      await assert.rejects(api.json('GET', path));
  },
);
