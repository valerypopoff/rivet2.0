import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { qualificationHash } from './runtime-qualification-execution.mjs';
import { proxyFixtureProcessCommand } from './staging-proxy-fixture-process.mjs';
import { PendingGatewayBackendError } from './reusable-staging-cloud.mjs';

const nsPath = (name) => `/api/v1/namespaces/${encodeURIComponent(name)}`;
const lists = [
  ['pod', '/api/v1', 'pods'],
  ['service', '/api/v1', 'services'],
  ['pvc', '/api/v1', 'persistentvolumeclaims'],
  ['deployment', '/apis/apps/v1', 'deployments'],
  ['statefulset', '/apis/apps/v1', 'statefulsets'],
  ['job', '/apis/batch/v1', 'jobs'],
  ['httproute', '/apis/gateway.networking.k8s.io/v1', 'httproutes'],
  ['configmap', '/api/v1', 'configmaps'],
  ['secret', '/api/v1', 'secrets'],
  ['healthcheckpolicy', '/apis/networking.gke.io/v1', 'healthcheckpolicies'],
];
export async function observeStagingInventory(state, cloud, { settlement } = {}) {
  const namespace = await state.namespace();
  const { record } = await state.read();
  if (!namespace) {
    assert.ok(
      !record.namespaceUid || record.namespaceDeleteIssued,
      'Namespace disappeared unexpectedly during inventory',
    );
    assert.equal(settlement, undefined, 'Cannot settle a disappeared namespace from an older inventory');
    return record.inventory;
  }
  assert.ok(!namespace.metadata.deletionTimestamp, 'Namespace is deleting during inventory');
  const existing = new Map(record.inventory.map((item) => [item.id, item]));
  const add = (item) => {
    const previous = existing.get(item.id);
    if (previous) assert.deepEqual(previous, item, 'Immutable cleanup identity changed');
    existing.set(item.id, item);
  };
  const base = {
    operationId: state.operation.operationId,
    projectNumber: state.operation.projectNumber,
    newlyCreated: true,
    namespaceUid: namespace.metadata.uid,
  };
  const k8s = (object, kind, apiPath) => {
    assert.ok(object.metadata?.uid && object.metadata.name);
    add({
      ...base,
      id: `k8s:${state.settings.clusterUid}:${object.metadata.uid}`,
      kind,
      name: object.metadata.name,
      uid: object.metadata.uid,
      apiPath,
      billable: kind === 'pod',
    });
  };
  k8s(namespace, 'namespace', nsPath(record.namespace));
  const operationLists = [
    ...lists,
    ...(state.operation.requestContinuityProfile
      ? [['gcpbackendpolicy', '/apis/networking.gke.io/v1', 'gcpbackendpolicies']]
      : []),
  ];
  for (const [kind, version, plural] of operationLists) {
    const root = `${version}/namespaces/${record.namespace}/${plural}`;
    const result = await state.api.json('GET', root);
    assert.ok(Array.isArray(result?.items));
    for (const object of result.items) {
      assert.equal(object.metadata.namespace, record.namespace);
      assert.ok(Date.parse(object.metadata.creationTimestamp) >= Date.parse(namespace.metadata.creationTimestamp));
      k8s(object, kind, `${root}/${object.metadata.name}`);
      if (kind === 'pvc') {
        assert.equal(
          object.status?.phase,
          'Bound',
          'Pending CSI creation is uncertain; preserve the namespace and inspect',
        );
        const pv = await state.api.json('GET', `/api/v1/persistentvolumes/${object.spec.volumeName}`);
        assert.equal(pv?.spec.claimRef.uid, object.metadata.uid);
        assert.equal(pv.spec.claimRef.namespace, record.namespace);
        assert.ok(
          Date.parse(pv.metadata.creationTimestamp) >= Date.parse(namespace.metadata.creationTimestamp),
          'Pre-existing PV is not operation-owned',
        );
        assert.equal(
          pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by'],
          'pd.csi.storage.gke.io',
          'Only new dynamic CSI volumes are cleanup-owned',
        );
        assert.equal(
          pv.spec.persistentVolumeReclaimPolicy,
          'Delete',
          'Retained disks require explicit separate recovery',
        );
        assert.equal(pv.spec.csi?.driver, 'pd.csi.storage.gke.io');
        k8s(pv, 'pv', `/api/v1/persistentvolumes/${pv.metadata.name}`);
        const handle = pv.spec.csi.volumeHandle;
        const disk = await cloud.get(handle);
        assert.ok(disk?.id, 'CSI disk immutable identity unavailable');
        assert.ok(
          Date.parse(disk.creationTimestamp) >= Date.parse(namespace.metadata.creationTimestamp),
          'Pre-existing disk is not operation-owned',
        );
        add({
          ...base,
          id: `gcp:${handle}:${disk.id}`,
          kind: 'disk',
          resource: handle,
          cloudId: String(disk.id),
          billable: true,
        });
      }
      if (kind === 'service' && object.metadata.annotations?.['cloud.google.com/neg']) {
        const status = JSON.parse(object.metadata.annotations['cloud.google.com/neg-status'] ?? '{}');
        // GKE injects ingress:true into internal dependency Services too. With
        // no Ingress and no explicit ports, that is not a pending NEG creation.
        // Existing status always remains inventory-owned, even after withdrawal.
        if (!object.metadata.annotations['cloud.google.com/neg-status']) {
          const intent = JSON.parse(object.metadata.annotations['cloud.google.com/neg']);
          if (object.spec?.type === 'ClusterIP' && intent.ingress === true && Object.keys(intent).length === 1) {
            const ingresses = await state.api.json(
              'GET',
              `/apis/networking.k8s.io/v1/namespaces/${record.namespace}/ingresses`,
            );
            assert.ok(Array.isArray(ingresses?.items));
            if (ingresses.items.length === 0) continue;
          }
        }
        assert.ok(
          status.zones?.length && Object.keys(status.network_endpoint_groups ?? {}).length,
          'NEG creation is uncertain; preserve its Service',
        );
        for (const zone of status.zones)
          for (const name of Object.values(status.network_endpoint_groups)) {
            const resource = `projects/${state.settings.projectId}/zones/${zone}/networkEndpointGroups/${name}`;
            const neg = await cloud.get(resource);
            assert.ok(neg?.id);
            assert.ok(
              Date.parse(neg.creationTimestamp) >= Date.parse(namespace.metadata.creationTimestamp),
              'Pre-existing NEG is not operation-owned',
            );
            add({
              ...base,
              id: `gcp:${resource}:${neg.id}`,
              kind: 'neg',
              resource,
              cloudId: String(neg.id),
              billable: false,
            });
          }
      }
    }
  }
  // Once a complete edge snapshot precedes route withdrawal, disappearance
  // of those exact backends is expected GC. Newly discovered NEG identities
  // still require complete backend/health-check evidence.
  const requiredNegIds = [...existing.values()]
    .filter((i) => i.kind === 'neg' && !record.retiringNegIds?.includes(i.id))
    .map((i) => i.id);
  for (const { resource, value } of await cloud.children([...existing.values()], { requiredNegIds })) {
    assert.ok(
      Date.parse(value.creationTimestamp) >= Date.parse(namespace.metadata.creationTimestamp),
      'Pre-existing Gateway child is not operation-owned',
    );
    add({
      ...base,
      id: `gcp:${resource}:${value.id}`,
      kind: resource.includes('/backendServices/') ? 'backendservice' : 'healthcheck',
      resource,
      cloudId: String(value.id),
      billable: false,
    });
  }
  const observedNamespace = await state.namespace();
  assert.equal(observedNamespace?.metadata.uid, namespace.metadata.uid, 'Namespace disappeared during inventory');
  assert.ok(!observedNamespace.metadata.deletionTimestamp, 'Namespace began deleting during inventory');
  const inventory = [...existing.values()].sort((a, b) => a.id.localeCompare(b.id));
  await state.change((r) => {
    r.inventory = inventory;
    if (settlement !== undefined) {
      assert.equal(r.cleanupOwner?.uid, record.cleanupOwner?.uid);
      assert.equal(r.phase, 'settling');
      r.settlement = settlement;
      r.phase = 'settled'; // Publish only with the final complete inventory.
    }
  });
  return inventory;
}
export async function removeExact(api, resource) {
  const current = await api.json('GET', resource.apiPath);
  if (!current) return;
  assert.equal(current.metadata.uid, resource.uid, 'Deletion target was replaced');
  await api.json('DELETE', resource.apiPath, {
    apiVersion: 'v1',
    kind: 'DeleteOptions',
    propagationPolicy: 'Foreground',
    preconditions: { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion },
  });
}
export async function removeStagingExact(state, resource) {
  const { record } = await state.read();
  const id = `${resource.apiPath}:${resource.uid}`,
    current = await state.api.json('GET', resource.apiPath);
  if (!current) return;
  assert.equal(current.metadata.uid, resource.uid);
  if (record.deletions?.[id]) {
    assert.ok(current.metadata.deletionTimestamp, 'DELETE remains uncertain; inspect instead of replaying');
    return;
  }
  await state.change((r) => {
    r.deletions ??= {};
    assert.ok(!r.deletions[id]);
    r.deletions[id] = { issuedAt: new Date().toISOString() };
  });
  await removeExact(state.api, resource);
}

/** Stop the exact ephemeral Actions runner before expiry takeover. Its absence,
 * not an expired heartbeat, proves that all its phase children stopped. */
export async function stopExpiredStagingWriter(state, wait) {
  const { record } = await state.read();
  assert.ok(Date.now() >= Date.parse(state.operation.expiresAt));
  const actor = record.actor;
  const confirmNode = async () => {
    const node = await state.api.json('GET', `/api/v1/nodes/${record.actorNode.name}`);
    assert.equal(node?.metadata.uid, record.actorNode.uid, 'Original runner node is not confirmed');
    assert.ok(
      node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
      'Unknown runner node state blocks expiry takeover',
    );
  };
  await confirmNode();
  assert.equal(actor.namespace, state.settings.runnerNamespace);
  const apiPath = `${nsPath(actor.namespace)}/pods/${actor.name}`;
  const pod = await state.api.json('GET', apiPath);
  if (pod?.metadata.uid === actor.uid) {
    assert.equal(pod.metadata.labels?.['rivet.dev/qualification-runner'], 'true');
    await state.change((r) => {
      r.closed = true;
      r.writerStopIntent = { ...actor, issuedAt: new Date().toISOString() };
    });
    // Ordinary grace, no --force/zero-grace shortcut. Accepted graphs run on
    // separate API owners and must still drain below.
    if (!pod.metadata.deletionTimestamp) await removeStagingExact(state, { uid: actor.uid, apiPath });
  }
  await wait(
    'exact staging runner exit',
    async () => (await state.api.json('GET', apiPath))?.metadata.uid !== actor.uid,
  );
  await confirmNode(); // API disappearance during an unreachable-node event is not process-exit evidence.
}

export async function settleStagingProcesses(state, wait) {
  const { record } = await state.read();
  for (const item of record.processes.filter((p) => p.state !== 'settled')) {
    assert.match(item.marker, /^\/tmp\/rivet-hpa-load-[a-f0-9-]+\.json$/);
    assert.match(item.stop, /^\/tmp\/rivet-hpa-stop-[a-f0-9-]+$/);
    const url = `${nsPath(record.namespace)}/pods/${item.pod}`;
    const exec = async (command) => {
      assert.equal((await state.api.json('GET', url))?.metadata.uid, item.uid);
      return state.api.exec(`${url}/exec`, command, { container: 'proxy' });
    };
    const pod = await state.api.json('GET', url);
    if (pod?.metadata.uid === item.uid) {
      if (!item.pid) {
        const identity = JSON.parse(await exec(['sh', '-ec', 'test -r "$1"; cat "$1"', 'read-fixture', item.marker]));
        assert.equal(identity.podUid, item.uid);
        assert.ok(Number.isInteger(identity.pid) && identity.pid > 1);
        assert.match(identity.startTicks, /^\d+$/);
        Object.assign(item, identity);
      }
      // An intent's marker is not authority to kill a process. Validate both its
      // precise incarnation and nonce-bearing command, then request normal exit.
      await exec(proxyFixtureProcessCommand(item, { stop: true }));
      await wait('exact bounded proxy fixture exit', async () => {
        if ((await state.api.json('GET', url))?.metadata.uid !== item.uid) return true;
        return (await exec(proxyFixtureProcessCommand(item))).trim() !== item.startTicks;
      });
    }
    await state.change((r) => {
      r.processes.find((p) => p.id === item.id).state = 'settled';
    });
  }
}

export async function settleStaging(state, cloud, owner, wait) {
  await state.claimCleanup(owner);
  const namespace = await state.namespace();
  if (!namespace) {
    const { record } = await state.read();
    if (record.namespaceUid) {
      assert.ok(record.namespaceDeleteIssued, 'Namespace disappeared unexpectedly before a complete cleanup');
      return record.inventory;
    }
    await state.change((r) => {
      r.phase = 'settled';
    });
    return (await state.read()).record.inventory;
  }
  const { record } = await state.read();
  assert.equal(record.cleanupOwner.uid, owner.uid);
  await state.change((r) => {
    assert.equal(r.cleanupOwner.uid, owner.uid);
    r.phase = 'settling';
  });
  await settleStagingProcesses(state, wait);
  // Disable the public test route before draining, without altering the shared
  // Gateway/listener/certificate. Snapshot creation outcomes before deletion.
  const inventory = await wait('complete staging Gateway backend discovery before route withdrawal', async () => {
    try {
      return await observeStagingInventory(state, cloud);
    } catch (error) {
      if (error instanceof PendingGatewayBackendError) return null;
      throw error;
    }
  });
  await state.change((r) => {
    r.retiringNegIds = inventory.filter((i) => i.kind === 'neg').map((i) => i.id);
  });
  for (const route of inventory.filter((r) => r.kind === 'httproute')) await removeStagingExact(state, route);
  const controllerPath = `/apis/apps/v1/namespaces/${record.namespace}/deployments/${record.release}-autoscaler`;
  const object = await state.api.json('GET', controllerPath);
  if (object) {
    assert.ok(
      inventory.some((i) => i.kind === 'deployment' && i.apiPath === controllerPath && i.uid === object.metadata.uid),
      'Controller changed after inventory',
    );
    if (object.spec.replicas !== 0) {
      assert.ok(!record.controllerStopIssued, 'Controller stop remains uncertain; inspect before another write');
      await state.change((r) => {
        r.controllerStopIssued = object.metadata.uid;
      });
      await state.api.json(
        'PATCH',
        controllerPath,
        [
          { op: 'test', path: '/metadata/uid', value: object.metadata.uid },
          { op: 'test', path: '/metadata/resourceVersion', value: object.metadata.resourceVersion },
          { op: 'replace', path: '/spec/replicas', value: 0 },
        ],
        'application/json-patch+json',
      );
    }
  }
  await wait('staging controller exit', async () => {
    const pods = await state.api.json('GET', `${nsPath(record.namespace)}/pods`);
    return pods.items.every((p) => p.metadata.labels?.['app.kubernetes.io/component'] !== 'autoscaler');
  });
  await wait('migration/test jobs physically stopped', async () => {
    const [jobs, pods] = await Promise.all([
      state.api.json('GET', `/apis/batch/v1/namespaces/${record.namespace}/jobs`),
      state.api.json('GET', `${nsPath(record.namespace)}/pods`),
    ]);
    // Zero active is also the initial state of a pending Job, and controller
    // status can lag the actual Pod. Both must establish terminal completion.
    return (
      jobs.items.every(
        (j) =>
          !(j.status?.active > 0) &&
          j.status?.conditions?.some((c) => ['Complete', 'Failed'].includes(c.type) && c.status === 'True'),
      ) &&
      pods.items
        .filter((p) => p.metadata.ownerReferences?.some((o) => o.controller && o.kind === 'Job'))
        .every((p) => ['Succeeded', 'Failed'].includes(p.status?.phase))
    );
  });
  const pods = (await state.api.json('GET', `${nsPath(record.namespace)}/pods`)).items;
  const retirements = [];
  for (const pod of pods.filter((p) =>
    ['backend', 'execution'].includes(p.metadata.labels?.['app.kubernetes.io/component']),
  )) {
    const url = `${nsPath(record.namespace)}/pods/${pod.metadata.name}`;
    const container = pod.metadata.labels['app.kubernetes.io/component'] === 'backend' ? 'backend' : 'api';
    const invoke = async (command) => {
      assert.equal((await state.api.json('GET', url))?.metadata.uid, pod.metadata.uid);
      return JSON.parse(
        await state.api.exec(`${url}/exec`, ['node', '/opt/rivet/retire-backend.mjs', ...command], { container }),
      );
    };
    const status = await invoke([]);
    assert.ok(
      ['serving', 'checking', 'draining', 'drained'].includes(status.state),
      'An unfinished withdrawal needs inspected recovery before cleanup',
    );
    const prior = (await state.read()).record.retirements?.[pod.metadata.uid];
    if (prior) {
      assert.equal(prior.incarnation, status.incarnation);
      assert.equal(
        status.operationId,
        prior.operationId,
        'Unacknowledged retirement requires inspection, never redispatch',
      );
    }
    const operationId = prior?.operationId ?? status.operationId ?? randomUUID();
    await state.change((r) => {
      r.retirements ??= {};
      r.retirements[pod.metadata.uid] = { name: pod.metadata.name, operationId, incarnation: status.incarnation };
    });
    if (status.state !== 'drained') {
      // The supported CLI fences admission and waits accepted work; never abort.
      if (!prior && !status.operationId) {
        try {
          await invoke([operationId, status.incarnation, '120']);
        } catch (error) {
          // The CLI's bounded wait can end before an accepted long graph. One
          // independent status observation can establish acceptance, never a
          // second modifying request or an assumed successful acknowledgement.
          const observed = await invoke([]);
          if (
            observed.incarnation !== status.incarnation ||
            observed.operationId !== operationId ||
            !['checking', 'draining', 'drained'].includes(observed.state)
          )
            throw error;
        }
      }
      await wait('accepted staging work drained', async () => {
        const current = await invoke([]);
        assert.equal(current.incarnation, status.incarnation);
        assert.equal(current.operationId, operationId);
        return current.state === 'drained';
      });
    }
    retirements.push({ uid: pod.metadata.uid, state: 'drained' });
  }
  return observeStagingInventory(state, cloud, { settlement: retirements });
}

export async function cleanupStaging(state, owner) {
  const { record } = await state.read();
  assert.equal(record.cleanupOwner?.uid, owner.uid);
  assert.equal(record.phase, 'settled');
  const namespace = await state.namespace();
  if (!namespace) {
    assert.ok(!record.namespaceUid || record.namespaceDeleteIssued, 'Namespace disappeared unexpectedly');
    return;
  }
  assert.ok(
    record.inventory.some((i) => i.kind === 'namespace' && i.uid === namespace.metadata.uid),
    'Complete inventory is required before namespace deletion',
  );
  assert.ok(!namespace.metadata.deletionTimestamp, 'Namespace deletion began without this operation intent');
  assert.ok(!record.namespaceDeleteIssued, 'Namespace deletion already dispatched; inspect rather than replay');
  await state.change((r) => {
    r.namespaceDeleteIssued = true;
    r.phase = 'deleting';
  });
  await removeExact(state.api, { apiPath: nsPath(record.namespace), uid: namespace.metadata.uid });
}
export async function verifyStagingCleanup(state, cloud) {
  const { record } = await state.read();
  assert.ok(record.closed && ['deleting', 'cleaned', 'settled'].includes(record.phase));
  const namespace = await state.namespace();
  if (record.namespaceDeleteIssued && namespace && !namespace.metadata.deletionTimestamp)
    throw Error('Namespace DELETE acknowledgement uncertain; explicit inspection is required');
  if (namespace) return null;
  if (record.namespaceUid) {
    assert.ok(
      record.namespaceDeleteIssued &&
        record.inventory.some((i) => i.kind === 'namespace' && i.uid === record.namespaceUid),
      'Unexpected namespace absence or incomplete inventory',
    );
  }
  const resources = [];
  for (const item of record.inventory) {
    const current = item.resource ? await cloud.get(item.resource) : await state.api.json('GET', item.apiPath);
    if (current) {
      if (item.uid) assert.equal(current.metadata.uid, item.uid, 'Cleanup target identity changed');
      else assert.equal(String(current.id), item.cloudId, 'Provider target identity changed');
      return null; // Controller garbage collection is an observation, not a write retry.
    }
    resources.push({ id: item.id, state: 'absent' });
  }
  const result = {
    inventoryComplete: true,
    inventoryHash: qualificationHash(record.inventory),
    resources,
    uncertainWrites: 0,
  };
  await state.change((r) => {
    r.phase = 'cleaned';
    r.cleanupVerified = true;
  });
  return result;
}
