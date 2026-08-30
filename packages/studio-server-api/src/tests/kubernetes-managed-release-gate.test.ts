import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildManagedReleaseGateConfig,
  imageReference,
  renderManagedReleaseGateValues,
} from '../../../../deploy/studio-server/scripts/lib/kubernetes-managed-release-gate-config.mjs';
import { buildManagedProviderGateConfig } from '../../../../deploy/studio-server/scripts/lib/kubernetes-managed-provider-gate-config.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

function createEnvironment(overrides = {}) {
  return {
    RIVET_K8S_RELEASE_GATE_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_RELEASE_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'release-gate',
    RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: 'release-gate-token',
    ...overrides,
  };
}

test('managed release gate fixture declares the runtime environment assertion', async () => {
  const fixturePath = path.join(
    rootDir,
    'deploy',
    'studio-server',
    'scripts',
    'fixtures',
    'managed-release-gate.rivet-project',
  );
  const fixture = await fs.readFile(fixturePath, 'utf8');

  assert.match(fixture, /\[environment-node\]:code "Environment"/);
  assert.match(fixture, /process\.env\.RIVET_RELEASE_GATE_VALUE/);
  assert.match(fixture, /output->"Delay" delay-node\/input1/);
});

test('managed release gate reserves enough workers for deterministic execution node-drain coverage', async () => {
  const overlay = await fs.readFile(
    path.join(rootDir, 'deploy', 'studio-server', 'helm', 'overlays', 'managed-release-gate.yaml'),
    'utf8',
  );
  const kindTopology = await fs.readFile(
    path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kind-managed-release-cluster.yaml'),
    'utf8',
  );

  assert.match(overlay, /availability:\s*\n\s*topologySpread:\s*\n\s*whenUnsatisfiable: DoNotSchedule/);
  assert.equal((kindTopology.match(/- role: worker/g) ?? []).length, 3);
});

test('managed release gate requires an exact explicitly allowed kube context', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'production',
        }),
      }),
    /must match exactly/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({ RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: '' }),
      }),
    /ALLOW_CONTEXT is required/,
  );
});

test('managed release gate requires every immutable candidate image digest', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: 'latest',
        }),
      }),
    /must be a sha256 OCI digest/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: '',
        }),
      }),
    /EXECUTOR_IMAGE_REPOSITORY is required/,
  );
});

test('managed release gate accepts an exact prior API image only as a complete digest pair', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
        }),
      }),
    /must be supplied together/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_DIGEST: 'latest',
        }),
      }),
    /PREVIOUS_API_IMAGE_DIGEST must be a sha256 OCI digest/,
  );
  const config = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment({
      RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
      RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_DIGEST: digest('e'),
    }),
  });
  assert.equal(imageReference(config.previousApiImage!), `example.test/rivet/api@${digest('e')}`);
  assert.deepEqual(config.managedWorkflowSchema, {
    version: 7,
    minimumRollbackCompatibleVersion: 2,
  });
});

test('managed release gate renders managed storage and digest-pinned image values', () => {
  const config = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment(),
    mode: 'release',
  });
  const values = renderManagedReleaseGateValues(config);

  assert.equal(config.mode, 'release');
  assert.equal(values.images.proxy.pullPolicy, 'Always');
  assert.equal(values.images.proxy.digest, digest('a'));
  assert.equal(values.postgres.host, 'release-gate-postgres');
  assert.equal(values.objectStorage.endpoint, 'http://release-gate-minio:9000');
  assert.equal(values.objectStorage.bucket, 'rivet-release-gate');
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 7, maximumVersion: 7 });
  assert.equal(imageReference(config.images.executor), `example.test/rivet/executor@${digest('d')}`);
});

test('managed release gate allows preloaded local images without weakening the default pull policy', () => {
  const localConfig = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment({
      RIVET_K8S_RELEASE_GATE_IMAGE_PULL_POLICY: 'IfNotPresent',
    }),
  });

  assert.equal(localConfig.imagePullPolicy, 'IfNotPresent');
  assert.equal(renderManagedReleaseGateValues(localConfig).images.api.pullPolicy, 'IfNotPresent');
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_IMAGE_PULL_POLICY: 'Never',
        }),
      }),
    /must be Always or IfNotPresent/,
  );
});

test('managed release gate rejects unsafe artifact paths and requires registry credentials', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_ARTIFACTS_DIR: '../outside',
        }),
      }),
    /must remain inside the repository/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: '',
        }),
      }),
    /REGISTRY_USERNAME is required/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'ci-user',
          RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: '',
        }),
      }),
    /REGISTRY_PASSWORD is required/,
  );
});
function createProviderEnvironment(configFile: string, valuesFile: string, overrides = {}) {
  return {
    RIVET_K8S_PROVIDER_GATE_CONFIRM: 'deploy-staging',
    RIVET_K8S_PROVIDER_GATE_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_CONFIG_FILE: configFile,
    RIVET_K8S_PROVIDER_GATE_VALUES_FILE: valuesFile,
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_PROVIDER_GATE_REGISTRY_USERNAME: 'provider-gate',
    RIVET_K8S_PROVIDER_GATE_REGISTRY_PASSWORD: 'provider-gate-token',
    ...overrides,
  };
}

test('managed release disruption gate covers WebSocket owner loss and managed dependency recovery', async () => {
  const [runner, fixture, overlay] = await Promise.all([
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kubernetes-managed-release-gate.mjs'),
      'utf8',
    ),
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'fixtures', 'managed-release-gate.rivet-project'),
      'utf8',
    ),
    fs.readFile(path.join(rootDir, 'deploy', 'studio-server', 'helm', 'overlays', 'managed-release-gate.yaml'), 'utf8'),
  ]);

  assert.match(fixture, /name: Long-running graph/);
  assert.match(fixture, /delay: 60000/);
  assert.match(fixture, /id: release-gate-long-run-button/);
  assert.match(runner, /web_app_action_runs/);
  assert.match(runner, /path\.join\(rootDir, ["']packages["'], ["']studio-server-api["'], ["']package\.json["']\)/);
  assert.doesNotMatch(runner, /path\.join\(rootDir, ["']wrapper["']/);
  assert.match(runner, /rootDir,\s+["']deploy["'],\s+["']studio-server["'],\s+["']scripts["'],\s+["']fixtures["'],/);
  assert.doesNotMatch(runner, /rootDir,\s+["']scripts["'],\s+["']fixtures["'],/);
  assert.match(runner, /run\.resume/);
  assert.match(runner, /action\.interrupted/);
  assert.match(runner, /["']--force["']/);
  assert.match(runner, /["']--grace-period=0["']/);
  assert.match(runner, /terminal\.reject\(error\)/);
  assert.match(runner, /["']interrupted WebSocket action replay["'],\s+async \(\) =>/);
  assert.match(runner, /resumed\.terminal,\s+30_000/);
  assert.match(runner, /120_000,\s+1_000/);
  assert.match(runner, /setDependencyReplicas\(\s*["']minio["']\s*,\s*0\)/);
  assert.match(runner, /setDependencyReplicas\(\s*["']postgres["']\s*,\s*0\)/);
  assert.match(runner, /["']workflow recovery after execution node drain["'],\s*\(\) =>[\s\S]*?this\.requestWorkflow/);
  assert.match(runner, /path: \/var\/lib\/rivet-managed-release-gate\/\$\{namespace\}\/postgres/);
  assert.match(runner, /path: \/var\/lib\/rivet-managed-release-gate\/\$\{namespace\}\/minio/);
  assert.equal(
    (runner.match(/type: DirectoryOrCreate/g) ?? []).length,
    2,
    'dependency pod replacement must retain PostgreSQL and MinIO fixture data',
  );
  assert.match(runner, /rotateAppSettingsKey/);
  assert.match(runner, /authorization: `Bearer \$\{this\.secrets\.rivetKey\}`/);
  assert.equal((runner.match(/this\.requestWorkflow\(/g) ?? []).length, 7);
  assert.match(runner, /result\?\.value\?\.type === ["']any["'] \? result\.value\.value : result/);
  assert.match(runner, /value\.environmentValue !== ["']managed-persistence["']/);
  assert.match(runner, /value\.hostname !== replacementExecutionPod/);
  assert.match(overlay, /shutdownGraceSeconds: 15/);
  assert.match(overlay, /terminationGracePeriodSeconds: 40/);
});

test('provider staging gate is explicitly confirmed, HTTPS-only, and scoped to a staging namespace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-gate-test-'));
  const configFile = path.join(directory, 'provider-gate.json');
  const valuesFile = path.join(directory, 'values.yaml');
  const interruptionFile = path.join(directory, 'block-postgres.yaml');
  const config = {
    namespace: 'rivet-staging-release',
    release: 'rivet-staging',
    baseUrl: 'https://rivet-staging.example.test',
    requestHeaders: { authorization: 'Bearer test-only' },
    workflowProbe: {
      path: '/workflows/provider-gate',
      method: 'POST',
      body: { input: 'provider-gate' },
      contains: 'provider-gate',
    },
    webAppProbe: {
      path: '/apps/provider-gate',
      contains: 'Provider gate',
    },
    keyRotation: {
      currentSecretName: 'rivet-settings-old',
      nextSecretName: 'rivet-settings-new',
    },
    legacyImport: {
      probe: {
        path: '/workflows/legacy-import',
        method: 'POST',
        body: { input: 'legacy' },
        contains: 'legacy',
      },
    },
    interruptionManifests: {
      postgres: {
        applyFile: 'block-postgres.yaml',
        restoreFile: 'block-postgres.yaml',
        restoreAction: 'delete',
      },
    },
  };
  try {
    await Promise.all([
      fs.writeFile(configFile, JSON.stringify(config)),
      fs.writeFile(valuesFile, 'vault:\n  enabled: true\n'),
      fs.writeFile(
        interruptionFile,
        'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: block-postgres\n  namespace: rivet-staging-release\n',
      ),
    ]);
    const providerConfig = buildManagedProviderGateConfig({
      rootDir,
      env: createProviderEnvironment(configFile, valuesFile),
    });
    assert.equal(providerConfig.namespace, 'rivet-staging-release');
    assert.equal(providerConfig.baseUrl, 'https://rivet-staging.example.test');
    assert.equal(providerConfig.interruptionManifests[0]?.restoreAction, 'delete');
    assert.equal(providerConfig.keyRotation?.nextSecretName, 'rivet-settings-new');
    assert.equal(providerConfig.registry.secretName, 'rivet-managed-provider-gate-registry');

    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile, {
            RIVET_K8S_PROVIDER_GATE_CONFIRM: 'production',
          }),
        }),
      /must equal deploy-staging/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        interruptionManifests: {
          postgres: {
            ...config.interruptionManifests.postgres,
            applyFile: 'missing-network-policy.yaml',
          },
        },
      }),
    );
    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile),
        }),
      /must identify a readable regular file/,
    );
    await fs.writeFile(configFile, JSON.stringify({ ...config, namespace: 'rivet-production' }));
    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile),
        }),
      /must start with rivet-staging-/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('provider staging gate preserves secret inputs outside uploaded artifacts', async () => {
  const [runner, workflow] = await Promise.all([
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kubernetes-managed-provider-gate.mjs'),
      'utf8',
    ),
    fs.readFile(path.join(rootDir, '.github', 'workflows', 'studio-server-images.yml'), 'utf8'),
  ]);

  assert.match(runner, /os\.tmpdir\(\)/);
  assert.match(
    runner,
    /path\.dirname\(fileURLToPath\(import\.meta\.url\)\),\s+["']\.\.["'],\s+["']\.\.["'],\s+["']\.\.["'],/,
  );
  assert.match(runner, /rivet-managed-provider-gate-/);
  assert.match(runner, /NetworkPolicy resources in/);
  assert.match(runner, /helm.*rollback/s);
  assert.match(runner, /inspectReleaseHistory/);
  assert.match(runner, /release:\\s\+not found/);
  assert.match(runner, /could not inspect Helm history/);
  assert.match(runner, /reuseValues: releaseHistory\.hasHistory/);
  assert.match(runner, /["']--atomic["']/);
  assert.match(runner, /reuseValues: true,\s+setValues: this\.getFinalAppSettingsKeyValues\(\)/);
  assert.match(runner, /app\.kubernetes\.io\/instance=\$\{this\.config\.release\}/);
  assert.match(runner, /readiness recovery[\s\S]*?await this\.assertPublicSurface\(\);/);
  assert.match(runner, /refusing to overwrite registry secret/);
  assert.match(runner, /could not determine whether registry secret/);
  assert.match(workflow, /managed-kubernetes-provider-gate:/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /environment:\r?\n\s+name: rivet-managed-staging/);
  assert.doesNotMatch(workflow, /\$\{\{\s*runner\.temp\s*\}\}/);
  assert.match(workflow, /Define Protected Staging File Paths/);
  assert.match(workflow, /echo "KUBECONFIG=\$RUNNER_TEMP\/rivet-managed-staging\.kubeconfig"/);
  assert.match(workflow, /RIVET_K8S_STAGING_KUBECONFIG_B64/);
  assert.match(workflow, /must not contain symbolic or hard links/);
  assert.match(workflow, /artifacts\/kubernetes-managed-provider-gate/);
});
