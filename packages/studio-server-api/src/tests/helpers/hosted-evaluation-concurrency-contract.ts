import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import type { EvaluationRun, EvaluationRecordingArtifact } from '@valerypopoff/rivet2-evaluations';
import {
  HostedEvaluationCapacityError,
  HostedEvaluationRetryConflictError,
  HostedEvaluationRunConflictError,
  type HostedEvaluationCoordinator,
  type HostedEvaluationGraphRunner,
} from '../../evaluation-runs/hosted-coordinator.js';
import { createHostedEvaluationFixture } from './hosted-evaluation-fixture.js';
import { startHostedEvaluationWorker } from './hosted-evaluation-worker-process.js';
import { PostgresRivetEvaluationStore } from '../../evaluation-runs/managed-store.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForGate(value: { promise: Promise<unknown> }, message = 'Hosted query/graph gate was not reached') {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      value.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => Promise<boolean>, label: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(`Hosted concurrency timeout: ${label}`);
    await delay(10);
  }
}

type QueryEvent = { sql: string; values: unknown[]; pid: number; result?: QueryResult };
function observedPool(
  pool: Pool,
  hooks: {
    before?: (event: QueryEvent) => void | Promise<void>;
    after?: (event: QueryEvent) => void | Promise<void>;
    released?: (pid: number) => void;
  } = {},
): Pool {
  const wrap = async (client: PoolClient, sql: string, values: unknown[] = []) => {
    const event: QueryEvent = { sql, values, pid: (client as PoolClient & { processID: number }).processID };
    await hooks.before?.(event);
    const result = await client.query(sql, values);
    await hooks.after?.({ ...event, result });
    return result;
  };
  return {
    async query(sql: string, values?: unknown[]) {
      const client = await pool.connect();
      try {
        return await wrap(client, sql, values);
      } finally {
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => wrap(client, sql, values),
        release() {
          client.release();
          hooks.released?.((client as PoolClient & { processID: number }).processID);
        },
      };
    },
  } as unknown as Pool;
}

async function blockedBy(pool: Pool, pid: number) {
  await until(
    async () =>
      (await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]))
        .rows[0]!.blocked,
    'contending connection is blocked',
  );
}

type Fixture = Awaited<ReturnType<typeof createHostedEvaluationFixture>>;
async function jobs(pool: Pool, fixture: Fixture) {
  return (
    await pool.query<{
      job_id: string;
      status: string;
      fencing_token: string;
      worker_id: string | null;
      trial_json: { outputs: Record<string, unknown> } | null;
    }>(
      'SELECT job_id,status,fencing_token,worker_id,trial_json FROM evaluation_hosted_trial_jobs WHERE project_id=$1 AND run_id=$2 ORDER BY case_index,trial_index',
      [fixture.identity.projectId, fixture.identity.runId],
    )
  ).rows;
}

export async function verifyHostedEvaluationConcurrencyContract(pool: Pool) {
  async function scenario(
    name: string,
    work: (context: {
      fixture(cases?: number, projectId?: ProjectId): Promise<Fixture>;
      own(coordinator: HostedEvaluationCoordinator): HostedEvaluationCoordinator;
      hold(): ReturnType<typeof gate>;
      track<T extends Promise<unknown>>(operation: T): T;
    }) => Promise<void>,
  ) {
    const fixtures: Fixture[] = [];
    const workers: HostedEvaluationCoordinator[] = [];
    const gates: ReturnType<typeof gate>[] = [];
    const operations: Promise<unknown>[] = [];
    try {
      await work({
        async fixture(cases = 2, projectId?: ProjectId) {
          const value = await createHostedEvaluationFixture(pool, cases, projectId);
          fixtures.push(value);
          return value;
        },
        own(worker) {
          workers.push(worker);
          return worker;
        },
        hold() {
          const value = gate();
          gates.push(value);
          return value;
        },
        track(operation) {
          // Register before waiting at a gate, so failures still settle before fixture cleanup.
          operations.push(operation);
          void operation.catch(() => undefined);
          return operation;
        },
      });
      console.log(`Hosted PostgreSQL: ${name} passed.`);
    } finally {
      for (const value of gates) value.release();
      await Promise.allSettled(operations);
      await Promise.all(workers.map((worker) => worker.stop()));
      for (const fixture of fixtures) await fixture.dispose();
    }
  }

  await scenario(
    'overlapping job IDs in separate runs retain independent active ownership',
    async ({ fixture, own, hold }) => {
      const f = await fixture(1),
        release = hold();
      const runId = `identity:${randomUUID()}`;
      const first = {
        ...f.submission,
        runId: `${runId}:part`,
        dataset: { ...f.submission.dataset, cases: [{ ...f.submission.dataset.cases[0]!, id: 'case' }] },
      };
      const second = {
        ...f.submission,
        runId,
        dataset: { ...f.submission.dataset, cases: [{ ...f.submission.dataset.cases[0]!, id: 'part:case' }] },
      };
      const firstIdentity = { ...f.identity, runId: first.runId },
        secondIdentity = { ...f.identity, runId: second.runId };
      const signals = new Map<string, AbortSignal>();
      const worker = own(
        f.coordinator({
          config: { workerConcurrency: 2 },
          runGraph: async ({ metadata, signal, inputs }) => {
            signals.set(metadata.evaluationRunId, signal!);
            await release.promise;
            return { outputs: { output: inputs.input! }, metrics: { durationMs: 1 } };
          },
        }),
      );
      await worker.submit(first);
      await worker.submit(second);
      worker.start();
      await until(async () => signals.size === 2, 'both runs are executing');
      assert.equal(
        (await jobs(pool, { ...f, identity: firstIdentity }))[0]!.job_id,
        (await jobs(pool, { ...f, identity: secondIdentity }))[0]!.job_id,
      );
      await worker.requestCancel(firstIdentity);
      assert.equal(signals.get(first.runId)!.aborted, true, 'The first run must still own its cancellation signal');
      assert.equal(signals.get(second.runId)!.aborted, false);
      await until(async () => (await f.store.get(firstIdentity))?.executionStatus === 'canceled', 'first run canceled');
      const third = { ...f.submission, runId: `${runId}:third` };
      const fourth = { ...f.submission, runId: `${runId}:fourth` };
      await worker.submit(third);
      await worker.submit(fourth);
      await until(async () => signals.size >= 3, 'a canceled task frees exactly one worker slot');
      assert.equal((await worker.getRunState({ ...f.identity, runId: fourth.runId }))?.jobs[0]?.status, 'queued');
      release.release();
      await until(
        async () =>
          (await f.store.get(secondIdentity))?.executionStatus === 'completed' &&
          (await f.store.get({ ...f.identity, runId: fourth.runId }))?.executionStatus === 'completed',
        'remaining runs completed',
      );
    },
  );

  await scenario('recovery keeps colon-containing project and run identities separate', async ({ fixture, own }) => {
    const prefix = randomUUID();
    const first = await fixture(1, `${prefix}:part` as ProjectId),
      second = await fixture(1, prefix as ProjectId);
    first.identity.runId = first.submission.runId = 'run';
    second.identity.runId = second.submission.runId = 'part:run';
    second.submission.purpose = 'execution-benchmark';
    const worker = own(
      first.coordinator({
        runGraph: async () => {
          throw new Error('Expired accepted work must not replay');
        },
      }),
    );
    await worker.submit(first.submission);
    await worker.submit(second.submission);
    await pool.query(
      "UPDATE evaluation_hosted_trial_jobs SET status='accepted', worker_id='lost-owner', attempt=1, fencing_token=1, accepted_at=NOW()-INTERVAL '30 seconds', lease_expires_at=NOW()-INTERVAL '1 second' WHERE project_id=ANY($1::text[])",
      [[first.identity.projectId, second.identity.projectId]],
    );
    await pool.query("UPDATE evaluation_hosted_runs SET status='running' WHERE project_id=ANY($1::text[])", [
      [first.identity.projectId, second.identity.projectId],
    ]);
    worker.start();
    await until(
      async () =>
        (await jobs(pool, first))[0]!.status === 'interrupted' &&
        (await jobs(pool, second))[0]!.status === 'interrupted',
      'expired jobs recovered',
    );
    await worker.drainAcceptedWork();
    assert.equal((await worker.getRunState(first.identity))?.status, 'interrupted');
    assert.equal((await worker.getRunState(second.identity))?.status, 'interrupted');
    assert.equal((await first.store.get(first.identity))?.trials[0]?.qualityStatus, 'failed');
    assert.equal((await second.store.get(second.identity))?.trials[0]?.qualityStatus, 'not-evaluated');
  });

  await scenario(
    'concurrent duplicate submission rolls back the losing transaction',
    async ({ fixture, own, hold, track }) => {
      const f = await fixture(1),
        locked = hold(),
        entered = hold();
      let secondPid = 0;
      const first = own(
        f.coordinator({
          config: { workerEnabled: false },
          pool: observedPool(pool, {
            after: async ({ sql }) => {
              if (sql.includes('pg_advisory_xact_lock')) {
                entered.release();
                await locked.promise;
              }
            },
          }),
        }),
      );
      const second = own(
        f.coordinator({
          config: { workerEnabled: false },
          pool: observedPool(pool, {
            before({ sql, pid }) {
              if (sql.includes('pg_advisory_xact_lock')) secondPid = pid;
            },
          }),
        }),
      );
      const winner = track(first.submit(f.submission));
      await waitForGate(entered);
      const loser = second.submit({ ...f.submission, dataset: { ...f.submission.dataset, name: 'losing snapshot' } });
      const rejected = track(assert.rejects(loser, HostedEvaluationRunConflictError));
      await until(async () => secondPid !== 0, 'second submit connected');
      await blockedBy(pool, secondPid);
      locked.release();
      await Promise.all([winner, rejected]);
      assert.equal((await jobs(pool, f)).length, 1);
      assert.equal(
        (await pool.query('SELECT 1 FROM evaluation_dataset_snapshots WHERE project_id=$1', [f.identity.projectId]))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT snapshot_json->'dataset'->>'name' AS name FROM evaluation_dataset_snapshots WHERE project_id=$1",
            [f.identity.projectId],
          )
        ).rows[0]!.name,
        f.submission.dataset.name,
        'The losing transaction must not replace the winning snapshot',
      );
    },
  );

  for (const firstKind of ['submit', 'retry'] as const) {
    await scenario(
      `global capacity serializes ${firstKind} before its competitor`,
      async ({ fixture, own, hold, track }) => {
        const submitted = await fixture(1),
          retried = await fixture(1);
        await own(retried.coordinator({ config: { workerEnabled: false } })).submit(retried.submission);
        await pool.query("UPDATE evaluation_hosted_trial_jobs SET status='interrupted' WHERE project_id=$1", [
          retried.identity.projectId,
        ]);
        await pool.query("UPDATE evaluation_hosted_runs SET status='interrupted' WHERE project_id=$1", [
          retried.identity.projectId,
        ]);
        const retryId = (await jobs(pool, retried))[0]!.job_id;
        const release = hold(),
          entered = hold();
        let secondPid = 0;
        const ownerPool = observedPool(pool, {
          after: async ({ sql }) => {
            if (sql.includes('pg_advisory_xact_lock(5611002')) {
              entered.release();
              await release.promise;
            }
          },
        });
        const competitorPool = observedPool(pool, {
          before: ({ sql, pid }) => {
            if (sql.includes('pg_advisory_xact_lock(5611002')) secondPid = pid;
          },
        });
        const submit = own(
          submitted.coordinator({
            pool: firstKind === 'submit' ? ownerPool : competitorPool,
            config: { workerEnabled: false, maxOutstandingJobs: 1 },
          }),
        );
        const retry = own(
          retried.coordinator({
            pool: firstKind === 'retry' ? ownerPool : competitorPool,
            config: { workerEnabled: false, maxOutstandingJobs: 1 },
          }),
        );
        const retryInput = { ...retried.identity, jobIds: [retryId] };
        const winner = track(
          firstKind === 'submit' ? submit.submit(submitted.submission) : retry.retryInterrupted(retryInput),
        );
        await waitForGate(entered);
        const loser = firstKind === 'submit' ? retry.retryInterrupted(retryInput) : submit.submit(submitted.submission);
        const rejected = track(
          assert.rejects(
            loser,
            (error: unknown) => error instanceof HostedEvaluationCapacityError && error.limit === 'outstanding',
          ),
        );
        await until(async () => secondPid !== 0, 'capacity competitor connected');
        await blockedBy(pool, secondPid);
        release.release();
        await Promise.all([winner, rejected]);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM evaluation_hosted_trial_jobs WHERE status IN ('queued','claimed','accepted')",
            )
          ).rows[0]!.n,
          1,
        );
        const beforeStaleRetry = await jobs(pool, retried);
        await assert.rejects(
          retry.retryInterrupted({
            ...retryInput,
            jobIds: firstKind === 'submit' ? [retryId, `${retryId}:missing`] : [retryId],
          }),
          HostedEvaluationRetryConflictError,
        );
        assert.deepEqual(
          await jobs(pool, retried),
          beforeStaleRetry,
          'A stale or partial selection must not requeue any job',
        );
      },
    );
  }

  await scenario('two workers skip a locked candidate and accept each job once', async ({ fixture, own, hold }) => {
    const f = await fixture(),
      release = hold();
    await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
    const initial = await jobs(pool, f);
    const locker = await pool.connect();
    const executions: string[] = [];
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM evaluation_hosted_trial_jobs WHERE project_id=$1 AND job_id=$2 FOR UPDATE', [
        f.identity.projectId,
        initial[0]!.job_id,
      ]);
      const runGraph: HostedEvaluationGraphRunner = async ({ metadata, inputs }) => {
        executions.push(metadata.caseId);
        await release.promise;
        return { outputs: { output: inputs.input! }, metrics: { durationMs: 1 } };
      };
      const a = own(f.coordinator({ runGraph }));
      a.start();
      await until(async () => executions.length === 1, 'unlocked job accepted');
      assert.deepEqual(executions, ['case-1']);
      await locker.query('COMMIT');
      const b = own(f.coordinator({ runGraph }));
      b.start();
      await until(async () => executions.length === 2, 'second worker accepted locked job');
      assert.deepEqual([...executions].sort(), ['case-0', 'case-1']);
      release.release();
      await until(
        async () => (await f.store.get(f.identity))?.executionStatus === 'completed',
        'two-worker completion',
      );
      assert.equal(
        (
          await pool.query("SELECT 1 FROM evaluation_hosted_trial_attempts WHERE project_id=$1 AND event='accepted'", [
            f.identity.projectId,
          ])
        ).rowCount,
        2,
      );
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
  });

  await scenario(
    'identical run and job IDs in different projects keep separate active ownership',
    async ({ fixture, own, hold }) => {
      const first = await fixture(1),
        second = await fixture(1);
      second.identity.runId = first.identity.runId;
      second.submission.runId = first.identity.runId;
      const releases = new Map([
        [first.identity.projectId, hold()],
        [second.identity.projectId, hold()],
      ]);
      const signals = new Map<string, AbortSignal>();
      const worker = own(
        first.coordinator({
          config: { workerConcurrency: 2 },
          runGraph: async ({ project, inputs, signal }) => {
            const id = project.metadata.id;
            signals.set(id, signal!);
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(signal!.reason);
              signal!.addEventListener('abort', abort, { once: true });
              void releases.get(id)!.promise.then(() => {
                signal!.removeEventListener('abort', abort);
                resolve();
              });
            });
            return { outputs: { output: inputs.input! }, metrics: { durationMs: 1 } };
          },
        }),
      );
      await worker.submit(first.submission);
      await worker.submit(second.submission);
      worker.start();
      await until(async () => signals.size === 2, 'both project-scoped jobs accepted');
      assert.equal((await jobs(pool, first))[0]!.job_id, (await jobs(pool, second))[0]!.job_id);
      await worker.requestCancel(first.identity);
      await until(
        async () => (await first.store.get(first.identity))?.executionStatus === 'canceled',
        'first project canceled',
      );
      assert.equal(signals.get(second.identity.projectId)!.aborted, false);
      assert.equal((await jobs(pool, second))[0]!.status, 'accepted');
      releases.get(second.identity.projectId)!.release();
      await until(
        async () => (await second.store.get(second.identity))?.executionStatus === 'completed',
        'second project completed',
      );
    },
  );

  await scenario('cancel committed before acceptance prevents graph dispatch', async ({ fixture, own, hold }) => {
    const f = await fixture(1),
      accept = hold(),
      entered = hold();
    let executions = 0;
    const worker = own(
      f.coordinator({
        pool: observedPool(pool, {
          before: async ({ sql }) => {
            if (sql.includes("SET status = 'accepted'")) {
              entered.release();
              await accept.promise;
            }
          },
        }),
        runGraph: async () => {
          executions++;
          return { outputs: {}, metrics: { durationMs: 1 } };
        },
      }),
    );
    await worker.submit(f.submission);
    worker.start();
    await waitForGate(entered);
    await worker.requestCancel(f.identity);
    worker.beginRetirement();
    accept.release();
    await worker.drainAcceptedWork();
    assert.equal(executions, 0);
    assert.equal((await jobs(pool, f))[0]!.status, 'canceled');
  });

  await scenario('retirement releases an unaccepted claim without executing it', async ({ fixture, own, hold }) => {
    const f = await fixture(1),
      entered = hold(),
      release = hold();
    let claimed = false,
      executions = 0;
    const worker = own(
      f.coordinator({
        pool: observedPool(pool, {
          after: async ({ sql }) => {
            if (sql.includes("SET status = 'claimed'")) claimed = true;
            if (claimed && sql === 'COMMIT') {
              claimed = false;
              entered.release();
              await release.promise;
            }
          },
        }),
        runGraph: async () => {
          executions++;
          return { outputs: {}, metrics: { durationMs: 1 } };
        },
      }),
    );
    await worker.submit(f.submission);
    worker.start();
    worker.start();
    await waitForGate(entered);
    worker.beginRetirement();
    release.release();
    await worker.drainAcceptedWork();
    const job = (await jobs(pool, f))[0]!;
    assert.equal(job.status, 'queued');
    assert.equal(job.worker_id, null);
    assert.equal(executions, 0);
    const events = (
      await pool.query('SELECT event FROM evaluation_hosted_trial_attempts WHERE project_id=$1 ORDER BY event', [
        f.identity.projectId,
      ])
    ).rows;
    assert.deepEqual(
      events.map((row) => row.event),
      ['claimed', 'requeued'],
    );
  });

  await scenario('slow heartbeats do not overlap and cannot renew an expired lease', async ({ fixture, own, hold }) => {
    const f = await fixture(1),
      entered = hold(),
      release = hold();
    let heartbeatCalls = 0,
      renewed: number | null | undefined;
    const worker = own(
      f.coordinator({
        pool: observedPool(pool, {
          before: async ({ sql }) => {
            if (sql.includes('SET lease_expires_at = NOW()')) {
              heartbeatCalls++;
              entered.release();
              await release.promise;
            }
          },
          after: ({ sql, result }) => {
            if (sql.includes('SET lease_expires_at = NOW()')) renewed = result!.rowCount;
          },
        }),
        runGraph: ({ signal }) =>
          new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })),
      }),
    );
    await worker.submit(f.submission);
    worker.start();
    await waitForGate(entered);
    worker.beginRetirement();
    // Observe the next normal heartbeat interval while the first call is held.
    await delay(5_100);
    assert.equal(heartbeatCalls, 1);
    await pool.query(
      "UPDATE evaluation_hosted_trial_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE project_id=$1",
      [f.identity.projectId],
    );
    release.release();
    await until(
      async () => (await jobs(pool, f))[0]!.status === 'interrupted',
      'expired heartbeat interrupts the owner',
    );
    await worker.drainAcceptedWork();
    assert.equal(renewed, 0);
  });

  await scenario(
    'bounded stop leaves evidence drain waiting for interruption persistence',
    async ({ fixture, own, hold, track }) => {
      const f = await fixture(1),
        entered = hold(),
        release = hold(),
        persistence = hold(),
        persistenceEntered = hold();
      let signal: AbortSignal | undefined;
      let graphFinished = false;
      const worker = own(
        f.coordinator({
          pool: observedPool(pool, {
            before: async ({ sql }) => {
              if (sql.includes("SET status = 'interrupted'")) {
                persistenceEntered.release();
                await persistence.promise;
              }
            },
          }),
          runGraph: async (input) => {
            signal = input.signal;
            entered.release();
            await release.promise;
            graphFinished = true;
            return { outputs: {}, metrics: { durationMs: 1 } };
          },
        }),
      );
      await worker.submit(f.submission);
      worker.start();
      await waitForGate(entered);
      const stop = track(worker.stop());
      await waitForGate(persistenceEntered);
      await waitForGate({ promise: stop }, 'Bounded shutdown did not return');
      assert.equal(signal!.aborted, true);
      assert.equal((await jobs(pool, f))[0]!.status, 'accepted');
      let drained = false;
      const drain = track(
        worker.drainAcceptedWork().then(() => {
          drained = true;
        }),
      );
      await delay(0);
      assert.equal(drained, false, 'Retirement must not claim success while accepted work is unresolved');
      persistence.release();
      await drain;
      assert.equal((await jobs(pool, f))[0]!.status, 'interrupted');
      assert.equal(graphFinished, false, 'The runner may ignore abort; durable interruption still governs retirement');
      release.release();
      await until(async () => graphFinished, 'non-cooperative test graph cleanup');
    },
  );

  for (const firstKind of ['cancel', 'retry'] as const) {
    await scenario(`cancel/retry serialization: ${firstKind} commits first`, async ({ fixture, own, hold, track }) => {
      const f = await fixture(),
        release = hold(),
        entered = hold();
      await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
      const rows = await jobs(pool, f);
      await pool.query("UPDATE evaluation_hosted_runs SET status='running' WHERE project_id=$1", [
        f.identity.projectId,
      ]);
      await pool.query(
        "UPDATE evaluation_hosted_trial_jobs SET status=CASE WHEN job_id=$2 THEN 'interrupted' ELSE 'accepted' END WHERE project_id=$1",
        [f.identity.projectId, rows[0]!.job_id],
      );
      let secondPid = 0;
      const first = own(
        f.coordinator({
          config: { workerEnabled: false },
          pool: observedPool(pool, {
            after: async ({ sql }) => {
              if (sql.includes('pg_advisory_xact_lock(hashtext')) {
                entered.release();
                await release.promise;
              }
            },
          }),
        }),
      );
      const second = own(
        f.coordinator({
          config: { workerEnabled: false },
          pool: observedPool(pool, {
            before({ sql, pid }) {
              if (sql.includes('pg_advisory_xact_lock(hashtext')) secondPid = pid;
            },
          }),
        }),
      );
      const retryInput = { ...f.identity, jobIds: [rows[0]!.job_id] };
      const winner = track(
        firstKind === 'cancel' ? first.requestCancel(f.identity) : first.retryInterrupted(retryInput),
      );
      await waitForGate(entered);
      const other = track(
        firstKind === 'cancel'
          ? assert.rejects(second.retryInterrupted(retryInput), HostedEvaluationRetryConflictError)
          : second.requestCancel(f.identity),
      );
      await until(async () => secondPid !== 0, 'cancel/retry competitor');
      await blockedBy(pool, secondPid);
      release.release();
      await Promise.all([winner, other]);
      assert.equal((await first.getRunState(f.identity))?.cancelRequested, true);
      assert.ok((await jobs(pool, f)).every((job) => job.status !== 'queued' && job.status !== 'claimed'));
    });
  }

  for (const deletionOwner of ['coordinator', 'generic store'] as const) {
    for (const firstKind of ['retry', 'delete'] as const) {
      await scenario(
        `${deletionOwner} deletion/retry serialization: ${firstKind} first`,
        async ({ fixture, own, hold, track }) => {
          const f = await fixture(1),
            entered = hold(),
            release = hold();
          await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
          await pool.query("UPDATE evaluation_hosted_runs SET status='interrupted' WHERE project_id=$1", [
            f.identity.projectId,
          ]);
          await pool.query("UPDATE evaluation_hosted_trial_jobs SET status='interrupted' WHERE project_id=$1", [
            f.identity.projectId,
          ]);
          const jobId = (await jobs(pool, f))[0]!.job_id;
          let secondPid = 0;
          const matches = (sql: string) =>
            firstKind === 'retry'
              ? sql.includes("AND status = 'interrupted'")
              : sql.includes('ORDER BY job_id FOR UPDATE');
          const firstPool = observedPool(pool, {
            after: async ({ sql }) => {
              if (matches(sql)) {
                entered.release();
                await release.promise;
              }
            },
          });
          const secondPool = observedPool(pool, {
            before: ({ sql, pid }) => {
              if (sql.includes('FOR UPDATE')) secondPid = pid;
            },
          });
          const retry = own(
            f.coordinator({ pool: firstKind === 'retry' ? firstPool : secondPool, config: { workerEnabled: false } }),
          );
          const deletionPool = firstKind === 'delete' ? firstPool : secondPool;
          const deleting = new PostgresRivetEvaluationStore(deletionPool);
          const coordinator = own(f.coordinator({ pool: deletionPool, config: { workerEnabled: false } }));
          const deleteRun = () =>
            deletionOwner === 'coordinator' ? coordinator.deleteRun(f.identity) : deleting.delete(f.identity);
          const winner = track(
            firstKind === 'retry' ? retry.retryInterrupted({ ...f.identity, jobIds: [jobId] }) : deleteRun(),
          );
          await waitForGate(entered);
          const loser = track(
            firstKind === 'retry'
              ? assert.rejects(deleteRun(), /queued or running/)
              : assert.rejects(
                  retry.retryInterrupted({ ...f.identity, jobIds: [jobId] }),
                  HostedEvaluationRetryConflictError,
                ),
          );
          await until(async () => secondPid !== 0, 'deletion competitor connected');
          await blockedBy(pool, secondPid);
          release.release();
          await Promise.all([winner, loser]);
          assert.equal((await jobs(pool, f)).length, firstKind === 'delete' ? 0 : 1);
        },
      );
    }
  }

  await scenario(
    'expired unaccepted claim requeues but expired accepted work does not replay',
    async ({ fixture, own, hold }) => {
      const f = await fixture(),
        release = hold();
      await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
      const rows = await jobs(pool, f);
      await pool.query(
        "UPDATE evaluation_hosted_trial_jobs SET status=CASE WHEN job_id=$2 THEN 'claimed' ELSE 'accepted' END, worker_id='lost', lease_expires_at=NOW()-INTERVAL '1 second', fencing_token=1, attempt=1 WHERE project_id=$1",
        [f.identity.projectId, rows[0]!.job_id],
      );
      const executed: string[] = [];
      const worker = own(
        f.coordinator({
          runGraph: async ({ metadata }) => {
            executed.push(metadata.caseId);
            await release.promise;
            return { outputs: {}, metrics: { durationMs: 1 } };
          },
        }),
      );
      worker.start();
      await until(async () => executed.length === 1, 'expired claim retried');
      assert.deepEqual(executed, ['case-0']);
      assert.equal((await jobs(pool, f))[1]!.status, 'interrupted');
      release.release();
      await until(async () => Boolean((await f.store.get(f.identity))?.completedAt), 'recovered terminal run');
      assert.equal((await f.store.get(f.identity))?.executionStatus, 'error');
    },
  );

  for (const replaceOwner of [false, true]) {
    await scenario(
      replaceOwner
        ? 'stale large fencing token cannot replace a new owner'
        : 'expired unrecovered owner can still settle',
      async ({ fixture, own, hold }) => {
        const f = await fixture(1),
          oldGraph = hold(),
          oldEntered = hold(),
          heartbeat = hold(),
          newGraph = hold(),
          newEntered = hold();
        await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
        await pool.query(
          "UPDATE evaluation_hosted_trial_jobs SET fencing_token='9007199254740992' WHERE project_id=$1",
          [f.identity.projectId],
        );
        const old = own(
          f.coordinator({
            pool: observedPool(pool, {
              before: async ({ sql }) => {
                if (sql.includes('SET lease_expires_at = NOW()')) await heartbeat.promise;
              },
            }),
            runGraph: async () => {
              oldEntered.release();
              await oldGraph.promise;
              return { outputs: { owner: 'old' }, metrics: { durationMs: 1 } };
            },
          }),
        );
        old.start();
        await waitForGate(oldEntered);
        old.beginRetirement();
        assert.equal((await jobs(pool, f))[0]!.fencing_token, '9007199254740993');
        await pool.query(
          "UPDATE evaluation_hosted_trial_jobs SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE project_id=$1",
          [f.identity.projectId],
        );
        if (replaceOwner) {
          const fresh = own(
            f.coordinator({
              runGraph: async () => {
                newEntered.release();
                await newGraph.promise;
                return { outputs: { owner: 'new' }, metrics: { durationMs: 1 } };
              },
            }),
          );
          fresh.start();
          await until(async () => (await jobs(pool, f))[0]!.status === 'interrupted', 'accepted lease recovered');
          await fresh.retryInterrupted({ ...f.identity, jobIds: [(await jobs(pool, f))[0]!.job_id] });
          await waitForGate(newEntered);
          oldGraph.release();
          heartbeat.release();
          await assert.rejects(old.drainAcceptedWork(), /not acknowledged|unconfirmed/);
          const current = (await jobs(pool, f))[0]!;
          assert.equal(current.fencing_token, '9007199254740994');
          assert.equal(current.status, 'accepted');
          assert.equal(current.trial_json, null);
          newGraph.release();
          await until(async () => (await jobs(pool, f))[0]!.status === 'settled', 'new owner settled');
          assert.deepEqual((await jobs(pool, f))[0]!.trial_json?.outputs, { owner: 'new' });
        } else {
          oldGraph.release();
          await until(async () => (await jobs(pool, f))[0]!.status === 'settled', 'unrecovered owner settled');
          heartbeat.release();
          await old.drainAcceptedWork();
          assert.deepEqual((await jobs(pool, f))[0]!.trial_json?.outputs, { owner: 'old' });
        }
      },
    );
  }

  await scenario(
    'retention failure rolls back terminal job, audit and projection together',
    async ({ fixture, own, hold }) => {
      const f = await fixture(1),
        rollback = hold(),
        inspect = hold();
      let failed = false,
        failedClient = 0;
      const worker = own(
        f.coordinator({
          pool: observedPool(pool, {
            before({ sql, pid }) {
              if (!failed && sql.includes('UPDATE evaluation_recordings SET artifact_json')) {
                failed = true;
                failedClient = pid;
                throw new Error('injected retention failure');
              }
            },
            after: async ({ sql, pid }) => {
              if (failed && pid === failedClient && sql === 'ROLLBACK') {
                inspect.release();
                await rollback.promise;
              }
            },
          }),
          runGraph: async ({ metadata }) => {
            const artifact: EvaluationRecordingArtifact = {
              projectId: f.identity.projectId,
              runId: f.identity.runId,
              trialId: `${metadata.evaluationRunId}:${metadata.caseId}:${metadata.trialIndex}`,
              reference: { id: 'retention-proof', retention: 'temporary', expiresAt: '2099-01-01T00:00:00.000Z' },
              serialized: 'fixture',
              createdAt: new Date().toISOString(),
            };
            await f.store.putRecording(artifact);
            return { outputs: { output: 'complete' }, metrics: { durationMs: 1 }, recording: artifact.reference };
          },
        }),
      );
      await worker.submit(f.submission);
      const before = (
        await pool.query('SELECT run_json FROM evaluation_runs WHERE project_id=$1', [f.identity.projectId])
      ).rows[0]!.run_json as EvaluationRun;
      worker.start();
      await waitForGate(inspect);
      worker.beginRetirement();
      assert.equal((await jobs(pool, f))[0]!.status, 'accepted');
      assert.equal(
        (
          await pool.query("SELECT 1 FROM evaluation_hosted_trial_attempts WHERE project_id=$1 AND event='settled'", [
            f.identity.projectId,
          ])
        ).rowCount,
        0,
      );
      const current = (
        await pool.query('SELECT run_json FROM evaluation_runs WHERE project_id=$1', [f.identity.projectId])
      ).rows[0]!.run_json as EvaluationRun;
      assert.equal(current.completedAt, before.completedAt);
      assert.equal(
        (await f.store.getRecording({ projectId: f.identity.projectId, recordingId: 'retention-proof' }))?.reference
          .retention,
        'temporary',
      );
      rollback.release();
      await worker.drainAcceptedWork();
      assert.equal((await jobs(pool, f))[0]!.status, 'interrupted');
    },
  );

  await scenario('terminal cancellation uses one leased connection while disabled', async ({ fixture, own }) => {
    const f = await fixture(1);
    const completed = own(f.coordinator());
    await completed.submit(f.submission);
    completed.start();
    await until(async () => (await f.store.get(f.identity))?.executionStatus === 'completed', 'terminal fixture');
    await completed.stop();
    const single = new Pool({ connectionString: pool.options.connectionString, max: 1, connectionTimeoutMillis: 1000 });
    try {
      const disabled = own(
        f.coordinator({
          pool: single,
          runStore: new PostgresRivetEvaluationStore(single),
          config: { enabled: false, workerEnabled: false, leaseMs: 0, pollMs: 0 },
        }),
      );
      assert.deepEqual(await disabled.requestCancel(f.identity), await f.store.get(f.identity));
      await assert.rejects(disabled.retryInterrupted({ ...f.identity, jobIds: ['none'] }), /disabled/);
      await assert.rejects(disabled.submit({ ...f.submission, runId: 'disabled' }), /not enabled/);
      await disabled.deleteRun(f.identity);
      assert.equal(await f.store.get(f.identity), undefined);
    } finally {
      await single.end();
    }
  });

  await scenario(
    'accepted cancellation aborts after commit and before releasing its client',
    async ({ fixture, own, hold }) => {
      const f = await fixture(1),
        entered = hold();
      const events: string[] = [];
      let cancelPid = 0;
      const worker = own(
        f.coordinator({
          pool: observedPool(pool, {
            before({ sql, pid }) {
              if (sql.includes('SET cancel_requested_at')) cancelPid = pid;
            },
            after({ sql, pid }) {
              if (pid === cancelPid && sql === 'COMMIT') events.push('commit');
            },
            released(pid) {
              if (pid === cancelPid) events.push('release');
            },
          }),
          runGraph: async ({ signal }) => {
            entered.release();
            await new Promise<void>((_, reject) =>
              signal!.addEventListener(
                'abort',
                () => {
                  events.push('abort');
                  reject(signal!.reason);
                },
                { once: true },
              ),
            );
            return { outputs: {}, metrics: { durationMs: 1 } };
          },
        }),
      );
      await worker.submit(f.submission);
      worker.start();
      await waitForGate(entered);
      await worker.requestCancel(f.identity);
      assert.deepEqual(events.slice(0, 3), ['commit', 'abort', 'release']);
      await until(async () => (await jobs(pool, f))[0]!.status === 'settled', 'accepted cancellation settlement');
      const run = await f.store.get(f.identity);
      assert.equal(run?.executionStatus, 'canceled');
      assert.equal(run?.trials[0]?.executionStatus, 'canceled');
      assert.equal(
        (
          await pool.query("SELECT 1 FROM evaluation_hosted_trial_attempts WHERE project_id=$1 AND event='canceled'", [
            f.identity.projectId,
          ])
        ).rowCount,
        1,
      );
    },
  );

  for (const phase of ['accept', 'settle'] as const) {
    await scenario(`lost ${phase} commit acknowledgement never replays the mutation`, async ({ fixture, own }) => {
      const f = await fixture(1);
      const clientPhases = new Map<number, string>();
      let lost = false,
        executions = 0;
      const worker = own(
        f.coordinator({
          pool: observedPool(pool, {
            after: ({ sql, pid }) => {
              if (sql.includes("SET status = 'accepted'")) clientPhases.set(pid, 'accept');
              if (sql.includes("SET status = 'settled'")) clientPhases.set(pid, 'settle');
              if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                const operation = clientPhases.get(pid);
                clientPhases.delete(pid);
                if (!lost && sql === 'COMMIT' && operation === phase) {
                  lost = true;
                  throw new Error(`Lost ${phase} acknowledgement`);
                }
              }
            },
          }),
          runGraph: async () => {
            executions++;
            return { outputs: { output: 'once' }, metrics: { durationMs: 1 } };
          },
        }),
      );
      await worker.submit(f.submission);
      worker.start();
      await until(async () => lost, 'commit acknowledgement injected after real COMMIT');
      worker.beginRetirement();
      await assert.rejects(worker.drainAcceptedWork(), /unconfirmed|not acknowledged/);
      assert.equal(executions, phase === 'accept' ? 0 : 1);
      assert.equal((await jobs(pool, f))[0]!.status, phase === 'accept' ? 'accepted' : 'settled');
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM evaluation_hosted_trial_attempts WHERE project_id=$1 AND event=$2',
            [f.identity.projectId, phase === 'accept' ? 'accepted' : 'settled'],
          )
        ).rows[0]!.n,
        1,
      );
    });
  }

  await scenario('unexpected worker exit is rejected by fixture cleanup', async () => {
    const worker = await startHostedEvaluationWorker({ database: pool.options.connectionString!, runtime: 'source' });
    try {
      const ready = worker.events.find((event) => event.event === 'ready');
      assert.ok(ready?.pid);
      process.kill(ready.pid, 'SIGKILL');
      await waitForGate({ promise: worker.exited }, 'Killed worker did not exit');
      await assert.rejects(worker.close(), /worker exited before shutdown/);
    } finally {
      await worker.kill();
    }
  });

  for (const runtime of ['source', 'compiled'] as const) {
    await scenario(`${runtime} worker accepts and persists real PostgreSQL work`, async ({ fixture, own }) => {
      const f = await fixture(1);
      await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
      const worker = await startHostedEvaluationWorker({
        database: pool.options.connectionString!,
        runtime,
        hold: true,
      });
      try {
        await worker.command('start');
        await worker.waitFor(() => worker.events.some((event) => event.event === 'graph'), `${runtime} graph entry`);
        assert.equal((await jobs(pool, f))[0]!.status, 'accepted');
        await worker.command('release');
        await until(async () => (await jobs(pool, f))[0]!.status === 'settled', `${runtime} settlement`);
        assert.equal((await f.store.get(f.identity))?.executionStatus, 'completed');
      } finally {
        await Promise.all([worker.close(), worker.close()]);
      }
    });
  }

  await scenario(
    'process loss after acceptance becomes interruption without graph replay',
    async ({ fixture, own }) => {
      const f = await fixture(1);
      await own(f.coordinator({ config: { workerEnabled: false } })).submit(f.submission);
      const worker = await startHostedEvaluationWorker({
        database: pool.options.connectionString!,
        runtime: 'compiled',
        hold: true,
      });
      try {
        await worker.command('start');
        await worker.waitFor(
          () => worker.events.some((event) => event.event === 'graph'),
          'graph accepted before process loss',
        );
        const row = (await jobs(pool, f))[0]!;
        assert.equal(row.status, 'accepted');
        await worker.kill();
        let executions = 0;
        const recovery = own(
          f.coordinator({
            runGraph: async () => {
              executions++;
              return { outputs: {}, metrics: { durationMs: 1 } };
            },
          }),
        );
        recovery.start();
        // The real 15-second configured lease expires; no shortened safety window.
        await until(
          async () => (await jobs(pool, f))[0]!.status === 'interrupted',
          'lost worker lease expired',
          45_000,
        );
        await recovery.stop();
        assert.equal(executions, 0);
        assert.equal((await f.store.get(f.identity))?.executionStatus, 'error');
      } finally {
        await worker.close();
      }
    },
  );
}
