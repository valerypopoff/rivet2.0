import test from 'node:test';
// test-style: fixture-read: reads only test-owned temporary dotenv files to verify durable initialization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  loadVmEnvironment,
  productionEnvironment,
  prepareProductionSecrets,
  vmProcessEnvironment,
} from './lib/server-launch-mode.mjs';
import { loadDevEnv } from './lib/dev-env.mjs';
import { renderKubernetesLauncherValuesYaml } from './lib/kubernetes-launcher-config.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const yaml = createRequire(import.meta.url)('yaml');
const selection = { release: 'test', namespace: 'test', context: 'test-cluster' };
const external = {
  RIVET_K8S_RELEASE: 'test',
  RIVET_K8S_NAMESPACE: 'test',
  RIVET_K8S_CONTEXT: 'test-cluster',
  RIVET_KEY: 'k'.repeat(32),
  RIVET_K8S_DATABASE_CONNECTION_STRING: 'postgresql://test:secret@database.example/rivet',
  RIVET_K8S_STORAGE_BUCKET: 'test',
  RIVET_K8S_STORAGE_REGION: 'us-east-1',
  RIVET_K8S_STORAGE_ACCESS_KEY_ID: 'test-access',
  RIVET_K8S_STORAGE_ACCESS_KEY: 'test-secret',
};

test('VM first start generates stable private credentials and does not replace custom settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-vm-config-'));
  try {
    const first = loadVmEnvironment(root);
    const bytes = fs.readFileSync(first.envPath, 'utf8');
    assert.equal(first.config.deploymentProfile, 'single-machine');
    assert.equal(first.config.context, 'rivet-vm');
    assert.ok(first.config.localServices);
    assert.equal(loadVmEnvironment(root).env.RIVET_KEY, first.env.RIVET_KEY);
    assert.equal(fs.readFileSync(first.envPath, 'utf8'), bytes);
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.envPath).mode & 0o777, 0o600);
    assert.throws(() => loadVmEnvironment(root, 'missing.env'), /does not exist/);
    fs.appendFileSync(first.envPath, '\nRIVET_VM_K8S_CLUSTER_PROVIDER=remote\n');
    assert.throws(() => loadVmEnvironment(root), /refusing a remote context/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production uses external connections, scoped Secrets and refuses incompatible mode/identity', () => {
  const config = productionEnvironment(external, selection);
  assert.equal(config.localServices, null);
  assert.equal(config.deploymentProfile, 'cluster');
  assert.equal(config.replicas.execution, 2);
  assert.equal(config.routeConfig.serverUiAuthMode, 'key');
  assert.equal(config.secrets.authName, 'test-auth');
  for (const change of [
    { RIVET_K8S_CONTEXT: 'other' },
    { RIVET_KEY: 'short' },
    { RIVET_KEY: 'replace-with-a-random-key-of-at-least-32-characters' },
    { RIVET_K8S_EXECUTION_REPLICAS: '2.5' },
    { RIVET_K8S_AUTH_SECRET_NAME: 'invalid/name' },
    { RIVET_ENABLE_DEVELOPMENT_AUTH: 'true' },
    { RIVET_K8S_AUTH_SECRET_NAME: 'same', RIVET_K8S_POSTGRES_SECRET_NAME: 'same' },
  ])
    assert.throws(() => productionEnvironment({ ...external, ...change }, selection));
  const values = renderKubernetesLauncherValuesYaml(config);
  assert.ok(!values.includes(external.RIVET_K8S_STORAGE_ACCESS_KEY));
  assert.ok(!values.includes(external.RIVET_K8S_DATABASE_CONNECTION_STRING));
});

test('one shared file isolates VM provisioning from production settings and survives the child dotenv reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-shared-env-'));
  const previousMode = process.env.RIVET_SERVER_LAUNCH_MODE;
  const previousFile = process.env.RIVET_ENV_FILE;
  try {
    const contents =
      '# Keep this comment\n' +
      Object.entries(external)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') +
      '\nRIVET_K8S_LOCAL_MANAGED_SERVICES=false\nRIVET_K8S_DEPLOYMENT_PROFILE=cluster\nRIVET_ARTIFACTS_HOST_PATH=/old-compose-data\nRIVET_VM_K8S_CONTEXT=vm-test\nRIVET_VM_K8S_NAMESPACE=vm-test\nRIVET_VM_K8S_RELEASE=vm-test\n';
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, contents);
    const vm = loadVmEnvironment(root);
    assert.equal(vm.envPath, envPath);
    assert.ok(fs.readFileSync(envPath, 'utf8').startsWith(contents));
    assert.equal(vm.config.context, 'vm-test');
    assert.equal(vm.config.namespace, 'vm-test');
    assert.ok(vm.config.databaseConnectionString.includes('vm-test-postgres.vm-test.svc'));
    assert.ok(!vm.config.databaseConnectionString.includes('database.example'));
    assert.notEqual(vm.config.objectStorage.secretAccessKey, external.RIVET_K8S_STORAGE_ACCESS_KEY);
    assert.equal(vm.config.sharedKey, external.RIVET_KEY);
    const processEnv = vmProcessEnvironment(
      { RIVET_K8S_CONTEXT: 'dangerous-ambient-context', PATH: 'preserved' },
      external,
    );
    assert.equal(processEnv.RIVET_K8S_CONTEXT, 'rivet-vm');
    assert.equal(processEnv.PATH, 'preserved');
    process.env.RIVET_SERVER_LAUNCH_MODE = 'vm';
    process.env.RIVET_ENV_FILE = envPath;
    const childEnv = loadDevEnv(root).mergedEnv;
    assert.equal(childEnv.RIVET_K8S_CONTEXT, 'vm-test');
    assert.equal(childEnv.RIVET_K8S_DATABASE_CONNECTION_STRING, undefined);
    assert.equal(childEnv.RIVET_ARTIFACTS_HOST_PATH, undefined);
    assert.equal(childEnv.RIVET_K8S_DEPLOYMENT_PROFILE, 'single-machine');
    const prod = productionEnvironment(
      {
        ...external,
        RIVET_VM_K8S_STORAGE_ACCESS_KEY: 'local-secret',
        RIVET_K8S_LOCAL_MANAGED_SERVICES: 'true',
        RIVET_K8S_DEPLOYMENT_PROFILE: 'single-machine',
      },
      selection,
    );
    assert.equal(prod.localServices, null);
    assert.equal(prod.deploymentProfile, 'cluster');
    assert.equal(prod.databaseConnectionString, external.RIVET_K8S_DATABASE_CONNECTION_STRING);
    assert.equal(prod.objectStorage.secretAccessKey, external.RIVET_K8S_STORAGE_ACCESS_KEY);
    const bytes = fs.readFileSync(envPath, 'utf8');
    loadVmEnvironment(root);
    assert.equal(fs.readFileSync(envPath, 'utf8'), bytes);
  } finally {
    if (previousMode === undefined) delete process.env.RIVET_SERVER_LAUNCH_MODE;
    else process.env.RIVET_SERVER_LAUNCH_MODE = previousMode;
    if (previousFile === undefined) delete process.env.RIVET_ENV_FILE;
    else process.env.RIVET_ENV_FILE = previousFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VM initialization refuses a competing owner without changing the shared file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-env-lock-'));
  try {
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, '# untouched\n');
    fs.writeFileSync(`${envPath}.rivet-init.lock`, 'owned');
    assert.throws(() => loadVmEnvironment(root), /another startup/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), '# untouched\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production credentials use exclusive creation, fenced replacement and refuse foreign ownership before writes', async () => {
  const config = productionEnvironment(external, selection);
  for (const state of ['absent', 'owned', 'foreign']) {
    const mutations = [];
    const run = async (args, options = {}) => {
      if (args[0] === 'get') return { stdout: '{}' }; // namespace exists
      if (args.includes('get'))
        return {
          stdout:
            state === 'absent'
              ? ''
              : JSON.stringify({
                  metadata: {
                    resourceVersion: '7',
                    annotations: { 'rivet.dev/server-launcher-owner': state === 'owned' ? 'test/test' : 'other' },
                  },
                }),
        };
      mutations.push({ args, resource: JSON.parse(options.input) });
      return { stdout: '' };
    };
    if (state === 'foreign') {
      await assert.rejects(prepareProductionSecrets(config, run), /refusing/);
      assert.equal(mutations.length, 0);
    } else {
      await prepareProductionSecrets(config, run);
      assert.equal(mutations.length, 3);
      for (const mutation of mutations) {
        assert.equal(mutation.args[0], state === 'owned' ? 'replace' : 'create');
        assert.equal(mutation.resource.metadata.resourceVersion, state === 'owned' ? '7' : undefined);
        assert.ok(!mutation.args.join(' ').includes('secret@'));
      }
    }
  }
});

test('a lost credential write acknowledgement is not retried or followed by more writes', async () => {
  let writes = 0;
  const run = async (args) => {
    if (args[0] === 'get') return { stdout: '{}' };
    if (args.includes('get')) return { stdout: '' };
    writes++;
    throw new Error('write outcome unknown');
  };
  await assert.rejects(prepareProductionSecrets(productionEnvironment(external, selection), run), /outcome unknown/);
  assert.equal(writes, 1);
});

test('mode commands reject invalid input before running tools or exposing secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-mode-command-'));
  try {
    const vm = loadVmEnvironment(root);
    const result = spawnSync(process.execPath, ['deploy/studio-server/scripts/start-server.mjs', 'vm', '--reset'], {
      env: { ...process.env, RIVET_ENV_FILE: vm.envPath },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /takes no arguments/);
    assert.ok(!result.stdout.includes(vm.config.sharedKey));
    const missing = spawnSync(process.execPath, ['deploy/studio-server/scripts/start-server.mjs', 'prod'], {
      env: { ...process.env, RIVET_ENV_FILE: path.join(root, 'missing.env') },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Create a private/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one-pod chart preserves roles, distinct ports, private caches, restore reachability and gateway readiness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-vm-render-'));
  try {
    const vm = loadVmEnvironment(root);
    const values = path.join(root, 'values.yaml');
    fs.writeFileSync(values, renderKubernetesLauncherValuesYaml(vm.config));
    const helm = resolveHelmBinOrThrow(process.cwd(), { env: process.env });
    const args = [
      'template',
      'test',
      'deploy/studio-server/helm',
      '-f',
      'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
      '-f',
      'deploy/studio-server/helm/overlays/single-machine.yaml',
      '-f',
      values,
    ];
    const rendered = spawnSync(helm, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(rendered.status, 0, rendered.stderr);
    const documents = yaml
      .parseAllDocuments(rendered.stdout)
      .map((doc) => doc.toJS())
      .filter(Boolean);
    const workloads = documents.filter((doc) => ['Deployment', 'StatefulSet'].includes(doc.kind));
    assert.equal(workloads.length, 1);
    const pod = workloads[0].spec.template.spec;
    assert.deepEqual(pod.containers.map((item) => item.name).sort(), ['backend', 'execution', 'proxy', 'web']);
    const ports = pod.containers.flatMap((container) => container.ports.map((port) => port.containerPort));
    assert.equal(new Set(ports).size, ports.length);
    const backendEnv = new Map(
      pod.containers.find((item) => item.name === 'backend').env.map((item) => [item.name, item.value]),
    );
    assert.equal(backendEnv.get('RIVET_HOSTED_EVALUATIONS_ENABLED'), 'true');
    assert.equal(backendEnv.get('RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY'), '1');
    assert.equal(backendEnv.has('RIVET_LEGACY_RESTORE_EVALUATION_READY_URL'), false);
    for (const role of ['execution']) {
      const container = pod.containers.find((item) => item.name === role);
      assert.equal(
        container.env.find((item) => item.name === 'RIVET_RUNNER_SLOT_ID').value,
        `$(RIVET_POD_NAME):${role}`,
      );
      assert.equal(container.volumeMounts.find((item) => item.name === 'app-data').subPath, role);
    }
    for (const service of documents.filter(
      (doc) => doc.kind === 'Service' && !doc.metadata.name.endsWith('headless'),
    )) {
      assert.equal(service.spec.selector['app.kubernetes.io/component'], 'backend');
      if (service.metadata.name.endsWith('proxy')) assert.ok(!service.spec.publishNotReadyAddresses);
      else if (!service.metadata.name.endsWith('executor')) assert.equal(service.spec.publishNotReadyAddresses, true);
      for (const port of service.spec.ports)
        assert.ok(pod.containers.some((container) => container.ports.some((entry) => entry.name === port.targetPort)));
    }
    const collision = spawnSync(helm, [...args, '--set', 'service.execution.targetPort=8081'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /distinct target ports/);
    const maintenance = spawnSync(
      helm,
      [
        ...args,
        '--set',
        'workflowSchema.maintenanceValidation=true',
        '--set',
        'replicaCount.proxy=0',
        '--set',
        'replicaCount.web=0',
        '--set',
        'replicaCount.evaluation=0',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(maintenance.status, 0, maintenance.stderr);
    const validationPod = yaml
      .parseAllDocuments(maintenance.stdout)
      .map((doc) => doc.toJS())
      .find((doc) => doc?.kind === 'StatefulSet').spec.template.spec;
    assert.deepEqual(validationPod.containers.map((item) => item.name).sort(), ['backend', 'execution']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
