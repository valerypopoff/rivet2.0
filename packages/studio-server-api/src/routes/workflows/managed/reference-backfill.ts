import type { Pool } from 'pg';
import type { ManagedWorkflowBlobStore } from './blob-store.js';
import { getWorkflowProjectIndexDataFromContents } from '../project-index.js';
import { PROJECT_REFERENCE_SUMMARY_VERSION } from '../project-reference-summary.js';
import { ACTIVE_REFERENCE_REVISIONS_SQL } from './reference-index.js';
import { queryReferences } from './reference-query.js';

type Candidate = {
  revision_id: string;
  workflow_id: string;
  project_blob_key: string;
  expected_summary: string | null;
};
const ACTIVE = `WITH active AS (${ACTIVE_REFERENCE_REVISIONS_SQL})`;
// Future extractor results belong to a newer writer. Never downgrade them.
const NEEDS_SUMMARY = `(r.reference_summary IS NULL OR (
  r.reference_summary->'version' IS DISTINCT FROM to_jsonb($1::int)
  AND NOT CASE WHEN jsonb_typeof(r.reference_summary->'version') = 'number'
    THEN (r.reference_summary->>'version')::numeric > $1 ELSE false END
))`;

export async function backfillProjectReferences(options: {
  pool: Pool;
  blobStore: ManagedWorkflowBlobStore;
  signal: AbortSignal;
  maxRevisions: number;
  batchSize?: number;
}) {
  if (!Number.isSafeInteger(options.maxRevisions) || options.maxRevisions < 1 || options.maxRevisions > 10_000)
    throw new Error('maxRevisions must be between 1 and 10000');
  const batchSize = options.batchSize ?? 25;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invalid batch size');
  const { pool, blobStore, signal } = options;
  const attempted: string[] = [];
  const failures: Array<{ revisionId: string; reason: 'unreadable-artifact' | 'invalid-summary' }> = [];
  let updated = 0;
  // Each iteration re-enumerates current pointers. Failed reads are excluded for
  // this invocation; a later explicit invocation can repair transient failures.
  while (attempted.length < options.maxRevisions) {
    signal.throwIfAborted();
    const rows = await queryReferences<Candidate>(
      pool,
      `${ACTIVE}
      SELECT r.revision_id, r.workflow_id, r.project_blob_key, r.reference_summary::text AS expected_summary
      FROM workflow_revisions r
      WHERE EXISTS (SELECT 1 FROM active a WHERE a.revision_id = r.revision_id AND a.workflow_id = r.workflow_id)
        AND ${NEEDS_SUMMARY} AND NOT (r.revision_id = ANY($2::text[]))
      ORDER BY r.revision_id LIMIT $3`,
      [PROJECT_REFERENCE_SUMMARY_VERSION, attempted, Math.min(batchSize, options.maxRevisions - attempted.length)],
      signal,
    );
    if (!rows.length) break;
    for (const row of rows) {
      signal.throwIfAborted();
      attempted.push(row.revision_id);
      let summary;
      try {
        const contents = await blobStore.getText(row.project_blob_key, { signal });
        signal.throwIfAborted();
        summary = getWorkflowProjectIndexDataFromContents(contents, null, true).referenceSummary!;
        if (summary.state === 'complete' && summary.projectId !== row.workflow_id)
          summary = {
            version: PROJECT_REFERENCE_SUMMARY_VERSION,
            state: 'invalid',
            reason: 'invalid-project',
          } as const;
      } catch {
        signal.throwIfAborted();
        failures.push({ revisionId: row.revision_id, reason: 'unreadable-artifact' });
        continue;
      }
      // A concurrent backfill, delete, repair or pointer switch must not be
      // overwritten. Never replay an uncertain SQL write automatically.
      // Retain PostgreSQL's exact old JSON value: decoding/re-encoding it in JS
      // would conflate JSON null with SQL NULL and round large numeric fields.
      const changed = await queryReferences<{ revision_id: string }>(
        pool,
        `${ACTIVE}
        UPDATE workflow_revisions r SET reference_summary = $1::jsonb
        WHERE r.revision_id = $2 AND r.workflow_id = $3 AND r.project_blob_key = $4
          AND r.reference_summary IS NOT DISTINCT FROM $5::jsonb
          AND EXISTS (SELECT 1 FROM active a WHERE a.revision_id = r.revision_id AND a.workflow_id = r.workflow_id)
        RETURNING r.revision_id`,
        [JSON.stringify(summary), row.revision_id, row.workflow_id, row.project_blob_key, row.expected_summary],
        signal,
        { write: true },
      );
      updated += changed.length;
      if (summary.state === 'invalid' || summary.graphCalls === null || summary.projectTargets === null)
        failures.push({ revisionId: row.revision_id, reason: 'invalid-summary' });
    }
  }
  const [coverage] = await queryReferences<{ total: number; complete: number }>(
    pool,
    `${ACTIVE}
    SELECT count(*)::int AS total, count(*) FILTER (WHERE
      r.reference_summary->'version' = to_jsonb($1::int) AND r.reference_summary->>'state' = 'complete'
      AND r.reference_summary->>'projectId' = a.workflow_id
      AND jsonb_typeof(r.reference_summary->'graphCalls') = 'array'
      AND jsonb_typeof(r.reference_summary->'projectTargets') = 'array')::int AS complete
    FROM (SELECT DISTINCT workflow_id, revision_id FROM active) a
    LEFT JOIN workflow_revisions r ON r.revision_id = a.revision_id AND r.workflow_id = a.workflow_id`,
    [PROJECT_REFERENCE_SUMMARY_VERSION],
    signal,
  );
  return { attempted: attempted.length, updated, failures, coverage };
}
