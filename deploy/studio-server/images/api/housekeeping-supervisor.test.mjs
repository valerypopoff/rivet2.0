import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHousekeepingSupervisor } from './housekeeping-supervisor.mjs';
import { startBackendSupervisor } from './backend-supervisor.mjs';
import { handoverHousekeeping } from '../../scripts/lib/housekeeping-handover.mjs';

// test-style: fixture-read: Inspect only test-owned descriptors, saved bytes and synthetic process counters.

async function unusedPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
test('real worker handover retains one disk owner and preserves its working files', async (t) => {
  assert.equal(process.platform, 'linux', 'Mandatory Linux process test.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-handover-'));
  const namespace = randomUUID();
  const make = async () =>
    createHousekeepingSupervisor({
      env: {
        ...process.env,
        RIVET_LEGACY_RESTORE_ROOT: root,
        RIVET_POD_UID: randomUUID(),
        RIVET_POD_IP: '127.0.0.1',
        RIVET_NAMESPACE_UID: namespace,
        RIVET_HOUSEKEEPING_PORT: String(await unusedPort()),
      },
      incarnation: randomUUID(),
      token: randomUUID(),
      timeoutMs: 3000,
      command: [process.execPath, fileURLToPath(new URL('./fixtures/housekeeping-api.mjs', import.meta.url))],
    });
  const first = await make(),
    second = await make();
  t.after(async () => {
    await first.stop();
    await second.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const id = randomUUID();
  assert.equal((await first.command('acquire', id)).state, 'owner');
  assert.equal((await first.command('acquire', id)).state, 'owner', 'same-operation observation is idempotent');
  await assert.rejects(async () => first.command('acquire', randomUUID()), /operation identity changed/);
  assert.equal(first.snapshot().state, 'owner', 'foreign command must not poison a healthy owner');
  const descriptor = JSON.parse(await fs.readFile(path.join(root, 'housekeeping-owner.json'), 'utf8'));
  assert.equal(descriptor.namespaceUid, namespace);
  assert.equal((await second.command('acquire', id)).state, 'standby');
  await fs.writeFile(path.join(root, 'saved-upload'), 'preserved bytes');
  await fs.writeFile(path.join(root, 'busy'), 'accepted restore awaiting confirmation');
  const release = first.command('release', id);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(first.snapshot().state, 'waiting', 'accepted restore remains available before API retirement');
  assert.equal((await second.command('acquire', id)).state, 'standby', 'busy owner cannot be replaced');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, 'housekeeping-owner.json'), 'utf8')).incarnation,
    descriptor.incarnation,
  );
  await fs.unlink(path.join(root, 'busy'));
  assert.equal((await release).state, 'released');
  assert.equal((await second.command('acquire', id)).state, 'owner');
  assert.notEqual(
    JSON.parse(await fs.readFile(path.join(root, 'housekeeping-owner.json'), 'utf8')).incarnation,
    descriptor.incarnation,
  );
  assert.equal(await fs.readFile(path.join(root, 'saved-upload'), 'utf8'), 'preserved bytes');
  await second.command('release', id);
});

test('an unavailable replacement lock mount never stops the healthy real worker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-target-unavailable-'));
  const make = async (directory) => {
    const incarnation = randomUUID(),
      uid = randomUUID(),
      port = await unusedPort();
    const supervisor = createHousekeepingSupervisor({
      env: {
        ...process.env,
        RIVET_LEGACY_RESTORE_ROOT: directory,
        RIVET_POD_UID: uid,
        RIVET_POD_IP: '127.0.0.1',
        RIVET_NAMESPACE_UID: 'test-namespace',
        RIVET_HOUSEKEEPING_PORT: String(port),
      },
      incarnation,
      token: randomUUID(),
      timeoutMs: 3000,
      command: [process.execPath, fileURLToPath(new URL('./fixtures/housekeeping-api.mjs', import.meta.url))],
    });
    return { uid, incarnation, port, supervisor };
  };
  const source = await make(root),
    target = await make(path.join(root, 'unavailable-mount'));
  t.after(async () => {
    await source.supervisor.stop();
    await target.supervisor.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  await source.supervisor.command('acquire', randomUUID());
  await assert.rejects(target.supervisor.command('acquire', randomUUID()), { code: 'ENOENT' });
  assert.equal(target.supervisor.snapshot().state, 'failed');
  const operation = {
    record: { token: randomUUID(), owner: {} },
    assertLease() {},
    async checkpoint(patch) {
      Object.assign(this.record, patch);
    },
  };
  let commands = 0;
  await assert.rejects(
    handoverHousekeeping({
      source,
      target,
      operation,
      timeoutMs: 3000,
      // Developer readiness is independent of the failed maintenance process.
      confirmReady: async () => {},
      status: async (pod) => ({ incarnation: pod.incarnation, housekeeping: pod.supervisor.snapshot() }),
      command: async (pod, action, id) => {
        commands++;
        return pod.supervisor.command(action, id);
      },
    }),
    /target cannot acquire ownership/,
  );
  assert.equal(commands, 0);
  assert.equal(source.supervisor.snapshot().state, 'owner');
  assert.equal((await fetch(`http://127.0.0.1:${source.port}/readyz`)).status, 200);
  assert.equal(operation.record.owner.housekeeping, undefined);
});

for (const duringPublication of [false, true])
  test(`worker crash ${duringPublication ? 'during publication' : 'after readiness'} retains fencing until its real supervisor exits`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-crash-owner-'));
    const port = await unusedPort(),
      incarnation = randomUUID();
    const env = {
      ...process.env,
      RIVET_LEGACY_RESTORE_ROOT: root,
      RIVET_POD_UID: randomUUID(),
      RIVET_POD_IP: '127.0.0.1',
      RIVET_NAMESPACE_UID: randomUUID(),
      RIVET_HOUSEKEEPING_PORT: String(port),
      RIVET_PROCESS_INCARNATION: incarnation,
      RIVET_ROLLING_RETIREMENT_TOKEN: randomUUID(),
      RIVET_FIXTURE_CRASH_DURING_PUBLICATION: duringPublication ? '1' : '0',
    };
    const parent = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/housekeeping-owner-process.mjs', import.meta.url))],
      { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    const closed = new Promise((resolve) => parent.once('close', resolve));
    let observed;
    parent.on('message', (message) => {
      observed = message.state;
    });
    const wait = async (state) => {
      const end = Date.now() + 5000;
      while (observed !== state && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(observed, state);
    };
    const follower = createHousekeepingSupervisor({
      env: { ...env, RIVET_POD_UID: randomUUID(), RIVET_HOUSEKEEPING_PORT: String(await unusedPort()) },
      incarnation: randomUUID(),
      token: randomUUID(),
      timeoutMs: 3000,
      command: [process.execPath, fileURLToPath(new URL('./fixtures/housekeeping-api.mjs', import.meta.url))],
    });
    t.after(async () => {
      parent.kill('SIGKILL');
      await closed;
      await follower.stop();
      await fs.rm(root, { recursive: true, force: true });
    });
    if (!duringPublication) {
      await wait('owner');
      await fetch(`http://127.0.0.1:${port}/crash`);
    }
    await wait('failed');
    assert.equal((await follower.command('acquire', randomUUID())).state, 'standby');
    parent.kill('SIGKILL');
    await closed;
    assert.equal((await follower.command('acquire', randomUUID())).state, 'owner');
    const descriptor = JSON.parse(await fs.readFile(path.join(root, 'housekeeping-owner.json'), 'utf8'));
    assert.notEqual(descriptor.incarnation, incarnation);
  });

test('restore recovery obtains exclusive housekeeping while the developer API is still fenced', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-fenced-developer-'));
  const apiPort = await unusedPort(),
    executorPort = await unusedPort(),
    healthPort = await unusedPort();
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap',
    RIVET_POD_NAME: 'backend-0',
    RIVET_POD_UID: randomUUID(),
    RIVET_POD_IP: '127.0.0.1',
    RIVET_NAMESPACE_UID: randomUUID(),
    RIVET_HOUSEKEEPING_PORT: String(await unusedPort()),
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`,
    RIVET_LEGACY_RESTORE_ENABLED: '1',
    RIVET_LEGACY_RESTORE_ROOT: root,
    RIVET_FIXTURE_RESTORE_MAINTENANCE: '1',
  };
  const supervisor = await startBackendSupervisor({
    env,
    executorCwd: root,
    apiCommand: [process.execPath, fileURLToPath(new URL('./fixtures/housekeeping-api.mjs', import.meta.url))],
    executorCommand: [process.execPath, '-e', 'throw Error("fenced editor must not start")'],
  });
  t.after(async () => {
    await supervisor.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const end = Date.now() + 5000;
  while (supervisor.housekeeping.snapshot().state !== 'owner' && Date.now() < end)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(supervisor.housekeeping.snapshot().state, 'owner');
  assert.equal((await fetch(`http://127.0.0.1:${healthPort}/readyz`)).status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${healthPort}/livez`)).status, 200);
});

test('an acknowledged restore consumer exit replaces only developer children, not housekeeping supervision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-consumer-cycle-'));
  const apiPort = await unusedPort(),
    executorPort = await unusedPort(),
    healthPort = await unusedPort();
  const env = {
    ...process.env,
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_RUNTIME_CONFIG_PROTOCOL: '1',
    RIVET_HA_CONTROL_PLANE_MODE: 'singleton-overlap',
    RIVET_POD_NAME: 'backend-1',
    RIVET_POD_UID: randomUUID(),
    RIVET_POD_IP: '127.0.0.1',
    RIVET_NAMESPACE_UID: randomUUID(),
    RIVET_HOUSEKEEPING_PORT: String(await unusedPort()),
    RIVET_BACKEND_API_PORT: String(apiPort),
    RIVET_BACKEND_EXECUTOR_PORT: String(executorPort),
    RIVET_BACKEND_HEALTH_PORT: String(healthPort),
    RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `http://127.0.0.1:${apiPort}/internal/executor-runtime-config`,
    RIVET_ROLLING_RETIREMENT_PROTOCOL: '1',
    RIVET_LEGACY_RESTORE_ROOT: root,
    RIVET_CYCLE_TEST_ROOT: root,
  };
  const api = `const fs=require('fs'),p=require('path').join(process.env.RIVET_CYCLE_TEST_ROOT,'starts');let n=Number(fs.existsSync(p)?fs.readFileSync(p):0)+1;fs.writeFileSync(p,String(n));require('http').createServer((q,s)=>s.end(JSON.stringify({ok:true}))).listen(Number(process.env.PORT),'127.0.0.1');if(n===1)setTimeout(()=>process.send({type:'rivet-restore-consumer-restart',incarnation:process.env.RIVET_PROCESS_INCARNATION},()=>process.exit(0)),300);`;
  const editor = `const s=require('net').createServer().listen(Number(process.env.PORT),'127.0.0.1',()=>process.send({type:'rivet-executor-ready'}));process.on('message',()=>{});process.on('SIGTERM',()=>s.close());`;
  const supervisor = await startBackendSupervisor({
    env,
    executorCwd: root,
    apiCommand: [process.execPath, '-e', api],
    executorCommand: [process.execPath, '-e', editor],
  });
  t.after(async () => {
    await supervisor.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const originalHousekeeping = supervisor.housekeeping;
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const starts = await fs.readFile(path.join(root, 'starts'), 'utf8').catch(() => '0');
    if (starts === '2' && (await fetch(`http://127.0.0.1:${healthPort}/readyz`)).ok) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(await fs.readFile(path.join(root, 'starts'), 'utf8'), '2');
  assert.equal((await fetch(`http://127.0.0.1:${healthPort}/readyz`)).status, 200);
  assert.equal(supervisor.housekeeping, originalHousekeeping);
  assert.equal(supervisor.housekeeping.snapshot().state, 'standby');
});
