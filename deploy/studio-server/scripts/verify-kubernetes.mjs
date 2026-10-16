import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { readManagedWorkflowSchemaReleaseContract } from './lib/studio-server-release-manifest.mjs';
import { singleMachineConfig, singleMachineValues } from './lib/single-machine-kubernetes.mjs';

const rootDir = process.cwd();
const launcherName = 'verify-kubernetes';

function quoteArg(arg) {
  if (!/\s|"/.test(arg)) {
    return arg;
  }

  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function spawnProgram(program, args, options = {}) {
  const { cwd = rootDir, env = process.env } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0) {
        resolve();
        return;
      }

      const commandLine = [program, ...args].map(quoteArg).join(' ');
      reject(new Error(`Command failed with exit code ${exitCode}: ${commandLine}`));
    });
  });
}

function writeLocalVerificationEnv() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-k8s-verify-'));
  const envPath = path.join(tempDir, 'local-kubernetes.env');
  const contents = [
    'RIVET_K8S_DATABASE_CONNECTION_STRING=postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    'RIVET_K8S_DATABASE_SSL_MODE=require',
    'RIVET_K8S_STORAGE_URL=https://test-bucket-111.sfo3.digitaloceanspaces.com',
    'RIVET_K8S_STORAGE_REGION=sfo3',
    'RIVET_K8S_STORAGE_ACCESS_KEY_ID=test-access-key',
    'RIVET_K8S_STORAGE_ACCESS_KEY=test-secret-key',
    'RIVET_KEY=test-shared-key',
    'RIVET_REQUIRE_UI_GATE_KEY=false',
    'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true',
    '',
  ].join('\n');

  fs.writeFileSync(envPath, contents, 'utf8');
  return { tempDir, envPath };
}

async function verifyLocalRender(nodeBin, envPath) {
  console.log(`[${launcherName}] Rendering the local Kubernetes rehearsal values path...`);
  await spawnProgram(nodeBin, ['deploy/studio-server/scripts/dev-kubernetes.mjs', 'config'], {
    env: {
      ...process.env,
      RIVET_ENV_FILE: envPath,
    },
  });
}

async function verifyProdRender(helmBin, managedWorkflowSchemaVersion, singleMachineValuesPath) {
  console.log(`[${launcherName}] Linting and rendering the production overlay...`);

  const prodImageArgs = [
    '--set',
    'images.proxy.repository=ghcr.io/example/proxy',
    '--set',
    `images.proxy.digest=sha256:${'a'.repeat(64)}`,
    '--set',
    'images.web.repository=ghcr.io/example/web',
    '--set',
    `images.web.digest=sha256:${'b'.repeat(64)}`,
    '--set',
    'images.api.repository=ghcr.io/example/api',
    '--set',
    `images.api.digest=sha256:${'c'.repeat(64)}`,
    '--set',
    'images.executor.repository=ghcr.io/example/executor',
    '--set',
    `images.executor.digest=sha256:${'d'.repeat(64)}`,
    '--set',
    `release.production.manifestDigest=sha256:${'f'.repeat(64)}`,
    '--set',
    `release.production.sourceSha=${'e'.repeat(40)}`,
    '--set',
    'release.production.verification.workflow=Build-Images',
    '--set',
    'release.production.verification.runId=12345',
    '--set',
    'release.production.verification.runAttempt=1',
    '--set',
    'release.production.chart.name=rivet',
    '--set',
    'release.production.chart.version=0.1.0',
    '--set',
    `release.production.chart.contentDigest=sha256:${'f'.repeat(64)}`,
    '--set',
    `release.production.database.managedWorkflowSchemaVersion=${managedWorkflowSchemaVersion}`,
  ];
  const profileArgs = singleMachineValuesPath
    ? ['-f', './deploy/studio-server/helm/overlays/single-machine.yaml', '-f', singleMachineValuesPath]
    : ['-f', './deploy/studio-server/scripts/fixtures/kubernetes-environment.values.yaml'];

  await spawnProgram(helmBin, [
    'lint',
    './deploy/studio-server/helm',
    '-f',
    './deploy/studio-server/helm/overlays/prod.yaml',
    ...profileArgs,
    ...prodImageArgs,
  ]);
  await spawnProgram(helmBin, [
    'template',
    'rivet-prod',
    './deploy/studio-server/helm',
    '-n',
    'rivet-prod',
    '-f',
    './deploy/studio-server/helm/overlays/prod.yaml',
    ...profileArgs,
    ...prodImageArgs,
  ]);
}

async function main() {
  const helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName });
  const nodeBin = process.execPath;
  const { tempDir, envPath } = writeLocalVerificationEnv();

  try {
    await spawnProgram(nodeBin, [
      '--test',
      'deploy/studio-server/scripts/studio-server-release-manifest.test.mjs',
      'deploy/studio-server/scripts/managed-release-cutover.test.mjs',
      'deploy/studio-server/scripts/ha-release-evidence.test.mjs',
      'deploy/studio-server/scripts/ha-release-gate.test.mjs',
      'deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs',
      'deploy/studio-server/scripts/single-machine-kubernetes.test.mjs',
      'deploy/studio-server/scripts/server-launch-mode.test.mjs',
      'deploy/studio-server/scripts/container-server.test.mjs',
    ]);
    await verifyLocalRender(nodeBin, envPath);
    await verifyLocalRender(nodeBin, path.join(rootDir, 'deploy', 'studio-server', '.env.kubernetes-local.example'));
    await verifyProdRender(helmBin, readManagedWorkflowSchemaReleaseContract(rootDir).version);
    const config = singleMachineConfig(
      {
        RIVET_K8S_CONTEXT: 'default',
        RIVET_K8S_CLUSTER_PROVIDER: 'k3s',
        RIVET_K8S_RELEASE: 'rivet',
        RIVET_K8S_NAMESPACE: 'rivet',
        RIVET_K8S_LOCAL_MANAGED_SERVICES: 'true',
        RIVET_K8S_LOCAL_POSTGRES_PASSWORD: 'verification-password',
        RIVET_KEY: 'verification-key-with-at-least-32-characters',
        RIVET_K8S_STORAGE_BUCKET: 'verification-bucket',
        RIVET_K8S_STORAGE_REGION: 'us-east-1',
        RIVET_K8S_STORAGE_ACCESS_KEY_ID: 'verification-access',
        RIVET_K8S_STORAGE_ACCESS_KEY: 'verification-secret',
      },
      { context: 'default', release: 'rivet', namespace: 'rivet' },
    );
    const singleValuesPath = path.join(tempDir, 'single-machine.yaml');
    fs.writeFileSync(singleValuesPath, singleMachineValues(config), { mode: 0o600 });
    await verifyProdRender(helmBin, readManagedWorkflowSchemaReleaseContract(rootDir).version, singleValuesPath);
    console.log(`[${launcherName}] Kubernetes local/prod render verification passed.`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
