import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextOccurrence, latestOccurrence, validateScheduledRun } from '../scheduled-runs/calendar.js';
import { ScheduledRunStore } from '../scheduled-runs/store.js';
import { ScheduledRunService } from '../scheduled-runs/service.js';
import { getActiveScheduledRunCount } from '../scheduled-runs/activity.js';
import type { ScheduledRunDraft } from '../../../studio-server-shared/scheduled-run-types.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { awaitPreparation } from '../scheduled-runs/cancellation.js';

const initial = Date.parse('2026-01-01T00:00:00Z');
test('PostgreSQL rollback failure preserves the original error and discards the uncertain connection', async () => {
  const primary = new Error('Lock failed'),
    secondary = new Error('Rollback failed');
  let discarded = false;
  const client = {
    query: async (sql: string) => {
      if (sql === 'ROLLBACK') throw secondary;
      if (sql.includes('pg_advisory')) throw primary;
      return { rows: [] };
    },
    release: (destroy: boolean) => {
      discarded = destroy;
    },
  };
  const pool = { connect: async () => client, end: async () => {} } as unknown as Pool;
  const store = ScheduledRunStore.postgres(pool);
  await assert.rejects(
    () => store.list(),
    (error) => error === primary,
  );
  assert.equal(discarded, true);
  await store.close();
});
const draft = (overrides: Partial<ScheduledRunDraft> = {}): ScheduledRunDraft => ({
  name: 'Daily work',
  description: '',
  projectId: 'project-a',
  version: 'latest',
  enabled: true,
  timeZone: 'UTC',
  schedule: { kind: 'interval', minutes: 1, anchor: new Date(initial + 60_000).toISOString() },
  record: true,
  timeoutMinutes: 5,
  missed: 'skip',
  ...overrides,
});

test('calendar preserves elapsed intervals and defines DST, month and once boundaries', () => {
  assert.equal(
    nextOccurrence({ kind: 'interval', minutes: 1, anchor: new Date(initial).toISOString() }, 'UTC', initial + 61_000),
    initial + 120_000,
  );
  assert.equal(
    nextOccurrence({ kind: 'daily', time: '02:30' }, 'America/New_York', Date.parse('2026-03-08T00:00:00Z')),
    Date.parse('2026-03-09T06:30:00Z'),
  );
  assert.equal(
    nextOccurrence({ kind: 'daily', time: '01:30' }, 'America/New_York', Date.parse('2026-11-01T05:30:00Z')),
    Date.parse('2026-11-02T06:30:00Z'),
  );
  assert.equal(
    nextOccurrence({ kind: 'monthly', day: 31, time: '10:00' }, 'UTC', Date.parse('2026-02-01T00:00:00Z')),
    Date.parse('2026-03-31T10:00:00Z'),
  );
  assert.equal(
    nextOccurrence({ kind: 'monthly', day: 'last', time: '10:00' }, 'UTC', Date.parse('2028-02-01T00:00:00Z')),
    Date.parse('2028-02-29T10:00:00Z'),
  );
  for (const localTime of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T25:00'])
    assert.throws(() => nextOccurrence({ kind: 'once', localTime }, 'UTC', initial));
  for (const localTime of ['2026-03-08T02:30', '2026-11-01T01:30'])
    assert.throws(() => nextOccurrence({ kind: 'once', localTime }, 'America/New_York', initial));
  assert.equal(
    latestOccurrence({ kind: 'daily', time: '10:00' }, 'UTC', Date.parse('2036-05-02T12:00:00Z')),
    Date.parse('2036-05-02T10:00:00Z'),
  );
  assert.equal(
    validateScheduledRun(draft({ input: {} }), initial).input &&
      Object.keys(validateScheduledRun(draft({ input: {} }), initial).input!).length,
    0,
  );
  assert.equal(validateScheduledRun(draft(), initial).input, undefined);
  for (const anchor of ['2026-02-30T10:00:00Z', '2026-01-01T24:00:00Z'])
    assert.throws(() => validateScheduledRun(draft({ schedule: { kind: 'interval', minutes: 1, anchor } }), initial));
  assert.throws(() => validateScheduledRun(draft({ input: [] as never }), initial));
  for (const value of [NaN, Infinity, undefined, 1n])
    assert.throws(() => validateScheduledRun(draft({ input: { value } as never }), initial), /JSON values/);
  assert.throws(() => validateScheduledRun(draft({ timeZone: 'not-a-zone' }), initial));
  assert.throws(
    () =>
      validateScheduledRun(draft({ schedule: { kind: 'interval', minutes: 60, anchor: '2026-01-01T10:00' } }), initial),
    /UTC offset/,
  );
  assert.deepEqual(
    validateScheduledRun(draft({ schedule: { kind: 'weekly', time: '10:00', weekdays: [2, 1, 2] } }), initial).schedule,
    { kind: 'weekly', time: '10:00', weekdays: [1, 2] },
  );
});

test('request acknowledgements survive restart, completion and deletion without duplicating actions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-requests-'));
  const file = path.join(root, 's.sqlite');
  let store = ScheduledRunStore.sqlite(file, () => initial);
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const createKey = randomUUID(),
    runKey = randomUUID(),
    retryKey = randomUUID();
  const s = await store.save(draft({ enabled: false }), undefined, 0, createKey);
  assert.equal((await store.save(draft({ enabled: false }), undefined, 0, createKey)).id, s.id);
  await assert.rejects(
    () => store.save(draft({ enabled: false, name: 'Different' }), undefined, 0, createKey),
    /different action/,
  );
  const [a, b] = await Promise.all([store.runNow(s.id, s.revision, runKey), store.runNow(s.id, s.revision, runKey)]);
  assert.equal(a.id, b.id);
  const job = (await store.tick('worker'))!;
  await store.accept(job.occurrence.id, 'worker', { graphId: 'g' });
  await store.finish(job.occurrence.id, 'worker', { status: 'failed' });
  const retry = await store.retry(a.id, retryKey);
  await store.cancel(retry.id);
  assert.equal((await store.retry(a.id, retryKey)).id, retry.id);
  await store.delete(s.id, s.revision);
  await store.close();
  store = ScheduledRunStore.sqlite(file, () => initial + 60_000);
  assert.equal((await store.save(draft({ enabled: false }), undefined, 0, createKey)).id, s.id);
  assert.equal((await store.runNow(s.id, s.revision, runKey)).id, a.id);
  assert.equal((await store.list()).schedules.length, 0);
  assert.equal((await store.list()).history.length, 2);
});

test('cancelled preparation settles promptly and disposes late values without publishing them', async () => {
  let complete!: (value: { dispose(): void }) => void;
  let disposed = 0;
  const controller = new AbortController();
  const result = awaitPreparation(
    new Promise<{ dispose(): void }>((resolve) => (complete = resolve)),
    controller.signal,
    (value) => value.dispose(),
  );
  controller.abort(new Error('Superseded'));
  await assert.rejects(result, /Superseded/);
  complete({
    dispose: () => {
      disposed++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
  await assert.rejects(awaitPreparation(Promise.reject(new Error('Late IO failure')), controller.signal), /Superseded/);
});

test('receipt retention protects active work and capacity rejection rolls back the action', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-capacity-'));
  const file = path.join(root, 's.sqlite');
  let now = initial;
  const store = ScheduledRunStore.sqlite(file, () => now);
  const db = new DatabaseSync(file);
  t.after(async () => {
    db.close();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const s = await store.save(draft({ enabled: false }));
  const key = randomUUID();
  const run = await store.runNow(s.id, s.revision, key);
  now += 86400_001;
  await store.save(draft({ enabled: false }), undefined, 0, randomUUID());
  assert.equal((await store.runNow(s.id, s.revision, key)).id, run.id);
  await store.cancel(run.id);
  await store.save(draft({ enabled: false }), undefined, 0, randomUUID());
  assert.equal(await store.acknowledged(key, { kind: 'run', id: s.id, revision: s.revision }), undefined);

  // Populate owned fixture rows directly instead of 10,000 expensive API calls.
  db.exec('DELETE FROM rivet_schedule_requests; BEGIN');
  const insert = db.prepare('INSERT INTO rivet_schedule_requests VALUES(?,?,?,?,?)');
  for (let i = 0; i < 10_000; i++) insert.run(`fixture-${i}`, 'fixture', now + 86400_000, 'fixture', '{}');
  db.exec('COMMIT');
  const before = await store.list();
  await assert.rejects(() => store.runNow(s.id, s.revision, randomUUID()), /capacity/);
  assert.deepEqual(await store.list(), before);
  db.exec('DELETE FROM rivet_schedule_requests');
  // Exceed the byte budget after action creation; the transaction must roll it back.
  insert.run('fixture-large', 'fixture', now + 86400_000, 'fixture', 'x'.repeat(16 * 1024 * 1024));
  await assert.rejects(() => store.save(draft({ enabled: false }), undefined, 0, randomUUID()), /capacity/);
  assert.deepEqual(await store.list(), before);
  db.exec('DELETE FROM rivet_schedule_requests');
  assert.equal((await store.runNow(s.id, s.revision, randomUUID())).status, 'queued');
});

test('shutdown aborts accepted work but does not close storage beneath late recording cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: initial });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-stop-'));
  const store = ScheduledRunStore.sqlite(path.join(root, 's.sqlite'), () => initial);
  let complete!: () => void;
  let signal!: AbortSignal;
  let closed = false;
  const close = store.close;
  Object.defineProperty(store, 'close', {
    value: async () => {
      await close();
      closed = true;
    },
  });
  const service = new ScheduledRunService(store, async (job, owner, currentSignal) => {
    signal = currentSignal;
    assert.equal(await store.accept(job.occurrence.id, owner, { graphId: 'g' }), true);
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return { status: 'interrupted' };
  });
  t.after(async () => {
    complete?.();
    await close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const s = await store.save(draft({ enabled: false }));
  await store.runNow(s.id, s.revision);
  service.start();
  while (!complete) await new Promise((resolve) => setImmediate(resolve));
  const stop = service.stop(0);
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(5001);
  }
  await stop;
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  assert.equal((await store.list()).history[0]?.status, 'running');
  complete();
  while (!closed) await new Promise((resolve) => setImmediate(resolve));
});

test('polling and startup are single-flight; shutdown is bounded and keeps a stalled claim store until cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: initial });
  let finishClaim!: (value: undefined) => void;
  let closed = 0;
  let claims = 0;
  const store = new ScheduledRunStore(
    async () => {
      throw new Error('Unexpected transaction');
    },
    async () => {
      closed++;
    },
  );
  store.tick = () => {
    claims++;
    return new Promise((resolve) => {
      finishClaim = resolve;
    });
  };
  const service = new ScheduledRunService(store, async () => {
    throw new Error('Retired work must not run');
  });
  const polling = service.tick();
  assert.equal(polling, service.tick());
  service.start();
  service.start();
  assert.equal(claims, 1);
  const stop = service.stop(0);
  assert.equal(stop, service.stop(10000));
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5001);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await stop;
  assert.equal(closed, 0);
  finishClaim(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  const failingStore = new ScheduledRunStore(
    async () => {
      throw new Error('Fixture claim failure');
    },
    async () => {
      closed++;
    },
  );
  const failingService = new ScheduledRunService(failingStore, async () => {
    throw new Error('Failed claims must not execute');
  });
  const failedPoll = failingService.tick();
  const failedStop = failingService.stop(0);
  await assert.rejects(failedPoll, /Fixture claim failure/);
  await failedStop;
  assert.equal(closed, 2);
});

test('durable queue handles CAS, competing claims, overlap, cancellation and worker loss', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-schedules-')),
    file = path.join(root, 'scheduled-runs.sqlite');
  let now = initial;
  const a = ScheduledRunStore.sqlite(file, () => now),
    b = ScheduledRunStore.sqlite(file, () => now);
  t.after(async () => {
    await a.close();
    await b.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const s = await a.save(draft());
  await assert.rejects(() => b.save(draft(), s.id, 0), /another window/);
  now += 60_000;
  const claims = await Promise.all([a.tick('a'), b.tick('b')]);
  assert.equal(claims.filter(Boolean).length, 1);
  const job = claims.find(Boolean)!;
  const owner = claims[0] ? 'a' : 'b';
  assert.equal(await a.accept(job.occurrence.id, owner, { graphId: 'g', revisionKey: 'r1' }), true);
  const duplicate = await b.runNow(s.id, s.revision);
  assert.equal(duplicate.status, 'skipped');
  now += 61_000;
  await a.finish(job.occurrence.id, owner, { status: 'succeeded' });
  const successor = await b.tick('new');
  assert.equal((await a.list()).history.find((r) => r.id === job.occurrence.id)?.status, 'interrupted');
  await a.finish(job.occurrence.id, owner, { status: 'succeeded' });
  assert.equal((await a.list()).history.find((r) => r.id === job.occurrence.id)?.status, 'interrupted');
  if (successor) await a.cancel(successor.occurrence.id);
  const manual = await a.runNow(s.id, s.revision);
  const held = await a.tick('old');
  assert.equal(held?.occurrence.id, manual.id);
  const changed = await b.save(draft({ name: 'Changed' }), s.id, s.revision);
  assert.equal(await a.accept(manual.id, 'old', { graphId: 'g' }), false);
  await a.delete(changed.id, changed.revision);
  await assert.rejects(() => a.retry(job.occurrence.id), /deleted/);
});

test('downtime skips or catches up only latest; restoration pauses copied schedules', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-schedules-'));
  let now = initial;
  const store = ScheduledRunStore.sqlite(path.join(root, 's.sqlite'), () => now);
  t.after(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await store.bindInstallation('original');
  const skip = await store.save(draft()),
    catchup = await store.save(draft({ missed: 'latest' }));
  now += 10 * 60_000;
  const claim = await store.tick('worker');
  assert.equal(claim?.occurrence.scheduleId, catchup.id);
  assert.equal(claim?.occurrence.scheduledAt, now);
  assert.equal((await store.list()).history.find((r) => r.scheduleId === skip.id)?.status, 'skipped');
  await store.bindInstallation('restored');
  assert.ok((await store.list()).schedules.every((s) => !s.enabled && s.nextAt === null));
  assert.equal(await store.accept(claim!.occurrence.id, 'worker', { graphId: 'g' }), false);
  await store.close();
  const db = new DatabaseSync(path.join(root, 's.sqlite'));
  db.exec('DROP TABLE rivet_schedule_runs');
  db.close();
  assert.throws(() => ScheduledRunStore.sqlite(path.join(root, 's.sqlite')), /missing tables/);
});

test('maintenance fences preparation; execution failure does not retry automatically', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-schedules-'));
  let now = initial,
    allowed = false;
  const store = ScheduledRunStore.sqlite(path.join(root, 's.sqlite'), () => now);
  const service = new ScheduledRunService(
    store,
    async (job, owner) => {
      assert.ok(getActiveScheduledRunCount() > 0);
      await store.accept(job.occurrence.id, owner, { graphId: 'g' });
      return { status: 'failed', reason: 'Graph failed.' };
    },
    () => allowed,
  );
  t.after(async () => {
    await service.stop(0);
    await fs.rm(root, { recursive: true, force: true });
  });
  const s = await store.save(draft({ enabled: false }));
  await store.runNow(s.id, s.revision);
  await service.tick();
  assert.equal((await store.list()).history[0]?.status, 'queued');
  allowed = true;
  await service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 10 && (await store.list()).history[0]?.status !== 'failed'; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.list()).history[0]?.status, 'failed');
  await service.tick();
  assert.equal((await store.list()).history.length, 1);
});

test('outcome commit failure cannot relabel successful execution or cause an automatic replay', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-scheduled-outcome-'));
  let now = initial,
    executions = 0,
    commits = 0;
  const store = ScheduledRunStore.sqlite(path.join(root, 's.sqlite'), () => now);
  const finish = store.finish.bind(store);
  store.finish = async (...args) => {
    if (++commits === 1) throw new Error('Fixture outcome storage failure');
    return finish(...args);
  };
  t.mock.method(console, 'error', () => {});
  const service = new ScheduledRunService(store, async (job, owner) => {
    executions++;
    assert.equal(await store.accept(job.occurrence.id, owner, { graphId: 'g' }), true);
    return { status: 'succeeded' };
  });
  t.after(async () => {
    await service.stop(0);
    await fs.rm(root, { recursive: true, force: true });
  });
  const s = await store.save(draft({ enabled: false }));
  await store.runNow(s.id, s.revision);
  await service.tick();
  while (service.activeCount) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commits, 1);
  assert.equal((await store.list()).history[0]?.status, 'running');
  now += 61_000;
  await service.tick();
  assert.equal((await store.list()).history[0]?.status, 'interrupted');
  assert.equal(executions, 1);
});
