import assert from 'node:assert/strict';
// test-style: fixture-read: Inspect generated journal files and exact Linux test-process identities, never implementation text.
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { TemporaryStagingStore } from './lib/temporary-staging-store.mjs';
import { temporaryPlan } from './fixtures/temporary-staging-plan.mjs';
import { temporaryCleanupReceipt } from './lib/temporary-staging-contract.mjs';
import {
  linuxProcessIdentity,
  sameLinuxProcess,
  writeWatchdogHealth,
  assertTemporaryWatchdog,
  requestTemporaryStop,
  releaseTemporaryAdmission,
} from './lib/temporary-staging-watchdog.mjs';

test('real kernel ownership blocks simultaneous and paused writers; precise watchdog expiry waits for actual exit', async (t) => {
  assert.equal(process.platform, 'linux', 'Mandatory real Linux test; run in the isolated test container, never skip');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-temp-linux-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'rivet-q-12345-1'),
    store = new TemporaryStagingStore(directory);
  await store.initialize(temporaryPlan());
  const contender = new TemporaryStagingStore(directory);
  await store.locked(async () => {
    await assert.rejects(
      contender.locked(async () => {}),
      /owns/,
    );
  });
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  const identity = await linuxProcessIdentity(child.pid);
  assert.ok(await sameLinuxProcess(identity));
  assert.equal(await sameLinuxProcess({ ...identity, startTicks: '0' }), false);
  assert.equal(await sameLinuxProcess({ ...identity, commandHash: '0'.repeat(64) }), false);
  await store.locked(() =>
    store.change((r) => {
      r.writer = identity;
      r.watchdog = { identity, nonce: 'local-precise-test' };
    }),
  );
  const plan = (await store.read()).record.plan;
  await writeWatchdogHealth(directory, identity, 'local-precise-test', plan.inputHash);
  await assertTemporaryWatchdog(store);
  child.kill('SIGSTOP');
  await assert.rejects(
    requestTemporaryStop(store, { settleMs: 30, wait: () => new Promise((r) => setTimeout(r, 10)) }),
    /remains alive/,
  );
  assert.ok(await sameLinuxProcess(identity), 'SIGTERM acknowledgement is not process exit');
  child.kill('SIGCONT');
  await closed;
  assert.equal(await sameLinuxProcess(identity), false);
  await assert.rejects(assertTemporaryWatchdog(store));
  await requestTemporaryStop(store);
  await store.locked(() =>
    store.change((r) => {
      r.closed = true;
    }),
  );
});

test('completed cleanup releases its exact admission marker after an interrupted exit, never a later operation', async (t) => {
  assert.equal(process.platform, 'linux');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-temp-admission-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'rivet-q-12345-1'),
    store = new TemporaryStagingStore(dir);
  const plan = temporaryPlan();
  await store.initialize(plan);
  const active = path.join(temp, `active-${plan.projectId}.json`);
  const marker = { operationId: plan.operationId, inputHash: plan.inputHash, directory: dir };
  await fs.writeFile(active, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  await assert.rejects(releaseTemporaryAdmission(store), /kernel writer lock/);
  await store.locked(async () => {
    await assert.rejects(releaseTemporaryAdmission(store), /Verified cleanup/);
    await store.change((r) => {
      r.closed = true;
      r.complete = true;
      r.cleanupVerified = true;
      r.phase = 'cleaned-unactivated';
      r.finishedAt = new Date().toISOString();
      r.cleanupReceipt = temporaryCleanupReceipt(r, r.finishedAt);
    });
    await requestTemporaryStop(store);
    await assert.rejects(fs.stat(path.join(dir, 'stop-request.json')), { code: 'ENOENT' });
    await releaseTemporaryAdmission(store);
    await assert.rejects(fs.stat(active), { code: 'ENOENT' });
    await releaseTemporaryAdmission(store); // Lost local acknowledgement is harmless.
    const later = { ...marker, operationId: 'rivet-q-12346-1' };
    await fs.writeFile(active, JSON.stringify(later), { flag: 'wx', mode: 0o600 });
    await releaseTemporaryAdmission(store);
    assert.deepEqual(JSON.parse(await fs.readFile(active, 'utf8')), later);
    await fs.writeFile(active, JSON.stringify({ ...marker, inputHash: 'changed' }));
    await assert.rejects(releaseTemporaryAdmission(store), /another operation/);
  });
});

test('actual command can inspect a private operation without loading provider credentials or mutating it', async (t) => {
  assert.equal(process.platform, 'linux');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-temp-command-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'rivet-q-12345-1'),
    store = new TemporaryStagingStore(dir);
  await store.initialize(temporaryPlan());
  const entry = fileURLToPath(new URL('./temporary-staging.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, 'status', dir], {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.resume();
  assert.equal((await once(child, 'close'))[0], 0);
  const status = JSON.parse(output);
  assert.equal(status.phase, 'planned');
  assert.equal(status.testsPassed, false);
  assert.equal(status.evidenceExported, false);
  assert.equal(status.cleanupVerified, false);
  assert.equal(status.evidenceFailure, null);
  assert.equal((await store.read()).revision, 0);
  const rejected = spawn(process.execPath, [entry, 'invalid-mode', dir], {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rejected.stdout.resume();
  let diagnostics = '';
  rejected.stderr.on('data', (c) => {
    diagnostics += c;
  });
  assert.equal((await once(rejected, 'close'))[0], 1);
  assert.match(diagnostics, /Inspect the exact private journal/);
  const errors = (await fs.readdir(dir)).filter((name) => name.startsWith('terminal-error-'));
  assert.equal(errors.length, 1);
  const failure = JSON.parse(await fs.readFile(path.join(dir, errors[0]), 'utf8'));
  assert.equal(failure.mode, 'invalid-mode');
  assert.ok(failure.name && failure.message);
  assert.equal((await fs.stat(path.join(dir, errors[0]))).mode & 0o777, 0o600);
  assert.equal((await store.read()).revision, 0, 'Reporting a failure never changes the operation journal');
  await store.locked(() =>
    store.change((r) => {
      r.closed = r.complete = r.cleanupVerified = r.testsPassed = true;
      r.evidenceExported = false;
      r.evidenceFailure = 'terminal-diagnostics-unavailable';
      r.phase = 'cleaned';
      r.finishedAt = new Date().toISOString();
      r.cleanupReceipt = temporaryCleanupReceipt(r, r.finishedAt);
    }),
  );
  const terminal = spawn(process.execPath, [entry, 'status', dir], {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let finalOutput = '';
  terminal.stdout.on('data', (c) => {
    finalOutput += c;
  });
  terminal.stderr.resume();
  assert.equal((await once(terminal, 'close'))[0], 0);
  const finalStatus = JSON.parse(finalOutput);
  assert.equal(finalStatus.complete, true);
  assert.equal(finalStatus.testsPassed, true);
  assert.equal(finalStatus.cleanupVerified, true);
  assert.equal(finalStatus.evidenceExported, false);
  assert.equal(finalStatus.evidenceFailure, 'terminal-diagnostics-unavailable');
  assert.equal((await store.read()).revision, 1, 'Terminal status is read-only, not permission to qualify');
});
