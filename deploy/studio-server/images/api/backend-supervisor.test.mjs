import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { childEnvironments, startBackendSupervisor, runBackendSupervisor } from './backend-supervisor.mjs';
import { acquireLocalMetadataOwnerLease } from './local-metadata-owner-lease.mjs';
import { devBackendSupervisorOptions } from '../../scripts/dev-backend-supervisor.mjs';
import { requestBackendRetirement, retireBackend } from './retire-backend.mjs';

// test-style: fixture-read: reads only writer PID/configuration records generated in owned temporary fixtures.

test('development first start and legacy preparation use the same current-source control command', () => {
  const options = devBackendSupervisorOptions('/fixture-workspace', { NODE_OPTIONS: '--enable-source-maps' });
  const control = [
    process.execPath,
    '--import',
    '/fixture-workspace/node_modules/tsx/dist/loader.mjs',
    '/fixture-workspace/packages/studio-server-api/src/scripts/local-metadata-control.ts',
  ];
  assert.deepEqual(options.localStorageInitializeCommand, [...control, '--initialize-empty']);
  assert.deepEqual(options.localUpgradeProvisionCommand, [...control, '--provision']);
  assert.equal(options.executorCwd, '/fixture-workspace');
  assert.equal(
    options.apiEnvOverrides.NODE_OPTIONS,
    '--enable-source-maps --import=/fixture-workspace/packages/studio-server-bootstrap/bootstrap.mjs',
  );
  assert.deepEqual(options.executorEnvOverrides, {
    NODE_OPTIONS: '',
    RIVET_EXECUTOR_CHILD_NODE_OPTIONS: options.apiEnvOverrides.NODE_OPTIONS,
  });
});

test(
  'pod-local retirement socket is private, incarnation fenced and removed on supervisor close',
  { timeout: 15000, skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivet-retirement-socket-'));
    const socketPath = `/tmp/rivet-retirement-${randomUUID()}.sock`;
    const apiScript = join(directory, 'api.mjs'),
      executorScript = join(directory, 'executor.mjs');
    const allocated = await ports();
    let supervisor;
    try {
      await writeFile(
        apiScript,
        `
        import {createServer} from 'node:http';
        let operationId=null, state='serving';
        const s=createServer(async(q,r)=>{
          if(q.url==='/readyz'){r.end(JSON.stringify({ok:true}));return;}
          if(q.headers['x-rivet-retirement-token']!==process.env.RIVET_ROLLING_RETIREMENT_TOKEN){r.writeHead(403).end();return;}
          if(q.method==='POST'){let body='';for await(const c of q)body+=c;operationId=JSON.parse(body).operationId;state='drained';}
          r.end(JSON.stringify({protocol:1,incarnation:process.env.RIVET_PROCESS_INCARNATION,operationId,state}));
        });
        s.listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
      `,
      );
      await writeFile(
        executorScript,
        `
        import {createServer} from 'node:net';
        let operationId=null,state='serving';
        process.on('message',m=>{if(m.type==='rivet-retire'){operationId=m.operationId;state='drained';}
          process.send({type:'rivet-retirement-status',nonce:m.nonce,protocol:1,incarnation:process.env.RIVET_PROCESS_INCARNATION,operationId,state});});
        const s=createServer(c=>c.end());s.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send({type:'rivet-executor-ready'}));
        process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
      `,
      );
      supervisor = await startBackendSupervisor({
        env: {
          ...environment(allocated),
          RIVET_ROLLING_RETIREMENT_PROTOCOL: '1',
          RIVET_ROLLING_RETIREMENT_SOCKET: socketPath,
        },
        apiCommand: [process.execPath, apiScript],
        executorCommand: [process.execPath, executorScript],
        executorCwd: directory,
        signalSource: new EventEmitter(),
        shutdownTimeoutMs: 1000,
        apiStartupTimeoutMs: 5000,
      });
      await waitForReady(allocated.healthPort);
      assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
      const before = await requestBackendRetirement(socketPath);
      await assert.rejects(
        requestBackendRetirement(socketPath, 'POST', {
          protocol: 1,
          operationId: randomUUID(),
          incarnation: randomUUID(),
        }),
        /rejected/,
      );
      assert.equal((await requestBackendRetirement(socketPath)).state, 'serving');
      assert.equal((await fetch(`http://127.0.0.1:${allocated.healthPort}/retirement`)).status, 404);
      const status = await retireBackend({
        socketPath,
        operationId: randomUUID(),
        incarnation: before.incarnation,
        timeoutMs: 5000,
      });
      assert.equal(status.state, 'drained');
      await supervisor.stop();
      await assert.rejects(access(socketPath), { code: 'ENOENT' });
    } finally {
      await supervisor?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'planned retirement keeps real children alive beyond the forced-shutdown grace and drains executor before API',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivet-planned-retirement-'));
    const apiScript = join(directory, 'api.mjs'),
      executorScript = join(directory, 'executor.mjs');
    const allocated = await ports();
    let supervisor;
    try {
      await writeFile(
        apiScript,
        `
        import { createServer } from 'node:http';
        let operationId = null, state = 'serving';
        const status = () => ({ protocol: 1, withdrawalProtocol: 1, incarnation: process.env.RIVET_PROCESS_INCARNATION, operationId, state });
        const server = createServer(async (req, res) => {
          if (req.url === '/readyz') { res.end(JSON.stringify({ ok: state === 'serving' })); return; }
          if (req.url === '/internal/process-retirement') {
            if (req.headers['x-rivet-retirement-token'] !== process.env.RIVET_ROLLING_RETIREMENT_TOKEN) { res.writeHead(403).end(); return; }
            if (req.method === 'POST') {
              let body = ''; for await (const chunk of req) body += chunk;
              const command = JSON.parse(body); operationId = command.operationId;
              state = command.action === 'withdraw' ? 'withdrawing' : 'draining';
            }
            res.end(JSON.stringify(status())); return;
          }
          if (req.url === '/finish') { state = 'drained'; res.end('complete'); return; }
          res.end(state);
        });
        server.listen(Number(process.env.PORT), '127.0.0.1');
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      `,
      );
      await writeFile(
        executorScript,
        `
        import { createServer } from 'node:http';
        if (process.env.RIVET_ROLLING_RETIREMENT_TOKEN) process.exit(9);
        let operationId = null, state = 'serving';
        const server = createServer((req, res) => {
          if (req.url === '/finish') state = 'drained';
          res.end(state);
        });
        process.on('message', (message) => {
          if (message.type === 'rivet-retire') { operationId = message.operationId; state = 'draining'; }
          if (['rivet-retire', 'rivet-retirement-query'].includes(message.type))
            process.send({ type: 'rivet-retirement-status', nonce: message.nonce, protocol: 1,
              incarnation: process.env.RIVET_PROCESS_INCARNATION, operationId, state });
        });
        server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send({type:'rivet-executor-ready'}));
        process.on('SIGTERM', () => server.close(() => process.exit(0)));
      `,
      );
      supervisor = await startBackendSupervisor({
        env: { ...environment(allocated), RIVET_ROLLING_RETIREMENT_PROTOCOL: '1' },
        apiCommand: [process.execPath, apiScript],
        executorCommand: [process.execPath, executorScript],
        executorCwd: directory,
        signalSource: new EventEmitter(),
        shutdownTimeoutMs: 1000,
        apiStartupTimeoutMs: 5000,
      });
      await waitForReady(allocated.healthPort);
      const before = supervisor.retirement.snapshot();
      supervisor.retirement.withdraw('a45b6a70-912f-4d7c-a4b3-7598f9a94021', before.incarnation);
      await waitForHealthStatus(allocated.healthPort, 503);
      assert.equal(await (await fetch(`http://127.0.0.1:${allocated.apiPort}`)).text(), 'withdrawing');
      assert.equal(await (await fetch(`http://127.0.0.1:${allocated.executorPort}`)).text(), 'serving');
      assert.equal(supervisor.retirement.snapshot().state, 'withdrawing');
      supervisor.retirement.begin('a45b6a70-912f-4d7c-a4b3-7598f9a94021', before.incarnation);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal((await fetch(`http://127.0.0.1:${allocated.healthPort}/livez`)).status, 200);
      assert.equal(await (await fetch(`http://127.0.0.1:${allocated.apiPort}`)).text(), 'withdrawing');
      assert.equal(await (await fetch(`http://127.0.0.1:${allocated.executorPort}`)).text(), 'draining');
      assert.equal(supervisor.retirement.snapshot().state, 'draining');
      await fetch(`http://127.0.0.1:${allocated.executorPort}/finish`);
      const deadline = Date.now() + 5000;
      while ((await (await fetch(`http://127.0.0.1:${allocated.apiPort}`)).text()) !== 'draining') {
        assert.ok(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await fetch(`http://127.0.0.1:${allocated.apiPort}/finish`);
      assert.equal((await supervisor.retirement.wait()).state, 'drained');
      assert.equal(await supervisor.stop(), 0);
    } finally {
      await supervisor?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('failed automatic first start never launches serving children and releases its owner lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rivet-first-start-fence-'));
  const marker = join(root, 'child-started');
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_WORKFLOW_STORAGE_BACKEND: 'filesystem',
    RIVET_DEPLOYMENT_STORAGE_MODE: '',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '',
    RIVET_LOCAL_METADATA_UI_ROOT: join(root, 'control'),
    RIVET_APP_DATA_ROOT: join(root, 'app-data'),
    RIVET_WORKFLOWS_ROOT: join(root, 'workflows'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: join(root, 'recordings'),
    RIVET_RUNTIME_LIBRARIES_ROOT: join(root, 'libraries'),
  };
  try {
    for (const directory of ['control', 'app-data', 'workflows', 'recordings', 'libraries'])
      await mkdir(join(root, directory));
    const childCommand = [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "started"); process.exit(99)',
      marker,
    ];
    await assert.rejects(
      runBackendSupervisor({
        env,
        signalSource: new EventEmitter(),
        localStorageInitializeCommand: [process.execPath, '-e', 'process.exit(1)'],
        apiCommand: childCommand,
        executorCommand: childCommand,
      }),
      /provisioning failed/,
    );
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await writeFile(join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'unexpected-entry'), 'retained');
    await assert.rejects(
      runBackendSupervisor({
        env,
        signalSource: new EventEmitter(),
        localStorageInitializeCommand: [process.execPath, '-e', 'process.exit(0)'],
        apiCommand: childCommand,
        executorCommand: childCommand,
      }),
      /fresh or owned/,
    );
    await assert.rejects(access(marker), { code: 'ENOENT' });
    const lease = acquireLocalMetadataOwnerLease(env.RIVET_LOCAL_METADATA_UI_ROOT);
    lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'shutdown during first start closes the offline writer before releasing ownership',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-first-start-stop-'));
    const env = {
      ...process.env,
      RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
      RIVET_WORKFLOW_STORAGE_BACKEND: 'filesystem',
      RIVET_DEPLOYMENT_STORAGE_MODE: '',
      RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
      RIVET_LOCAL_METADATA_UI_ROOT: join(root, 'control'),
      RIVET_APP_DATA_ROOT: join(root, 'app-data'),
      RIVET_WORKFLOWS_ROOT: join(root, 'workflows'),
      RIVET_WORKFLOW_RECORDINGS_ROOT: join(root, 'recordings'),
      RIVET_RUNTIME_LIBRARIES_ROOT: join(root, 'libraries'),
    };
    const signals = new EventEmitter();
    const pidFile = join(root, 'writer-pid');
    let pending;
    try {
      for (const directory of ['control', 'app-data', 'workflows', 'recordings', 'libraries'])
        await mkdir(join(root, directory));
      pending = runBackendSupervisor({
        env,
        signalSource: signals,
        shutdownTimeoutMs: 1000,
        localStorageInitializeCommand: [
          process.execPath,
          '-e',
          `
        process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(process.argv[1], String(process.pid));
        setTimeout(() => process.exit(0), 5000);
      `,
          pidFile,
        ],
      });
      const deadline = Date.now() + 5000;
      let pid;
      while (!pid) {
        try {
          pid = Number(await readFile(pidFile, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        assert.ok(Date.now() < deadline, 'offline writer did not start');
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.throws(() => acquireLocalMetadataOwnerLease(env.RIVET_LOCAL_METADATA_UI_ROOT));
      signals.emit('SIGTERM');
      assert.equal(await pending, 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      const lease = acquireLocalMetadataOwnerLease(env.RIVET_LOCAL_METADATA_UI_ROOT);
      lease.release();
      assert.equal(signals.listenerCount('SIGTERM'), 0);
      const configuration = JSON.parse(
        await readFile(join(env.RIVET_LOCAL_METADATA_UI_ROOT, 'ui-managed', 'ui-configuration.json'), 'utf8'),
      );
      assert.equal(configuration.phase, 'initializing');
    } finally {
      signals.emit('SIGTERM');
      await pending;
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
      'RIVET_ROLLING_RETIREMENT_PROTOCOL',
      'RIVET_ROLLING_RETIREMENT_TOKEN',
      'RIVET_PROCESS_INCARNATION',
      'RIVET_HA_PROTOCOL',
      'RIVET_POD_NAME',
      'RIVET_HA_HEADLESS_SERVICE',
      'RIVET_HA_BACKEND_NAME',
      'RIVET_BACKEND_API_PORT',
      'RIVET_BACKEND_EXECUTOR_PORT',
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

test(
  'replicated dotenv cannot reopen release admission or retarget schema-reader inventory',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rivet-cutover-dotenv-'));
    const dotenv = join(dir, 'fixture.env');
    const selected = {
      RIVET_RELEASE_MAINTENANCE: 'true',
      RIVET_SCHEMA_MIGRATION_RELEASE: 'owned-release',
      RIVET_MANAGED_MAINTENANCE_ENABLED: 'false',
      RIVET_ROLLING_RETIREMENT_PROTOCOL: '1',
      RIVET_ROLLING_RETIREMENT_TOKEN: 'fixture-private-retirement-token',
      RIVET_PROCESS_INCARNATION: 'fixture-incarnation',
      RIVET_HA_PROTOCOL: '1',
      RIVET_POD_NAME: 'fixture-backend-0',
      RIVET_HA_HEADLESS_SERVICE: 'fixture-headless.example',
      RIVET_HA_BACKEND_NAME: 'fixture-backend',
      RIVET_BACKEND_API_PORT: '3001',
      RIVET_BACKEND_EXECUTOR_PORT: '21888',
    };
    try {
      await writeFile(
        dotenv,
        'RIVET_RELEASE_MAINTENANCE=false\nRIVET_SCHEMA_MIGRATION_RELEASE=other\nRIVET_MANAGED_MAINTENANCE_ENABLED=true\n' +
          'RIVET_ROLLING_RETIREMENT_PROTOCOL=other\nRIVET_ROLLING_RETIREMENT_TOKEN=other\nRIVET_PROCESS_INCARNATION=other\n' +
          'RIVET_HA_PROTOCOL=other\nRIVET_POD_NAME=other\nRIVET_HA_HEADLESS_SERVICE=other\nRIVET_HA_BACKEND_NAME=other\nRIVET_BACKEND_API_PORT=9000\nRIVET_BACKEND_EXECUTOR_PORT=9001\n',
      );
      const output = execFileSync(
        'sh',
        [
          '-c',
          '. "$1"; load_optional_dotenv_preserving_deployment_storage "$2"; "$3" -e \'console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(k=>[k,process.env[k]]))))\' "$4"',
          'fixture',
          fileURLToPath(new URL('../lib/load-env.sh', import.meta.url)),
          dotenv,
          process.execPath,
          JSON.stringify(Object.keys(selected)),
        ],
        { env: { ...process.env, ...selected, RIVET_DEPLOYMENT_TOPOLOGY: 'replicated' }, encoding: 'utf8' },
      );
      assert.deepEqual(JSON.parse(output), selected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

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

test('execution-only overlap pods do not initialize developer housekeeping or require its disk identity', async () => {
  const env = { ...environment(await ports()), RIVET_HA_API_ONLY: '1', RIVET_API_PROFILE: 'execution',
    RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap' };
  const supervisor = await startBackendSupervisor({ env,
    apiCommand: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    executorCommand: [process.execPath, '-e', 'process.exit(99)'],
    shutdownTimeoutMs: 1000,
  });
  assert.equal(supervisor.housekeeping, null);
  await supervisor.stop();
});

test(
  'shutdown in the listener-opening gap cannot strand a newly started child supervisor',
  { timeout: 10_000 },
  async () => {
    const signals = new EventEmitter();
    let injected = false;
    signals.on('newListener', (event) => {
      if (event === 'SIGINT' && signals.listenerCount('SIGINT') === 1) {
        // Parent is listening, but startBackendSupervisor has not yet registered
        // its handlers. Reproduce a signal during its asynchronous startup gap.
        injected = true;
        signals.emit('SIGTERM');
      }
    });
    const result = await runBackendSupervisor({
      env: environment(await ports()),
      signalSource: signals,
      apiCommand: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 5000)'],
      executorCommand: [process.execPath, '-e', 'process.exit(99)'],
      shutdownTimeoutMs: 1000,
    });
    assert.equal(injected, true);
    assert.equal(result, 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  },
);

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
  assert.throws(() => childEnvironments({ ...env, RIVET_RUNNER_SLOT_ID: 'runtime-2',
    RIVET_EXECUTION_STARTUP_FENCE: 'runtime-2' }), /startup-fenced/);
  assert.doesNotThrow(() => childEnvironments({ ...env, RIVET_RUNNER_SLOT_ID: 'runtime-1',
    RIVET_EXECUTION_STARTUP_FENCE: 'runtime-2' }));
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

test('managed restore keeps control ready without an executor, warms consumers and protects restart capability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-restore-supervisor-'));
  const apiScript = join(dir, 'api.mjs');
  const executorScript = join(dir, 'executor.mjs');
  const tokenFile = join(dir, 'token');
  const warmFile = join(dir, 'warm');
  const executorMarker = join(dir, 'executor-started');
  const allocated = await ports();
  let supervisor;
  await writeFile(
    apiScript,
    `
    import {createServer} from 'node:http';import {writeFileSync,existsSync} from 'node:fs';
    writeFileSync(${JSON.stringify(tokenFile)},process.env.RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN);
    const server=createServer((_req,res)=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({restoreMaintenance:true,restoreWarmup:existsSync(${JSON.stringify(warmFile)})})));
    server.listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `,
  );
  await writeFile(
    executorScript,
    `
    import {createServer} from 'node:net';import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(executorMarker)},'started');
    const server=createServer(socket=>socket.end());server.listen(Number(process.env.PORT),'127.0.0.1',()=>process.send?.({type:'rivet-executor-ready'}));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `,
  );
  try {
    supervisor = await startBackendSupervisor({
      env: { ...environment(allocated), RIVET_LEGACY_RESTORE_ENABLED: '1' },
      apiCommand: [process.execPath, apiScript],
      executorCommand: [process.execPath, executorScript],
      executorCwd: dir,
      apiStartupTimeoutMs: 5000,
      shutdownTimeoutMs: 2000,
    });
    await waitForReady(allocated.healthPort);
    await assert.rejects(access(executorMarker), { code: 'ENOENT' });
    const restart = `http://127.0.0.1:${allocated.healthPort}/legacy-restore/restart`;
    assert.equal((await fetch(restart, { method: 'POST' })).status, 403);
    const token = await readFile(tokenFile, 'utf8');
    assert.equal(
      (
        await fetch(restart, {
          method: 'POST',
          headers: { 'x-rivet-supervisor-token': token, origin: 'https://foreign.test' },
        })
      ).status,
      403,
    );
    await writeFile(warmFile, 'warm');
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await access(executorMarker);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('Executor did not warm');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await waitForReady(allocated.healthPort);
    assert.equal(
      (await fetch(restart, { method: 'POST', headers: { 'x-rivet-supervisor-token': token } })).status,
      202,
    );
    assert.equal(await supervisor.completed, 0);
    assert.equal(supervisor.requestedAction, 'restart');
  } finally {
    if (supervisor) await supervisor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
