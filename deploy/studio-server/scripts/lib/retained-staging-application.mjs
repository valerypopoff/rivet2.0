import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function retainedApplicationSettings(input) {
  assert.equal(input.protocol, 1);
  for (const key of ['namespace', 'recordName']) assert.match(input[key], /^rivet-staging-[a-z0-9][a-z0-9-]{0,38}$/);
  return { protocol: 1, namespace: input.namespace, recordName: input.recordName };
}

/** The application has a durable owner separate from per-test cleanup. Time or
 * a process heartbeat never permits another test to adopt a dirty installation. */
export class RetainedStagingApplication {
  constructor(state) {
    this.state = state;
    this.settings = retainedApplicationSettings(state.operation.retainedApplication);
    assert.deepEqual(this.settings, state.settings.retainedApplication);
    this.path = `/api/v1/namespaces/${state.settings.controlNamespace}/configmaps/${this.settings.recordName}`;
  }
  async read() {
    const object = await this.state.api.json('GET', this.path);
    if (!object) return null;
    assert.ok(object.metadata.uid && !object.metadata.deletionTimestamp);
    const record = JSON.parse(object.data.record);
    assert.equal(record.protocol, 1);
    assert.equal(record.clusterUid, this.state.settings.clusterUid);
    assert.equal(record.projectNumber, this.state.settings.projectNumber);
    assert.equal(record.namespace, this.settings.namespace);
    assert.ok(record.nonce);
    return { object, record };
  }
  async change(transform, expected) {
    const { object, record } = await this.read();
    if (expected) {
      assert.equal(object.metadata.uid, expected.metadata.uid);
      assert.equal(
        object.metadata.resourceVersion,
        expected.metadata.resourceVersion,
        'Retained application changed during admission; inspect rather than retry',
      );
    }
    const next = structuredClone(record);
    await transform(next);
    const result = await this.state.api.json('PUT', this.path, { ...object, data: { record: JSON.stringify(next) } });
    assert.equal(result.metadata.uid, object.metadata.uid);
    return next;
  }
  async acquire(registryUid) {
    const state = this.state,
      operation = state.operation;
    let current = await this.read();
    const binding = { operationId: operation.operationId, inputHash: operation.inputHash, registryUid };
    if (current) {
      assert.equal(
        current.record.phase,
        'idle',
        'Retained staging is busy or quarantined; recover it before another attempt',
      );
      assert.equal(
        current.record.manifestDigest,
        operation.predecessorManifestDigest,
        'Retained staging differs from installed production; explicit recovery/reseed is required',
      );
      assert.ok(current.record.namespaceUid);
      const previous = await state.api.json(
        'GET',
        `/api/v1/namespaces/${state.settings.controlNamespace}/configmaps/${current.record.lastOperationId}`,
      );
      const receipt = previous && JSON.parse(previous.data.record);
      assert.ok(
        receipt?.closed && receipt.cleanupVerified,
        'Previous retained cleanup acknowledgement is not confirmed',
      );
      await this.change((record) => {
        assert.equal(record.phase, 'idle');
        record.phase = 'owned';
        record.owner = binding;
      }, current.object);
    } else {
      await state.change((record) => {
        assert.ok(!record.applicationCreateIssued, 'Retained application creation is uncertain');
        record.applicationCreateIssued = true;
      });
      const object = await state.api.json('POST', this.path.slice(0, this.path.lastIndexOf('/')), {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: this.settings.recordName,
          namespace: state.settings.controlNamespace,
          labels: { 'rivet.dev/retained-staging': 'true' },
        },
        data: {
          record: JSON.stringify({
            protocol: 1,
            phase: 'owned',
            owner: binding,
            nonce: randomUUID(),
            namespace: this.settings.namespace,
            namespaceUid: null,
            projectNumber: state.settings.projectNumber,
            clusterUid: state.settings.clusterUid,
            manifestDigest: null,
          }),
        },
      });
      assert.ok(object.metadata.uid);
    }
    current = await this.read();
    assert.deepEqual(current.record.owner, binding);
    const identity = {
      name: this.settings.recordName,
      uid: current.object.metadata.uid,
      nonce: current.record.nonce,
      bootstrap: !current.record.namespaceUid,
    };
    await state.change((record) => {
      record.namespace = this.settings.namespace;
      record.namespaceUid = current.record.namespaceUid;
      record.creationNonce = current.record.nonce;
      record.retainedApplication = identity;
    });
    return identity;
  }
  async owned() {
    const current = await this.read(),
      { object, record } = await this.state.read();
    assert.equal(current?.object.metadata.uid, record.retainedApplication?.uid);
    assert.equal(current.record.nonce, record.creationNonce);
    if (current.record.namespaceUid) assert.equal(current.record.namespaceUid, record.namespaceUid);
    assert.deepEqual(current.record.owner, {
      operationId: this.state.operation.operationId,
      inputHash: this.state.operation.inputHash,
      registryUid: object.metadata.uid,
    });
    assert.equal(current.record.phase, 'owned');
    return current;
  }
  async reconcileAcquisition() {
    const current = await this.read(),
      { object, record } = await this.state.read();
    if (record.retainedApplication) {
      if (
        ['idle', 'quarantined'].includes(current?.record.phase) &&
        current.record.lastOperationId === this.state.operation.operationId &&
        !current.record.owner
      ) {
        // A finish PUT can commit before its reply or per-attempt receipt is
        // saved. Observe that exact completion; never acquire or finish again.
        assert.equal(current.object.metadata.uid, record.retainedApplication.uid);
        assert.equal(current.record.nonce, record.creationNonce);
        assert.equal(current.record.namespaceUid, record.namespaceUid);
        assert.ok(record.closed && record.acceptedWorkSettled);
        const receipt = current.record.lastReceipt;
        assert.equal(receipt?.operationId, this.state.operation.operationId);
        assert.equal(typeof receipt.healthy, 'boolean');
        assert.equal(typeof receipt.dataCleaned, 'boolean');
        const healthy = receipt.healthy && receipt.dataCleaned;
        assert.equal(current.record.phase, healthy ? 'idle' : 'quarantined');
        assert.equal(
          receipt.manifestDigest,
          healthy ? this.state.operation.candidateManifestDigest : this.state.operation.predecessorManifestDigest,
        );
        await this.state.change((value) => {
          value.retainedCleanup = {
            ...receipt,
            namespaceUid: current.record.namespaceUid,
            phase: current.record.phase,
          };
        });
        return true;
      }
      await this.owned();
      return true;
    }
    const binding = {
      operationId: this.state.operation.operationId,
      inputHash: this.state.operation.inputHash,
      registryUid: object.metadata.uid,
    };
    if (!isDeepStrictEqual(current?.record.owner, binding)) {
      assert.ok(
        !record.namespaceCreateIssued && !record.fixtureFolder,
        'An unbound retained attempt has unexpected application writes',
      );
      return false;
    }
    // Observe an acknowledged/uncertain acquisition; never send another PUT.
    await this.state.change((value) => {
      value.namespace = this.settings.namespace;
      value.namespaceUid = current.record.namespaceUid;
      value.creationNonce = current.record.nonce;
      value.retainedApplication = {
        name: this.settings.recordName,
        uid: current.object.metadata.uid,
        nonce: current.record.nonce,
        bootstrap: !current.record.namespaceUid,
      };
    });
    await this.owned();
    return true;
  }
  async namespaceCreated(uid) {
    const current = await this.owned();
    await this.change((record) => {
      assert.ok(!record.namespaceUid || record.namespaceUid === uid);
      record.namespaceUid = uid;
    }, current.object);
  }
  async finish({ healthy, dataCleaned, manifestDigest }) {
    const current = await this.owned();
    const result = await this.change((record) => {
      record.phase = healthy && dataCleaned ? 'idle' : 'quarantined';
      record.lastOperationId = this.state.operation.operationId;
      record.lastReceipt = { healthy, dataCleaned, manifestDigest, operationId: this.state.operation.operationId };
      if (healthy && dataCleaned) record.manifestDigest = manifestDigest;
      delete record.owner;
    }, current.object);
    return { ...result.lastReceipt, namespaceUid: result.namespaceUid, phase: result.phase };
  }
}
