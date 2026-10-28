import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ready, role, until } from './provider-gate.mjs';
const here = process.env.RIVET_QUALIFICATION_BUNDLE_DIRECTORY ?? path.dirname(fileURLToPath(import.meta.url));
export function faultControllerTemplate(original, namespace, release) {
  const name = 'rivet-runtime-fault';
  const spec = structuredClone(original);
  assert.equal(spec.spec.serviceAccountName, release + '-autoscaler');
  assert.equal(spec.spec.containers.length, 1);
  assert.equal(spec.spec.containers[0].name, 'autoscaler');
  assert.ok(!(spec.spec.volumes ?? []).some((v) => v.name === 'fixture-service-account'));
  assert.ok(
    !(spec.spec.containers[0].volumeMounts ?? []).some(
      (v) => v.mountPath === '/var/run/secrets/kubernetes.io/serviceaccount',
    ),
  );
  spec.spec.automountServiceAccountToken = false;
  spec.spec.volumes = [
    ...(spec.spec.volumes ?? []),
    {
      name: 'fixture-service-account',
      projected: {
        sources: [
          { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
          { secret: { name, items: [{ key: 'tls.crt', path: 'ca.crt' }] } },
          {
            downwardAPI: {
              items: [{ path: 'namespace', fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' } }],
            },
          },
        ],
      },
    },
  ];
  const container = spec.spec.containers[0];
  assert.ok(!(container.env ?? []).some((e) => /^KUBERNETES_SERVICE_(HOST|PORT_HTTPS)$/.test(e.name)));
  container.env = [
    ...(container.env ?? []),
    { name: 'KUBERNETES_SERVICE_HOST', value: name + '.' + namespace + '.svc' },
    { name: 'KUBERNETES_SERVICE_PORT_HTTPS', value: '8443' },
  ];
  container.volumeMounts = [
    ...(container.volumeMounts ?? []),
    { name: 'fixture-service-account', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
  ];
  return spec;
}
export async function installFaultTransport(gate, journal) {
  const operation = gate.operation.operationId,
    projectNumber = gate.operation.projectNumber,
    namespace = gate.config.namespace,
    name = 'rivet-runtime-fault';
  const metadata = () => ({ name, namespace, labels: { 'rivet.dev/ha-rehearsal': operation } });
  assert.equal(gate.controllerEnabled, true);
  await gate.assertProofContext();
  const deploymentName = gate.config.release + '-autoscaler';
  const readDeployment = async () =>
    JSON.parse((await gate.kube(['get', 'deployment', deploymentName, '-o', 'json'])).stdout);
  const original = await readDeployment();
  assert.equal(original.spec.replicas, 1);
  const stop = async () => {
    await gate.scaleExact('deployment', deploymentName, 1, 0);
    await until(
      'exact fault-mode controller settled',
      async () => !(await gate.pods()).some((p) => role(p) === 'autoscaler'),
      180000,
    );
  };
  // Freeze the idle controller before provisioning the fixture. Its first
  // resumed observation is missing metrics, never an accidental idle decision.
  await stop();
  const created = [],
    create = async (object) => {
      const result = await journal.create(object);
      created.push(result);
      return result;
    };
  const state = await create({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: metadata(),
    data: { state: JSON.stringify({ mode: 'metrics-missing', operation, projectNumber: projectNumber }) },
  });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-owned-fault-tls-'));
  let cert, key;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(folder, 'tls.key'),
        '-out',
        path.join(folder, 'tls.crt'),
        '-days',
        '1',
        '-subj',
        '/CN=' + name + '.' + namespace + '.svc',
        '-addext',
        `subjectAltName=DNS:${name}.${namespace}.svc,DNS:${name}.${namespace}.svc.cluster.local`,
      ],
      { stdio: 'pipe' },
    );
    cert = await fs.readFile(path.join(folder, 'tls.crt'), 'utf8');
    key = await fs.readFile(path.join(folder, 'tls.key'), 'utf8');
  } finally {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('rivet-owned-fault-tls-'));
    await fs.rm(folder, { recursive: true });
  }
  const certificate = new X509Certificate(cert);
  assert.ok(certificate.checkHost(name + '.' + namespace + '.svc'));
  await create({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/tls',
    metadata: metadata(),
    stringData: { 'tls.crt': cert, 'tls.key': key },
  });
  key = undefined;
  await create({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata(), automountServiceAccountToken: true });
  await create({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: metadata(),
    rules: [{ apiGroups: [''], resources: ['configmaps'], resourceNames: [name], verbs: ['get', 'update'] }],
  });
  await create({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: metadata(),
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name },
    subjects: [{ kind: 'ServiceAccount', name, namespace }],
  });
  const fixtureConfig = {
    operation,
    projectNumber,
    namespace,
    release: gate.config.release,
    maxReplicas: gate.operation.policy.maxReplicas,
    journalName: gate.journalName,
    name,
    controlUid: state.metadata.uid,
    expiresAt: gate.identity.expiresAt,
  };
  const codeMetadata = metadata();
  codeMetadata.name = name + '-code';
  await create({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: codeMetadata,
    data: {
      'fault-transport.mjs': await fs.readFile(path.join(here, 'fault-transport.mjs'), 'utf8'),
      'fault-transport-entry.mjs': await fs.readFile(path.join(here, 'fault-transport-entry.mjs'), 'utf8'),
      'config.json': JSON.stringify(fixtureConfig),
    },
  });
  await create({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata(),
    spec: { selector: { 'rivet.dev/fixture': name }, ports: [{ port: 8443, targetPort: 8443 }] },
  });
  await create({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { ...metadata(), labels: { ...metadata().labels, 'rivet.dev/fixture': name } },
    spec: {
      serviceAccountName: name,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 30,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
      containers: [
        {
          name: 'fixture',
          image: gate.config.images.api.repository + '@' + gate.config.images.api.digest,
          command: ['node', '/fixture/fault-transport-entry.mjs'],
          ports: [{ containerPort: 8443 }],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 },
          resources: {
            requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '1Gi' },
            limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi' },
          },
          volumeMounts: [
            { name: 'code', mountPath: '/fixture', readOnly: true },
            { name: 'tls', mountPath: '/fixture-tls', readOnly: true },
            { name: 'cluster-ca', mountPath: '/cluster-ca', readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: 'code', configMap: { name: name + '-code' } },
        { name: 'tls', secret: { secretName: name } },
        { name: 'cluster-ca', configMap: { name: 'kube-root-ca.crt' } },
      ],
    },
  });
  await gate.kube(['wait', '--for=condition=Ready', 'pod/' + name, '--timeout=300s']);
  const patched = faultControllerTemplate(original.spec.template, namespace, gate.config.release);
  const patchTemplate = async (current, template) =>
    JSON.parse(
      (
        await gate.kube([
          'patch',
          'deployment',
          deploymentName,
          '--type=json',
          '-p',
          JSON.stringify([
            { op: 'test', path: '/metadata/uid', value: original.metadata.uid },
            { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
            { op: 'test', path: '/spec/replicas', value: 0 },
            { op: 'replace', path: '/spec/template', value: template },
          ]),
          '-o',
          'json',
        ])
      ).stdout,
    );
  await gate.artifact(
    'fault-controller-template-intent.json',
    JSON.stringify({ deploymentUid: original.metadata.uid, original: original.spec.template, desired: patched }),
  );
  const installed = await patchTemplate(await readDeployment(), patched);
  await gate.artifact(
    'fault-controller-template-installed.json',
    JSON.stringify({ deploymentUid: installed.metadata.uid, template: installed.spec.template }),
  );
  await gate.scaleExact('deployment', deploymentName, 0, 1);
  await until(
    'real controller Ready through private strict TLS fixture',
    async () => (await gate.pods()).some((p) => role(p) === 'autoscaler' && ready(p)),
    180000,
  );
  let restored = false;
  return {
    controlUid: state.metadata.uid,
    tlsFingerprint: certificate.fingerprint256,
    async read() {
      const value = JSON.parse((await gate.kube(['get', 'configmap', name, '-o', 'json'])).stdout);
      assert.equal(value.metadata.uid, state.metadata.uid);
      return { object: value, state: JSON.parse(value.data.state) };
    },
    async mode(mode) {
      assert.ok(['pass', 'metrics-missing', 'metrics-stale', 'lose-scale-ack-once'].includes(mode));
      const current = await this.read();
      const next = { mode, operation, projectNumber: projectNumber };
      await gate.kube([
        'patch',
        'configmap',
        name,
        '--type=json',
        '-p',
        JSON.stringify([
          { op: 'test', path: '/metadata/uid', value: state.metadata.uid },
          { op: 'test', path: '/metadata/resourceVersion', value: current.object.metadata.resourceVersion },
          { op: 'replace', path: '/data/state', value: JSON.stringify(next) },
        ]),
      ]);
    },
    async restore() {
      assert.equal(restored, false);
      await stop();
      const current = await readDeployment();
      assert.equal(current.metadata.uid, original.metadata.uid);
      assert.ok(
        isDeepStrictEqual(current.spec.template, installed.spec.template),
        'controller template changed outside this fixture; preserve rather than overwrite',
      );
      await patchTemplate(current, original.spec.template);
      await gate.scaleExact('deployment', deploymentName, 0, 1);
      await until(
        'original direct management transport restored',
        async () => (await gate.pods()).some((p) => role(p) === 'autoscaler' && ready(p)),
        180000,
      );
      restored = true;
      const order = ['Pod', 'Service', 'Secret', 'ConfigMap', 'RoleBinding', 'Role', 'ServiceAccount'];
      for (const kind of order)
        for (const object of created.filter((o) => o.kind === kind)) await journal.remove(object);
    },
  };
}
