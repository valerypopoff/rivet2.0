import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixtureDeploymentSafety } from '../fixtures/deployment-safety.mjs';
import {
  assertOnlineEditorResources,
  readRetainedOnlineEditor,
  runKubernetesOnlineEditorAdoption,
} from '../lib/online-editor-kubernetes.mjs';

export async function exerciseOnlineEditorKubernetes(
  installed,
  desired,
  { loseAdmission = false, abortAfterFence = false } = {},
) {
  const { backend, claim, active, services } = assertOnlineEditorResources(installed, desired);
  const identity = { namespace: 'default', release: 'rivet', manifestDigest: 'retained' };
  const objects = new Map(),
    states = new Map(),
    mutations = [];
  let version = 0,
    time = 0,
    held = false;
  const key = (kind, name) => kind.toLowerCase() + '/' + name;
  const get = (kind, name) => objects.get(key(kind, name));
  const store = (input) => {
    const object = structuredClone(input);
    object.metadata.uid ??= randomUUID();
    object.metadata.resourceVersion = String(++version);
    objects.set(key(object.kind, object.metadata.name), object);
    return object;
  };
  const list = (kind) => [...objects.values()].filter((object) => object.kind === kind);
  for (const resource of installed) store(resource);
  for (const service of list('Service')) service.spec.clusterIP ??= '10.96.0.10';
  const backendName = backend.metadata.name,
    controller = get('statefulset', backendName);
  const createPod = (workload, ordinal) => {
    const name = `${workload.metadata.name}-${ordinal}`;
    const parent = { kind: 'StatefulSet', name: workload.metadata.name, uid: workload.metadata.uid, controller: true };
    const revision = store({
      kind: 'ControllerRevision',
      metadata: { name: 'revision-' + version, ownerReferences: [parent] },
      data: { spec: { template: workload.spec.template } },
    });
    const template = workload.spec.template;
    const container = template.spec.containers[0];
    const mode =
      container.command?.[0] === '/bin/sh' && ordinal === 0
        ? 'singleton'
        : container.env.find((entry) => entry.name === 'RIVET_HA_CONTROL_PLANE_MODE').value;
    const fenced = container.env.some(
      (entry) => entry.name === 'RIVET_EXECUTION_STARTUP_FENCE' && entry.value === name,
    );
    const pod = store({
      kind: 'Pod',
      metadata: {
        ...template.metadata,
        name,
        ownerReferences: [parent],
        labels: {
          ...template.metadata.labels,
          'statefulset.kubernetes.io/pod-name': name,
          'controller-revision-hash': revision.metadata.name,
        },
      },
      spec: { ...template.spec, nodeName: 'fixture-node' },
      status: { podIP: '127.0.0.1', conditions: [{ type: 'Ready', status: fenced ? 'False' : 'True' }] },
    });
    const incarnation = randomUUID();
    states.set(name, {
      protocol: 1,
      withdrawalProtocol: 1,
      incarnation,
      state: 'serving',
      operationId: null,
      ...(mode === 'singleton-overlap'
        ? {
            housekeeping: { state: ordinal ? 'standby' : 'owner', podUid: pod.metadata.uid, incarnation },
          }
        : {}),
    });
  };
  createPod(controller, 0);
  const original = get('pod', backendName + '-0').metadata.uid;
  const execution = get('statefulset', active.metadata.name);
  for (let i = 0; i < execution.spec.replicas; i++) createPod(execution, i);
  const published = list('Pod').filter((pod) => pod.metadata.name.startsWith(execution.metadata.name));
  const liveClaim = get('persistentvolumeclaim', claim.metadata.name);
  liveClaim.spec.volumeName = 'fixture-volume';
  liveClaim.status = { phase: 'Bound' };
  store({
    kind: 'PersistentVolume',
    metadata: { name: 'fixture-volume' },
    spec: { claimRef: { uid: liveClaim.metadata.uid } },
  });
  store({
    kind: 'Namespace',
    metadata: {
      name: identity.namespace,
      uid: backend.spec.template.spec.containers[0].env.find((entry) => entry.name === 'RIVET_NAMESPACE_UID').value,
    },
  });
  store({
    kind: 'Node',
    metadata: { name: 'fixture-node' },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      allocatable: { cpu: '50', memory: '80Gi', 'ephemeral-storage': '100Gi', pods: '100' },
    },
  });
  const endpoints = (service) =>
    list('Pod').filter(
      (p) =>
        Object.entries(service.spec.selector).every(([label, value]) => p.metadata.labels[label] === value) &&
        p.status.conditions[0].status === 'True',
    );
  const admission = 'rivet.dev/editor-adoption';
  const observeRoutes = (owner) => {
    for (const spec of services) {
      const routed = endpoints(get('service', spec.metadata.name));
      assert.ok(routed.length > 0, 'Every change retains both editor Service endpoints');
      if (owner) assert.ok(routed.some((pod) => pod.metadata.uid === owner.uid));
    }
    assert.ok(
      published.every((pod) => get('pod', pod.metadata.name) === pod),
      'Published owners cannot be changed by editor adoption',
    );
  };
  const json = (value) => ({ stdout: value === undefined ? '' : JSON.stringify(value) });
  const kube = async ([verb, kind, name, ...tail], options = {}) => {
    if (verb === 'get') {
      if (kind === 'pods') return json({ items: list('Pod') });
      if (kind === 'endpointslice')
        return json({
          items: services.map((service) => ({
            metadata: { labels: { 'kubernetes.io/service-name': service.metadata.name } },
            endpoints: endpoints(get('service', service.metadata.name)).map((p) => ({
              targetRef: { uid: p.metadata.uid },
              conditions: { ready: true },
            })),
          })),
        });
      if (loseAdmission && kind === 'service' && services.some((service) => service.metadata.name === name)) {
        const editors = [0, 1].map((ordinal) => get('pod', `${backendName}-${ordinal}`));
        if (editors.every((pod) => pod?.metadata.labels[admission])) {
          // Reproduce the gap between Pod admission and the first selector CAS.
          for (const pod of editors) {
            delete pod.metadata.labels[admission];
            pod.metadata.resourceVersion = String(++version);
          }
          loseAdmission = false;
        }
      }
      const fullKind = { pvc: 'persistentvolumeclaim', pv: 'persistentvolume' }[kind] ?? kind;
      return json(get(fullKind, name));
    }
    if (verb === 'create' || verb === 'replace') {
      const resource = JSON.parse(options.input);
      const prior = get('configmap', resource.metadata.name);
      assert.equal(resource.metadata.resourceVersion, prior?.metadata.resourceVersion);
      return json(store({ ...resource, metadata: { ...resource.metadata, uid: prior?.metadata.uid } }));
    }
    assert.ok(held, 'A Kubernetes mutation needs the held restore lock');
    if (verb === 'exec') {
      if (tail.at(-1) === '--withdraw-only' || tail.at(-1) === '--begin-only') {
        const state = states.get(kind);
        assert.equal(state.incarnation, tail.at(-2));
        state.operationId = tail.at(-3);
        state.state = tail.at(-1) === '--withdraw-only' ? 'withdrawing' : 'drained';
        get('pod', kind).status.conditions[0].status = 'False';
        observeRoutes();
      }
      return json(states.get(kind));
    }
    if (verb === 'patch') {
      const object = get(kind, name);
      assert.ok(
        name === backendName ||
          name.startsWith(backendName + '-') ||
          services.some((service) => service.metadata.name === name),
      );
      const [uid, rv, mutation] = JSON.parse(tail.at(-1));
      assert.equal(uid.value, object.metadata.uid);
      assert.equal(rv.value, object.metadata.resourceVersion);
      const [, group, field] = mutation.path.split('/');
      object[group][field] = mutation.value;
      object.metadata.resourceVersion = String(++version);
      if (field === 'replicas') {
        if (mutation.value === 2) createPod(controller, 1);
        else {
          assert.equal(states.get(backendName + '-1').state, 'drained');
          objects.delete(key('pod', backendName + '-1'));
        }
      }
      mutations.push(mutation.path);
      if (
        abortAfterFence &&
        field === 'template' &&
        mutation.value.spec.containers[0].env.some((entry) => entry.name === 'RIVET_EXECUTION_STARTUP_FENCE')
      ) {
        createPod(controller, 0);
        observeRoutes();
        throw Error('Editor recreated after the source fence was armed');
      }
    } else if (verb === 'delete') {
      const pod = get('pod', name.split('/').at(-1));
      const { preconditions } = JSON.parse(options.input);
      assert.deepEqual(preconditions, { uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion });
      assert.ok(!pod.metadata.labels[admission]);
      assert.ok(states.get(pod.metadata.name).state === 'drained' || pod.status.conditions[0].status === 'False');
      objects.delete(key('pod', pod.metadata.name));
      createPod(controller, 0);
      mutations.push('delete:' + pod.metadata.uid);
    } else throw Error('Unexpected command: ' + [verb, kind, name, ...tail].join(' '));
    observeRoutes();
    return json();
  };
  const run = (resumeToken, abort) =>
    runKubernetesOnlineEditorAdoption({
      ...identity,
      resumeToken,
      abort,
      installed,
      desired,
      kube,
      safety: fixtureDeploymentSafety('topology', identity),
      timeoutMs: 10_000,
      routingWithdrawalClock: {
        now: () => time,
        wait: async () => {
          time += 1000;
        },
      },
      openRestoreGuard: async (pod) => {
        assert.equal(pod, execution.metadata.name + '-0');
        held = true;
        return {
          check: () => assert.ok(held),
          close: () => {
            held = false;
          },
        };
      },
      verifyTraffic: async (_stage, owner) => observeRoutes(owner),
      verifyDeveloperReady: async (pod) => assert.equal(states.get(pod.name).incarnation, pod.incarnation),
      settle: async (_operation, beforeWrite) => {
        await beforeWrite();
        assert.equal(controller.spec.replicas, 1);
        assert.notEqual(get('pod', backendName + '-0').metadata.uid, original);
        for (const service of services)
          assert.deepEqual(get('service', service.metadata.name).spec.selector, service.spec.selector);
      },
    });
  let resumeToken;
  if (loseAdmission) {
    await assert.rejects(run(), (error) => {
      assert.match(error.message, /no longer matches the proposed Service selector/);
      resumeToken = error.deploymentOperation.token;
      return true;
    });
    for (const service of services)
      assert.deepEqual(get('service', service.metadata.name).spec.selector, {
        ...service.spec.selector,
        'statefulset.kubernetes.io/pod-name': backendName + '-0',
      });
    observeRoutes({ uid: original });
  }
  if (abortAfterFence) {
    await assert.rejects(run(), (error) => {
      assert.match(error.message, /Editor recreated after the source fence was armed/);
      resumeToken = error.deploymentOperation.token;
      return true;
    });
    const aborted = await run(resumeToken, true);
    assert.equal(aborted.abortedBeforeTopologyChanges, true);
    const legacy = get('pod', backendName + '-0');
    controller.status = { updateRevision: legacy.metadata.labels['controller-revision-hash'] };
    const retained = await readRetainedOnlineEditor({ kube, installed, desired });
    assert.deepEqual(retained.pods, [legacy.metadata.uid]);
    get('controllerrevision', retained.revision).data.spec.template = backend.spec.template;
    assert.equal(await readRetainedOnlineEditor({ kube, installed, desired }), undefined);
    assert.equal(held, false);
    return;
  }
  const result = await run(resumeToken);
  assert.equal(result.phase, 'complete');
  assert.ok(mutations.includes('/spec/selector') && mutations.includes('delete:' + original));
  assert.equal(held, false);
}
