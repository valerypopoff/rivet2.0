import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { temporaryHash, completedTemporaryCleanup } from './temporary-staging-contract.mjs';

/** Every releaser holds the same operation lock, including the completed-state
 * watchdog. A later operation's marker can never be removed by this one. */
export async function releaseTemporaryAdmission(store) {
  store.assertLocked();
  const { record } = await store.read();
  completedTemporaryCleanup(record);
  const file = path.join(path.dirname(store.directory), `active-${record.plan.projectId}.json`);
  const lease = await fs
    .readFile(file, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (!lease) return;
  // This completed operation may already have released its marker and a new
  // operation may have acquired admission. It has no remaining claim on it.
  if (lease.operationId !== record.plan.operationId) return;
  assert.deepEqual(
    lease,
    {
      operationId: record.plan.operationId,
      inputHash: record.plan.inputHash,
      directory: store.directory,
    },
    'Admission belongs to another operation',
  );
  await fs.unlink(file);
}

export async function linuxProcessIdentity(pid) {
  assert.equal(process.platform, 'linux', 'Infrastructure writers and watchdogs require Linux');
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const command = await fs.readFile(`/proc/${pid}/cmdline`);
    return {
      pid,
      startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      commandHash: temporaryHash(command),
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function sameLinuxProcess(identity) {
  const actual = await linuxProcessIdentity(identity.pid);
  return !!actual && actual.startTicks === identity.startTicks && actual.commandHash === identity.commandHash;
}
export async function writeWatchdogHealth(directory, identity, nonce, inputHash) {
  const temp = path.join(directory, `health-${process.pid}.tmp`),
    target = path.join(directory, 'watchdog-health.json');
  await fs.writeFile(temp, JSON.stringify({ identity, nonce, inputHash, observedAt: Date.now() }), { mode: 0o600 });
  await fs.rename(temp, target);
}
export async function assertTemporaryWatchdog(store) {
  const { record } = await store.read();
  const health = JSON.parse(await fs.readFile(path.join(store.directory, 'watchdog-health.json'), 'utf8'));
  assert.deepEqual(health.identity, record.watchdog.identity);
  assert.equal(health.nonce, record.watchdog.nonce);
  assert.equal(health.inputHash, record.plan.inputHash);
  assert.ok(Date.now() - health.observedAt >= 0 && Date.now() - health.observedAt < 30000);
  assert.ok(await sameLinuxProcess(record.watchdog.identity), 'Independent external watchdog is not running');
  assert.notEqual(record.watchdog.identity.pid, process.pid);
  assert.equal(
    await fs.stat(path.join(store.directory, 'stop-request.json')).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    ),
    false,
    'Expiry/stop admission is closed',
  );
}

/** Closing admission is independent of the writer lock. It never steals that
 * lock, kills an unidentified process, or treats a signal as proof of exit. */
export async function requestTemporaryStop(
  store,
  { settleMs = 120000, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const { record } = await store.read();
  if (record.complete && record.cleanupVerified) return;
  let firstRequest = true;
  await fs
    .writeFile(
      path.join(store.directory, 'stop-request.json'),
      JSON.stringify({ inputHash: record.plan.inputHash, at: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    )
    .catch((e) => {
      if (e.code !== 'EEXIST') throw e;
      firstRequest = false;
    });
  const writer = record.writer;
  if (!writer || !(await sameLinuxProcess(writer))) return;
  if (firstRequest) process.kill(writer.pid, 'SIGTERM');
  const end = Date.now() + settleMs;
  while (await sameLinuxProcess(writer)) {
    assert.ok(Date.now() < end, 'Exact writer remains alive; cleanup is blocked, not forced');
    await wait(1000);
  }
}
