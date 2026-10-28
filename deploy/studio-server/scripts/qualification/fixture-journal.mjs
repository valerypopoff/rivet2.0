import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { removeStagingExact } from '../lib/reusable-staging-cleanup.mjs';

const plurals = {
  ConfigMap: ['v1', 'configmaps'],
  Secret: ['v1', 'secrets'],
  Service: ['v1', 'services'],
  Pod: ['v1', 'pods'],
  ServiceAccount: ['v1', 'serviceaccounts'],
  Role: ['rbac.authorization.k8s.io/v1', 'roles'],
  RoleBinding: ['rbac.authorization.k8s.io/v1', 'rolebindings'],
};
export class FixtureJournal {
  constructor(state) {
    this.state = state;
  }
  async create(object) {
    const state = this.state;
    await state.admission();
    const { record } = await state.read();
    assert.equal(object.metadata.namespace, record.namespace);
    const [version, plural] = plurals[object.kind] ?? [];
    assert.equal(object.apiVersion, version);
    const root = `${version === 'v1' ? '/api' : '/apis'}/${version}/namespaces/${record.namespace}/${plural}`;
    const apiPath = `${root}/${object.metadata.name}`,
      nonce = randomUUID();
    assert.equal(await state.api.json('GET', apiPath), null, 'Fixture name is occupied');
    await state.change((r) => {
      r.fixtureIntents ??= [];
      r.fixtureIntents.push({ apiPath, nonce, kind: object.kind });
    });
    const created = await state.api.json('POST', root, {
      ...object,
      metadata: {
        ...object.metadata,
        annotations: { ...object.metadata.annotations, 'rivet.dev/fixture-nonce': nonce },
      },
    });
    assert.ok(created.metadata.uid);
    await state.change((r) => {
      r.fixtureIntents.find((i) => i.nonce === nonce).uid = created.metadata.uid;
    });
    return created;
  }
  async remove(object) {
    const { record } = await this.state.read();
    const intent = record.fixtureIntents.find((i) => i.uid === object.metadata.uid);
    assert.ok(intent);
    await removeStagingExact(this.state, { uid: intent.uid, apiPath: intent.apiPath });
  }
  async processIntent(item) {
    await this.state.admission();
    const id = randomUUID();
    await this.state.change((r) => {
      r.processes.push({ ...item, id, state: 'intent' });
    });
    return id;
  }
  async processIdentity(id, identity) {
    await this.state.change((r) => {
      const item = r.processes.find((i) => i.id === id);
      assert.ok(item && item.state === 'intent');
      assert.equal(item.uid, identity.podUid);
      Object.assign(item, identity, { state: 'running' });
    });
  }
  async processSettled(id) {
    await this.state.change((r) => {
      const item = r.processes.find((i) => i.id === id);
      assert.ok(item);
      item.state = 'settled';
    });
  }
}
