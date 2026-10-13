import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './deploy-kubernetes-release.mjs';
import { preserveKubernetesContext } from './lib/kubernetes-context.mjs';
import {
  singleMachineConfig,
  singleMachineValues,
  assertSingleMachineCluster,
} from './lib/single-machine-kubernetes.mjs';
import { legacyServingFixtureEntrypoint } from './lib/legacy-serving-fixture.mjs';

const env = {
  RIVET_K8S_CONTEXT: 'test',
  RIVET_K8S_CLUSTER_PROVIDER: 'k3s',
  RIVET_K8S_RELEASE: 'rivet',
  RIVET_K8S_NAMESPACE: 'rivet',
  RIVET_K8S_LOCAL_MANAGED_SERVICES: 'true',
  RIVET_KEY: 'test-key-with-more-than-thirty-two-characters',
  RIVET_K8S_LOCAL_POSTGRES_PASSWORD: 'test-database-secret',
  RIVET_K8S_STORAGE_ACCESS_KEY_ID: 'test-minio',
  RIVET_K8S_STORAGE_ACCESS_KEY: 'test-minio-secret',
  RIVET_K8S_STORAGE_BUCKET: 'test-bucket',
  RIVET_K8S_STORAGE_REGION: 'us-east-1',
};
const selection = { context: 'test', release: 'rivet', namespace: 'rivet' };
const config = () => singleMachineConfig(env, selection);

test('release CLI accepts the documented Yarn separator but rejects unknown and duplicate options', () => {
  const args = parseArgs(['--', '--single-machine', '--context', 'test', '--dry-run']);
  assert.equal(args.get('--single-machine'), true);
  assert.equal(args.get('--context'), 'test');
  assert.equal(args.get('--dry-run'), true);
  assert.throws(() => parseArgs(['--context', 'test', '--context', 'other']));
  assert.throws(() => parseArgs(['--unknown']));
  assert.throws(() => parseArgs(['--context']));
});

test('Minikube context changes are restored on success and failure, without overriding another choice', async () => {
  for (const failed of [false, true]) {
    for (const selected of ['rivet-test', 'chosen-elsewhere']) {
      let context = 'original';
      const restored = [];
      const operation = preserveKubernetesContext(
        {
          targetContext: 'rivet-test',
          readContext: async () => context,
          restoreContext: async (value) => {
            restored.push(value);
            context = value;
          },
        },
        async () => {
          context = selected;
          if (failed) throw new Error('load failed');
          return 'loaded';
        },
      );
      if (failed) await assert.rejects(operation, /load failed/);
      else assert.equal(await operation, 'loaded');
      assert.deepEqual(restored, selected === 'rivet-test' ? ['original'] : []);
      assert.equal(context, selected === 'rivet-test' ? 'original' : 'chosen-elsewhere');
    }
  }
});

test('a context restoration failure does not hide the original Minikube failure', async () => {
  let context = 'original';
  const operationFailure = new Error('image import outcome unknown');
  const restorationFailure = new Error('kubeconfig write failed');
  await assert.rejects(
    preserveKubernetesContext(
      {
        targetContext: 'rivet-test',
        readContext: async () => context,
        restoreContext: async () => {
          throw restorationFailure;
        },
      },
      async () => {
        context = 'rivet-test';
        throw operationFailure;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [operationFailure, restorationFailure]);
      return true;
    },
  );
});

test('single-machine values share managed storage and keep credentials out of Helm values', () => {
  const c = config();
  assert.equal(c.singleMachine, true);
  assert.equal(c.localServices.postgresName, 'rivet-postgres');
  const values = singleMachineValues(c);
  assert.match(values, /execution: 1/);
  assert.match(values, /backend: postgres/);
  assert.ok(!values.includes(env.RIVET_KEY));
  assert.ok(!values.includes(env.RIVET_K8S_LOCAL_POSTGRES_PASSWORD));
  assert.ok(!values.includes(env.RIVET_K8S_STORAGE_ACCESS_KEY));
});

test('single-machine selection rejects mismatched installation identities and example credentials', () => {
  for (const field of ['context', 'namespace', 'release']) {
    assert.throws(() => singleMachineConfig(env, { ...selection, [field]: 'another' }));
  }
  assert.throws(() =>
    singleMachineConfig({ ...env, RIVET_KEY: 'replace-with-a-random-key-of-at-least-32-characters' }, selection),
  );
  assert.throws(() => singleMachineConfig({ ...env, RIVET_K8S_LOCAL_MANAGED_SERVICES: 'false' }, selection));
  assert.throws(() => singleMachineConfig({ ...env, RIVET_K8S_EXECUTION_REPLICAS: '2' }, selection));
});

function cluster({ server = 'https://127.0.0.1:6443', count = 1, ready = true, version = 'v1.34.1+k3s1' } = {}) {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify(
          args[0] === 'config'
            ? { clusters: [{ cluster: { server } }] }
            : {
                items: Array.from({ length: count }, () => ({
                  status: {
                    nodeInfo: { kubeletVersion: version },
                    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
                  },
                })),
              },
        ),
      };
    },
  };
}

test('single-machine preflight accepts only one ready local K3s node without any mutation', async () => {
  const c = cluster();
  await assertSingleMachineCluster(config(), c.run);
  assert.equal(c.calls.length, 2);
  for (const args of c.calls) assert.ok(['get', 'config'].includes(args[0]));
  for (const options of [
    { server: 'https://production.example:6443' },
    { server: 'http://127.0.0.1:6443' },
    { server: 'https://password@127.0.0.1:6443' },
    { count: 2 },
    { count: 0 },
    { ready: false },
    { version: 'v1.34.1' },
  ]) {
    await assert.rejects(assertSingleMachineCluster(config(), cluster(options).run));
  }
});

test('legacy fixture transformation changes only the explicit managed startup gate', () => {
  const source = [
    '#!/bin/sh',
    'export PORT=8080',
    'NODE_OPTIONS= node --input-type=module -e server-deployment-contract',
    'append_proxy_bootstrap_node_options',
    'exec node /app/packages/studio-server-api/dist/studio-server-api/src/serve.js',
    '',
  ].join('\r\n');
  const fixture = legacyServingFixtureEntrypoint(source);
  assert.equal(
    fixture,
    '#!/bin/sh\nexport PORT=8080\nappend_proxy_bootstrap_node_options\nexec node /app/packages/studio-server-api/dist/studio-server-api/src/server.js\n',
  );
  assert.throws(() => legacyServingFixtureEntrypoint('an unexpected entry point'));
});

test('retired public launchers reject without external tools or storage writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-retired-launch-test-'));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./retired-server-launcher.mjs', import.meta.url))],
      {
        cwd: root,
        env: { PATH: '', SystemRoot: process.env.SystemRoot ?? '', NODE_OPTIONS: '' },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retired/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
