import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

const rootDir = process.cwd();
const launcherName = 'verify-kubernetes';

function quoteArg(arg) {
  if (!/\s|"/.test(arg)) {
    return arg;
  }

  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function spawnProgram(program, args, options = {}) {
  const {
    cwd = rootDir,
    env = process.env,
  } = options;

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
    'RIVET_STORAGE_MODE=managed',
    'RIVET_DATABASE_MODE=managed',
    'RIVET_DATABASE_CONNECTION_STRING=postgresql://db-user:db-pass@example-db:5432/rivet?sslmode=require',
    'RIVET_DATABASE_SSL_MODE=require',
    'RIVET_STORAGE_URL=https://test-bucket-111.sfo3.digitaloceanspaces.com',
    'RIVET_STORAGE_ACCESS_KEY_ID=test-access-key',
    'RIVET_STORAGE_ACCESS_KEY=test-secret-key',
    'RIVET_KEY=test-shared-key',
    'RIVET_REQUIRE_WORKFLOW_KEY=false',
    'RIVET_REQUIRE_UI_GATE_KEY=false',
    'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=true',
    '',
  ].join('\n');

  fs.writeFileSync(envPath, contents, 'utf8');
  return { tempDir, envPath };
}

async function verifyLocalRender(nodeBin, envPath) {
  console.log(`[${launcherName}] Rendering the local Kubernetes rehearsal values path...`);
  await spawnProgram(nodeBin, ['scripts/dev-kubernetes.mjs', 'config'], {
    env: {
      ...process.env,
      RIVET_ENV_FILE: envPath,
    },
  });
}

async function verifyProdRender(helmBin) {
  console.log(`[${launcherName}] Linting and rendering the production overlay...`);

  const prodImageArgs = [
    '--set', 'images.proxy.repository=ghcr.io/example/proxy',
    '--set', 'images.web.repository=ghcr.io/example/web',
    '--set', 'images.api.repository=ghcr.io/example/api',
    '--set', 'images.executor.repository=ghcr.io/example/executor',
  ];

  await spawnProgram(helmBin, ['lint', './charts', '-f', './charts/overlays/prod.yaml', ...prodImageArgs]);
  await spawnProgram(helmBin, ['template', 'rivet-prod', './charts', '-n', 'rivet-prod', '-f', './charts/overlays/prod.yaml', ...prodImageArgs]);
}

async function main() {
  const helmBin = resolveHelmBinOrThrow(rootDir, { env: process.env, launcherName });
  const nodeBin = process.execPath;
  const { tempDir, envPath } = writeLocalVerificationEnv();

  try {
    await verifyLocalRender(nodeBin, envPath);
    await verifyProdRender(helmBin);
    console.log(`[${launcherName}] Kubernetes local/prod render verification passed.`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
