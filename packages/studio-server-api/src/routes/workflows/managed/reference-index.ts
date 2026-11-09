import type { Pool } from 'pg';
import type { ProjectGraphCallSite } from '@valerypopoff/rivet2-core';
import type {
  WorkflowProjectReferencesResponse,
  WorkflowProjectReferenceSource,
} from '../../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { PROJECT_REFERENCE_SUMMARY_VERSION, type ProjectReferenceTarget } from '../project-reference-summary.js';
import { queryReferences } from './reference-query.js';

export type ProjectReferenceQuery = {
  relativePath?: string;
  expectedProjectId?: string;
  graphIds?: readonly string[];
  signal: AbortSignal;
};

/** Active pointers only: historic revisions are intentionally excluded. */
export const ACTIVE_REFERENCE_REVISIONS_SQL = `
  SELECT workflow_id, current_draft_revision_id AS revision_id, 'saved-latest' AS kind, NULL::text AS label FROM workflows
  UNION ALL
  SELECT workflow_id, published_revision_id, 'published-endpoint', COALESCE(published_endpoint_name, endpoint_name) FROM workflows WHERE published_revision_id IS NOT NULL
  UNION ALL
  SELECT workflow_id, revision_id, 'published-web-app', slug FROM workflow_web_apps
`;

// Exact revision/blob identity is intrinsic to the immutable revision row. Only
// matching edges leave PostgreSQL, rather than every project's summary JSON.
export const INCOMING_REFERENCE_SQL = `
WITH target AS MATERIALIZED (
  SELECT workflow_id, relative_path FROM workflows
  WHERE CASE WHEN $1::text IS NOT NULL THEN relative_path = $1 ELSE workflow_id = $2 END
), active AS MATERIALIZED (${ACTIVE_REFERENCE_REVISIONS_SQL}),
summaries AS MATERIALIZED (
  SELECT a.*, w.name, w.relative_path, r.reference_summary AS summary,
    CASE WHEN r.revision_id IS NULL THEN 'invalid-summary'
      WHEN r.reference_summary IS NULL THEN 'missing-summary'
      WHEN r.reference_summary->'version' IS DISTINCT FROM to_jsonb($4::int) THEN 'outdated-summary'
      WHEN r.reference_summary->>'state' IS DISTINCT FROM 'complete'
        OR r.reference_summary->>'projectId' IS DISTINCT FROM a.workflow_id
        OR jsonb_typeof(CASE WHEN $3::text[] IS NULL THEN r.reference_summary->'projectTargets'
          ELSE r.reference_summary->'graphCalls' END) IS DISTINCT FROM 'array' THEN 'invalid-summary'
      ELSE NULL END AS issue
  FROM active a JOIN workflows w USING (workflow_id)
  LEFT JOIN workflow_revisions r ON r.revision_id = a.revision_id AND r.workflow_id = a.workflow_id
), coverage AS (
  SELECT workflow_id, bool_and(issue IS NULL) AS complete FROM summaries
  WHERE workflow_id <> (SELECT workflow_id FROM target) GROUP BY workflow_id
), matches AS MATERIALIZED (
  SELECT s.workflow_id, s.name, s.relative_path, s.kind, s.label, edge
  FROM summaries s CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN s.issue IS NULL THEN
      CASE WHEN $3::text[] IS NULL THEN s.summary->'projectTargets' ELSE s.summary->'graphCalls' END
    ELSE '[]'::jsonb END
  ) edge
  WHERE s.workflow_id <> (SELECT workflow_id FROM target)
    AND CASE WHEN $3::text[] IS NULL THEN edge->>'projectId' ELSE edge->>'targetProjectId' END = (SELECT workflow_id FROM target)
    AND ($3::text[] IS NULL OR edge->>'targetGraphId' = ANY($3))
  ORDER BY s.relative_path, CASE s.kind WHEN 'saved-latest' THEN 0 WHEN 'published-endpoint' THEN 1 ELSE 2 END,
    s.label, edge->>'sourceGraphId', edge->>'nodeId', edge->>'version'
  LIMIT 1001
), budgeted_matches AS MATERIALIZED (
  SELECT to_jsonb(m) AS value, sum(octet_length(to_jsonb(m)::text)) OVER (
    ORDER BY relative_path, CASE kind WHEN 'saved-latest' THEN 0 WHEN 'published-endpoint' THEN 1 ELSE 2 END,
      label, edge->>'sourceGraphId', edge->>'nodeId', edge->>'version'
    ROWS UNBOUNDED PRECEDING
  ) AS bytes FROM matches m
)
SELECT (SELECT row_to_json(t) FROM target t) AS target,
  (SELECT CASE WHEN summary IS NULL THEN issue
      WHEN summary->'version' IS DISTINCT FROM to_jsonb($4::int) THEN 'outdated-summary'
      WHEN summary->>'projectId' IS DISTINCT FROM workflow_id THEN 'invalid-summary'
      ELSE NULL END
    FROM summaries WHERE workflow_id = (SELECT workflow_id FROM target) AND kind = 'saved-latest') AS target_issue,
  (SELECT count(*)::int FROM coverage) AS total,
  (SELECT count(*)::int FROM coverage WHERE complete) AS checked,
  COALESCE((SELECT jsonb_agg(DISTINCT issue) FROM summaries WHERE issue IS NOT NULL
    AND workflow_id <> (SELECT workflow_id FROM target)), '[]'::jsonb) AS issues,
  COALESCE((SELECT jsonb_agg(item) FROM (
    SELECT DISTINCT name, relative_path AS "relativePath" FROM summaries WHERE issue = 'invalid-summary'
      AND workflow_id <> (SELECT workflow_id FROM target) ORDER BY "relativePath" LIMIT 1000
  ) item), '[]'::jsonb) AS unreadable,
  ((SELECT count(*) > 1000 FROM matches) OR EXISTS (SELECT 1 FROM budgeted_matches WHERE bytes > 2097152)) AS truncated,
  COALESCE((SELECT jsonb_agg(value) FROM budgeted_matches WHERE bytes <= 2097152), '[]'::jsonb) AS matches
`;

type ReferenceRow = {
  target: { workflow_id: string; relative_path: string } | null;
  target_issue: NonNullable<WorkflowProjectReferencesResponse['incompleteReasons']>[number] | null;
  total: number;
  checked: number;
  truncated: boolean;
  issues: NonNullable<WorkflowProjectReferencesResponse['incompleteReasons']>;
  unreadable: WorkflowProjectReferencesResponse['unreadableProjects'];
  matches: Array<{
    workflow_id: string;
    name: string;
    relative_path: string;
    kind: WorkflowProjectReferenceSource['kind'];
    label: string | null;
    edge: ProjectGraphCallSite | ProjectReferenceTarget;
  }>;
};

export async function readIndexedProjectReferences(
  pool: Pool,
  options: ProjectReferenceQuery,
): Promise<WorkflowProjectReferencesResponse> {
  if (!options.relativePath && !options.expectedProjectId) throw createHttpError(400, 'Project identity is required');
  const [row] = await queryReferences<ReferenceRow>(
    pool,
    INCOMING_REFERENCE_SQL,
    [
      options.relativePath ?? null,
      options.expectedProjectId ?? null,
      options.graphIds ?? null,
      PROJECT_REFERENCE_SUMMARY_VERSION,
    ],
    options.signal,
  );
  if (!row?.target) throw createHttpError(404, 'Project not found');
  if (options.expectedProjectId && row.target.workflow_id !== options.expectedProjectId)
    throw createHttpError(409, 'The selected project changed. Reopen Project settings.');
  const truncated = row.truncated || row.matches.length > 1000;
  const reasons = new Set(row.issues);
  if (row.target_issue) reasons.add(row.target_issue);
  if (truncated) reasons.add('result-limit');
  const result: WorkflowProjectReferencesResponse = {
    projectId: row.target.workflow_id,
    references: [],
    checkedProjects: row.checked,
    totalProjects: row.total,
    complete: reasons.size === 0 && row.checked === row.total,
    changedDuringScan: false,
    unreadableProjects: row.unreadable,
    incompleteReasons: [...reasons],
    ...(options.graphIds ? { graphReferences: [], graphReferencesTruncated: truncated } : {}),
  };
  const callers = new Map<string, WorkflowProjectReferencesResponse['references'][number]>();
  for (const match of row.matches.slice(0, 1000)) {
    const source = { kind: match.kind, ...(match.label !== null ? { label: match.label } : {}) };
    let caller = callers.get(match.workflow_id);
    if (!caller) {
      caller = { projectId: match.workflow_id, name: match.name, relativePath: match.relative_path, sources: [] };
      callers.set(match.workflow_id, caller);
    }
    let callerSource = caller.sources.find((item) => item.kind === source.kind && item.label === source.label);
    if (!callerSource) {
      callerSource = { ...source, targetVersions: [] };
      caller.sources.push(callerSource);
    }
    const edge = match.edge;
    const version = 'targetVersion' in edge ? edge.targetVersion : edge.version;
    if (!callerSource.targetVersions.includes(version)) callerSource.targetVersions.push(version);
    callerSource.targetVersions.sort();
    if ('targetVersion' in edge && result.graphReferences)
      result.graphReferences.push({
        ...edge,
        projectId: match.workflow_id,
        projectName: match.name,
        relativePath: match.relative_path,
        source,
      });
  }
  result.references = [...callers.values()];
  return result;
}
