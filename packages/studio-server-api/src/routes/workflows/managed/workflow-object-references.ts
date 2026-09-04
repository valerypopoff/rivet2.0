import type { Pool, QueryResultRow } from 'pg';

type WorkflowReferenceRow = QueryResultRow & { object_key: string };

/**
 * The managed workflow blob store is shared by revisions and recordings. Keep
 * this reference set in one place: reconciliation and every destructive
 * outbox policy must make the same conservative decision about live metadata.
 */
export const MANAGED_WORKFLOW_OBJECT_REFERENCES_CTE = `
  WITH referenced_objects AS (
    SELECT project_blob_key AS object_key FROM workflow_revisions
    UNION
    SELECT dataset_blob_key AS object_key FROM workflow_revisions WHERE dataset_blob_key IS NOT NULL
    UNION
    SELECT recording_blob_key AS object_key FROM workflow_recordings
    UNION
    SELECT replay_project_blob_key AS object_key FROM workflow_recordings
    UNION
    SELECT replay_dataset_blob_key AS object_key FROM workflow_recordings WHERE replay_dataset_blob_key IS NOT NULL
  )
`;

/**
 * Returns the supplied keys which are still reachable from live managed
 * workflow metadata. Callers must treat a query error as a failed-closed
 * deletion decision rather than assuming the objects are safe to remove.
 */
export async function findManagedWorkflowObjectReferences(
  client: Pick<Pool, 'query'>,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await client.query<WorkflowReferenceRow>(
    `${MANAGED_WORKFLOW_OBJECT_REFERENCES_CTE}
      SELECT object_key FROM referenced_objects WHERE object_key = ANY($1::text[])
    `,
    [keys],
  );
  return new Set(result.rows.map((row) => row.object_key));
}
