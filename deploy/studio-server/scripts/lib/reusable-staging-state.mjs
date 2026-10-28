import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { qualificationHash } from './runtime-qualification-execution.mjs';

export const stagingOwner = 'rivet.dev/qualification-operation';
export const stagingRegistry = 'rivet.dev/qualification-registry';
export const stagingInput = 'rivet.dev/qualification-input';
const dns = (value) => {
  assert.match(value, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  return value;
};
export function reusableStagingSettings(value) {
  assert.equal(value.protocol, 1);
  assert.equal(value.mode, 'reusable-cluster');
  assert.match(value.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  assert.notEqual(value.projectId, 'wartime-storyteller');
  assert.match(value.projectNumber, /^[1-9][0-9]+$/);
  for (const key of ['clusterUid', 'gatewayUid']) assert.ok(typeof value[key] === 'string' && value[key]);
  assert.ok(typeof value.context === 'string' && value.context && !/[\r\n\0]/.test(value.context));
  for (const key of ['controlNamespace', 'gatewayNamespace', 'gatewayName', 'runnerNamespace', 'storageClassName'])
    dns(value[key]);
  assert.ok(!['default', 'kube-system', value.controlNamespace].includes(value.runnerNamespace));
  const origin = new URL(value.clusterServer);
  assert.equal(origin.protocol, 'https:');
  assert.equal(origin.origin + '/', origin.href);
  assert.match(value.domain, /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/);
  assert.ok(!value.domain.includes('litnet.com'), 'Production DNS is excluded');
  for (const image of [value.postgresImage, value.objectStorageImage])
    assert.match(image, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  if (value.registrySecret) {
    dns(value.registrySecret.name);
    assert.ok(typeof value.registrySecret.uid === 'string' && value.registrySecret.uid);
  }
  assert.ok(Array.isArray(value.trustedClients) && value.trustedClients.length);
  for (const client of value.trustedClients) {
    const [ip, bits, extra] = client.split('/');
    const family = isIP(ip);
    assert.ok(family && !extra);
    if (bits !== undefined)
      assert.ok(/^\d+$/.test(bits) && Number(bits) > 0 && Number(bits) <= (family === 4 ? 32 : 128));
  }
  return Object.freeze(structuredClone(value));
}
const namespacePath = (name) => `/api/v1/namespaces/${encodeURIComponent(name)}`;
export const stagingRecordPath = (settings, id) => `${namespacePath(settings.controlNamespace)}/configmaps/${id}`;
export function assertStagingRecord(object, operation, settings) {
  assert.ok(object?.metadata.uid && object.metadata.resourceVersion);
  assert.equal(object.metadata.namespace, settings.controlNamespace);
  assert.equal(object.metadata.labels?.[stagingOwner], operation.operationId);
  const record = JSON.parse(object.data.record);
  const { inputHash, ...input } = record.operation;
  assert.equal(qualificationHash(input), inputHash);
  assert.equal(record.namespace, `rivet-staging-${operation.operationId}`);
  assert.equal(record.release, 'rivet-qualification');
  assert.equal(record.protocol, 1);
  assert.equal(record.operation.inputHash, operation.inputHash);
  assert.equal(record.operation.operationId, operation.operationId);
  assert.equal(record.operation.projectId, settings.projectId);
  assert.equal(record.operation.projectNumber, settings.projectNumber);
  assert.equal(record.operation.staging.clusterUid, settings.clusterUid);
  return record;
}

/** Durable records live in the pre-existing control namespace. No expiry,
 * heartbeat or process number alone grants cleanup ownership. */
export class ReusableStagingState {
  constructor(api, settings, operation) {
    assert.match(operation.operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
    dns(`rivet-staging-${operation.operationId}`);
    this.api = api;
    this.settings = settings;
    this.operation = operation;
  }
  async cluster() {
    assert.equal(this.operation.projectId, this.settings.projectId);
    assert.equal(this.operation.projectNumber, this.settings.projectNumber);
    assert.equal(this.operation.staging.clusterUid, this.settings.clusterUid);
    assert.equal(this.operation.staging.gatewayUid, this.settings.gatewayUid);
    assert.equal(this.operation.staging.clusterServer, this.settings.clusterServer);
    const system = await this.api.json('GET', namespacePath('kube-system'));
    assert.equal(system?.metadata.uid, this.settings.clusterUid, 'Staging cluster identity changed');
    const gateway = await this.api.json(
      'GET',
      `/apis/gateway.networking.k8s.io/v1/namespaces/${this.settings.gatewayNamespace}/gateways/${this.settings.gatewayName}`,
    );
    assert.equal(gateway?.metadata.uid, this.settings.gatewayUid, 'Shared staging Gateway changed');
    assert.ok(!gateway.metadata.deletionTimestamp);
  }
  async read() {
    await this.cluster();
    const object = await this.api.json('GET', stagingRecordPath(this.settings, this.operation.operationId));
    assert.ok(object, 'Operation registry is missing; never recreate an uncertain operation');
    return { object, record: assertStagingRecord(object, this.operation, this.settings) };
  }
  async change(transform) {
    const { object, record } = await this.read();
    const next = structuredClone(record);
    await transform(next);
    assert.equal(next.operation.inputHash, record.operation.inputHash);
    assert.equal(qualificationHash(next.operation), qualificationHash(record.operation));
    assert.ok(
      Buffer.byteLength(JSON.stringify(next)) < 800000,
      'Bounded operation registry exhausted; stop and inspect',
    );
    const result = await this.api.json('PUT', stagingRecordPath(this.settings, this.operation.operationId), {
      ...object,
      data: { record: JSON.stringify(next) },
    });
    assert.equal(result.metadata.uid, object.metadata.uid);
    return next;
  }
  async arm(actor) {
    await this.cluster();
    assert.equal(actor.namespace, this.settings.runnerNamespace);
    const pod = await this.api.json('GET', `${namespacePath(actor.namespace)}/pods/${dns(actor.name)}`);
    assert.equal(pod?.metadata.uid, actor.uid);
    assert.ok(!pod.metadata.deletionTimestamp);
    assert.equal(pod.metadata.labels?.['rivet.dev/qualification-runner'], 'true');
    const node = await this.api.json('GET', `/api/v1/nodes/${dns(pod.spec.nodeName)}`);
    assert.ok(node?.metadata.uid && node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
    // An existing record is never a successful create acknowledgement.
    assert.equal(await this.api.json('GET', stagingRecordPath(this.settings, this.operation.operationId)), null);
    const object = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: this.operation.operationId,
        namespace: this.settings.controlNamespace,
        labels: { [stagingOwner]: this.operation.operationId },
      },
      data: {
        record: JSON.stringify({
          protocol: 1,
          operation: this.operation,
          actor,
          namespace: `rivet-staging-${this.operation.operationId}`,
          release: 'rivet-qualification',
          actorNode: { name: node.metadata.name, uid: node.metadata.uid },
          creationNonce: randomUUID(),
          namespaceUid: null,
          closed: false,
          workers: [],
          inventory: [],
          processes: [],
          phase: 'armed',
          cleanupOwner: null,
        }),
      },
    };
    const created = await this.api.json('POST', `${namespacePath(this.settings.controlNamespace)}/configmaps`, object);
    const janitor = await this.api.json(
      'GET',
      `${namespacePath(this.settings.controlNamespace)}/configmaps/rivet-qualification-janitor-health`,
    );
    const health = JSON.parse(janitor?.data?.health ?? '{}');
    assert.equal(health.clusterUid, this.settings.clusterUid);
    assert.equal(
      health.driverDigest,
      this.operation.driverBundleSha256,
      'Independent janitor has not approved this exact driver',
    );
    assert.ok(
      Number.isFinite(health.observedAt) &&
        Date.now() - health.observedAt >= 0 &&
        Date.now() - health.observedAt < 60000,
      'Independent janitor is not freshly healthy',
    );
    const owner = await this.api.json(
      'GET',
      `${namespacePath(this.settings.controlNamespace)}/pods/${dns(health.podName)}`,
    );
    assert.equal(owner?.metadata.uid, health.podUid);
    assert.ok(!owner.metadata.deletionTimestamp);
    return {
      identity: created.metadata.uid,
      expiresAt: this.operation.expiresAt,
      maxUsd: this.operation.maxUsd,
      stagingClusterUid: this.settings.clusterUid,
      armed: true,
      independent: true,
      billableActivation: false,
    };
  }
  async namespace({ create = false } = {}) {
    const { object, record } = await this.read();
    const url = namespacePath(record.namespace);
    let current = await this.api.json('GET', url);
    if (!current && create) {
      assert.ok(!record.namespaceUid && !record.namespaceCreateIssued && !record.closed);
      assert.ok(Date.now() < Date.parse(this.operation.expiresAt));
      await this.change((r) => {
        r.namespaceCreateIssued = true;
      });
      current = await this.api.json('POST', '/api/v1/namespaces', {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: record.namespace,
          labels: {
            [stagingOwner]: this.operation.operationId,
            'rivet.release-gate/owned': 'true',
            'rivet.dev/qualification-route': 'true',
          },
          annotations: {
            [stagingRegistry]: object.metadata.uid,
            [stagingInput]: this.operation.inputHash,
            'rivet.dev/qualification-nonce': record.creationNonce,
          },
        },
      });
    }
    if (!current) {
      assert.ok(
        !record.namespaceCreateIssued || record.namespaceUid,
        'Namespace CREATE remains uncertain; inspect without replay or absence claims',
      );
      assert.ok(!record.namespaceUid || !create);
      return null;
    }
    assert.equal(current.metadata.labels?.[stagingOwner], this.operation.operationId);
    assert.equal(current.metadata.annotations?.[stagingRegistry], object.metadata.uid);
    assert.equal(current.metadata.annotations?.[stagingInput], this.operation.inputHash);
    assert.equal(current.metadata.annotations?.['rivet.dev/qualification-nonce'], record.creationNonce);
    if (record.namespaceUid) assert.equal(current.metadata.uid, record.namespaceUid);
    else {
      // Reconcile an uncertain CREATE using its unique persisted intent/nonce,
      // never another POST or a namespace name alone.
      assert.ok(record.namespaceCreateIssued || create);
      await this.change((r) => {
        assert.ok(!r.namespaceUid);
        r.namespaceUid = current.metadata.uid;
      });
    }
    return current;
  }
  async admission() {
    const { record } = await this.read();
    assert.ok(!record.closed && Date.now() < Date.parse(this.operation.expiresAt), 'Staging test admission is closed');
    await this.namespace();
  }
  async claimCleanup(owner, { expired = false } = {}) {
    assert.ok([this.settings.runnerNamespace, this.settings.controlNamespace].includes(owner.namespace));
    const pod = await this.api.json('GET', `${namespacePath(owner.namespace)}/pods/${dns(owner.name)}`);
    assert.equal(pod?.metadata.uid, owner.uid);
    assert.ok(!pod.metadata.deletionTimestamp);
    const { record } = await this.read();
    if (expired) assert.ok(Date.now() >= Date.parse(this.operation.expiresAt));
    const previous = record.cleanupOwner;
    if (previous && previous.uid !== owner.uid) {
      const current = await this.api.json('GET', `${namespacePath(previous.namespace)}/pods/${previous.name}`);
      assert.ok(!current || current.metadata.uid !== previous.uid, 'A live or paused cleanup owner blocks takeover');
    }
    await this.change((r) => {
      assert.equal(r.cleanupOwner?.uid ?? null, previous?.uid ?? null);
      r.closed = true;
      r.cleanupOwner = owner;
    });
  }
}
