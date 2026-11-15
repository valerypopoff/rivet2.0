import type { WorkflowRecordingPageQuery } from '../data-backend.js';
import type {
  WorkflowRecordingRunsPageResponse,
  WorkflowRecordingRunSummary,
} from '@valerypopoff/rivet-studio-server-shared/workflow-recording-types.js';
import { recordingWorkflowScopeClause } from '../recording-workflow-scope.js';
import { evidenceSummary, type EvidenceRow } from './recording-evidence.js';
import type { RecordingRow } from './types.js';
import type { ManagedWorkflowContext } from './context.js';

function missingClause(query: WorkflowRecordingPageQuery) {
  const childScope = ['children', 'family-children', 'project-family-children'].includes(query.runScope ?? '');
  const project = childScope
    ? `e.input_json->>'rootId'=$1`
    : query.workflowId
      ? `(e.workflow_id=$1 OR ($2 AND e.input_json->>'rootId' IN
        (SELECT recording_id FROM workflow_recordings WHERE workflow_id=$1 UNION SELECT run_id FROM workflow_run_evidence WHERE workflow_id=$1)))`
      : "($1='' OR e.workflow_id=$1)";
  return `${project} AND e.availability NOT IN ('available','deleted')
    AND NOT EXISTS(SELECT 1 FROM workflow_recordings recorded WHERE recorded.recording_id=e.run_id)
    ${query.runScope === 'roots' ? "AND COALESCE(e.input_json->'executionIdentity'->>'surface','')<>'subgraph_project'" : ''}
    ${query.statusFilter === 'failed' ? "AND e.state IN ('failed','suspicious')" : ''}`;
}
export async function missingRecordingCount(context: ManagedWorkflowContext, query: WorkflowRecordingPageQuery) {
  const result = await context.db.queryOne<{ count: number }>(
    context.pool,
    `SELECT COUNT(*)::integer AS count FROM workflow_run_evidence e
    WHERE ${missingClause(query)} AND ($2::boolean OR NOT $2::boolean)`,
    [query.workflowId, !!query.includeSubgraphRuns],
    query.signal,
  );
  return result?.count ?? 0;
}
export async function listRecordingHistory(
  context: ManagedWorkflowContext,
  query: WorkflowRecordingPageQuery,
  toSummary: (row: RecordingRow) => WorkflowRecordingRunSummary,
): Promise<WorkflowRecordingRunsPageResponse> {
  const page = Math.max(1, query.page),
    pageSize = Math.min(100, Math.max(1, query.pageSize));
  let normalScope = recordingWorkflowScopeClause(
    query.workflowId,
    !!query.includeSubgraphRuns,
    'managed',
    1,
    query.runScope,
    query.statusFilter,
  );
  if (['children', 'family-children', 'project-family-children'].includes(query.runScope ?? ''))
    normalScope = `(${normalScope} OR r.recording_id IN (SELECT run_id FROM workflow_run_evidence
      WHERE input_json->>'rootId'=$1 AND availability='available'))`;
  const status = query.statusFilter === 'failed' ? "AND r.status IN ('failed','suspicious')" : '';
  const familyEvidence =
    query.runScope === 'families'
      ? `AND NOT EXISTS (
    SELECT 1 FROM workflow_run_evidence child JOIN workflow_run_evidence e ON e.run_id=child.input_json->>'rootId'
    WHERE child.run_id=r.recording_id AND ${missingClause(query)})`
      : '';
  const row = await context.db.queryOne<{
    total: number;
    playable: number;
    rows: Array<{ recording: RecordingRow | null; evidence: EvidenceRow | null }>;
  }>(
    context.pool,
    `
    WITH normal AS (SELECT r.recording_id AS id,r.created_at FROM workflow_recordings r WHERE ${normalScope} ${status} ${familyEvidence}),
    missing AS (SELECT e.run_id AS id,e.created_at,e.input_json->>'rootId' AS root_id FROM workflow_run_evidence e
      WHERE ${missingClause(query)} AND ($2::boolean OR NOT $2::boolean)),
    visible_missing AS (SELECT * FROM missing e ${
      query.runScope === 'families'
        ? `WHERE e.root_id IS NULL OR
      (NOT EXISTS(SELECT 1 FROM normal parent WHERE parent.id=e.root_id)
       AND NOT EXISTS(SELECT 1 FROM missing parent WHERE parent.id=e.root_id))`
        : ''
    }),
    history AS (
      SELECT id,created_at FROM normal UNION ALL SELECT id,created_at FROM visible_missing),
    paged AS (SELECT * FROM history ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4)
    SELECT (SELECT COUNT(*)::integer FROM history) AS total,(SELECT COUNT(*)::integer FROM normal) AS playable,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('recording',CASE WHEN r IS NULL THEN NULL ELSE
        to_jsonb(r)||jsonb_build_object('has_sub_runs',EXISTS(SELECT 1 FROM workflow_run_evidence child
          WHERE child.input_json->>'rootId'=p.id AND child.availability<>'deleted') OR
          (COALESCE(r.execution_surface,'')<>'subgraph_project' AND
            EXISTS(SELECT 1 FROM workflow_recordings child WHERE child.execution_surface='subgraph_project'
              AND child.correlation_id=r.correlation_id AND COALESCE(r.correlation_id,'')<>'')
            AND (SELECT COUNT(*) FROM workflow_recordings primary_run WHERE primary_run.correlation_id=r.correlation_id
              AND COALESCE(primary_run.execution_surface,'')<>'subgraph_project')=1)) END,'evidence',
        CASE WHEN e IS NULL THEN NULL ELSE (to_jsonb(e)-ARRAY['token','manifest_json','fingerprint'])||
          jsonb_build_object('has_sub_runs',EXISTS(SELECT 1 FROM workflow_run_evidence child
            WHERE child.input_json->>'rootId'=p.id AND child.availability<>'deleted')) END)
        ORDER BY p.created_at DESC,p.id DESC) FROM paged p
        LEFT JOIN workflow_recordings r ON r.recording_id=p.id LEFT JOIN workflow_run_evidence e ON e.run_id=p.id),'[]'::jsonb) AS rows`,
    [query.workflowId, !!query.includeSubgraphRuns, pageSize, (page - 1) * pageSize],
    query.signal,
  );
  if (!row) throw new Error('Recording history query returned no result.');
  const runs = row.rows.map(({ recording, evidence }): WorkflowRecordingRunSummary => {
    if (recording) {
      const summary = toSummary(recording);
      if (evidence) summary.evidence = { availability: 'available', childCoverage: evidence.child_coverage };
      return summary;
    }
    const e = evidenceSummary(evidence!);
    return {
      id: e.id,
      workflowId: e.projectId,
      sourceProjectName: e.sourceProjectName,
      hasSubRuns: !!evidence?.has_sub_runs,
      sourceProjectRelativePath: e.sourceProjectRelativePath,
      createdAt: e.createdAt,
      runKind: e.runKind,
      status: e.state,
      durationMs: e.durationMs ?? -1,
      cost: e.cost,
      endpointNameAtExecution: e.endpointName,
      executionIdentity: e.executionIdentity,
      hasReplayDataset: false,
      recordingCompressedBytes: 0,
      recordingUncompressedBytes: 0,
      projectCompressedBytes: 0,
      projectUncompressedBytes: 0,
      datasetCompressedBytes: 0,
      datasetUncompressedBytes: 0,
      evidence: { availability: e.availability, reason: e.reason, childCoverage: e.childCoverage },
    };
  });
  return {
    workflowId: query.workflowId,
    page,
    pageSize,
    statusFilter: query.statusFilter ?? 'all',
    totalRuns: row.total,
    playableRuns: row.playable,
    hasMore: page * pageSize < row.total,
    runs,
  };
}
