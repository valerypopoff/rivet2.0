import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Pool } from 'pg';

import { PostgresRivetWebAppRunCoordinator } from '../web-app-action-coordinator.js';
import { awaitWebAppActionPreflight } from '../routes/workflows/web-app-execution.js';

test('durably accepted cancellation stays successful when PostgreSQL notification delivery fails', async () => {
  const queries: string[] = [];
  const errors: unknown[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('INSERT INTO web_app_action_cancel_commands')) {
        return { rows: [{ run_id: 'run-a' }] };
      }
      if (text.includes('SELECT pg_notify')) {
        throw new Error('notification connection reset');
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const coordinator = new PostgresRivetWebAppRunCoordinator(
    pool,
    { connectionString: 'postgres://unused' },
    (error) => errors.push(error),
  );

  try {
    const cancelled = await coordinator.cancelRun({
      hostId: 'runner-a',
      ownerScope: 'owner-a',
      runId: 'run-a',
    });

    assert.equal(cancelled, true);
    assert.equal(errors.length, 1);
    assert.match(
      queries.find((query) => query.includes('INSERT INTO web_app_action_cancel_commands')) ?? '',
      /ON CONFLICT \(run_id\) DO UPDATE/,
    );
  } finally {
    await coordinator.dispose();
  }
});

test('coordinator polling delivers each new sequence once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let eventReads = 0;
  let delivered = 0;
  let sequence = 1;
  const pool = {
    async query(text: string) {
      if (text.includes('SELECT DISTINCT ON')) {
        eventReads += 1;
        return {
          rows: [{
            run_id: 'run-a',
            sequence,
            event: {
              type: 'action.progress',
              progress: 0.5,
              requestId: 'request-a',
              runId: 'run-a',
              sequence,
            },
          }],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const coordinator = new PostgresRivetWebAppRunCoordinator(
    pool,
    { connectionString: 'postgres://unused' },
    undefined,
    10,
  );

  try {
    await coordinator.subscribe({
      hostId: 'runner-a',
      ownerScope: 'owner-a',
      runId: 'run-a',
      onEvent: () => {
        delivered += 1;
      },
      onUnavailable: () => undefined,
    });
    for (const nextSequence of [1, 1, 2, 2]) {
      sequence = nextSequence;
      t.mock.timers.tick(10);
      await setImmediate();
      assert.equal(delivered, nextSequence);
    }
    assert.equal(eventReads, 4);
  } finally {
    await coordinator.dispose();
  }
});

test('web-app action preflight reports its timeout and observes late completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abortController = new AbortController();
  let finishOperation!: () => void;
  const operation = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });

  try {
    const rejected = assert.rejects(
      () => awaitWebAppActionPreflight(operation, abortController, 5),
      (error: Error & { code?: string; retryAfterSeconds?: number; status?: number }) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'web_app_action_preflight_timeout');
        assert.equal(error.retryAfterSeconds, 1);
        return true;
      },
    );
    t.mock.timers.tick(5);
    await rejected;
    assert.equal(abortController.signal.aborted, true);
  } finally {
    finishOperation();
    await operation;
  }
});
