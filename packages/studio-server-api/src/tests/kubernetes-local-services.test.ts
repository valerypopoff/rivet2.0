import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { repoRoot } from './helpers/repo-contract-helpers.js';
import path from 'node:path';

const yaml = createRequire(path.join(repoRoot, 'package.json'))('yaml');
const configModule = await import(
  new URL('../../../../deploy/studio-server/scripts/lib/kubernetes-launcher-config.mjs', import.meta.url).href
);
const services = await import(
  new URL('../../../../deploy/studio-server/scripts/lib/local-kubernetes-services.mjs', import.meta.url).href
);
const env = {
  RIVET_K8S_LOCAL_MANAGED_SERVICES: 'true',
  RIVET_K8S_CONTEXT: 'restore-test',
  RIVET_K8S_CLUSTER_PROVIDER: 'minikube',
  RIVET_K8S_LOCAL_POSTGRES_PASSWORD: 'p@ss:/word',
  RIVET_KEY: 'rivet-test-key-with-at-least-32-characters',
  RIVET_K8S_STORAGE_BUCKET: 'test-bucket',
  RIVET_K8S_STORAGE_REGION: 'us-east-1',
  RIVET_K8S_STORAGE_ACCESS_KEY_ID: 'test-access',
  RIVET_K8S_STORAGE_ACCESS_KEY: 'test-secret',
};
const config = () => configModule.buildKubernetesLauncherConfig(env);

function fakeCluster(initial: any[] = []) {
  const objects = new Map(
    initial.map((resource) => [`${resource.kind.toLowerCase()}/${resource.metadata.name}`, resource]),
  );
  const calls: { args: string[]; input?: string }[] = [];
  const run = async (args: string[], options: { input?: string } = {}) => {
    calls.push({ args, input: options.input });
    const commandIndex = args[0] === '-n' ? 2 : 0;
    const command = args[commandIndex];
    const name =
      command === 'delete'
        ? args
            .find((arg) => arg.startsWith('--field-selector=metadata.name='))
            ?.split('=')
            .slice(2)
            .join('=')
        : args[commandIndex + 2];
    const key = `${args[commandIndex + 1]?.toLowerCase()}/${name}`;
    if (command === 'get') return { stdout: JSON.stringify(objects.get(key) ?? null).replace(/^null$/, '') };
    if (command === 'create' || command === 'apply') {
      const input = JSON.parse(options.input!);
      for (const resource of input.items ?? [input])
        objects.set(`${resource.kind.toLowerCase()}/${resource.metadata.name}`, resource);
    }
    if (command === 'delete') objects.delete(key);
    return { stdout: '' };
  };
  return { objects, calls, run };
}

test('local services use namespace-scoped URLs, escaped credentials, key auth and secret references', () => {
  const c = config();
  assert.equal(
    c.databaseConnectionString,
    'postgresql://rivet:p%40ss%3A%2Fword@rivet-local-postgres.rivet-restore-local.svc.cluster.local:5432/rivet?sslmode=disable',
  );
  assert.equal(c.objectStorage.endpoint, 'http://rivet-local-minio.rivet-restore-local.svc.cluster.local:9000');
  assert.equal(c.objectStorage.forcePathStyle, true);
  assert.equal(c.routeConfig.serverUiAuthMode, 'key');
  assert.equal(c.routeConfig.requireUiGateKey, true);
  const values = yaml.parse(configModule.renderKubernetesLauncherValuesYaml(c));
  assert.equal(values.postgres.maxConnections, 200);
  assert.equal(values.legacyRestore.enabled, true);
  assert.equal(values.appSettings.backend, 'postgres');
  assert.ok(!JSON.stringify(values).includes(env.RIVET_K8S_LOCAL_POSTGRES_PASSWORD));
  const resources = services.localDependencyResources(c);
  assert.equal(resources.length, 6);
  for (const resource of resources) {
    assert.equal(resource.metadata.namespace, c.namespace);
    assert.equal(resource.metadata.labels[services.localOwnerLabel], c.release);
  }
  const deployments = resources.filter((r: any) => r.kind === 'Deployment');
  assert.ok(deployments.every((r: any) => r.spec.strategy.type === 'Recreate'));
  assert.ok(deployments.every((r: any) => !r.spec.template.spec.volumes.some((v: any) => v.hostPath || v.emptyDir)));
  assert.ok(!JSON.stringify(resources).includes(env.RIVET_K8S_LOCAL_POSTGRES_PASSWORD));
  const secrets = yaml
    .parseAllDocuments(configModule.renderKubernetesLauncherSecretManifest(c))
    .map((doc: any) => doc.toJS())
    .filter((r: any) => r.kind === 'Secret');
  assert.ok(secrets.every((r: any) => r.metadata.labels[services.localOwnerLabel] === c.release));
  assert.equal(
    secrets.find((r: any) => r.metadata.name === c.secrets.postgresName).stringData.password,
    env.RIVET_K8S_LOCAL_POSTGRES_PASSWORD,
  );
});

test('local configuration rejects external URLs, remote contexts and incompatible authentication before provisioning', () => {
  for (const overrides of [
    { RIVET_K8S_DATABASE_CONNECTION_STRING: 'postgresql://real-cloud/rivet' },
    { RIVET_K8S_STORAGE_ENDPOINT: 'https://real-cloud.test' },
    { RIVET_SERVER_UI_AUTH_MODE: 'none' },
    { RIVET_K8S_DATABASE_SSL_MODE: 'require' },
    { RIVET_K8S_STORAGE_FORCE_PATH_STYLE: 'false' },
    { RIVET_K8S_CLUSTER_PROVIDER: 'generic' },
    { RIVET_K8S_NAMESPACE: 'default; delete something' },
    { RIVET_K8S_MINIKUBE_PROFILE: 'another-context' },
    { RIVET_K8S_LOCAL_POSTGRES_SIZE: '0Gi' },
    { RIVET_KEY: 'short' },
    { RIVET_K8S_AUTH_SECRET_NAME: 'same', RIVET_K8S_POSTGRES_SECRET_NAME: 'same' },
  ])
    assert.throws(() => configModule.buildKubernetesLauncherConfig({ ...env, ...overrides }));
});

test('provisioning claims its namespace, installs credentials before workloads, and waits for both dependencies', async () => {
  const c = config();
  const cluster = fakeCluster();
  await services.prepareLocalServices(c, cluster.run, async () => {
    cluster.calls.push({ args: ['apply-secrets'] });
  });
  assert.ok(cluster.calls.find((call) => call.args[0] === 'create'));
  const secretIndex = cluster.calls.findIndex((call) => call.args[0] === 'apply-secrets');
  const workloadIndex = cluster.calls.findIndex((call) => call.args[0] === 'apply');
  assert.ok(secretIndex >= 0 && workloadIndex > secretIndex);
  assert.equal(cluster.calls.filter((call) => call.args.includes('rollout')).length, 2);
  await services.ensureLocalNamespace(c, cluster.run);
  assert.equal(cluster.calls.filter((call) => call.args[0] === 'create').length, 1);
});

test('an unrelated namespace or resource prevents all mutation, including cleanup', async () => {
  const c = config();
  for (const objects of [
    [{ kind: 'namespace', metadata: { name: c.namespace, labels: {} } }],
    [
      { ...services.localNamespaceManifest(c), kind: 'namespace' },
      { kind: 'Service', metadata: { name: c.localServices.minioName, labels: {} } },
    ],
    [
      { ...services.localNamespaceManifest(c), kind: 'namespace' },
      { kind: 'secret', metadata: { name: c.secrets.authName, labels: {} } },
    ],
  ]) {
    const cluster = fakeCluster(objects);
    await assert.rejects(
      services.prepareLocalServices(c, cluster.run, async () => {
        throw new Error('must not apply');
      }),
      /owner|owned/,
    );
    await assert.rejects(services.removeLocalServices(c, cluster.run, { eraseData: true }), /owner|owned/);
    assert.ok(cluster.calls.every((call) => call.args.includes('get')));
  }
});

test('credentials cannot silently change or disappear while local data remains', async () => {
  const c = config();
  const secret = {
    kind: 'secret',
    metadata: { name: c.secrets.postgresName, labels: { [services.localOwnerLabel]: c.release } },
    data: { password: Buffer.from('old-password').toString('base64') },
  };
  const cluster = fakeCluster([secret]);
  await assert.rejects(services.assertLocalCredentials(c, cluster.run), /credentials changed/);
  const missing = fakeCluster(
    services.localDependencyResources(c).filter((r: any) => r.kind === 'PersistentVolumeClaim'),
  );
  await assert.rejects(services.assertLocalCredentials(c, missing.run), /credentials are missing/);
});

test('down retains PVCs, recreate erases only named owned dependencies, and neither deletes namespaces', async () => {
  const c = config();
  for (const eraseData of [false, true]) {
    const cluster = fakeCluster([
      { ...services.localNamespaceManifest(c), kind: 'namespace' },
      ...services.localDependencyResources(c),
    ]);
    await services.removeLocalServices(c, cluster.run, { eraseData });
    const deletes = cluster.calls.filter((call) => call.args.includes('delete'));
    assert.ok(deletes.every((call) => call.args[0] === '-n' && call.args[1] === c.namespace));
    assert.ok(deletes.every((call) => !call.args.includes('namespace')));
    assert.equal(deletes.filter((call) => call.args.includes('PersistentVolumeClaim')).length, eraseData ? 2 : 0);
    assert.equal(deletes.filter((call) => call.args.includes('secret')).length, eraseData ? 3 : 0);
    if (eraseData) {
      assert.ok(
        deletes.findIndex((call) => call.args.includes('PersistentVolumeClaim')) >
          deletes.map((call) => call.args.includes('Deployment')).lastIndexOf(true),
      );
    }
    assert.ok(deletes.every((call) => call.args.includes('-l')));
    assert.ok(deletes.every((call) => call.args[4].startsWith('--field-selector=metadata.name=')));
  }
});

test('cluster permission failures are not mistaken for an absent namespace', async () => {
  let calls = 0;
  await assert.rejects(
    services.ensureLocalNamespace(config(), async () => {
      calls++;
      throw new Error('forbidden');
    }),
    /forbidden/,
  );
  assert.equal(calls, 1);
});

test('a namespace creation race never adopts the competing owner', async () => {
  const c = config();
  const cluster = fakeCluster();
  const run = async (args: string[], options?: { input?: string }) => {
    if (args[0] === 'create') {
      cluster.objects.set(`namespace/${c.namespace}`, { metadata: { name: c.namespace, labels: {} } });
      return { stdout: '', exitCode: 1 };
    }
    return cluster.run(args, options);
  };
  await assert.rejects(services.ensureLocalNamespace(c, run), /not owned/);
  assert.ok(cluster.calls.every((call) => call.args.includes('get')));
});

test('matching persisted secrets allow resume, while bucket/prefix drift is rejected before apply', async () => {
  const c = config();
  const secrets = yaml
    .parseAllDocuments(configModule.renderKubernetesLauncherSecretManifest(c))
    .map((doc: any) => doc.toJS())
    .filter((r: any) => r.kind === 'Secret')
    .map((r: any) => ({
      ...r,
      data: Object.fromEntries(
        Object.entries(r.stringData).map(([key, value]) => [key, Buffer.from(value as string).toString('base64')]),
      ),
    }));
  const cluster = fakeCluster([{ ...services.localNamespaceManifest(c), kind: 'namespace' }, ...secrets]);
  await services.assertLocalCredentials(c, cluster.run);
  for (const property of ['bucket', 'prefix', 'region']) {
    const changed = { ...c, objectStorage: { ...c.objectStorage, [property]: 'different' } };
    await assert.rejects(
      services.prepareLocalServices(changed, cluster.run, async () => {
        throw new Error('must not apply');
      }),
      /credentials changed/,
    );
  }
});
