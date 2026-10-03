/**
 * A project browse scope includes its own recordings and called-project replays
 * sharing a retained root execution key. Child rows are not root anchors: a
 * project called by A must not accidentally pull in A's sibling calls.
 * This is metadata-only and does not change replay ownership or retention.
 */
export function recordingWorkflowScopeClause(
  workflowId: string,
  includeSubgraphRuns: boolean,
  storage: 'filesystem' | 'sqlite' | 'managed',
  parameterIndex = 1,
): string {
  const parameter = storage === 'managed' ? `$${parameterIndex}` : `?${parameterIndex}`;
  if (!workflowId) return storage === 'managed' ? `${parameter}::text IS NOT NULL` : '1 = 1';
  if (!includeSubgraphRuns) return `workflow_id = ${parameter}`;
  const table =
    storage === 'filesystem' ? 'recording_runs' : storage === 'sqlite' ? 'recordings' : 'workflow_recordings';
  const field = (name: 'surface' | 'correlationId', prefix = '') =>
    storage === 'sqlite'
      ? `json_extract(${prefix}metadata_json, '$.executionIdentity.${name}')`
      : `${prefix}${name === 'surface' ? 'execution_surface' : 'correlation_id'}`;
  return `(workflow_id = ${parameter} OR (
    ${field('surface')} = 'subgraph_project'
    AND ${field('correlationId')} <> ''
    AND ${field('correlationId')} IN (
      SELECT ${field('correlationId', 'root.')} FROM ${table} AS root
      WHERE root.workflow_id = ${parameter}
        AND COALESCE(${field('surface', 'root.')}, '') <> 'subgraph_project'
        AND ${field('correlationId', 'root.')} <> ''
    )
  ))`;
}
