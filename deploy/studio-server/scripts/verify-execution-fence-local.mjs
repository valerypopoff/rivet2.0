import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createKubernetesTransport, createExecutionAutoscalerIO } from './lib/execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicy, reconcileExecutionAutoscaling } from './lib/execution-autoscaler.mjs';

// Explicit local profile only. Does not accept a host kubeconfig/current context.
const profile = process.env.RIVET_FENCE_LOCAL_PROFILE;
const image = process.env.RIVET_FENCE_LOCAL_IMAGE;
assert.match(profile ?? '', /^rivet-fence-[a-z0-9-]+$/);
assert.match(image ?? '', /^rivet-local\/autoscaler-fence:[a-z0-9-]+$/);
const docker = (args, input) =>
  execFileSync('docker', args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 8e6, timeout: 60000 });
const id = docker(['inspect', '--format', '{{.Id}}', profile]).trim();
assert.ok(docker(['inspect', '--format', '{{.Config.Image}}', profile]).includes('kicbase'));
const binary = '/var/lib/minikube/binaries/v1.35.1/kubectl';
const kube = (args, input) =>
  docker(
    ['exec', '-i', profile, binary, '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=30s', ...args],
    input,
  );
const namespace = `rivet-fence-${randomUUID().slice(0, 8)}`,
  workload = 'rivet-execution',
  release = 'rivet-fence';
const label = { 'app.kubernetes.io/instance': release, 'app.kubernetes.io/component': 'execution' };
const annotation = 'rivet.dev/execution-retirement-fence';
const create = (r) => JSON.parse(kube(['create', '-f', '-', '-o', 'json'], JSON.stringify(r)));
const ns = create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } });
const folder = path.resolve('artifacts', namespace);
await fs.mkdir(folder, { recursive: false });
const inventory = {
  profile,
  containerId: id,
  namespace,
  namespaceUid: ns.metadata.uid,
  image,
  kind: 'local-protocol-only',
};
await fs.writeFile(path.join(folder, 'inventory.json'), JSON.stringify(inventory, null, 2));
const wait = async (check, description) => {
  const end = Date.now() + 300000;
  while (!(await check())) {
    if (Date.now() >= end) throw Error(`Local fence proof timed out: ${description}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const getPods = () =>
  JSON.parse(kube(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=${release}`, '-o', 'json'])).items;
const ready = (p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
const writeActive = (name, value) =>
  kube([
    '-n',
    namespace,
    'exec',
    name,
    '--',
    'node',
    '-e',
    `require('node:fs').writeFileSync('/tmp/active','${value}')`,
  ]);
const proof = { ...inventory, events: [], simulatedCpuMetrics: true, applicationStorageQualified: false };
try {
  create({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'observer', namespace } });
  create({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'observer', namespace },
    rules: [
      {
        apiGroups: [''],
        resources: ['pods', 'configmaps'],
        verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'],
      },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
      { apiGroups: ['apps'], resources: ['statefulsets', 'statefulsets/scale'], verbs: ['get', 'patch'] },
      { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['list'] },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['list'] },
    ],
  });
  create({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'observer', namespace },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'observer' },
    subjects: [{ kind: 'ServiceAccount', name: 'observer', namespace }],
  });
  const probe = await fs.readFile('deploy/studio-server/scripts/fixtures/execution-fence-probe.mjs', 'utf8');
  const retire = `const r=await fetch('http://127.0.0.1:8080/status',process.argv[2]?{method:'POST',body:JSON.stringify({operationId:process.argv[2],incarnation:process.argv[3],action:process.argv[4]})}:{});if(!r.ok)process.exit(1);console.log(await r.text());`;
  create({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'probe', namespace },
    data: { 'probe.mjs': probe, 'retire-backend.mjs': retire, sentinel: 'preserved' },
  });
  create({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: workload, namespace },
    spec: { selector: label, ports: [{ port: 8080 }] },
  });
  const owner = create({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: workload, namespace, labels: label },
    spec: {
      replicas: 3,
      podManagementPolicy: 'Parallel',
      serviceName: workload,
      updateStrategy: { type: 'OnDelete' },
      selector: { matchLabels: label },
      template: {
        metadata: { labels: label },
        spec: {
          automountServiceAccountToken: false,
          // Probe owns no external work. Real application drain/grace is tested separately.
          terminationGracePeriodSeconds: 1,
          containers: [
            {
              name: 'api',
              image,
              imagePullPolicy: 'Never',
              command: ['node', '/fixture/probe.mjs'],
              env: [
                { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
                {
                  name: 'STARTUP_FENCE',
                  valueFrom: { fieldRef: { fieldPath: `metadata.annotations['${annotation}']` } },
                },
              ],
              readinessProbe: { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 1 },
              resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '128Mi' } },
              volumeMounts: [
                { name: 'probe', mountPath: '/fixture', readOnly: true },
                {
                  name: 'probe',
                  mountPath: '/opt/rivet/retire-backend.mjs',
                  subPath: 'retire-backend.mjs',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [{ name: 'probe', configMap: { name: 'probe' } }],
        },
      },
    },
  });
  await wait(() => getPods().length === 3 && getPods().every(ready), 'initial scheduling');
  const tail = getPods().find((p) => p.metadata.name.endsWith('-2'));
  kube(['-n', namespace, 'annotate', 'pod', tail.metadata.name, `${annotation}=${workload}-0`]);
  writeActive(tail.metadata.name, 1);
  const token = kube(['-n', namespace, 'create', 'token', 'observer', '--duration=15m']).trim();
  const ca = docker(['exec', profile, 'cat', '/var/lib/minikube/certs/ca.crt']);
  const port = docker(['port', profile, '8443/tcp']).trim().split('\n')[0];
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  const { WebSocket } = createRequire(path.resolve('packages/studio-server-api/package.json'))('ws');
  const transport = createKubernetesTransport({
    origin: `https://${port}`,
    ca: () => ca,
    token: () => token,
    WebSocketClass: WebSocket,
    timeoutMs: 15000,
  });
  const baseJson = transport.json;
  let failed = false;
  transport.json = async (method, url, body, type) => {
    if (url.startsWith('/apis/metrics.k8s.io/'))
      return {
        items: getPods().map((p) => ({
          metadata: { name: p.metadata.name },
          timestamp: new Date().toISOString(),
          containers: [{ name: 'api', usage: { cpu: '1n' } }],
        })),
      };
    if (!failed && method === 'PATCH' && url.includes(`/pods/${tail.metadata.name}`)) {
      failed = true;
      throw Error('Injected local pre-write failure');
    }
    return baseJson(method, url, body, type);
  };
  const policy = autoscalerPolicy({
    minReplicas: 2,
    maxReplicas: 5,
    stabilizationSeconds: 30,
    cooldownSeconds: 1,
    withdrawalSeconds: 1,
    pollSeconds: 15,
  });
  const io = createExecutionAutoscalerIO({ transport, release, namespace, workload, service: workload, image, policy });
  const tick = async () => {
    const result = await reconcileExecutionAutoscaling({
      io,
      release,
      namespace,
      workload,
      image,
      policy,
      runner: 'local-proof',
      manifestDigest: 'local-proof',
    });
    proof.events.push(result);
    return result;
  };
  await wait(async () => {
    try {
      await tick();
      return false;
    } catch (error) {
      assert.match(error.message, /Injected/);
      return true;
    }
  }, 'stable low demand and injected metadata failure');
  assert.equal((await io.readJournal()).phase, 'fencing');
  assert.equal((await tick()).state, 'withdrawing');
  for (const p of getPods()) writeActive(p.metadata.name, 30);
  assert.equal((await tick()).state, 'scaled-up');
  await wait(
    () =>
      getPods().length === 5 &&
      getPods()
        .filter((p) => p.metadata.name !== tail.metadata.name)
        .every(ready),
    'growth while fenced',
  );
  const inherited = getPods().find((p) => p.metadata.name.endsWith('-4'));
  assert.equal(inherited.metadata.annotations[annotation], tail.metadata.name);
  for (const p of getPods()) writeActive(p.metadata.name, p.metadata.name === tail.metadata.name ? 1 : 0);
  await wait(async () => {
    await tick();
    return (await io.readJournal()).phase === 'draining';
  }, 'routing withdrawal');
  assert.equal((await tick()).state, 'waiting-for-work');
  assert.equal(getPods().find((p) => p.metadata.name === tail.metadata.name).metadata.uid, tail.metadata.uid);
  writeActive(tail.metadata.name, 0);
  await wait(async () => {
    await tick();
    return (await io.readJournal()).phase === 'complete';
  }, 'interior replacement');
  await wait(async () => {
    await tick();
    return getPods().length === 2 && (await io.readJournal()).phase === 'complete';
  }, 'inherited later ordinals retire');
  assert.ok(getPods().every(ready));
  assert.equal(
    JSON.parse(kube(['-n', namespace, 'get', 'configmap', 'probe', '-o', 'json'])).data.sentinel,
    'preserved',
  );
  proof.outcome = 'passed';
  proof.finalReplicas = 2;
  proof.workloadUid = owner.metadata.uid;
} finally {
  proof.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(
    JSON.stringify({
      folder,
      outcome: proof.outcome ?? 'failed',
      namespace,
      cleanup: 'Delete only the separately recorded disposable local profile after inspecting this result.',
    }),
  );
}
