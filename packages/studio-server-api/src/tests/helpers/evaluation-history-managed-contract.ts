import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { evaluationHistoryPageQuery, type EvaluationHistoryRow } from '../../evaluation-runs/history-page.js';

/** Uses only a connection-local table; never changes durable deployment data. */
export async function verifyManagedEvaluationHistoryCursorContract(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE evaluation_runs (
      run_id text, project_id text, suite_id text, started_at timestamptz, run_json jsonb
    ) ON COMMIT DROP`);
    const projectId = 'history-cursor-contract' as ProjectId;
    // All three timestamps collapse to the same JavaScript millisecond. IDs
    // deliberately oppose time ordering so an imprecise cursor loses rows.
    for (const [id, timestamp] of [
      ['a', '2026-10-08T00:00:00.000300Z'],
      ['b', '2026-10-08T00:00:00.000200Z'],
      ['c', '2026-10-08T00:00:00.000100Z'],
    ]) {
      await client.query('INSERT INTO evaluation_runs VALUES ($1, $2, $3, $4, $5)', [
        id,
        projectId,
        'suite',
        timestamp,
        { version: 2, id, projectId, suiteId: 'suite', startedAt: '2026-10-08T00:00:00.000Z' },
      ]);
    }
    await client.query("SET LOCAL DateStyle = 'SQL, DMY'");
    await client.query("SET LOCAL TIME ZONE 'Pacific/Auckland'");
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const query = evaluationHistoryPageQuery('postgres', { projectId, suiteId: 'suite', limit: 1, after });
      const rows = await client.query<EvaluationHistoryRow>(query.sql, query.values);
      const page = query.page(rows.rows);
      ids.push(...page.runs.map((run) => run.id));
      after = page.nextCursor;
      if (after) {
        const cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
        assert.match(cursor[2], /^2026-10-08T00:00:00\.000[123]00Z$/);
      }
    } while (after && ids.length < 5);
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}
