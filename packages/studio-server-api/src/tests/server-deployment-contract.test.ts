import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertServerDeploymentContract } from '../server-deployment-contract.js';

const deployment = {
  RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
  RIVET_APP_SETTINGS_BACKEND: 'postgres',
  RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
  RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
  RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify',
  RIVET_API_PROFILE: 'control',
};

test('the same managed serving contract admits every role with or without Kubernetes', () => {
  for (const role of ['control', 'execution', 'evaluation']) {
    assert.doesNotThrow(() => assertServerDeploymentContract({ ...deployment, RIVET_API_PROFILE: role }));
    assert.doesNotThrow(() =>
      assertServerDeploymentContract({ ...deployment, RIVET_API_PROFILE: role, KUBERNETES_SERVICE_HOST: '10.0.0.1' }),
    );
  }
});

test('uncoordinated, combined, SQLite, filesystem and serving migrations fail closed', () => {
  for (const [name, value] of Object.entries(deployment)) {
    assert.throws(() => assertServerDeploymentContract({ ...deployment, [name]: '' }));
  }
  for (const overrides of [
    { RIVET_API_PROFILE: 'combined' },
    { RIVET_APP_SETTINGS_BACKEND: 'sqlite' },
    { RIVET_DEPLOYMENT_STORAGE_MODE: 'filesystem' },
    { RIVET_DEPLOYMENT_DATABASE_MODE: 'local-docker' },
    { RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'migrate' },
    { RIVET_LOCAL_METADATA_BOOT_GENERATION: 'old-generation' },
    { RIVET_LOCAL_METADATA_CONTROL_ROOT: '/old-data' },
    { RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1' },
  ]) {
    assert.throws(() => assertServerDeploymentContract({ ...deployment, ...overrides }));
  }
});

test('deployment errors do not echo credentials or connection strings', () => {
  assert.throws(
    () => assertServerDeploymentContract({ ...deployment, RIVET_APP_SETTINGS_BACKEND: 'secret-password' }),
    (error: unknown) => error instanceof Error && !error.message.includes('secret-password'),
  );
});

test('the real serving entry point rejects a retired deployment before importing store owners', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-serving-contract-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        fileURLToPath(new URL('../serve.ts', import.meta.url)),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          KUBERNETES_SERVICE_HOST: '',
          RIVET_APP_DATA_ROOT: path.join(root, 'settings'),
          RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
          RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires RIVET_/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
