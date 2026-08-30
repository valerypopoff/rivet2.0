import type { Pool, PoolClient } from 'pg';
import type {
  RivetWebAppRunCreation,
  RivetWebAppRunEvent,
  RivetWebAppRunStore,
  RivetWebAppStoredRun,
  RivetWebAppUnsequencedRunEvent,
} from '@valerypopoff/rivet2-node';

const MAX_EVENTS_PER_RUN = 256;

type RunRow = {
  component_id: string;
  created_at: Date;
  host_id: string;
  last_sequence: number;
  lease_expires_at: Date;
  lease_id: string;
  owner_scope: string;
  request_id: string;
  run_id: string;
  status: RivetWebAppStoredRun['status'];
  updated_at: Date;
};

type EventRow = {
  event: RivetWebAppRunEvent | string;
  sequence: number;
};

function parseEvent(value: EventRow['event']): RivetWebAppRunEvent {
  return typeof value === 'string' ? JSON.parse(value) as RivetWebAppRunEvent : value;
}

function toStoredRun(row: RunRow, events: RivetWebAppRunEvent[]): RivetWebAppStoredRun {
  return {
    componentId: row.component_id,
    createdAt: row.created_at.getTime(),
    events,
    hostId: row.host_id,
    lastSequence: row.last_sequence,
    leaseExpiresAt: row.lease_expires_at.getTime(),
    leaseId: row.lease_id,
    ownerScope: row.owner_scope,
    requestId: row.request_id,
    runId: row.run_id,
    status: row.status,
    updatedAt: row.updated_at.getTime(),
  };
}

function terminalStatus(event: RivetWebAppRunEvent): RivetWebAppStoredRun['status'] {
  switch (event.type) {
    case 'action.completed': return 'completed';
    case 'action.failed': return 'failed';
    case 'action.cancelled': return 'cancelled';
    case 'action.interrupted': return 'interrupted';
    default: return 'running';
  }
}

function isTerminal(event: RivetWebAppRunEvent): boolean {
  return terminalStatus(event) !== 'running';
}

async function loadEvents(client: Pool | PoolClient, runId: string): Promise<RivetWebAppRunEvent[]> {
  const { rows } = await client.query<EventRow>(`
    SELECT sequence, event
    FROM web_app_action_run_events
    WHERE run_id = $1
    ORDER BY CASE WHEN event->>'type' = 'action.accepted' THEN 0 ELSE 1 END, sequence ASC
  `, [runId]);
  return rows.map(({ event }) => parseEvent(event));
}

async function loadRun(client: Pool | PoolClient, runId: string): Promise<RivetWebAppStoredRun | undefined> {
  const { rows } = await client.query<RunRow>(`
    SELECT run_id, owner_scope, request_id, component_id, host_id, lease_id,
      lease_expires_at, status, last_sequence, created_at, updated_at
    FROM web_app_action_runs
    WHERE run_id = $1
  `, [runId]);
  const row = rows[0];
  return row ? toStoredRun(row, await loadEvents(client, row.run_id)) : undefined;
}

async function compactEvents(client: PoolClient, runId: string): Promise<void> {
  await client.query(`
    DELETE FROM web_app_action_run_events
    WHERE run_id = $1
      AND sequence NOT IN (
        SELECT sequence
        FROM web_app_action_run_events
        WHERE run_id = $1
        ORDER BY CASE WHEN event->>'type' = 'action.accepted' THEN 0 ELSE 1 END, sequence DESC
        LIMIT $2
      )
  `, [runId, MAX_EVENTS_PER_RUN]);
}

export async function readStoredWebAppActionEvent(
  pool: Pool,
  runId: string,
  sequence: number,
): Promise<RivetWebAppRunEvent | undefined> {
  const { rows } = await pool.query<EventRow>(`
    SELECT sequence, event
    FROM web_app_action_run_events
    WHERE run_id = $1 AND sequence = $2
  `, [runId, sequence]);
  return rows[0] ? parseEvent(rows[0].event) : undefined;
}

export function createPostgresRivetWebAppRunStore(pool: Pool): RivetWebAppRunStore {

  const interruptRuns = async (
    predicateSql: string,
    predicateParams: unknown[],
    error: string,
  ): Promise<RivetWebAppStoredRun[]> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<RunRow>(`
        SELECT run_id, owner_scope, request_id, component_id, host_id, lease_id,
          lease_expires_at, status, last_sequence, created_at, updated_at
        FROM web_app_action_runs
        WHERE status = 'running' AND ${predicateSql}
        FOR UPDATE
      `, predicateParams);
      const interrupted: RivetWebAppStoredRun[] = [];
      for (const row of rows) {
        const event = {
          type: 'action.interrupted' as const,
          error,
          requestId: row.request_id,
          runId: row.run_id,
          sequence: row.last_sequence + 1,
        };
        await client.query(`
          UPDATE web_app_action_runs
          SET status = 'interrupted', last_sequence = $2, updated_at = NOW()
          WHERE run_id = $1
        `, [row.run_id, event.sequence]);
        await client.query(`
          INSERT INTO web_app_action_run_events (run_id, sequence, event)
          VALUES ($1, $2, $3::jsonb)
        `, [row.run_id, event.sequence, JSON.stringify(event)]);
        await client.query('DELETE FROM web_app_action_cancel_commands WHERE run_id = $1', [row.run_id]);
        await compactEvents(client, row.run_id);
        const updated: RunRow = { ...row, last_sequence: event.sequence, status: 'interrupted', updated_at: new Date() };
        interrupted.push(toStoredRun(updated, await loadEvents(client, row.run_id)));
      }
      await client.query('COMMIT');
      return interrupted;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    async appendEvent(runId, leaseId, event) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<Pick<RunRow, 'last_sequence' | 'request_id'>>(
          `
            SELECT last_sequence, request_id
            FROM web_app_action_runs
            WHERE run_id = $1
              AND lease_id = $2
              AND status = 'running'
              AND lease_expires_at > NOW()
            FOR UPDATE
          `,
          [runId, leaseId],
        );
        const run = rows[0];
        if (!run || run.request_id !== event.requestId || event.runId !== runId) {
          await client.query('ROLLBACK');
          return undefined;
        }

        const storedEvent = { ...event, sequence: run.last_sequence + 1 } as RivetWebAppRunEvent;
        const status = terminalStatus(storedEvent);
        await client.query(`
          UPDATE web_app_action_runs
          SET last_sequence = $2,
            status = $3,
            updated_at = NOW()
          WHERE run_id = $1
        `, [runId, storedEvent.sequence, status]);
        await client.query(`
          INSERT INTO web_app_action_run_events (run_id, sequence, event)
          VALUES ($1, $2, $3::jsonb)
        `, [runId, storedEvent.sequence, JSON.stringify(storedEvent)]);
        if (isTerminal(storedEvent)) {
          await client.query('DELETE FROM web_app_action_cancel_commands WHERE run_id = $1', [runId]);
        }
        await compactEvents(client, runId);
        await client.query('COMMIT');
        return storedEvent;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async createRun(input) {
      const { rows } = await pool.query<RunRow>(`
        INSERT INTO web_app_action_runs (
          run_id, owner_scope, request_id, component_id, host_id, lease_id,
          lease_expires_at, status, last_sequence, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          NOW() + ($7::bigint * INTERVAL '1 millisecond'), 'running', 0,
          to_timestamp($8 / 1000.0), to_timestamp($8 / 1000.0)
        )
        ON CONFLICT (owner_scope, request_id) DO NOTHING
        RETURNING run_id, owner_scope, request_id, component_id, host_id, lease_id,
          lease_expires_at, status, last_sequence, created_at, updated_at
      `, [
        input.runId,
        input.ownerScope,
        input.requestId,
        input.componentId,
        input.hostId,
        input.leaseId,
        input.leaseDurationMs,
        input.createdAt,
      ]);
      const created = rows[0];
      if (created) {
        return { created: true, run: toStoredRun(created, []) };
      }

      const { rows: existingRows } = await pool.query<RunRow>(`
        SELECT run_id, owner_scope, request_id, component_id, host_id, lease_id,
          lease_expires_at, status, last_sequence, created_at, updated_at
        FROM web_app_action_runs
        WHERE owner_scope = $1 AND request_id = $2
      `, [input.ownerScope, input.requestId]);
      const existing = existingRows[0];
      if (!existing) {
        throw new Error('Web app action run reservation disappeared before it could be read.');
      }
      return { created: false, run: toStoredRun(existing, await loadEvents(pool, existing.run_id)) };
    },

    async getRun(runId) {
      return loadRun(pool, runId);
    },

    async getRunByRequestId(ownerScope, requestId) {
      const { rows } = await pool.query<RunRow>(`
        SELECT run_id, owner_scope, request_id, component_id, host_id, lease_id,
          lease_expires_at, status, last_sequence, created_at, updated_at
        FROM web_app_action_runs
        WHERE owner_scope = $1 AND request_id = $2
      `, [ownerScope, requestId]);
      const row = rows[0];
      return row ? toStoredRun(row, await loadEvents(pool, row.run_id)) : undefined;
    },

    async interruptExpiredRuns(error) {
      return interruptRuns('lease_expires_at <= NOW()', [], error);
    },

    async interruptRunsByLease(leaseId, error) {
      return interruptRuns('lease_id = $1', [leaseId], error);
    },

    async renewRunLeases(leaseId, runIds, leaseDurationMs) {
      if (runIds.length === 0) return [];
      const { rows } = await pool.query<{ run_id: string }>(`
        UPDATE web_app_action_runs
        SET lease_expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
          updated_at = NOW()
        WHERE lease_id = $1
          AND run_id = ANY($2::text[])
          AND status = 'running'
          AND lease_expires_at > NOW()
        RETURNING run_id
      `, [leaseId, runIds, leaseDurationMs]);
      return rows.map((row) => row.run_id);
    },
  };
}
