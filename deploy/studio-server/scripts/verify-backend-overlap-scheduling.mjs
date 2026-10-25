import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

// Deliberately has no kubeconfig/context option. Only a named local minikube
// Docker container is reachable; never run against a user's current context.
const container = process.env.RIVET_OVERLAP_LOCAL_NODE;
if (!/^rivet-[a-z0-9-]+$/.test(container ?? '')) throw Error('Select an explicit local Rivet minikube container.');
const docker = (args, input) =>
  execFileSync('docker', args, { input, encoding: 'utf8', windowsHide: true, maxBuffer: 8e6 });
if (!docker(['inspect', '--format', '{{.Config.Image}}', container]).includes('kicbase'))
  throw Error('Not a local minikube node.');
const kubectl = process.env.RIVET_OVERLAP_LOCAL_KUBECTL || '/var/lib/minikube/binaries/v1.35.1/kubectl';
if (!/^\/var\/lib\/minikube\/binaries\/v[0-9.]+\/kubectl$/.test(kubectl))
  throw Error('Unexpected local kubectl binary.');
const kube = (args, input) =>
  docker(
    ['exec', '-i', container, kubectl, '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=30s', ...args],
    input,
  );
const nodes = JSON.parse(kube(['get', 'nodes', '-o', 'json'])).items;
if (nodes.length < 2) throw Error('This test requires a real multi-node local cluster.');
const token = randomUUID(),
  namespace = `rivet-overlap-${token.slice(0, 8)}`;
const label = { 'rivet.dev/local-overlap-operation': token };
const folder = path.resolve('artifacts', namespace);
await fs.mkdir(folder, { recursive: false });
let namespaceUid, claimUid, volume;
const probeImage = `rivet-local/overlap-probe:${token}`;
const imageArchive = path.join(folder, 'probe-image.tar');
const imported = [];
const record = async (extra = {}) =>
  fs.writeFile(
    path.join(folder, 'inventory.json'),
    JSON.stringify(
      {
        localContainer: container,
        namespace,
        namespaceUid,
        claimUid,
        volume,
        token,
        ...extra,
      },
      null,
      2,
    ),
  );
const json = (args) => JSON.parse(kube(['-n', namespace, ...args, '-o', 'json']));
const create = (object) => JSON.parse(kube(['create', '-f', '-', '-o', 'json'], JSON.stringify(object)));
const wait = async (predicate, label) => {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(`Local overlap scheduling timed out: ${label}`);
};
try {
  // Import an operation-unique alias; never depend on cluster internet access or
  // replace a tag that an existing local workload might use on restart.
  docker(['tag', 'node:24-alpine', probeImage]);
  docker(['save', '--output', imageArchive, probeImage]);
  for (const node of nodes) {
    const name = node.metadata.name;
    if (!name.startsWith(container)) throw Error('Foreign local node identity.');
    docker(
      ['exec', '-i', name, 'ctr', '--namespace', 'k8s.io', 'images', 'import', '-'],
      await fs.readFile(imageArchive),
    );
    imported.push(name);
  }
  const ns = create({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: label } });
  namespaceUid = ns.metadata.uid;
  await record();
  const rendered = execFileSync(
    resolveHelmBinOrThrow(process.cwd()),
    [
      'template',
      'rivet',
      'deploy/studio-server/helm',
      '-n',
      namespace,
      '-f',
      'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-ha.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-runtime-ha.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/gke-compact-edge.yaml',
      '--set',
      'objectStorage.bucket=fixture',
      '--set',
      'postgres.maxConnections=250',
      '--set',
      'ha.controlPlane.mode=singleton-overlap',
      '--set',
      `ha.namespaceUid=${namespaceUid}`,
    ],
    { encoding: 'utf8' },
  );
  const backend = parseAllDocuments(rendered)
    .map((d) => d.toJSON())
    .find((r) => r?.kind === 'StatefulSet' && r.metadata.labels['app.kubernetes.io/component'] === 'backend');
  const claim = create({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'scratch', namespace, labels: label },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } }, storageClassName: 'standard' },
  });
  claimUid = claim.metadata.uid;
  await record();
  create({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'backend', namespace, labels: label },
    spec: { clusterIP: 'None', selector: backend.spec.selector.matchLabels, ports: [{ port: 8080 }] },
  });
  const spec = {
    replicas: 1,
    serviceName: 'backend',
    selector: backend.spec.selector,
    updateStrategy: { type: 'OnDelete' },
    podManagementPolicy: 'Parallel',
    template: {
      metadata: { labels: { ...backend.spec.selector.matchLabels, ...label } },
      spec: {
        affinity: backend.spec.template.spec.affinity,
        securityContext: { runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
        initContainers: [
          {
            name: 'fixture-volume-permissions',
            image: probeImage,
            imagePullPolicy: 'Never',
            securityContext: { runAsUser: 0, runAsGroup: 0 },
            command: ['node', '-e', "require('fs').chownSync('/scratch',10001,10001)"],
            volumeMounts: [{ name: 'scratch', mountPath: '/scratch' }],
          },
        ],
        containers: [
          {
            name: 'probe',
            image: probeImage,
            imagePullPolicy: 'Never',
            command: [
              'node',
              '-e',
              `const fs=require('fs');try{fs.writeFileSync('/scratch/proof','${token}',{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}require('http').createServer((q,s)=>s.end('ready')).listen(8080)`,
            ],
            resources: { requests: { cpu: '20m', memory: '32Mi' } },
            readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1 },
            volumeMounts: [{ name: 'scratch', mountPath: '/scratch' }],
          },
        ],
        volumes: [{ name: 'scratch', persistentVolumeClaim: { claimName: 'scratch' } }],
      },
    },
  };
  create({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'backend', namespace, labels: label }, spec });
  const ready = (p) => p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
  const pod0 = await wait(() => {
    const p = json(['get', 'pod', 'backend-0']);
    return ready(p) && p;
  }, 'first self-affinity pod');
  const saved = json(['get', 'pvc', 'scratch']);
  volume = saved.spec.volumeName;
  await record();
  const change = (replicas, cpu) => {
    const live = json(['get', 'statefulset', 'backend']);
    live.spec.replicas = replicas;
    live.spec.template.spec.containers[0].resources.requests.cpu = cpu;
    kube(['replace', '-f', '-'], JSON.stringify(live));
  };
  change(2, '100000');
  await wait(() => {
    const p = json(['get', 'pod', 'backend-1']);
    return p.status?.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'False');
  }, 'insufficient capacity remains pending');
  if (!ready(json(['get', 'pod', 'backend-0']))) throw Error('Pending surge interrupted existing backend.');
  change(1, '20m');
  await wait(
    () => !kube(['-n', namespace, 'get', 'pod', 'backend-1', '--ignore-not-found', '-o', 'name']).trim(),
    'pending surge removal',
  );
  change(2, '20m');
  const pod1 = await wait(() => {
    const p = json(['get', 'pod', 'backend-1']);
    return ready(p) && p;
  }, 'same-node surge');
  if (pod0.spec.nodeName !== pod1.spec.nodeName) throw Error('Backends did not share the RWO node.');
  for (const pod of ['backend-0', 'backend-1']) {
    const bytes = kube([
      '-n',
      namespace,
      'exec',
      pod,
      '--',
      'node',
      '-e',
      "process.stdout.write(require('fs').readFileSync('/scratch/proof','utf8'))",
    ]);
    if (bytes !== token) throw Error('Shared claim bytes changed.');
  }
  if (json(['get', 'pvc', 'scratch']).metadata.uid !== claimUid) throw Error('Claim identity changed.');
  await record({
    passed: true,
    checks: ['initial-self-affinity', 'insufficient-capacity-retains-old', 'same-node-surge', 'shared-rwo-bytes'],
  });
  console.log(`Local multi-node scheduling passed. Evidence: ${folder}`);
} catch (error) {
  if (namespaceUid) {
    await fs.writeFile(path.join(folder, 'failure-pods.json'), kube(['-n', namespace, 'get', 'pods', '-o', 'json']));
    await fs.writeFile(
      path.join(folder, 'failure-events.json'),
      kube(['-n', namespace, 'get', 'events', '-o', 'json']),
    );
  }
  throw error;
} finally {
  if (namespaceUid) {
    const current = JSON.parse(kube(['get', 'namespace', namespace, '-o', 'json']));
    if (current.metadata.uid !== namespaceUid || current.metadata.labels['rivet.dev/local-overlap-operation'] !== token)
      throw Error('Local namespace ownership changed; cleanup refused.');
    kube(
      ['delete', '--raw', `/api/v1/namespaces/${namespace}`, '-f', '-'],
      JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: namespaceUid } }),
    );
    await wait(
      () => !kube(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']).trim(),
      'owned namespace cleanup',
    );
    if (volume)
      await wait(
        () => !kube(['get', 'pv', volume, '--ignore-not-found', '-o', 'name']).trim(),
        'owned local PV cleanup',
      );
    await fs.writeFile(
      path.join(folder, 'cleanup.json'),
      JSON.stringify({ namespaceUid, claimUid, volume, absent: true }),
    );
  }
  for (const name of imported) {
    const normalized = `docker.io/${probeImage}`;
    docker(['exec', name, 'ctr', '--namespace', 'k8s.io', 'images', 'remove', normalized]);
    if (docker(['exec', name, 'ctr', '--namespace', 'k8s.io', 'images', 'list', '-q']).split('\n').includes(normalized))
      throw Error('Owned local probe image alias remains.');
  }
  docker(['image', 'rm', probeImage]);
  await fs.unlink(imageArchive).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
