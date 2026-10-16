import test from 'node:test';
import assert from 'node:assert/strict';
import { HaReleaseGate } from './kubernetes-ha-release-gate.mjs';
import { parseAllDocuments } from 'yaml';

test('disposable PostgreSQL really provides the HA fixture connection budget', async () => {
  const gate = new HaReleaseGate({ namespace: 'fixture' }, 'unused', 'unused');
  let postgres;
  gate.kubectl = async (args, extra) => {
    if (args[0] === 'get') return { stdout: 'local-node' };
    if (extra?.input)
      for (const doc of parseAllDocuments(extra.input)) {
        assert.equal(doc.errors.length, 0);
        const resource = doc.toJSON();
        if (resource?.kind === 'Deployment' && resource.metadata.name === 'release-gate-postgres')
          postgres = resource.spec.template.spec.containers[0];
      }
    return { stdout: '' };
  };
  gate.waitForDependency = async () => {};
  await gate.installDependencies();
  assert.deepEqual(postgres.args, ['postgres', '-c', 'max_connections=250']);
});

test('HA preparation never deletes or rotates Secrets in an existing namespace', async () => {
  const gate = new HaReleaseGate({ namespace: 'existing' }, 'unused', 'unused');
  const calls = [];
  gate.assertLocalContext = async () => {};
  gate.kubectl = async (args) => {
    calls.push(args);
    return { stdout: 'namespace/existing\n' };
  };
  gate.createNamespace = async () => {
    throw Error('must not mutate');
  };
  await assert.rejects(gate.prepare(), /fresh disposable namespace/);
  assert.deepEqual(calls, [['get', 'namespace', 'existing', '--ignore-not-found', '-o', 'name']]);
});

test('the local proof cannot select a production context, even when allow-context matches', async () => {
  const gate = new HaReleaseGate({ context: 'gke-production', allowedContext: 'gke-production' }, 'unused', 'unused');
  gate.kubectl = async () => {
    throw Error('must not access cluster');
  };
  await assert.rejects(gate.assertLocalContext(), /disposable local cluster/);
});
