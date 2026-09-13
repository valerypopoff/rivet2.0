import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { PostgresRivetWebAppRunCoordinator } from '../web-app-action-coordinator.js';
import { awaitWebAppActionPreflight } from '../routes/workflows/execution.js';

async function waitFor(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for the expected coordinator poll.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

test('coordinator polling does not rebroadcast an unchanged latest event', async () => {
  let eventReads = 0;
  let delivered = 0;
  const pool = {
    async query(text: string) {
      if (text.includes('SELECT DISTINCT ON')) {
        eventReads += 1;
        return {
          rows: [{
            run_id: 'run-a',
            sequence: 1,
            event: {
              type: 'action.progress',
              progress: 0.5,
              requestId: 'request-a',
              runId: 'run-a',
              sequence: 1,
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
    await waitFor(() => eventReads >= 2);
    assert.equal(delivered, 1);
  } finally {
    await coordinator.dispose();
  }
});

test('web-app action preflight times out the client without releasing the underlying operation', async () => {
  const abortController = new AbortController();
  // The production timeout is intentionally unref'd so it cannot keep a
  // shutting-down API alive. A real request socket is an active handle; model
  // that ownership here so Node's test runner does not end the process first.
  const activeRequest = setInterval(() => undefined, 60_000);
  let finishOperation: (() => void) | undefined;
  const operation = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });

  try {
    await assert.rejects(
      () => awaitWebAppActionPreflight(operation, abortController, 5),
      (error: Error & { code?: string; retryAfterSeconds?: number; status?: number }) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'web_app_action_preflight_timeout');
        assert.equal(error.retryAfterSeconds, 1);
        return true;
      },
    );
    assert.equal(abortController.signal.aborted, true);

    // The caller timed out, but the operation remains independently owned. Its
    // completion is observed by the middleware that still holds the permit.
    finishOperation?.();
    await operation;
  } finally {
    clearInterval(activeRequest);
  }
});
