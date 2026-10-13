import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';

async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function eventually(label, check) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Supervised restore timed out: ${label}`);
}

/** Use only the disposable database/bucket/root supplied by the managed migration fixture.
 * Real compiled API, import worker, bundled editor executor and supervisor; no fake restart/drain hooks.
 * Peer process restarts stand in for Kubernetes' container restart policy, not its networking or scheduling. */
export async function verifySupervisedLegacyRestore({
  repoRoot,
  root,
  target,
  archive,
  secret,
  installation,
  expectModifiedBackup = false,
}) {
  const api = path.join(repoRoot, 'packages/studio-server-api/dist/studio-server-api/src/serve.js');
  const executor = path.join(repoRoot, 'packages/studio-server-executor/dist/executor-bundle.cjs');
  await fs.access(api);
  await fs.access(executor);
  const { runBackendSupervisor } = await import(
    pathToFileURL(path.join(repoRoot, 'deploy/studio-server/images/api/backend-supervisor.mjs')).href
  );
  const [apiPort, executorPort, healthPort, executionPort, evaluationPort] = await Promise.all(
    Array.from({ length: 5 }, port),
  );
  assert.equal(new Set([apiPort, executorPort, healthPort, executionPort, evaluationPort]).size, 5);
  const scratch = path.join(root, 'supervised-restore');
  await fs.mkdir(scratch);
  const directories = {};
  for (const role of ['control', 'editor', 'execution', 'evaluation']) {
    directories[role] = path.join(scratch, role);
    await fs.mkdir(directories[role]);
  }
  const restoreRoot = path.join(scratch, 'upload');
  await fs.mkdir(restoreRoot);
  const key = 'supervised-restore-fixture';
  const bootstrap = pathToFileURL(path.join(repoRoot, 'packages/studio-server-bootstrap/bootstrap.mjs')).href;
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${bootstrap}`,
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_API_PROFILE: 'control',
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_APP_SETTINGS_DATABASE_URL: target.databaseUrl,
    RIVET_APP_SETTINGS_ENCRYPTION_KEY: secret,
    RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING: target.databaseUrl,
    RIVET_DEPLOYMENT_DATABASE_SSL_MODE: target.databaseSslMode,
    RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
    RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
    RIVET_DEPLOYMENT_STORAGE_BUCKET: target.objectStorageBucket,
    RIVET_DEPLOYMENT_STORAGE_ENDPOINT: target.objectStorageEndpoint,
    RIVET_DEPLOYMENT_STORAGE_PREFIX: target.objectStoragePrefix,
    RIVET_DEPLOYMENT_STORAGE_REGION: target.objectStorageRegion,
    RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE: String(target.objectStorageForcePathStyle),
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID: target.objectStorageAccessKeyId,
    RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY: target.objectStorageSecretAccessKey,
    RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify',
    RIVET_MANAGED_MAINTENANCE_ENABLED: 'false',
    RIVET_HOSTED_EVALUATIONS_ENABLED: 'false',
    RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: 'false',
    RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: 'none',
    RIVET_LEGACY_RESTORE_ENABLED: '1',
    // Reproduce the real Kubernetes importer boundary: serving workers have no
    // schema-migration Job identity or Kubernetes mutation permissions.
    KUBERNETES_SERVICE_HOST: '127.0.0.1',
    RIVET_SCHEMA_MIGRATION_RELEASE: '',
    RIVET_LEGACY_RESTORE_INSTALLATION: installation,
    RIVET_LEGACY_RESTORE_ROOT: restoreRoot,
    // Not covered by the backup's literal 127.0.0.1 noProxy exception.
    // Stand in for Compose/cluster service hostnames without requiring custom DNS.
    RIVET_LEGACY_RESTORE_EXECUTION_READY_URL: `http://localhost:${executionPort}/readyz`,
    RIVET_LEGACY_RESTORE_EVALUATION_READY_URL: `http://localhost:${evaluationPort}/readyz`,
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`,
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_KEY: key,
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_REQUIRE_UI_GATE_KEY: 'true',
    RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: 'false',
    RIVET_SHUTDOWN_GRACE_SECONDS: '10',
    RIVET_APP_DATA_ROOT: directories.control,
    RIVET_WORKFLOWS_ROOT: directories.control,
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(directories.control, 'libraries'),
    RIVET_RUNNER_SLOT_ID: 'restore-control',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_UI_ROOT: '',
    RIVET_LOCAL_METADATA_BOOT_GENERATION: '',
    RIVET_RELEASE_MAINTENANCE: 'false',
  };
  const peers = [];
  let stopping = false;
  for (const [role, rolePort] of [
    ['execution', executionPort],
    ['evaluation', evaluationPort],
  ]) {
    const owner = { child: undefined, task: undefined, starts: 0 };
    owner.task = (async () => {
      while (!stopping) {
        const child = spawn(process.execPath, [api], {
          cwd: repoRoot,
          env: {
            ...env,
            PORT: String(rolePort),
            RIVET_API_PROFILE: role,
            RIVET_RUNTIME_PROCESS_ROLE: 'api',
            RIVET_APP_DATA_ROOT: directories[role],
            RIVET_RUNTIME_LIBRARIES_ROOT: path.join(directories[role], 'libraries'),
            RIVET_RUNNER_SLOT_ID: `restore-${role}`,
          },
          stdio: 'inherit',
        });
        owner.child = child;
        owner.starts++;
        await once(child, 'close');
        if (!stopping) await delay(250);
      }
    })();
    peers.push(owner);
  }
  const signals = new EventEmitter();
  const supervisor = runBackendSupervisor({
    env,
    apiCommand: [process.execPath, api],
    executorCommand: [process.execPath, executor, '--host', '127.0.0.1', '--port', String(executorPort)],
    executorCwd: repoRoot,
    executorEnvOverrides: {
      RIVET_APP_DATA_ROOT: directories.editor,
      RIVET_RUNTIME_LIBRARIES_ROOT: path.join(directories.editor, 'libraries'),
      RIVET_CODE_RUNNER_REQUIRE_ROOT: path.join(directories.editor, 'libraries/current/node_modules'),
    },
    signalSource: signals,
    shutdownTimeoutMs: 15_000,
  });
  // Attach immediately so a failed child cannot produce an unhandled rejection while polling.
  let supervisorError;
  supervisor.then(
    (code) => {
      if (!stopping) supervisorError = new Error(`Supervisor exited before verification (${code}).`);
    },
    (error) => {
      supervisorError = error;
    },
  );
  const headers = {
    'x-rivet-proxy-auth': createHash('sha256').update(`${key}:proxy-auth`).digest('hex'),
    cookie: `rivet_ui_token=${createHash('sha256').update(`${key}:ui-session`).digest('hex')}`,
    'X-Rivet-Migration-Intent': '1',
  };
  const base = `http://127.0.0.1:${apiPort}`;
  const request = async (url, options) => fetch(url, { signal: AbortSignal.timeout(5000), ...options });
  const schemaPreparation = async (command) => {
    const child = spawn(
      process.execPath,
      [path.join(path.dirname(api), 'scripts/migrate-managed-workflow-schema.js'), command],
      {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [code] = await once(child, 'close');
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
  const verifyRecoveryPreparation = async (pending) => {
    await eventually('read-only container recovery preparation', async () => {
      const result = await schemaPreparation('prepare-container-startup');
      if (result.code !== 75) return false; // Validator ownership handoff may still be finishing.
      assert.match(result.stdout, /No migration or settings seeding was performed/);
      return true;
    });
    const blocked = await schemaPreparation('migrate');
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /Finish or cancel/);
    const retained = await request(`${base}/api/legacy-restore`, { headers }).then((res) => res.json());
    assert.deepEqual(retained.operation, pending, 'Restart preparation must not alter the pending archive or journal');
  };
  const healthy = async (port) =>
    request(`http://127.0.0.1:${port}/readyz`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        return res.ok && body?.restoreMaintenance !== true;
      })
      .catch(() => false);
  let acceptedId;
  try {
    await eventually('initial server and editor readiness', async () => {
      if (supervisorError) throw supervisorError;
      return (await healthy(healthPort)) && (await healthy(executionPort)) && (await healthy(evaluationPort));
    });
    const uploaded = await request(`${base}/api/legacy-restore/upload`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/gzip' },
      body: createReadStream(archive),
      duplex: 'half',
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(uploaded.status, 202, await uploaded.text());
    let ready;
    if (expectModifiedBackup) {
      await eventually('modified backup rejection before override', async () => {
        ready = await request(`${base}/api/legacy-restore`, { headers })
          .then((res) => res.json())
          .then((body) => body.operation);
        return ready?.phase === 'failed';
      });
      assert.equal(ready.destructive, false);
      assert.equal(ready.canProceedAnyway, true);
      await verifyRecoveryPreparation(ready);
      for (const digest of ['b'.repeat(64), ready.archiveDigest]) {
        const proceed = await request(`${base}/api/legacy-restore/proceed-anyway`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ready.id, archiveDigest: digest }),
        });
        assert.equal(proceed.status, digest === ready.archiveDigest ? 202 : 409, await proceed.text());
      }
    }
    await eventually('backup validation', async () => {
      const res = await request(`${base}/api/legacy-restore`, { headers });
      const body = await res.json();
      assert.equal(body.available, true, JSON.stringify(body));
      assert.notEqual(body.operation?.phase, 'failed', body.operation?.message);
      ready = body.operation;
      return ready?.phase === 'awaiting-confirmation';
    });
    await verifyRecoveryPreparation(ready);
    if (expectModifiedBackup) {
      assert.equal(ready.integrityOverridden, true);
      assert.equal(ready.recordings, 0);
      assert.equal(ready.destructive, false);
    }
    acceptedId = ready.id;
    const start = await request(`${base}/api/legacy-restore/start`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ready.id, archiveDigest: ready.archiveDigest, confirmation: 'RESTORE LEGACY BACKUP' }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.equal(start.status, 202, await start.text());
    await eventually('automatic completion and normal generation', async () => {
      if (supervisorError) throw supervisorError;
      const res = await request(`${base}/api/legacy-restore`, { headers }).catch(() => null);
      if (!res?.ok) return false;
      const body = await res.json();
      assert.notEqual(body.operation?.phase, 'failed', body.operation?.message);
      return (
        body.operation?.id === acceptedId &&
        body.operation.phase === 'completed' &&
        (await healthy(healthPort)) &&
        (await healthy(executionPort)) &&
        (await healthy(evaluationPort))
      );
    });
    assert.ok(
      peers.every((peer) => peer.starts >= 3),
      'each peer must restart through standby, warmup and normal serving',
    );
    assert.deepEqual(await fs.readdir(restoreRoot), []);
    const config = await request(`${base}/api/config`, { headers }).then((res) => res.json());
    assert.equal(config.legacyRestoreEpoch, acceptedId);
    assert.equal(config.legacyRestoreMaintenance, false);
    const proxy = await request(`${base}/api/app-settings/node-executor-proxy`, { headers }).then((res) => res.json());
    assert.equal(proxy.httpProxy, 'http://127.0.0.1:9');
    assert.equal(proxy.httpsProxy, 'http://127.0.0.1:9');
    assert.equal(proxy.noProxy, '127.0.0.1', 'restore must not rewrite outbound proxy policy to repair coordination');
    const environment = await request(`${base}/api/workflows/execution-environment`, {
      headers: {
        ...headers,
        'x-rivet-executor-auth': createHash('sha256').update(`${key}:executor-internal`).digest('hex'),
      },
    });
    assert.equal(environment.status, 200);
    assert.equal((await environment.json()).environment.MIGRATION_SECRET, 'fixture-sensitive-value');
    const browserEnvironment = await request(`${base}/api/config/env/MIGRATION_SECRET`, { headers });
    assert.equal((await browserEnvironment.json()).value, '', 'restored private UI variables must remain private');
    const endpoint = `http://127.0.0.1:${executionPort}`;
    const executionHeaders = { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    const publicRun = await request(`${endpoint}/workflows/migration-fixture`, {
      method: 'POST',
      headers: executionHeaders,
      body: '{}',
    });
    assert.equal(publicRun.status, 404, await publicRun.text()); // Backup marks this endpoint internal-only.
    const internalRun = await request(`${endpoint}/internal/workflows/migration-fixture`, {
      method: 'POST',
      headers: executionHeaders,
      body: '{}',
    });
    assert.equal(internalRun.status, 200, await internalRun.text()); // Test-owned empty graph, no provider calls.
    for (const role of ['control', 'editor', 'execution', 'evaluation'])
      await fs.access(path.join(directories[role], 'libraries/current/node_modules/tiny-lib/index.js'));
    console.log(
      `Legacy restore: ${expectModifiedBackup ? 'modified backup with recordings removed and explicit override' : 'original backup'}, compiled worker/editor and automatic supervised restarts passed.`,
    );
  } finally {
    stopping = true;
    for (const peer of peers) peer.child?.kill('SIGTERM');
    signals.emit('SIGTERM');
    await Promise.all([supervisor, ...peers.map((peer) => peer.task)]);
  }
  if (!expectModifiedBackup) {
    // A second full restore uses the same isolated installation, not weakened mocks
    // or regenerated backup hashes. Preserve the original archive and manifest.
    const editedRoot = path.join(root, 'modified-backup-round');
    const editedSource = path.join(editedRoot, 'source');
    await fs.mkdir(editedSource, { recursive: true });
    await tar.x({ file: archive, cwd: editedSource });
    await fs.rm(path.join(editedSource, 'recordings'), { recursive: true });
    for (const name of ['._.', '.DS_Store', '._backup.json', 'workflows/.DS_Store', 'appData/._settings'])
      await fs.writeFile(path.join(editedSource, name), 'macOS metadata');
    const modifiedArchive = path.join(editedRoot, 'backup.tar.gz');
    await tar.c({ file: modifiedArchive, cwd: editedSource, gzip: true }, ['./']);
    await verifySupervisedLegacyRestore({
      repoRoot,
      root: editedRoot,
      target,
      archive: modifiedArchive,
      secret,
      installation,
      expectModifiedBackup: true,
    });
  }
}
