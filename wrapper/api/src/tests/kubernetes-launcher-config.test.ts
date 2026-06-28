import assert from 'node:assert/strict';
import test from 'node:test';

type KubernetesLauncherModule = {
  buildKubernetesLauncherConfig: (env: Record<string, string>) => any;
  renderKubernetesLauncherSecretManifest: (config: any) => string;
  renderKubernetesLauncherValuesYaml: (config: any) => string;
};

let kubernetesLauncherModulePromise: Promise<KubernetesLauncherModule> | null = null;

function loadKubernetesLauncherModule(): Promise<KubernetesLauncherModule> {
  if (kubernetesLauncherModulePromise == null) {
    const moduleUrl = new URL('../../../../scripts/lib/kubernetes-launcher-config.mjs', import.meta.url);
    kubernetesLauncherModulePromise = import(moduleUrl.href) as Promise<KubernetesLauncherModule>;
  }

  return kubernetesLauncherModulePromise;
}

test('kubernetes launcher config uses managed canonical envs and local rehearsal defaults', async () => {
  const { buildKubernetesLauncherConfig } = await loadKubernetesLauncherModule();
  const config = buildKubernetesLauncherConfig({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    RIVET_DATABASE_SSL_MODE: 'verify-full',
    RIVET_STORAGE_BUCKET: 'rivet-prod',
    RIVET_STORAGE_REGION: 'us-east-1',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
    RIVET_KEY: 'shared-key',
    RIVET_K8S_NAMESPACE: 'rivet-dev',
    RIVET_K8S_RELEASE: 'rivet-dev',
    RIVET_K8S_PROXY_PORT: '8090',
    RIVET_K8S_PROXY_REPLICAS: '3',
    RIVET_K8S_WEB_REPLICAS: '2',
    RIVET_K8S_EXECUTION_REPLICAS: '4',
  });

  assert.equal(config.namespace, 'rivet-dev');
  assert.equal(config.release, 'rivet-dev');
  assert.equal(config.localPort, 8090);
  assert.equal(config.context, 'docker-desktop');
  assert.equal(config.localClusterProvider, 'docker-desktop');
  assert.equal(config.minikubeProfile, undefined);
  assert.equal(config.clusterDomain, 'cluster.local');
  assert.equal(config.databaseSslMode, 'verify-full');
  assert.equal(config.loadLocalImages, true);
  assert.equal(config.replicas.proxy, 3);
  assert.equal(config.replicas.web, 2);
  assert.equal(config.replicas.execution, 4);
  assert.equal(config.objectStorage.bucket, 'rivet-prod');
  assert.equal(config.objectStorage.region, 'us-east-1');
  assert.equal(config.routeConfig.webAppsBasePath, '/apps');
  assert.equal(config.routeConfig.latestWebAppsBasePath, '/apps-latest');
  assert.equal(config.routeConfig.enableLatestRemoteDebugger, true);
  assert.equal(config.routeConfig.requireWorkflowKey, false);
  assert.equal(config.routeConfig.requireUiGateKey, false);
});

test('kubernetes launcher config can derive object storage settings from RIVET_STORAGE_URL', async () => {
  const { buildKubernetesLauncherConfig } = await loadKubernetesLauncherModule();
  const config = buildKubernetesLauncherConfig({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    RIVET_STORAGE_URL: 'https://my-bucket.s3.us-east-1.amazonaws.com',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
    RIVET_KEY: 'shared-key',
  });

  assert.equal(config.objectStorage.bucket, 'my-bucket');
  assert.equal(config.objectStorage.endpoint, 'https://s3.us-east-1.amazonaws.com');
  assert.equal(config.objectStorage.region, 'us-east-1');
  assert.equal(config.objectStorage.forcePathStyle, false);
  assert.equal(config.replicas.web, 1);
});

test('kubernetes launcher renderer emits chart values and secrets compatible with the local rehearsal workflow', async () => {
  const {
    buildKubernetesLauncherConfig,
    renderKubernetesLauncherSecretManifest,
    renderKubernetesLauncherValuesYaml,
  } = await loadKubernetesLauncherModule();
  const config = buildKubernetesLauncherConfig({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    RIVET_STORAGE_BUCKET: 'rivet-prod',
    RIVET_STORAGE_REGION: 'us-east-1',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
    RIVET_KEY: 'shared-key',
  });

  const valuesYaml = renderKubernetesLauncherValuesYaml(config);
  const secretManifest = renderKubernetesLauncherSecretManifest(config);

  assert.match(valuesYaml, /connectionStringSecretName: "rivet-postgres-conn"/);
  assert.match(valuesYaml, /accessKeySecretName: "rivet-object-storage"/);
  assert.match(valuesYaml, /clusterDomain: "cluster\.local"/);
  assert.match(valuesYaml, /RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: "true"/);
  assert.match(valuesYaml, /RIVET_PUBLISHED_APPS_BASE_PATH: "\/apps"/);
  assert.match(valuesYaml, /RIVET_LATEST_APPS_BASE_PATH: "\/apps-latest"/);
  assert.match(valuesYaml, /RIVET_WEB_APPS_BASE_PATH: "\/apps"/);
  assert.match(valuesYaml, /RIVET_LATEST_WEB_APPS_BASE_PATH: "\/apps-latest"/);
  assert.match(valuesYaml, /RIVET_REQUIRE_WORKFLOW_KEY: "false"/);
  assert.match(valuesYaml, /RIVET_REQUIRE_UI_GATE_KEY: "false"/);

  assert.match(secretManifest, /kind: Secret/);
  assert.match(secretManifest, /name: rivet-auth/);
  assert.match(secretManifest, /name: rivet-postgres-conn/);
  assert.match(secretManifest, /name: rivet-object-storage/);
  assert.match(secretManifest, /connectionString: "postgresql:\/\/db-user:db-pass@example-db:5432\/rivet\?sslmode=require"/);
});

test('kubernetes launcher config rejects non-managed local modes', async () => {
  const { buildKubernetesLauncherConfig } = await loadKubernetesLauncherModule();
  assert.throws(
    () =>
      buildKubernetesLauncherConfig({
        RIVET_STORAGE_MODE: 'filesystem',
        RIVET_DATABASE_MODE: 'managed',
        RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
        RIVET_STORAGE_BUCKET: 'rivet-prod',
        RIVET_STORAGE_REGION: 'us-east-1',
        RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
        RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
        RIVET_KEY: 'shared-key',
      }),
    /RIVET_STORAGE_MODE must be "managed"/,
  );

  assert.throws(
    () =>
      buildKubernetesLauncherConfig({
        RIVET_STORAGE_MODE: 'managed',
        RIVET_DATABASE_MODE: 'local-docker',
        RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
        RIVET_STORAGE_BUCKET: 'rivet-prod',
        RIVET_STORAGE_REGION: 'us-east-1',
        RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
        RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
        RIVET_KEY: 'shared-key',
      }),
    /RIVET_DATABASE_MODE must be "managed"/,
  );
});

test('kubernetes launcher config can disable local image loading explicitly', async () => {
  const { buildKubernetesLauncherConfig } = await loadKubernetesLauncherModule();
  const config = buildKubernetesLauncherConfig({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    RIVET_STORAGE_BUCKET: 'rivet-prod',
    RIVET_STORAGE_REGION: 'us-east-1',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
    RIVET_KEY: 'shared-key',
    RIVET_K8S_CONTEXT: 'custom-cluster',
    RIVET_K8S_CLUSTER_DOMAIN: 'corp.internal',
    RIVET_K8S_LOAD_LOCAL_IMAGES: 'false',
  });

  assert.equal(config.context, 'custom-cluster');
  assert.equal(config.localClusterProvider, 'generic');
  assert.equal(config.minikubeProfile, undefined);
  assert.equal(config.clusterDomain, 'corp.internal');
  assert.equal(config.loadLocalImages, false);
});

test('kubernetes launcher config treats minikube as a first-class local cluster provider', async () => {
  const { buildKubernetesLauncherConfig } = await loadKubernetesLauncherModule();
  const config = buildKubernetesLauncherConfig({
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'managed',
    RIVET_DATABASE_CONNECTION_STRING: 'postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    RIVET_STORAGE_BUCKET: 'rivet-prod',
    RIVET_STORAGE_REGION: 'us-east-1',
    RIVET_STORAGE_ACCESS_KEY_ID: 'spaces-key',
    RIVET_STORAGE_ACCESS_KEY: 'spaces-secret',
    RIVET_KEY: 'shared-key',
    RIVET_K8S_CONTEXT: 'minikube',
  });

  assert.equal(config.context, 'minikube');
  assert.equal(config.localClusterProvider, 'minikube');
  assert.equal(config.minikubeProfile, 'minikube');
  assert.equal(config.loadLocalImages, true);
});
