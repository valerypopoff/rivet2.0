import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { acquireFixtureFileLock } from './fixture-file-lock.mjs';
import { autoscalerPolicyDigest } from '../lib/execution-autoscaler.mjs';

const kind = process.argv[2];
const original = process.argv.slice(3);
const directory = process.env.RIVET_COMMAND_FIXTURE;
if (!directory) throw Error('This stand-in requires an explicit local fixture directory.');
const stateFile = path.join(directory, 'state.json'),
  lockFile = path.join(directory, 'state.lock');
// Heartbeat and foreground command children share the simulated API server.
// Serialize reads/writes just as its resourceVersion preconditions require.
const lock = acquireFixtureFileLock(lockFile);
let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const logs = path.join(directory, 'calls.ndjson');
const args = [];
for (let i = 0; i < original.length; i++) {
  if (['--kube-context', '--context', '-n', '--namespace'].includes(original[i])) {
    if (original[i].includes('context') && original[i + 1] !== 'fixture-context') throw Error('Unexpected context.');
    i++;
    continue;
  }
  if (original[i].startsWith('--request-timeout=')) continue;
  args.push(original[i]);
}
const readInput = () => JSON.parse(fs.readFileSync(0, 'utf8'));
const clone = structuredClone;
const component = (r) => r.metadata?.labels?.['app.kubernetes.io/component'];
const touch = (r) => {
  r.metadata.resourceVersion = String(++state.version);
};
const find = (type, name) => state.resources.find((r) => r.kind === type && r.metadata.name === name);
const reference = (r) => ({ kind: r.kind, name: r.metadata.name, uid: r.metadata.uid, controller: true });
const fail = (message) => {
  throw Error(message);
};
const output = (value) => (typeof value === 'string' ? value : JSON.stringify(value));

function reconcile(resource, templateChanged = false) {
  const role = component(resource),
    desired = resource.spec.replicas;
  const revision = createHash('sha256').update(JSON.stringify(resource.spec.template)).digest('hex').slice(0, 12);
  resource.metadata.generation ??= 1;
  resource.metadata.annotations ??= {};
  resource.metadata.annotations['deployment.kubernetes.io/revision'] = revision;
  if (resource.kind === 'Deployment') {
    state.resources = state.resources.filter(
      (r) => r.kind !== 'ReplicaSet' || !r.metadata.ownerReferences?.some((o) => o.uid === resource.metadata.uid),
    );
    state.pods = state.pods.filter((p) => component(p) !== role);
    const rs = {
      kind: 'ReplicaSet',
      metadata: {
        name: `${resource.metadata.name}-${revision}`,
        namespace: state.namespace,
        uid: randomUUID(),
        labels: { ...resource.metadata.labels, 'pod-template-hash': revision },
        annotations: { 'deployment.kubernetes.io/revision': revision },
        ownerReferences: [reference(resource)],
      },
      spec: { replicas: desired, template: clone(resource.spec.template) },
      status: { replicas: desired },
    };
    state.resources.push(rs);
  }
  const owner =
    resource.kind === 'Deployment'
      ? state.resources.find(
          (r) => r.kind === 'ReplicaSet' && r.metadata.ownerReferences?.some((o) => o.uid === resource.metadata.uid),
        )
      : resource;
  if (
    resource.kind === 'StatefulSet' &&
    templateChanged &&
    (resource.spec.updateStrategy?.type ?? 'RollingUpdate') === 'RollingUpdate'
  )
    state.pods = state.pods.filter((p) => !p.metadata.ownerReferences?.some((o) => o.uid === owner.metadata.uid));
  state.pods = state.pods.filter(
    (p) =>
      !p.metadata.ownerReferences?.some((o) => o.uid === owner.metadata.uid) ||
      Number(p.metadata.name.split('-').at(-1)) < desired,
  );
  for (let i = 0; i < desired; i++) {
    const name = `${resource.metadata.name}-${i}`;
    if (state.pods.some((p) => p.metadata.name === name)) continue;
    const pod = {
      kind: 'Pod',
      metadata: {
        name,
        namespace: state.namespace,
        uid: randomUUID(),
        labels: {
          ...resource.spec.template.metadata.labels,
          'controller-revision-hash': revision,
          'pod-template-hash': revision,
        },
        ownerReferences: [reference(owner)],
      },
      spec: { ...clone(resource.spec.template.spec), nodeName: 'fixture-node' },
      status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
    };
    state.pods.push(pod);
    state.retirements[name] = { protocol: 1, withdrawalProtocol: 1, incarnation: randomUUID(), state: 'serving' };
    if (
      role === 'backend' &&
      resource.spec.template.spec.containers.some((c) =>
        c.env?.some((e) => e.name === 'RIVET_HA_CONTROL_PLANE_MODE' && e.value === 'singleton-overlap'),
      )
    ) {
      state.housekeepingOwnerUid ??= pod.metadata.uid;
      state.retirements[name].housekeeping = {
        protocol: 1,
        podUid: pod.metadata.uid,
        incarnation: state.retirements[name].incarnation,
        state: state.housekeepingOwnerUid === pod.metadata.uid ? 'owner' : 'standby',
      };
    }
  }
  const owned = state.pods.filter((p) => p.metadata.ownerReferences?.some((o) => o.uid === owner.metadata.uid));
  resource.status = {
    observedGeneration: resource.metadata.generation,
    replicas: desired,
    readyReplicas: desired,
    availableReplicas: desired,
    updatedReplicas: owned.filter((p) => p.metadata.labels['controller-revision-hash'] === revision).length,
    updateRevision: revision,
    currentRevision: revision,
  };
  touch(resource);
}

function apply(resources) {
  for (const target of resources) {
    const live = find(target.kind, target.metadata.name);
    if (target.metadata.resourceVersion && target.metadata.resourceVersion !== live?.metadata.resourceVersion)
      fail('Conflict: stale Helm workload resourceVersion');
  }
  const wanted = new Set(resources.map((r) => `${r.kind}/${r.metadata.name}`));
  // Helm deletes omitted controllers; Kubernetes then garbage-collects their
  // exact owner chains. In particular fenced validation removes the autoscaler.
  const removed = new Set(
    state.resources
      .filter((r) => r.kind !== 'ReplicaSet' && !wanted.has(`${r.kind}/${r.metadata.name}`))
      .map((r) => r.metadata.uid),
  );
  for (const r of state.resources)
    if (r.kind === 'ReplicaSet' && r.metadata.ownerReferences?.some((owner) => removed.has(owner.uid)))
      removed.add(r.metadata.uid);
  state.pods = state.pods.filter((p) => !p.metadata.ownerReferences?.some((owner) => removed.has(owner.uid)));
  state.resources = state.resources.filter((r) => !removed.has(r.metadata.uid));
  for (const target of resources) {
    if (target.kind === 'Job') continue;
    let live = find(target.kind, target.metadata.name);
    const oldUid = live?.metadata.uid;
    const uid = oldUid ?? randomUUID();
    const copy = clone(target);
    copy.metadata = {
      ...copy.metadata,
      namespace: state.namespace,
      uid,
      generation: (live?.metadata.generation ?? 0) + 1,
    };
    const templateChanged = !live || JSON.stringify(live.spec?.template) !== JSON.stringify(copy.spec?.template);
    if (live) state.resources.splice(state.resources.indexOf(live), 1);
    state.resources.push(copy);
    if (['Deployment', 'StatefulSet'].includes(copy.kind)) reconcile(copy, templateChanged);
    if (copy.kind === 'HorizontalPodAutoscaler') {
      // Ordinary GKE responses need not expose HPAGeneration. Do not let the
      // stand-in invent optional fields that the verifier accidentally requires.
      delete copy.metadata.generation;
      copy.status = {
        currentReplicas: copy.spec.minReplicas,
        desiredReplicas: copy.spec.minReplicas,
        conditions: [
          { type: 'AbleToScale', status: 'True' },
          { type: 'ScalingActive', status: 'True' },
        ],
      };
    }
    if (copy.kind === 'PersistentVolumeClaim') {
      copy.spec.volumeName = 'fixture-volume';
      copy.status = { phase: 'Bound' };
      state.volume ??= {
        kind: 'PersistentVolume',
        metadata: { name: 'fixture-volume', uid: randomUUID() },
        spec: { claimRef: { uid }, accessModes: ['ReadWriteOnce'] },
      };
    }
    touch(copy);
  }
  return resources;
}

function helm() {
  if (args[0] === 'version') return 'v3.20.1';
  if (['lint', 'template'].includes(args[0]))
    return execFileSync(process.env.RIVET_FIXTURE_REAL_HELM, original, {
      encoding: 'utf8',
      env: { ...process.env, KUBECONFIG: path.join(directory, 'empty-kubeconfig') },
    });
  if (args[0] === 'list')
    return state.releaseStatus === 'pending-upgrade' && !args.includes('--all')
      ? []
      : [{ name: state.release, namespace: state.namespace, status: state.releaseStatus ?? 'deployed' }];
  if (args[0] === 'get' && args[1] === 'values') return state.installed;
  if (args[0] === 'get' && args[1] === 'manifest') {
    if (['afterSettlementNotReady', 'afterSettlementPodReplaced'].includes(state.fault)) {
      state.finalManifestReads = (state.finalManifestReads ?? 0) + 1;
      if (state.finalManifestReads === 2) {
        if (state.fault === 'afterSettlementNotReady')
          state.pods[0].status.conditions.find((c) => c.type === 'Ready').status = 'False';
        else state.pods[0].metadata.uid = randomUUID();
      }
    }
    return state.manifest;
  }
  if (args[0] === 'history') return [];
  if (args[0] === 'status') return 'fixture release';
  if (args[0] === 'upgrade') {
    const index = args.indexOf(state.release);
    const chart = args[index + 1],
      flags = [];
    for (let i = index + 2; i < args.length; i++) {
      if (['--values', '-f', '--set', '--set-string'].includes(args[i])) {
        flags.push(args[i], args[++i]);
      }
    }
    const rendered = execFileSync(
      process.env.RIVET_FIXTURE_REAL_HELM,
      ['template', state.release, chart, '--namespace', state.namespace, ...flags],
      { encoding: 'utf8' },
    );
    apply(
      parseAllDocuments(rendered)
        .map((d) => d.toJSON())
        .filter(Boolean),
    );
    state.manifest = rendered;
    // Merge the actual values supplied by the command, in Helm precedence order.
    const merge = (a, b) => {
      for (const [k, v] of Object.entries(b))
        a[k] =
          v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v) : v;
      return a;
    };
    state.installed = parseAllDocuments(fs.readFileSync(path.join(chart, 'values.yaml'), 'utf8'))[0].toJSON();
    for (let i = 0; i < flags.length; i += 2) {
      if (['--values', '-f'].includes(flags[i]))
        merge(state.installed, parseAllDocuments(fs.readFileSync(flags[i + 1], 'utf8'))[0].toJSON());
    }
    if (flags.includes('workflowSchema.migrationJob.enabled=false')) state.finalReady = true;
    if (state.finalReady && state.fault === 'lostFinalApply' && !state.injected) {
      state.injected = true;
      fail('fixture lost final Helm acknowledgement');
    }
    if (['lostTemplate', 'lostTemplateDiagnostics'].includes(state.fault) && !state.injected) {
      state.injected = true;
      fail('fixture lost template acknowledgement');
    }
    return 'fixture upgrade committed';
  }
  fail(`Unsupported fixture Helm call: ${args.join(' ')}`);
}

function kubectl() {
  const kinds = {
    deployment: 'Deployment',
    statefulset: 'StatefulSet',
    service: 'Service',
    hpa: 'HorizontalPodAutoscaler',
    pvc: 'PersistentVolumeClaim',
    persistentvolumeclaim: 'PersistentVolumeClaim',
    pod: 'Pod',
    replicasets: 'ReplicaSet',
    replicaset: 'ReplicaSet',
    daemonset: 'DaemonSet',
    replicationcontroller: 'ReplicationController',
    cronjob: 'CronJob',
    job: 'Job',
  };
  if (args[0] === 'get') {
    const type = args[1],
      name = args[2]?.startsWith('-') ? null : args[2];
    if (type === '--raw') {
      const url = new URL(args[2], 'https://fixture.invalid');
      const select = (object) =>
        !url.searchParams.get('labelSelector') ||
        url.searchParams
          .get('labelSelector')
          .split(',')
          .every((entry) => {
            const [key, value] = entry.split('=');
            return object.metadata.labels?.[key] === value;
          });
      if (url.pathname.startsWith(`/apis/metrics.k8s.io/v1beta1/namespaces/${state.namespace}/pods`))
        return {
          items: state.pods.filter(select).map((p) => ({
            metadata: { name: p.metadata.name },
            timestamp: new Date().toISOString(),
            containers: p.spec.containers.map((c) => ({ name: c.name, usage: { cpu: '1m' } })),
          })),
        };
      if (url.pathname === `/api/v1/namespaces/${state.namespace}/pods`) return { items: state.pods.filter(select) };
      if (url.pathname.startsWith(`/api/v1/namespaces/${state.namespace}/pods/`))
        return state.pods.find((p) => p.metadata.name === url.pathname.split('/').at(-1));
      if (url.pathname.startsWith(`/apis/apps/v1/namespaces/${state.namespace}/statefulsets/`))
        return find('StatefulSet', url.pathname.split('/').at(-1));
      if (url.pathname.startsWith(`/apis/apps/v1/namespaces/${state.namespace}/deployments/`))
        return find('Deployment', url.pathname.split('/').at(-1));
      if (url.pathname === `/apis/apps/v1/namespaces/${state.namespace}/replicasets`)
        return { items: state.resources.filter((r) => r.kind === 'ReplicaSet' && select(r)) };
      if (url.pathname === `/apis/autoscaling/v2/namespaces/${state.namespace}/horizontalpodautoscalers`)
        return { items: state.resources.filter((r) => r.kind === 'HorizontalPodAutoscaler') };
      fail(`Unsupported fixture raw GET: ${url.pathname}`);
    }
    if (
      state.fault === 'inventoryAutoscalerAdvance' &&
      state.claimAdmissionRead &&
      type.startsWith('deployment,statefulset,hpa,pvc') &&
      !state.inventoryAutoscalerAdvanced
    ) {
      const record = JSON.parse(state.journal.data.record);
      if (record.autoscalingProtocol !== 1 || record.phase !== 'complete')
        fail('Expected idle autoscaler before claim');
      state.inventoryAutoscalerAdvanced = true;
      state.journal.data.record = JSON.stringify({
        ...record,
        token: randomUUID(),
        runner: randomUUID(),
        lastSampleAt: Date.now(),
      });
      touch(state.journal);
      state.inventorySampleVersion = state.journal.metadata.resourceVersion;
    }
    if (
      state.finalReady &&
      state.fault === 'lostFinalInventory' &&
      type.startsWith('deployment,statefulset,hpa,pvc') &&
      !state.injected
    ) {
      state.injected = true;
      fail('fixture inventory connection lost after acknowledged Helm');
    }
    if (state.fault === 'unavailableInventory' && type.includes(',pod,'))
      fail('fixture management inventory unavailable');
    if (state.fault === 'settlementDisconnect' && state.finalReady && type.includes(',pod,') && !state.injected) {
      state.injected = true;
      fail('fixture final observation connection lost');
    }
    if (type === 'namespace') {
      state.namespaceReads = (state.namespaceReads ?? 0) + 1;
      if (state.fault === 'changedNamespace' && state.namespaceReads > 1) state.namespaceUid = 'replacement';
      return { metadata: { name: state.namespace, uid: state.namespaceUid } };
    }
    if (type === 'configmap') {
      if (state.fault === 'inventoryAutoscalerAdvance' && state.autoscalerAdvancedDuringBaseline)
        state.claimAdmissionRead = true;
      if ((state.fault === 'controllerRecreation' || state.simulateAutoscaler) && state.finalReady && state.journal) {
        const record = JSON.parse(state.journal.data.record);
        if (record.phase === 'complete' && record.autoscalingProtocol !== 1) {
          // Simulate the recreated controller's normal first tick only after
          // the deployment lease has completed. Never hide an unfinished cutover.
          const controller = state.resources.find((r) => component(r) === 'autoscaler');
          const config = JSON.parse(
            controller.spec.template.spec.containers[0].env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value,
          );
          state.completedCutover = record;
          state.journal.metadata.labels = { 'app.kubernetes.io/instance': state.release };
          state.journal.data.record = JSON.stringify({
            autoscalingProtocol: 1,
            release: state.release,
            namespace: state.namespace,
            phase: 'complete',
            token: randomUUID(),
            runner: randomUUID(),
            leaseExpiresAt: Date.now(),
            lastSampleAt: Date.now(),
            manifestDigest: config.manifestDigest,
            policyDigest: autoscalerPolicyDigest(config.policy),
            controllerUid: controller.metadata.uid,
          });
          touch(state.journal);
        }
      }
      if (state.fault === 'samplingAutoscalerAdvance' && state.journal) {
        const record = JSON.parse(state.journal.data.record);
        if (record.autoscalingProtocol === 1 && record.leaseExpiresAt > Date.now())
          state.samplingLeaseReads = (state.samplingLeaseReads ?? 0) + 1;
      }
      return state.journal ?? '';
    }
    if (type === 'pod') return state.pods.find((p) => p.metadata.name === name) ?? '';
    if (type === 'job') return find('Job', name) ?? '';
    if (type === 'node')
      return {
        metadata: { name, uid: 'fixture-node-uid' },
        spec: {},
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          allocatable: { cpu: '1000', memory: '1Ti', pods: '1000' },
        },
      };
    if (type === 'pods') {
      const selector = args.includes('-l') ? args[args.indexOf('-l') + 1] : null;
      return {
        items: state.pods.filter(
          (p) =>
            !selector ||
            selector.split(',').every((entry) => {
              const [key, value] = entry.split('=');
              return p.metadata.labels?.[key] === value;
            }),
        ),
      };
    }
    if (type === 'pv') return state.volume;
    if (['endpointslice', 'volumeattachments'].includes(type)) return { items: [] };
    const types = type.split(',').map((t) => kinds[t]);
    if (types.some((t) => !t)) fail(`Unsupported fixture get: ${type}`);
    let items = state.resources.filter((r) => types.includes(r.kind));
    if (name) return items.find((r) => r.metadata.name === name) ?? '';
    return { items: type.split(',').includes('pod') ? [...items, ...state.pods] : items };
  }
  if (['create', 'replace'].includes(args[0])) {
    const value = readInput();
    if (value.kind === 'Job' && args[0] === 'create') {
      if (find('Job', value.metadata.name)) fail('Preparation Job already exists');
      const plan = JSON.parse(state.journal.data.record).preparation;
      if (!plan?.jobs.some((j) => j.name === value.metadata.name && j.createIssued)) fail('Preparation intent missing');
      value.metadata.uid = randomUUID();
      touch(value);
      value.status = { conditions: [{ type: 'Complete', status: 'True' }] };
      state.resources.push(value);
      state.pods.push({
        kind: 'Pod',
        metadata: {
          name: value.metadata.name + '-pod',
          namespace: state.namespace,
          uid: randomUUID(),
          labels: { ...value.spec.template.metadata.labels, 'job-name': value.metadata.name },
          ownerReferences: [reference(value)],
        },
        spec: { ...clone(value.spec.template.spec), nodeName: 'fixture-node' },
        status: { phase: 'Succeeded' },
      });
      return value;
    }
    if (value.kind !== 'ConfigMap') fail('Fixture only accepts owned journal writes.');
    const initialClaim =
      state.journal &&
      JSON.parse(state.journal.data.record).autoscalingProtocol === 1 &&
      JSON.parse(value.data.record).formatVersion === 1;
    if (initialClaim && state.fault === 'claimConflict') {
      touch(state.journal); // A sampling tick after the fresh read still wins CAS.
      fail('Conflict: fixture journal advanced immediately before claim');
    }
    if (value.metadata.resourceVersion !== state.journal?.metadata.resourceVersion)
      fail('Conflict: fixture journal resourceVersion');
    if (value.metadata.uid && value.metadata.uid !== state.journal?.metadata.uid) fail('Conflict: fixture journal UID');
    if (state.inventoryAutoscalerAdvanced && JSON.parse(state.journal.data.record).autoscalingProtocol === 1)
      state.claimVersion = value.metadata.resourceVersion;
    value.metadata.uid = state.journal?.metadata.uid ?? randomUUID();
    touch(value);
    state.journal = value;
    if (initialClaim && state.fault === 'lostClaimAcknowledgement') fail('Fixture lost accepted claim acknowledgement');
    return value;
  }
  if (args[0] === 'exec') {
    const pod = state.pods.find((p) => p.metadata.name === args[1]);
    if (!pod) fail('Unknown fixture pod');
    if (args.includes('wget')) return { ok: true, profile: 'execution' };
    if (args.includes('-e') && args.some((a) => a.includes('/metrics')))
      return 'rivet_published_execution_active_runs 0\nrivet_published_execution_admission_limit{mode="enforce"} 4\n';
    if (args.includes('--input-type=module'))
      return {
        protocol: 1,
        housekeepingOverlapProtocol: 1,
        maintenanceIdle: true,
        executionOwnedProxySettings: component(pod) === 'execution',
        scheduledRunScope:
          component(pod) === 'execution' ? 'published' : component(pod) === 'backend' ? 'latest' : null,
      };
    if (args.includes('-e')) return '';
    const status = state.retirements[args[1]];
    if (args.includes('--housekeeping-release') || args.includes('--housekeeping-acquire')) {
      if (args.at(-2) !== status.incarnation) fail('Housekeeping incarnation changed');
      const action = args.includes('--housekeeping-release') ? 'release' : 'acquire';
      status.housekeeping.state = action === 'release' ? 'released' : 'owner';
      status.housekeeping.operationId = args.at(-3);
      state.housekeepingOwnerUid = action === 'release' ? null : pod.metadata.uid;
      if (state.fault === `lostHousekeeping-${action}` && !state.injected) {
        state.injected = true;
        fail('fixture lost housekeeping acknowledgement');
      }
    }
    if (args.includes('--withdraw-only') || args.includes('--begin-only')) {
      if (args.at(-2) !== status.incarnation) fail('Incarnation changed');
      status.operationId = args.at(-3);
      status.state = args.includes('--begin-only') ? 'drained' : 'withdrawing';
      if (state.fault === 'lostBegin' && args.includes('--begin-only') && !state.injected) {
        state.injected = true;
        fail('fixture lost begin acknowledgement');
      }
    }
    return status;
  }
  if (args[0] === 'scale') {
    const [type, name] = args[1].split('/'),
      resource = find(kinds[type], name);
    if (!resource) fail('Missing scale workload');
    const expected = args.find((a) => a.startsWith('--resource-version='))?.split('=')[1];
    if (expected && expected !== resource.metadata.resourceVersion) fail('Conflict: fixture scale resourceVersion');
    const count = args.find((a) => a.startsWith('--current-replicas='))?.split('=')[1];
    if (count !== undefined && Number(count) !== resource.spec.replicas) fail('Conflict: fixture replicas');
    resource.spec.replicas = Number(args.find((a) => a.startsWith('--replicas=')).split('=')[1]);
    reconcile(resource);
    return '';
  }
  if (args[0] === 'patch') {
    const resource = find(kinds[args[1]], args[2]),
      patch = JSON.parse(args.at(-1));
    if (patch[0].value !== resource.metadata.uid || patch[1].value !== resource.metadata.resourceVersion)
      fail('Conflict: fixture patch identity');
    if (patch.at(-1).path === '/spec/replicas') {
      if (resource.spec.replicas !== patch[2].value) fail('Conflict: fixture replicas');
      resource.spec.replicas = patch.at(-1).value;
    } else resource.spec.template = patch.at(-1).value;
    reconcile(resource);
    return '';
  }
  if (args[0] === 'delete') {
    if (args[1] === 'hpa') {
      state.resources = state.resources.filter(
        (r) => r.kind !== 'HorizontalPodAutoscaler' || r.metadata.name !== args[2],
      );
      return '';
    }
    const name = args[2].split('/').at(-1),
      deletion = readInput();
    if (args[2].includes('/jobs/')) {
      const job = find('Job', name);
      if (
        !job ||
        deletion.propagationPolicy !== 'Foreground' ||
        job.metadata.uid !== deletion.preconditions.uid ||
        job.metadata.resourceVersion !== deletion.preconditions.resourceVersion
      )
        fail('Unsafe preparation Job deletion');
      state.resources = state.resources.filter((r) => r !== job);
      state.pods = state.pods.filter((p) => !p.metadata.ownerReferences?.some((o) => o.uid === job.metadata.uid));
      return { kind: 'Status' };
    }
    if (args[2].includes('/horizontalpodautoscalers/')) {
      const hpa = find('HorizontalPodAutoscaler', name);
      if (
        !hpa ||
        hpa.metadata.uid !== deletion.preconditions.uid ||
        hpa.metadata.resourceVersion !== deletion.preconditions.resourceVersion
      )
        fail('Conflict: fixture HPA identity');
      state.resources = state.resources.filter((r) => r !== hpa);
      return '';
    }
    if (args[2].includes('/pods/')) {
      const pod = state.pods.find((p) => p.metadata.name === name);
      if (pod?.metadata.uid !== deletion.preconditions.uid) fail('Conflict: fixture deletion UID');
      state.pods = state.pods.filter((p) => p !== pod);
      const owner = state.resources.find(
        (r) => r.kind === 'StatefulSet' && pod.metadata.ownerReferences.some((o) => o.uid === r.metadata.uid),
      );
      if (owner) reconcile(owner);
      return '';
    }
    const resource = find('StatefulSet', name);
    if (resource?.metadata.uid !== deletion.preconditions.uid || resource.spec.replicas !== 0)
      fail('Unsafe fixture controller deletion');
    state.resources = state.resources.filter((r) => r !== resource);
    return '';
  }
  fail(`Unsupported fixture kubectl call: ${args.join(' ')}`);
}

try {
  fs.appendFileSync(logs, JSON.stringify({ kind, args }) + '\n');
  const result = kind === 'helm' ? helm() : kubectl();
  process.stdout.write(output(result));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.closeSync(lock);
  fs.unlinkSync(lockFile);
}
