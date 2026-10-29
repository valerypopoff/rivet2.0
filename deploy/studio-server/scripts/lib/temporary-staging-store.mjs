import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { acquireMaintenanceLock } from '../../images/api/maintenance-lock.mjs';
import { temporaryHash, verifyTemporaryPlan, completedTemporaryCleanup } from './temporary-staging-contract.mjs';

function transition(previous, record) {
  assert.equal(record.plan.inputHash, previous.plan.inputHash);
  for (const key of [
    'inputsHash',
    'firstBillableIntentAt',
    'firstBillableActivation',
    'expiresAt',
    'watchdog',
    'operation',
    'actorNodeIdentity',
    'baseline',
    'accounts',
    'settings',
    'exported',
    'finishedAt',
    'cleanupReceipt',
    'evidenceFailure',
  ])
    if (previous[key]) assert.deepEqual(record[key], previous[key], 'Frozen operation authority changed');
  for (const [key, value] of Object.entries(previous.identities ?? {}))
    assert.deepEqual(record.identities?.[key], value, 'Pinned environment identity changed');
  assert.equal(new Set(record.resources.map((r) => r.key)).size, record.resources.length);
  for (const item of previous.resources) {
    const next = record.resources.find((r) => r.key === item.key);
    assert.ok(next, 'Inventory history lost');
    for (const key of [
      'kind',
      'billable',
      'createAt',
      'identity',
      'nonce',
      'apiPath',
      'bodyHash',
      'parentId',
      'description',
      'createOperation',
      'deleteOperation',
    ])
      if (item[key] !== undefined) assert.deepEqual(next[key], item[key], 'Pinned inventory identity changed');
    for (const key of ['absent', 'createIssued', 'deleteIssued', 'rejected'])
      if (item[key]) assert.equal(next[key], true);
  }
  for (const key of [
    'closed',
    'complete',
    'cleanupVerified',
    'writersStopped',
    'acceptedWorkSettled',
    'providerChildrenSettled',
    'qualificationIssued',
    'actorInstallIssued',
    'testsPassed',
    'evidenceExported',
  ])
    if (previous[key]) assert.equal(record[key], true);
  for (const key of ['bootstrapChildren', 'edgeChildren'])
    for (const child of previous[key] ?? [])
      assert.ok(
        record[key]?.some((next) => JSON.stringify(next) === JSON.stringify(child)),
        'Controller-child history lost',
      );
  if (previous.dns) assert.deepEqual(record.dns.rrset, previous.dns.rrset, 'DNS authority changed');
  for (const item of previous.iam ?? []) {
    const next = record.iam?.find((i) => i.member === item.member);
    assert.ok(next);
    assert.equal(next.accountId, item.accountId);
    assert.equal(next.preexisting, item.preexisting);
    if (item.removed) assert.equal(next.removed, true);
  }
}

/** Append-only private snapshots. A partial/gapped record blocks recovery; a
 * PID/expiry never grants permission to unlink or steal the kernel lock. */
export class TemporaryStagingStore {
  constructor(directory, { lock = acquireMaintenanceLock } = {}) {
    this.directory = directory;
    this.acquire = lock;
  }
  async initialize(plan) {
    verifyTemporaryPlan(plan);
    await fs.mkdir(this.directory, { mode: 0o700 });
    return this.locked(async () =>
      this.save({
        protocol: 1,
        plan,
        closed: false,
        complete: false,
        resources: [],
        firstBillableIntentAt: null,
        firstBillableActivation: null,
        expiresAt: null,
        phase: 'planned',
      }),
    );
  }
  async locked(action) {
    assert.ok(!this.lock, 'Nested infrastructure writer');
    const handle = await this.acquire(this.directory);
    if (!handle)
      throw Object.assign(new Error('Another live or paused infrastructure writer owns the operation'), {
        code: 'RIVET_TEMPORARY_WRITER_BUSY',
      });
    this.lock = handle;
    try {
      return await action();
    } finally {
      this.lock = null;
      await handle.close();
    }
  }
  assertLocked() {
    assert.ok(this.lock, 'Infrastructure mutation requires the kernel writer lock');
  }
  async read() {
    const stat = await fs.lstat(this.directory);
    assert.ok(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        (await fs.realpath(this.directory)) === path.resolve(this.directory),
    );
    const files = (await fs.readdir(this.directory)).filter((n) => /^state-\d{6}\.json$/.test(n)).sort();
    assert.ok(files.length <= 2048);
    let previous = null,
      hash = null;
    for (let i = 0; i < files.length; i++) {
      assert.equal(files[i], `state-${String(i).padStart(6, '0')}.json`);
      const file = path.join(this.directory, files[i]),
        entry = await fs.lstat(file);
      assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.size < 4 * 1024 * 1024);
      const bytes = await fs.readFile(file, 'utf8'),
        value = JSON.parse(bytes);
      assert.equal(value.revision, i);
      assert.equal(value.previousHash, hash);
      verifyTemporaryPlan(value.record.plan);
      if (value.record.complete) completedTemporaryCleanup(value.record);
      if (previous) transition(previous.record, value.record);
      previous = value;
      hash = temporaryHash(bytes);
    }
    return previous ? { ...previous, hash } : null;
  }
  async save(record) {
    this.assertLocked();
    verifyTemporaryPlan(record.plan);
    if (record.complete) completedTemporaryCleanup(record);
    const previous = await this.read(),
      revision = previous ? previous.revision + 1 : 0;
    assert.ok(revision < 2048);
    if (previous) transition(previous.record, record);
    const value = { revision, previousHash: previous?.hash ?? null, record },
      bytes = JSON.stringify(value);
    assert.ok(Buffer.byteLength(bytes) < 4 * 1024 * 1024);
    const target = path.join(this.directory, `state-${String(revision).padStart(6, '0')}.json`);
    const pending = path.join(this.directory, `pending-${randomUUID()}.json`);
    const handle = await fs.open(pending, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      fsyncSync(handle.fd);
    } finally {
      await handle.close();
    }
    // Readers never observe a half-written final record. A hard-link publishes
    // atomically without replacing any existing history entry. A crash before
    // publication cannot have dispatched the subsequent provider write.
    await fs.link(pending, target);
    await fs.unlink(pending);
    if (process.platform === 'linux') {
      const dir = await fs.open(this.directory, 'r');
      try {
        fsyncSync(dir.fd);
      } finally {
        await dir.close();
      }
    }
    return structuredClone(record);
  }
  async change(action) {
    const { record } = await this.read();
    const next = structuredClone(record);
    await action(next);
    if (JSON.stringify(next) === JSON.stringify(record)) return structuredClone(record);
    return this.save(next);
  }
}
