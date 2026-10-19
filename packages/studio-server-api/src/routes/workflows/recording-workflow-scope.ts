/**
 * A project browse scope includes its own recordings and called-project replays
 * sharing a retained root execution key. Child rows are not root anchors: a
 * project called by A must not accidentally pull in A's sibling calls.
 * This is metadata-only and does not change replay ownership or retention.
 */
export type RecordingRunScope =
  | 'all'
  | 'roots'
  | 'children'
  | 'families'
  | 'family-children'
  | 'project-family-children';

/** Mirrors primary-owned child discovery, independently of page/status/input filters. */
export function recordingHasSubRunsSql(
  storage: 'filesystem' | 'sqlite' | 'managed',
  pageTable?: 'recording_page',
): string {
  const table =
    storage === 'filesystem' ? 'recording_runs' : storage === 'sqlite' ? 'recordings' : 'workflow_recordings';
  const field = (alias: string, name: 'surface' | 'correlationId') =>
    storage === 'sqlite'
      ? `json_extract(${alias}.metadata_json, '$.executionIdentity.${name}')`
      : `${alias}.${name === 'surface' ? 'execution_surface' : 'correlation_id'}`;
  const source = pageTable ?? table;
  const key = field(source, 'correlationId');
  // This derived SQLite index has real correlation columns. Indexed probes
  // avoid scanning/grouping every run merely to decorate one bounded page.
  if (storage === 'filesystem')
    return `(CASE WHEN COALESCE(${field(source, 'surface')}, '') <> 'subgraph_project'
      AND TRIM(COALESCE(${key}, '')) <> ''
      THEN EXISTS (SELECT 1 FROM ${table} AS child
        WHERE ${field('child', 'correlationId')} = ${key} AND ${field('child', 'surface')} = 'subgraph_project')
        AND (SELECT COUNT(*) FROM ${table} AS primary_run
          WHERE ${field('primary_run', 'correlationId')} = ${key}
            AND COALESCE(${field('primary_run', 'surface')}, '') <> 'subgraph_project') = 1
      ELSE FALSE END)`;
  const candidateKeys = pageTable
    ? `WHERE ${field('member', 'correlationId')} IN (
        SELECT ${field(pageTable, 'correlationId')} FROM ${pageTable}
        WHERE COALESCE(${field(pageTable, 'surface')}, '') <> 'subgraph_project'
          AND TRIM(COALESCE(${field(pageTable, 'correlationId')}, '')) <> '')`
    : '';
  // One metadata aggregation per window, not a correlated full-history scan
  // for each visible row (the legacy SQLite catalog has no correlation index).
  return `(CASE WHEN COALESCE(${field(source, 'surface')}, '') <> 'subgraph_project'
    AND TRIM(COALESCE(${key}, '')) <> ''
    THEN ${key} IN (SELECT ${field('member', 'correlationId')} FROM ${table} AS member
      ${candidateKeys}
      GROUP BY ${field('member', 'correlationId')}
      HAVING SUM(CASE WHEN COALESCE(${field('member', 'surface')}, '') <> 'subgraph_project' THEN 1 ELSE 0 END) = 1
        AND SUM(CASE WHEN ${field('member', 'surface')} = 'subgraph_project' THEN 1 ELSE 0 END) > 0)
    ELSE FALSE END)`;
}

export function recordingWorkflowScopeClause(
  workflowId: string,
  includeSubgraphRuns: boolean,
  storage: 'filesystem' | 'sqlite' | 'managed',
  parameterIndex = 1,
  runScope: RecordingRunScope = 'all',
  statusFilter: 'all' | 'failed' = 'all',
): string {
  const parameter = storage === 'managed' ? `$${parameterIndex}` : `?${parameterIndex}`;
  const table =
    storage === 'filesystem' ? 'recording_runs' : storage === 'sqlite' ? 'recordings' : 'workflow_recordings';
  const field = (name: 'surface' | 'correlationId', prefix = '') =>
    storage === 'sqlite'
      ? `json_extract(${prefix}metadata_json, '$.executionIdentity.${name}')`
      : `${prefix}${name === 'surface' ? 'execution_surface' : 'correlation_id'}`;
  const id = storage === 'filesystem' ? 'id' : 'recording_id';
  if (runScope === 'family-children' || runScope === 'project-family-children') {
    // A context group has no unambiguous primary in the current results. Its
    // representative is a real child, never a fabricated root. Project-scoped
    // context includes sibling calls only if that project also owns a caller
    // under this key, matching the ordinary project browse scope below.
    return `(${field('surface')} = 'subgraph_project' AND TRIM(COALESCE(${field('correlationId')}, '')) <> ''
      AND ${field('correlationId')} IN (SELECT ${field('correlationId', 'anchor.')} FROM ${table} AS anchor
        WHERE anchor.${id} = ${parameter} AND ${field('surface', 'anchor.')} = 'subgraph_project')
      ${
        runScope === 'project-family-children'
          ? `AND (workflow_id IN (SELECT anchor.workflow_id FROM ${table} AS anchor WHERE anchor.${id} = ${parameter})
        OR EXISTS (SELECT 1 FROM ${table} AS anchor JOIN ${table} AS caller
          ON caller.workflow_id = anchor.workflow_id
          AND COALESCE(${field('surface', 'caller.')}, '') <> 'subgraph_project'
          AND ${field('correlationId', 'caller.')} = ${field('correlationId', 'anchor.')}
          WHERE anchor.${id} = ${parameter}))`
          : ''
      })`;
  }
  if (runScope === 'children') {
    // In this scope the bound ID identifies a retained primary recording,
    // not a workflow. No payload reads or input/status filters are involved.
    return `(${field('surface')} = 'subgraph_project' AND ${field('correlationId')} <> ''
      AND ${field('correlationId')} IN (
        SELECT ${field('correlationId', 'root.')} FROM ${table} AS root
        WHERE root.${id} = ${parameter}
          AND COALESCE(${field('surface', 'root.')}, '') <> 'subgraph_project'
          AND (SELECT COUNT(*) FROM ${table} AS primary_run
            WHERE COALESCE(${field('surface', 'primary_run.')}, '') <> 'subgraph_project'
              AND ${field('correlationId', 'primary_run.')} = ${field('correlationId', 'root.')}) = 1
      ))`;
  }
  if (runScope === 'families') {
    const scope = recordingWorkflowScopeClause(workflowId, includeSubgraphRuns, storage, parameterIndex);
    const status = storage === 'sqlite' ? "json_extract(metadata_json, '$.status')" : 'status';
    const created = storage === 'sqlite' ? "json_extract(metadata_json, '$.createdAt')" : 'created_at';
    const primary = `CASE WHEN COALESCE(${field('surface')}, '') <> 'subgraph_project' THEN 1 ELSE 0 END`;
    // Paginate one anchor per visible family. Unique primaries own their group;
    // ambiguous primaries stay independent and their children get a context
    // group. Legacy/unlinked rows remain independent. Only metadata is queried.
    return `${id} IN (SELECT family_id FROM (
      SELECT family_id, ROW_NUMBER() OVER (
        PARTITION BY CASE WHEN TRIM(COALESCE(family_key, '')) = '' OR (is_primary = 1 AND primary_count <> 1)
          THEN 'run:' || family_id ELSE 'correlation:' || family_key END
        ORDER BY is_primary DESC, family_created DESC, family_id DESC
      ) AS family_position FROM (
        SELECT ${id} AS family_id, ${created} AS family_created, ${field('correlationId')} AS family_key,
          ${primary} AS is_primary,
          SUM(${primary}) OVER (PARTITION BY ${field('correlationId')}) AS primary_count,
          CASE WHEN ${scope}${statusFilter === 'failed' ? ` AND ${status} IN ('failed', 'suspicious')` : ''}
            THEN 1 ELSE 0 END AS family_eligible
        FROM ${table}
      ) AS family_candidates WHERE family_eligible = 1
    ) AS family_anchors WHERE family_position = 1)`;
  }
  const scope = !workflowId
    ? storage === 'managed'
      ? `${parameter}::text IS NOT NULL`
      : '1 = 1'
    : `workflow_id = ${parameter}`;
  if (runScope === 'roots') return `(${scope} AND COALESCE(${field('surface')}, '') <> 'subgraph_project')`;
  if (!workflowId || !includeSubgraphRuns) return scope;
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
