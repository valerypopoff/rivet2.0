import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { chmodSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  ScheduledRun,
  ScheduledRunDraft,
  ScheduledOccurrence,
  ScheduledRunList,
} from '../../../studio-server-shared/scheduled-run-types.js';
import { latestOccurrence, nextOccurrence, validateScheduledRun } from './calendar.js';
import { SCHEDULE_SCHEMA_SQL } from './schema.js';
import { assertLocalOperationalSchema, LOCAL_SCHEDULE_SCHEMA_VERSION } from '../local-metadata/operational-schema.js';
import { createHttpError } from '../utils/httpError.js';
import { requestId, requestFingerprint } from './requests.js';

type Row = Record<string, any>;
type Query = (sql: string, parameters?: unknown[]) => Promise<Row[]>;
type Tx = <T>(operation: (query: Query, now: number) => Promise<T>) => Promise<T>;
export type ClaimedRun = { occurrence: ScheduledOccurrence; draft: ScheduledRunDraft };
const decode = <T>(row: Row): T => JSON.parse(row.json);
const active = ['queued', 'claimed', 'running'];
const sqliteQueues = new Map<string, { tail: Promise<unknown>; references: number }>();

/** SQL transactions own all queue decisions. Never await execution/storage IO in
 * this transaction. PostgreSQL's lock coordinates replicas; SQLite serializes
 * callers before BEGIN IMMEDIATE, including separate processes via the DB lock. */
export class ScheduledRunStore {
  constructor(
    private readonly transaction: Tx,
    readonly close: () => Promise<void>,
  ) {}
  static sqlite(file: string, clock = Date.now): ScheduledRunStore {
    const existing = existsSync(file);
    if (existing && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
      throw new Error('Invalid scheduled run database.');
    const db = new DatabaseSync(file);
    try {
      if (existing) assertLocalOperationalSchema(db, 'schedules');
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      try {
        // Recheck under the write lock: another process may have upgraded while
        // this connection was waiting. DDL and its version marker commit together.
        if (existing) assertLocalOperationalSchema(db, 'schedules');
        db.exec(`${SCHEDULE_SCHEMA_SQL}\nPRAGMA user_version=${LOCAL_SCHEDULE_SCHEMA_VERSION};`);
        assertLocalOperationalSchema(db, 'schedules');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (process.platform !== 'win32') chmodSync(file, 0o600);
    } catch (error) {
      db.close();
      throw error;
    }
    const canonical = realpathSync(path.resolve(file));
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const queue = sqliteQueues.get(key) ?? { tail: Promise.resolve(), references: 0 };
    sqliteQueues.set(key, queue);
    queue.references++;
    let closed = false;
    const tx: Tx = (operation) => {
      if (closed) return Promise.reject(new Error('Scheduled run store is closed.'));
      const run = queue.tail.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation(
            async (sql, args = []) => db.prepare(sql.replace(/\$\d+/g, '?')).all(...(args as any[])),
            clock(),
          );
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      queue.tail = run.catch(() => {});
      return run;
    };
    return new ScheduledRunStore(tx, async () => {
      if (closed) return;
      closed = true;
      await queue.tail;
      db.close();
      if (--queue.references === 0) sqliteQueues.delete(key);
    });
  }
  static postgres(pool: Pool): ScheduledRunStore {
    return new ScheduledRunStore(
      async (operation) => {
        const client = await pool.connect();
        let discard = false;
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(8071, 24019)');
          const now = Number(
            (await client.query('SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now,
          );
          const result = await operation(async (sql, args = []) => (await client.query(sql, args)).rows, now);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discard = true;
          }
          throw error;
        } finally {
          client.release(discard);
        }
      },
      () => pool.end(),
    );
  }
  list(): Promise<ScheduledRunList> {
    return this.transaction(async (q) => ({
      schedules: (await q('SELECT json FROM rivet_schedules ORDER BY id')).map((r) => decode<ScheduledRun>(r)),
      history: (await q('SELECT json FROM rivet_schedule_runs ORDER BY scheduled_at DESC, id DESC LIMIT 300')).map(
        (r) => decode<ScheduledOccurrence>(r),
      ),
    }));
  }
  acknowledged<T>(key: string, intent: unknown): Promise<T | undefined> {
    return this.transaction(async (q) => {
      const row = (await q('SELECT fingerprint,json FROM rivet_schedule_requests WHERE id=$1', [requestId(key)]))[0];
      if (!row) return undefined;
      if (row.fingerprint !== requestFingerprint(intent))
        throw createHttpError(409, 'This request ID was already used for a different action.');
      return decode<T>(row);
    });
  }
  private requested<T extends { id: string }>(
    key: string | undefined,
    intent: unknown,
    operation: (q: Query, now: number) => Promise<T>,
  ): Promise<T> {
    if (key !== undefined) key = requestId(key);
    const fingerprint = key === undefined ? undefined : requestFingerprint(intent);
    return this.transaction(async (q, now) => {
      if (key !== undefined) {
        const row = (await q('SELECT fingerprint,json FROM rivet_schedule_requests WHERE id=$1', [key]))[0];
        if (row) {
          if (row.fingerprint !== fingerprint)
            throw createHttpError(409, 'This request ID was already used for a different action.');
          return decode<T>(row);
        }
        // Keep receipts for active occurrences, even after their 24-hour window.
        await q(
          "DELETE FROM rivet_schedule_requests WHERE expires_at < $1 AND resource_id NOT IN (SELECT id FROM rivet_schedule_runs WHERE status IN ('queued','claimed','running'))",
          [now],
        );
        if (Number((await q('SELECT COUNT(*) AS count FROM rivet_schedule_requests'))[0]!.count) >= 10_000)
          throw createHttpError(429, 'Action acknowledgement capacity reached. Try again later.');
      }
      const result = await operation(q, now);
      if (key !== undefined) {
        const json = JSON.stringify(result);
        // Bound receipt storage as well as count. Four UTF-8 bytes per SQL
        // character is conservative across both supported databases.
        const used = Number(
          (await q('SELECT COALESCE(SUM(length(json)),0) AS size FROM rivet_schedule_requests'))[0]!.size,
        );
        if ((used + json.length) * 4 > 64 * 1024 * 1024)
          throw createHttpError(429, 'Action acknowledgement capacity reached. Try again later.');
        await q(
          'INSERT INTO rivet_schedule_requests(id,fingerprint,expires_at,resource_id,json) VALUES($1,$2,$3,$4,$5)',
          [key, fingerprint, now + 86400_000, result.id, json],
        );
      }
      return result;
    });
  }
  /** Restoring app data under a different independently owned control volume
   * must not start the original installation's external side effects. */
  bindInstallation(identity: string): Promise<void> {
    return this.transaction(async (q, now) => {
      const old = (await q("SELECT value FROM rivet_schedule_installation WHERE key='installation'"))[0]?.value;
      if (old && old !== identity) {
        for (const row of await q('SELECT json FROM rivet_schedules')) {
          const s = decode<ScheduledRun>(row);
          s.enabled = false;
          s.nextAt = null;
          s.revision++;
          s.updatedAt = now;
          await q('UPDATE rivet_schedules SET enabled=0,next_at=NULL,revision=$1,json=$2 WHERE id=$3', [
            s.revision,
            JSON.stringify(s),
            s.id,
          ]);
          await this.cancelQueued(q, s.id, now, 'Restored installation: enable explicitly after review.');
        }
        for (const row of await q("SELECT * FROM rivet_schedule_runs WHERE status='running'"))
          await this.writeRun(
            q,
            {
              ...decode<ScheduledOccurrence>(row),
              status: 'interrupted',
              finishedAt: now,
              reason: 'Restored installation; original outcome uncertain.',
            },
            row.draft_json,
            null,
            null,
          );
      }
      await q(
        "INSERT INTO rivet_schedule_installation(key,value) VALUES('installation',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [identity],
      );
    });
  }
  save(draft: ScheduledRunDraft, id: string = randomUUID(), expectedRevision = 0, key?: string): Promise<ScheduledRun> {
    const intent = { kind: 'create', draft: validateScheduledRun(draft, 0) };
    if (key !== undefined && expectedRevision !== 0)
      throw new Error('Request acknowledgement is only used for creation.');
    return this.requested(key, intent, async (q, now) => {
      draft = validateScheduledRun(draft, now);
      const previous = (await q('SELECT json FROM rivet_schedules WHERE id=$1', [id]))[0];
      const old = previous ? decode<ScheduledRun>(previous) : undefined;
      if ((old?.revision ?? 0) !== expectedRevision)
        throw createHttpError(409, 'Schedule changed in another window. Reload before saving.');
      if (!old && Number((await q('SELECT COUNT(*) AS count FROM rivet_schedules'))[0]!.count) >= 1000)
        throw createHttpError(409, 'Maximum of 1,000 schedules reached.');
      const schedule: ScheduledRun = {
        ...draft,
        id,
        revision: expectedRevision + 1,
        nextAt: draft.enabled ? nextOccurrence(draft.schedule, draft.timeZone, now) : null,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      await q(
        'INSERT INTO rivet_schedules(id,revision,enabled,next_at,json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,next_at=excluded.next_at,json=excluded.json',
        [id, schedule.revision, draft.enabled ? 1 : 0, schedule.nextAt, JSON.stringify(schedule)],
      );
      await this.cancelQueued(q, id, now, 'Schedule changed.');
      return schedule;
    });
  }
  delete(id: string, revision: number): Promise<void> {
    return this.transaction(async (q, now) => {
      const row = (await q('SELECT revision FROM rivet_schedules WHERE id=$1', [id]))[0];
      if (!row || Number(row.revision) !== revision)
        throw createHttpError(409, 'Schedule changed or was deleted. Reload before deleting.');
      await this.cancelQueued(q, id, now, 'Schedule deleted.');
      await q('DELETE FROM rivet_schedules WHERE id=$1', [id]);
    });
  }
  private async cancelQueued(q: Query, id: string, now: number, reason: string) {
    for (const row of await q(
      "SELECT * FROM rivet_schedule_runs WHERE schedule_id=$1 AND status IN ('queued','claimed')",
      [id],
    )) {
      const run = decode<ScheduledOccurrence>(row);
      await this.writeRun(q, { ...run, status: 'cancelled', finishedAt: now, reason }, row.draft_json, null, null);
    }
  }
  private writeRun(q: Query, run: ScheduledOccurrence, draft: string, owner: string | null, lease: number | null) {
    return q(
      'INSERT INTO rivet_schedule_runs(id,schedule_id,status,owner,lease_until,scheduled_at,json,draft_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET status=excluded.status,owner=excluded.owner,lease_until=excluded.lease_until,json=excluded.json',
      [run.id, run.scheduleId, run.status, owner, lease, run.scheduledAt, JSON.stringify(run), draft],
    );
  }
  private async enqueue(q: Query, s: ScheduledRun, at: number, id: string, reason?: string) {
    const pending =
      (
        await q(
          "SELECT id FROM rivet_schedule_runs WHERE schedule_id=$1 AND status IN ('queued','claimed','running') LIMIT 1",
          [s.id],
        )
      ).length > 0;
    const run: ScheduledOccurrence = {
      id,
      scheduleId: s.id,
      scheduleRevision: s.revision,
      name: s.name,
      projectId: s.projectId,
      scheduledAt: at,
      status: pending ? 'skipped' : 'queued',
      ...(reason ? { reason } : {}),
      ...(pending ? { reason: 'Previous occurrence is still pending or running.' } : {}),
    };
    await this.writeRun(q, run, JSON.stringify(s), null, null);
    return run;
  }
  runNow(id: string, revision: number, key?: string): Promise<ScheduledOccurrence> {
    return this.requested(key, { kind: 'run', id, revision }, async (q, now) => {
      const row = (await q('SELECT json FROM rivet_schedules WHERE id=$1', [id]))[0];
      if (!row) throw createHttpError(404, 'Schedule not found.');
      const s = decode<ScheduledRun>(row);
      if (s.revision !== revision) throw createHttpError(409, 'Schedule changed. Reload before running.');
      return this.enqueue(q, s, now, randomUUID(), 'Manual run.');
    });
  }
  retry(id: string, key?: string): Promise<ScheduledOccurrence> {
    return this.requested(key, { kind: 'retry', id }, async (q, now) => {
      const row = (await q('SELECT * FROM rivet_schedule_runs WHERE id=$1', [id]))[0];
      if (!row || !['failed', 'interrupted'].includes(row.status))
        throw createHttpError(409, 'Only failed or interrupted occurrences can be retried.');
      const draft = JSON.parse(row.draft_json) as ScheduledRun;
      // Retired/deleted schedules cannot be revived through historical records.
      if (!(await q('SELECT id FROM rivet_schedules WHERE id=$1', [draft.id])).length)
        throw createHttpError(409, 'Schedule was deleted.');
      return this.enqueue(q, draft, now, randomUUID(), 'Explicit retry; earlier side effects may have occurred.');
    });
  }
  cancel(id: string): Promise<void> {
    return this.transaction(async (q, now) => {
      const row = (await q('SELECT * FROM rivet_schedule_runs WHERE id=$1', [id]))[0];
      if (!row) throw createHttpError(404, 'Occurrence not found.');
      const run = decode<ScheduledOccurrence>(row);
      if (!active.includes(run.status)) return;
      if (run.status !== 'running')
        await this.writeRun(q, { ...run, status: 'cancelled', finishedAt: now }, row.draft_json, null, null);
      else
        await this.writeRun(q, { ...run, cancelRequested: true }, row.draft_json, row.owner, Number(row.lease_until));
    });
  }
  tick(owner: string, maxActive = 2): Promise<ClaimedRun | undefined> {
    return this.transaction(async (q, now) => {
      for (const row of await q(
        "SELECT * FROM rivet_schedule_runs WHERE status IN ('claimed','running') AND lease_until < $1",
        [now],
      )) {
        const run = decode<ScheduledOccurrence>(row);
        await this.writeRun(
          q,
          {
            ...run,
            status: run.status === 'claimed' ? 'queued' : 'interrupted',
            ...(run.status === 'running'
              ? { finishedAt: now, reason: 'Worker lost; outcome uncertain. Retry only after checking side effects.' }
              : {}),
          },
          row.draft_json,
          null,
          null,
        );
      }
      for (const row of await q(
        'SELECT json FROM rivet_schedules WHERE enabled=1 AND next_at <= $1 ORDER BY next_at LIMIT 100',
        [now],
      )) {
        const s = decode<ScheduledRun>(row);
        const at =
          s.missed === 'latest'
            ? Math.max(s.nextAt!, latestOccurrence(s.schedule, s.timeZone, now) ?? s.nextAt!)
            : s.nextAt!;
        const id = `${s.id}:${s.revision}:${at}`;
        if (s.missed === 'skip' && now - at > 60_000) {
          await this.writeRun(
            q,
            {
              id,
              scheduleId: s.id,
              scheduleRevision: s.revision,
              name: s.name,
              projectId: s.projectId,
              scheduledAt: at,
              status: 'skipped',
              finishedAt: now,
              reason: 'Missed while server unavailable, paused or delayed.',
            },
            JSON.stringify(s),
            null,
            null,
          );
        } else
          await this.enqueue(
            q,
            s,
            at,
            id,
            now - at > 60_000 ? 'Catch-up of missed work (one occurrence only).' : undefined,
          );
        s.nextAt = nextOccurrence(s.schedule, s.timeZone, now);
        if (s.nextAt === null) s.enabled = false;
        await q('UPDATE rivet_schedules SET enabled=$1,next_at=$2,json=$3 WHERE id=$4', [
          s.enabled ? 1 : 0,
          s.nextAt,
          JSON.stringify(s),
          s.id,
        ]);
      }
      // History is bounded independently of replay retention. Active rows survive.
      await q(
        "DELETE FROM rivet_schedule_runs WHERE status NOT IN ('queued','claimed','running') AND id NOT IN (SELECT id FROM rivet_schedule_runs ORDER BY scheduled_at DESC, id DESC LIMIT 1000)",
      );
      if (
        Number(
          (await q("SELECT COUNT(*) AS count FROM rivet_schedule_runs WHERE status IN ('claimed','running')"))[0]!
            .count,
        ) >= maxActive
      )
        return;
      const row = (
        await q("SELECT * FROM rivet_schedule_runs WHERE status='queued' ORDER BY scheduled_at,id LIMIT 1")
      )[0];
      if (!row) return;
      const occurrence = decode<ScheduledOccurrence>(row);
      // A capacity queue is bounded by one entry per schedule and a 15 minute
      // window, measured from due time (catch-up explicitly exempts downtime).
      if (now - occurrence.scheduledAt > 900_000 && !occurrence.reason?.startsWith('Catch-up')) {
        await this.writeRun(
          q,
          { ...occurrence, status: 'skipped', finishedAt: now, reason: 'Capacity lateness window exceeded.' },
          row.draft_json,
          null,
          null,
        );
        return;
      }
      occurrence.status = 'claimed';
      await this.writeRun(q, occurrence, row.draft_json, owner, now + 60_000);
      return { occurrence, draft: JSON.parse(row.draft_json) };
    });
  }
  accept(id: string, owner: string, metadata: Pick<ScheduledOccurrence, 'revisionKey' | 'graphId'>): Promise<boolean> {
    return this.transaction(async (q, now) => {
      const row = (
        await q(
          "SELECT * FROM rivet_schedule_runs WHERE id=$1 AND owner=$2 AND status='claimed' AND lease_until >= $3",
          [id, owner, now],
        )
      )[0];
      if (!row) return false;
      const run = { ...decode<ScheduledOccurrence>(row), ...metadata, status: 'running' as const, startedAt: now };
      await this.writeRun(q, run, row.draft_json, owner, now + 60_000);
      return true;
    });
  }
  heartbeat(id: string, owner: string): Promise<boolean> {
    return this.transaction(async (q, now) => {
      const row = (
        await q(
          "SELECT * FROM rivet_schedule_runs WHERE id=$1 AND owner=$2 AND status IN ('claimed','running') AND lease_until >= $3",
          [id, owner, now],
        )
      )[0];
      if (!row || decode<ScheduledOccurrence>(row).cancelRequested) return false;
      await q('UPDATE rivet_schedule_runs SET lease_until=$1 WHERE id=$2', [now + 60_000, id]);
      return true;
    });
  }
  finish(id: string, owner: string, result: Partial<ScheduledOccurrence>): Promise<void> {
    return this.transaction(async (q, now) => {
      const row = (
        await q(
          "SELECT * FROM rivet_schedule_runs WHERE id=$1 AND owner=$2 AND status IN ('claimed','running') AND lease_until >= $3",
          [id, owner, now],
        )
      )[0];
      if (!row) return; // A retired worker cannot overwrite interruption evidence.
      if (!result.status || !['succeeded', 'failed', 'interrupted', 'cancelled'].includes(result.status))
        throw new Error('Invalid execution outcome.');
      await this.writeRun(
        q,
        { ...decode<ScheduledOccurrence>(row), ...result, finishedAt: now },
        row.draft_json,
        null,
        null,
      );
    });
  }
}
