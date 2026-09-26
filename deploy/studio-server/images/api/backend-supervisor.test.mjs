import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { childEnvironments, startBackendSupervisor } from './backend-supervisor.mjs';

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

function environment({ apiPort, executorPort, healthPort }) {
  return {
    ...process.env,
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`,
  };
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
  };
  delete env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL;
  const children = childEnvironments(env);
  assert.equal(children.api.PORT, String(apiPort));
  assert.equal(children.executor.PORT, String(executorPort));
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
