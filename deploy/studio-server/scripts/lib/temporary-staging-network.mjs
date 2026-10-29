import assert from 'node:assert/strict';
import { temporaryFoundationSpecs } from './temporary-staging-gcp.mjs';

/** Let GKE finish controller GC before attempting parent deletes. A completed
 * cluster operation alone does not prove its VMs/disks/groups have disappeared.
 * Discovery can block cleanup, but never grants permission to delete a resource. */
export async function settleTemporaryProviderChildren(store, cloud, wait) {
  let { record } = await store.read();
  const cluster = record.resources.find((i) => i.key === 'cluster');
  if ((cluster && !cluster.absent && !cluster.rejected) || record.providerChildrenSettled) return;
  const baseline = new Set(record.baseline.map((i) => `${i.kind}:${i.id}`));
  const roots = new Set(
    temporaryFoundationSpecs(record.plan).flatMap((spec) => {
      const item = record.resources.find((i) => i.key === spec.key);
      return item?.identity ? [`${spec.collection.split('/').at(-1)}:${item.identity.id}`] : [];
    }),
  );
  await wait('GKE child garbage collection before network parent removal', async () => {
    const current = await cloud.snapshot();
    // Routes/firewalls have an explicit, separately checked network-parent
    // cleanup path below. Every other unknown new identity must disappear.
    const pending = current.filter(
      (i) =>
        !baseline.has(`${i.kind}:${i.id}`) &&
        !roots.has(`${i.kind}:${i.id}`) &&
        !['routes', 'firewalls'].includes(i.kind),
    );
    await store.change((r) => {
      r.residualResources = pending;
    });
    return pending.length === 0;
  });
  await store.change((r) => {
    r.providerChildrenSettled = true;
  });
}

/** Only exact post-baseline children of this new immutable network qualify.
 * No prefix matching, pre-existing rule, unrelated network or peering removal. */
export async function removeTemporaryNetworkRules(store, cloud, wait) {
  const { record } = await store.read(),
    spec = temporaryFoundationSpecs(record.plan).find((s) => s.key === 'network');
  const parent = record.resources.find((i) => i.key === 'network');
  assert.ok(parent?.identity && !parent.absent);
  const network = await cloud.get(spec);
  assert.equal(cloud.identity(spec, network).id, parent.identity.id);
  const canonical = (ref) => {
    const url = new URL(ref);
    assert.ok(['https://www.googleapis.com', 'https://compute.googleapis.com'].includes(url.origin));
    return url.pathname
      .replace(/^\/compute\/v1\//, '')
      .replace(`projects/${record.plan.projectNumber}/`, `projects/${record.plan.projectId}/`);
  };
  const baseline = new Set(record.baseline.map((i) => `${i.kind}:${i.id}`));
  for (const value of (await cloud.snapshot()).filter(
    (i) => ['firewalls', 'routes'].includes(i.kind) && i.network && canonical(i.network) === spec.path,
  )) {
    assert.ok(!baseline.has(`${value.kind}:${value.id}`), 'Pre-existing network rule is not operation-owned');
    const resource = canonical(`https://compute.googleapis.com/compute/v1/${value.resource}`);
    assert.match(resource, new RegExp(`^projects/${record.plan.projectId}/global/(firewalls|routes)/[a-z0-9-]+$`));
    let actual = await cloud.request('compute', 'GET', resource);
    assert.equal(String(actual?.id), value.id);
    assert.equal(canonical(actual.network), spec.path);
    if (
      value.kind === 'routes' &&
      (actual.nextHopPeering ||
        ['SUBNET', 'PEERING_SUBNET', 'PEERING_STATIC', 'PEERING_DYNAMIC'].includes(actual.routeType))
    ) {
      await store.change((r) => {
        r.residualResources = [{ ...value, reason: 'managed-route-await-controller' }];
      });
      throw Error('Managed route remains; await controller GC or review the exact hold, never force peering');
    }
    const key = `network-rule-${value.kind}-${value.id}`;
    let item = (await store.read()).record.resources.find((i) => i.key === key);
    if (!item) {
      await store.change((r) => {
        r.resources.push({
          key,
          kind: 'network-rule',
          billable: false,
          apiPath: resource,
          parentId: parent.identity.id,
          identity: { id: value.id, name: value.name },
          description: actual.description ?? '',
          parentObserved: true,
        });
      });
      item = (await store.read()).record.resources.find((i) => i.key === key);
    }
    assert.equal(item.parentId, parent.identity.id);
    assert.equal(item.identity.id, value.id);
    const child = {
      service: 'compute',
      collection: resource.slice(0, resource.lastIndexOf('/')),
      path: resource,
      name: value.name,
      kind: value.kind === 'routes' ? 'route' : 'firewall',
      body: { description: item.description },
    };
    if (!item.deleteIssued) {
      await store.change((r) => {
        r.resources.find((i) => i.key === key).deleteIssued = true;
      });
      const operation = await cloud.remove(child);
      await store.change((r) => {
        r.resources.find((i) => i.key === key).deleteOperation = operation;
      });
      if (operation.targetId) assert.equal(String(operation.targetId), item.identity.id);
      await cloud.wait(child, operation, { wait });
    } else if (item.deleteOperation) await cloud.wait(child, item.deleteOperation, { wait });
    else throw Error('Network-rule deletion is uncertain; inspect without redispatching');
    await wait('exact new network rule absence', async () => {
      actual = await cloud.request('compute', 'GET', resource);
      if (!actual) return true;
      assert.equal(String(actual.id), item.identity.id);
      return false;
    });
    await store.change((r) => {
      r.resources.find((i) => i.key === key).absent = true;
    });
  }
  // A lost DELETE may already have removed a previously recorded child. Prove
  // its exact absence without inventing an acknowledged operation or retrying.
  for (const item of (await store.read()).record.resources.filter((i) => i.kind === 'network-rule' && !i.absent)) {
    const actual = await cloud.request('compute', 'GET', item.apiPath);
    assert.ok(!actual && item.deleteIssued, 'A recorded network-rule outcome remains unknown');
    await store.change((r) => {
      r.resources.find((i) => i.key === item.key).absent = true;
    });
  }
}
