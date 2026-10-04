import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { childEnvironments, startBackendSupervisor, runBackendSupervisor } from './backend-supervisor.mjs';
import { acquireLocalMetadataOwnerLease } from './local-metadata-owner-lease.mjs';

test(
  'single-host dotenv cannot replace supervisor-owned selection or private UI capabilities',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivet-ui-dotenv-'));
    const names = [
      'RIVET_LOCAL_METADATA_CONTROL_ROOT',
      'RIVET_LOCAL_METADATA_ENCRYPTION_KEY',
      'RIVET_LOCAL_METADATA_UPGRADE_ENABLED',
      'RIVET_LOCAL_METADATA_SUPERVISED',
      'RIVET_LOCAL_METADATA_BOOT_GENERATION',
      'RIVET_LOCAL_METADATA_BOOT_REVISION',
      'RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN',
      'RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE',
      'RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE',
    ];
    const selection = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
    selection.RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE = '1';
    const dotenv = join(dir, 'fixture.env');
    try {
      await writeFile(
        dotenv,
        `RIVET_DEPLOYMENT_TOPOLOGY=replicated\n${names.map((name) => `${name}=stale`).join('\n')}\n`,
      );
      const script =
        '. "$1"; load_optional_dotenv_preserving_deployment_storage "$2"; "$3" -e \'console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(k=>[k,process.env[k]]))))\' "$4"';
      const output = execFileSync(
        'sh',
        [
          '-c',
          script,
          'fixture',
          fileURLToPath(new URL('../lib/load-env.sh', import.meta.url)),
          dotenv,
          process.execPath,
          JSON.stringify([...names, 'RIVET_DEPLOYMENT_TOPOLOGY']),
        ],
        {
          env: { ...process.env, ...selection, RIVET_DEPLOYMENT_TOPOLOGY: 'single-host' },
          encoding: 'utf8',
        },
      );
      assert.deepEqual(JSON.parse(output), { ...selection, RIVET_DEPLOYMENT_TOPOLOGY: 'single-host' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ports() {
  const apiPort = await unusedPort();
  let executorPort = await unusedPort();
  while (executorPort === apiPort) executorPort = await unusedPort();
  let healthPort = await unusedPort();
  while (healthPort === apiPort || healthPort === executorPort) healthPort = await unusedPort();
  return { apiPort, executorPort, healthPort };
}

function legacyTransitionFixture(root) {
  const db = new DatabaseSync(join(root, 'transition.sqlite'));
  try {
    db.exec(
      "PRAGMA application_id = 1380537418; PRAGMA user_version = 1; CREATE TABLE transition_state (phase TEXT, generation_id TEXT, revision INTEGER); INSERT INTO transition_state VALUES ('legacy', NULL, 1)",
    );
  } finally {
    db.close();
  }
}

function environment({ apiPort, executorPort, healthPort }) {
  const env = {
    ...process.env,
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`,
  };
  // Each behavior fixture owns its control state; never inherit an operator's
  // opt-in production/recovery root from the shell running these tests.
  delete env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
  return env;
}

async function waitForReady(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      /* The supervisor may not yet have opened the listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Combined backend did not become ready.');
}

async function waitForHealthStatus(port, status) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).status === status) return;
    } catch {
      /* The supervisor may not yet have opened the listener. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Combined backend readiness did not become ${status}.`);
}

test('UI restart is private, stops both children and reloads the journal with a fresh capability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-ui-restart-'));
  legacyTransitionFixture(dir);
  const apiScript = join(dir, 'api.mjs'),
    executorScript = join(dir, 'executor.mjs');
  await writeFile(
    apiScript,
    `import {createServer} from 'node:http';
    const s=createServer((q,r)=>r.end(JSON.stringify({token:process.env.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN, revision:process.env.RIVET_LOCAL_METADATA_BOOT_REVISION,pid:process.pid})));
    s.listen(Number(process.env.PORT),'127.0.0.1'); process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`,
  );
  await writeFile(
    executorScript,
    `import {createServer} from 'node:net';
    if(process.env.RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN)process.exit(9);
    const s=createServer(s=>s.end());s.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send({type:'rivet-executor-ready'}));
    process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`,
  );
  const allocated = await ports();
  const env = {
    ...environment(allocated),
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: '',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: dir,
    RIVET_APP_DATA_ROOT: dir,
  };
  const signals = new EventEmitter();
  const completed = runBackendSupervisor({
    env,
    apiCommand: [process.execPath, apiScript],
    executorCommand: [process.execPath, executorScript],
    executorCwd: dir,
    signalSource: signals,
    apiStartupTimeoutMs: 5000,
    shutdownTimeoutMs: 1000,
  });
  try {
    await waitForReady(allocated.healthPort);
    const old = await (await fetch(`http://127.0.0.1:${allocated.apiPort}`)).json();
    const url = `http://127.0.0.1:${allocated.healthPort}/local-upgrade/restart`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'X-Rivet-Supervisor-Token': old.token, Origin: 'http://evil.test' },
        })
      ).status,
      403,
    );
    const db = new DatabaseSync(join(dir, 'transition.sqlite'));
    db.exec('UPDATE transition_state SET revision = 2');
    db.close();
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'X-Rivet-Supervisor-Token': old.token } })).status,
      202,
    );
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'X-Rivet-Supervisor-Token': old.token } })).status,
      409,
    );
    await waitForHealthStatus(allocated.healthPort, 503);
    await waitForReady(allocated.healthPort);
    const next = await (await fetch(`http://127.0.0.1:${allocated.apiPort}`)).json();
    assert.equal(next.revision, '2');
    assert.notEqual(next.pid, old.pid);
    assert.notEqual(next.token, old.token);
    assert.equal(
      (await fetch(url, { method: 'POST', headers: { 'X-Rivet-Supervisor-Token': old.token } })).status,
      403,
    );
  } finally {
    signals.emit('SIGTERM');
    assert.equal(await completed, 0);
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined backend keeps the child environments and loopback configuration separate', async () => {
  const env = environment(await ports());
  const children = childEnvironments(env);
  assert.equal(children.api.RIVET_RUNTIME_PROCESS_ROLE, 'api');
  assert.equal(children.api.PORT, env.RIVET_BACKEND_API_PORT);
  assert.equal(children.executor.RIVET_RUNTIME_PROCESS_ROLE, 'executor');
  assert.equal(children.executor.PORT, env.RIVET_BACKEND_EXECUTOR_PORT);
  assert.equal(children.executor.RIVET_RUNTIME_LIBRARIES_REPLICA_TIER, 'editor');
  assert.equal(children.executor.RIVET_API_PROFILE, undefined);
  assert.equal(children.executor.RIVET_LLM_PROFILE_HEALTH_API_URL, undefined);
  assert.equal(children.executor.RIVET_EXECUTION_ENVIRONMENT_API_URL, undefined);
  assert.throws(
    () => childEnvironments({ ...env, RIVET_BACKEND_EXECUTOR_PORT: env.RIVET_BACKEND_API_PORT }),
    /distinct/,
  );
  assert.throws(
    () => childEnvironments({ ...env, RIVET_EXECUTOR_RUNTIME_CONFIG_URL: 'http://api:8080/config' }),
    /loopback/,
  );
  assert.throws(() => childEnvironments({ ...env, RIVET_RUNTIME_CONFIG_PROTOCOL: '0' }), /protocol 1/);
  assert.throws(
    () => childEnvironments({ ...env, RIVET_DEPLOYMENT_TOPOLOGY: 'single-host' }),
    /local executor settings/,
  );
});

test('single-host backend keeps local executor configuration and shares only the loopback API', async () => {
  const { apiPort, executorPort, healthPort } = await ports();
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_APP_DATA_ROOT: '/data/rivet-app',
  };
  delete env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL;
  const children = childEnvironments(env);
  assert.equal(children.api.PORT, String(apiPort));
  assert.equal(children.api.RIVET_VM_MIGRATION_EDITOR_CONTROL, '1');
  assert.equal(children.executor.PORT, String(executorPort));
  assert.equal(children.executor.RIVET_VM_MIGRATION_CONTROL_ROOT, '/data/rivet-app');
  assert.equal(children.executor.RIVET_EXECUTOR_RUNTIME_CONFIG_URL, undefined);
  assert.equal(children.executor.RIVET_RUNTIME_LIBRARIES_REPLICA_TIER, undefined);
  assert.equal(
    children.executor.RIVET_LLM_PROFILE_HEALTH_API_URL,
    `http://127.0.0.1:${apiPort}/api/workflows/llm-profile-health`,
  );
  assert.equal(
    children.executor.RIVET_EXECUTION_ENVIRONMENT_API_URL,
    `http://127.0.0.1:${apiPort}/api/workflows/execution-environment`,
  );
  assert.throws(
    () =>
      childEnvironments({
        ...env,
        RIVET_EXECUTOR_RUNTIME_CONFIG_URL: 'http://127.0.0.1:80/internal/executor-runtime-config',
      }),
    /local executor settings/,
  );
});

test('single-host supervisor keeps its metadata owner lease until both children stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-owner-'));
  legacyTransitionFixture(dir);
  const env = {
    ...environment(await ports()),
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_APP_DATA_ROOT: dir,
    RIVET_LOCAL_METADATA_CONTROL_ROOT: dir,
  };
  delete env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL;
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  await writeFile(
    apiScript,
    `import {createServer} from 'node:http';
    const server = createServer((_request, response) => response.writeHead(200).end());
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));`,
  );
  await writeFile(
    executorScript,
    `import {createServer} from 'node:net';
    const server = createServer(socket => socket.end());
    server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.({type:'rivet-executor-ready'}));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));`,
  );
  let supervisor;
  try {
    supervisor = await startBackendSupervisor({
      env,
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    await waitForReady(Number(env.RIVET_BACKEND_HEALTH_PORT));
    assert.throws(() => acquireLocalMetadataOwnerLease(dir), /Another backend/);
    await supervisor.stop();
    const lease = acquireLocalMetadataOwnerLease(dir, { requireExisting: true });
    lease.release();
  } finally {
    await supervisor?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('supervisor releases the owner lease when its health listener fails before child launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-owner-listener-'));
  legacyTransitionFixture(dir);
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '0.0.0.0', resolve));
  const env = {
    ...environment(await ports()),
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: dir,
    RIVET_APP_DATA_ROOT: dir,
    RIVET_BACKEND_HEALTH_PORT: String(listener.address().port),
  };
  delete env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL;
  try {
    await assert.rejects(startBackendSupervisor({ env }), { code: 'EADDRINUSE' });
    const lease = acquireLocalMetadataOwnerLease(dir, { requireExisting: true });
    lease.release();
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined backend becomes ready only after both children and exits when the executor fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-supervisor-'));
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  const { apiPort, executorPort, healthPort } = await ports();
  await writeFile(
    apiScript,
    `
    import { createServer } from 'node:http';
    const server = createServer((_request, response) => response.writeHead(200).end());
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `,
  );
  await writeFile(
    executorScript,
    `
    import { createServer } from 'node:net';
    createServer((socket) => socket.end()).listen(Number(process.env.PORT), '127.0.0.1', () => {
      process.send?.({ type: 'rivet-executor-ready' });
    });
    setTimeout(() => process.exit(7), 1_000);
  `,
  );
  try {
    const supervisor = await startBackendSupervisor({
      env: environment({ apiPort, executorPort, healthPort }),
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    await waitForReady(healthPort);
    assert.equal((await fetch(`http://127.0.0.1:${healthPort}/livez`)).status, 200);
    assert.equal(await supervisor.completed, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined backend does not launch the executor before the API is ready', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-supervisor-'));
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  const executorMarker = join(dir, 'executor-started');
  const { apiPort, executorPort, healthPort } = await ports();
  await writeFile(apiScript, 'process.exit(7);');
  await writeFile(
    executorScript,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(executorMarker)}, 'started');`,
  );
  try {
    const supervisor = await startBackendSupervisor({
      env: environment({ apiPort, executorPort, healthPort }),
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    assert.equal(await supervisor.completed, 1);
    await assert.rejects(access(executorMarker), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined backend withdraws readiness while the development executor watcher replaces its child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-supervisor-'));
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  const { apiPort, executorPort, healthPort } = await ports();
  await writeFile(
    apiScript,
    `import { createServer } from 'node:http';
     const server = createServer((_request, response) => response.writeHead(200).end());
     server.listen(Number(process.env.PORT), '127.0.0.1');
     process.on('SIGTERM', () => server.close(() => process.exit(0)));`,
  );
  await writeFile(
    executorScript,
    `import { createServer } from 'node:net';
     const server = createServer((socket) => socket.end());
     server.listen(Number(process.env.PORT), '127.0.0.1', () => {
       process.send?.({ type: 'rivet-executor-ready' });
       setTimeout(() => {
         process.send?.({ type: 'rivet-executor-unready' });
         setTimeout(() => process.send?.({ type: 'rivet-executor-ready' }), 500);
       }, 500);
     });
     process.on('SIGTERM', () => server.close(() => process.exit(0)));`,
  );
  let supervisor;
  try {
    supervisor = await startBackendSupervisor({
      env: environment({ apiPort, executorPort, healthPort }),
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
    });
    await waitForReady(healthPort);
    await waitForHealthStatus(healthPort, 503);
    await waitForReady(healthPort);
  } finally {
    if (supervisor) assert.equal(await supervisor.stop(), 0);
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined backend terminates both children on a graceful stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-backend-supervisor-'));
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  const apiMarker = join(dir, 'api-stopped');
  const executorMarker = join(dir, 'executor-stopped');
  const { apiPort, executorPort, healthPort } = await ports();
  await writeFile(
    apiScript,
    `
    import { createServer } from 'node:http';
    import { writeFileSync } from 'node:fs';
    const server = createServer((_request, response) => response.writeHead(200).end());
    server.listen(Number(process.env.PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => {
      writeFileSync(${JSON.stringify(apiMarker)}, 'stopped');
      process.exit(0);
    }));
  `,
  );
  await writeFile(
    executorScript,
    `
    import { createServer } from 'node:net';
    import { writeFileSync } from 'node:fs';
    if (process.cwd() !== ${JSON.stringify(dir)}) process.exit(3);
    const server = createServer((socket) => socket.end());
    server.listen(Number(process.env.PORT), '127.0.0.1', () => {
      process.send?.({ type: 'rivet-executor-ready' });
    });
    process.on('SIGTERM', () => server.close(() => {
      writeFileSync(${JSON.stringify(executorMarker)}, 'stopped');
      process.exit(0);
    }));
  `,
  );
  try {
    const supervisor = await startBackendSupervisor({
      env: environment({ apiPort, executorPort, healthPort }),
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000,
    });
    await waitForReady(healthPort);
    assert.equal(await supervisor.stop(), 0);
    // Windows terminates child processes directly for SIGTERM instead of delivering their handlers.
    if (process.platform !== 'win32') {
      await access(apiMarker);
      await access(executorMarker);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
