import type {
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTarget,
  WorkflowRecordingExecutionIdentity,
} from '../../../../studio-server-shared/workflow-recording-types.js';
import type { WorkflowRecordingStatisticsRow } from './recording-statistics.js';

type Dialect = 'sqlite' | 'postgres';
export type RecordingStatisticsSqlRow = {
  workflow_id: string;
  source_project_name: string;
  created_at: string | Date;
  recording_id: string;
  run_kind: WorkflowRecordingStatisticsRow['runKind'];
  status: WorkflowRecordingStatisticsRow['status'];
  duration_ms: number;
  endpoint_name_at_execution: string;
  execution_surface: WorkflowRecordingExecutionIdentity['surface'] | null;
  ui_graph_id_at_execution: string | null;
  component_id_at_execution: string | null;
  ui_graph_name_at_execution: string | null;
  component_type_at_execution: 'button' | 'chat' | null;
  component_label_at_execution: string | null;
  metadata_valid: number;
  total_runs?: number | string;
};

/** A compact, common projection; artifact references and payloads never cross this boundary. */
function source(dialect: Dialect): string {
  if (dialect === 'postgres')
    return `SELECT recording_id, workflow_id, source_project_name, created_at, run_kind,
      status, duration_ms, endpoint_name_at_execution, execution_surface,
      ui_graph_id_at_execution, component_id_at_execution, ui_graph_name_at_execution,
      component_type_at_execution, component_label_at_execution, 1 AS metadata_valid
      FROM workflow_recordings`;
  const field = (name: string) => `json_extract(data, '$.${name}')`;
  return `SELECT recording_id, workflow_id,
    ${field('sourceProjectName')} AS source_project_name, ${field('createdAt')} AS created_at,
    ${field('runKind')} AS run_kind, ${field('status')} AS status,
    ${field('durationMs')} AS duration_ms, ${field('endpointName')} AS endpoint_name_at_execution,
    ${field('executionIdentity.surface')} AS execution_surface,
    ${field('executionIdentity.uiGraphId')} AS ui_graph_id_at_execution,
    ${field('executionIdentity.componentId')} AS component_id_at_execution,
    ${field('executionIdentity.uiGraphName')} AS ui_graph_name_at_execution,
    ${field('executionIdentity.componentType')} AS component_type_at_execution,
    ${field('executionIdentity.componentLabel')} AS component_label_at_execution,
    COALESCE(${field('recordingId')} = recording_id AND ${field('workflowId')} = workflow_id
      AND json_type(data, '$.recordingId') = 'text' AND json_type(data, '$.workflowId') = 'text'
      AND json_type(data, '$.createdAt') = 'text'
      AND substr(${field('createdAt')}, 12, 2) BETWEEN '00' AND '23'
      AND ${field('createdAt')} = strftime('%Y-%m-%dT%H:%M:%fZ', ${field('createdAt')})
      AND ${field('runKind')} IN ('published', 'latest', 'editor')
      AND ${field('status')} IN ('succeeded', 'failed', 'suspicious')
      AND json_type(data, '$.durationMs') IN ('integer', 'real') AND ${field('durationMs')} >= 0
      AND json_type(data, '$.sourceProjectName') = 'text'
      AND json_type(data, '$.endpointName') = 'text', 0) AS metadata_valid
    FROM (SELECT recording_id, workflow_id, metadata_json AS data FROM recordings)`;
}

/** Match the shared statistics target semantics, including pre-identity web-app recordings. */
export function recordingStatisticsTargetSql(target: WorkflowRunStatisticsTarget): {
  clause: string;
  values: string[];
} {
  const stable =
    "execution_surface = 'web_app_action' AND COALESCE(ui_graph_id_at_execution, '') <> '' AND COALESCE(component_id_at_execution, '') <> ''";
  if (target.surface === 'endpoint')
    return {
      clause:
        "workflow_id = ? AND (execution_surface = 'workflow_endpoint' OR (execution_surface IS NULL AND endpoint_name_at_execution NOT LIKE '/%'))",
      values: [target.workflowId],
    };
  if ('legacyEndpointName' in target)
    return {
      clause: `workflow_id = ? AND ((execution_surface IS NULL AND endpoint_name_at_execution LIKE '/%')
        OR (execution_surface = 'web_app_action' AND NOT (${stable}))) AND endpoint_name_at_execution = ?`,
      values: [target.workflowId, target.legacyEndpointName],
    };
  return {
    clause: `workflow_id = ? AND ${stable} AND ui_graph_id_at_execution = ? AND component_id_at_execution = ?`,
    values: [target.workflowId, target.uiGraphId, target.componentId],
  };
}

function bind(sql: string, dialect: Dialect): string {
  let index = 0;
  return dialect === 'sqlite' ? sql : sql.replace(/\?/g, () => `$${++index}`);
}

export function recordingStatisticsRowsSql(dialect: Dialect, query: WorkflowRunStatisticsQuery) {
  const target = recordingStatisticsTargetSql(query.target);
  return {
    sql: bind(
      `WITH source AS (${source(dialect)}) SELECT * FROM source
      WHERE created_at >= ?${dialect === 'postgres' ? '::timestamptz' : ''}
        AND created_at < ?${dialect === 'postgres' ? '::timestamptz' : ''}
        AND ${target.clause} ${query.runKind === 'both' ? '' : 'AND run_kind = ?'}
      ORDER BY created_at ASC, recording_id ASC`,
      dialect,
    ),
    values: [
      query.period.from,
      query.period.to,
      ...target.values,
      ...(query.runKind === 'both' ? [] : [query.runKind]),
    ],
  };
}

/** One row per target, with exact counts and latest non-null labels, in either SQL engine. */
export function recordingStatisticsCatalogSql(dialect: Dialect, surface: WorkflowRunStatisticsSurface) {
  const stable =
    "execution_surface = 'web_app_action' AND COALESCE(ui_graph_id_at_execution, '') <> '' AND COALESCE(component_id_at_execution, '') <> ''";
  const legacy = `(execution_surface IS NULL AND endpoint_name_at_execution LIKE '/%') OR
    (execution_surface = 'web_app_action' AND NOT (${stable}))`;
  const partition = 'workflow_id, target_surface, target_ui, target_component, target_legacy';
  const latest = 'created_at DESC, recording_id DESC';
  const labels = ['ui_graph_name_at_execution', 'component_type_at_execution', 'component_label_at_execution'];
  return {
    sql: bind(
      `WITH source AS (${source(dialect)}), targets AS (
      SELECT *, CASE WHEN execution_surface IN ('editor_local', 'subgraph_project', 'scheduled') THEN NULL
        WHEN ${stable} OR ${legacy} THEN 'web_app' ELSE 'endpoint' END AS target_surface,
        CASE WHEN ${stable} THEN ui_graph_id_at_execution END AS target_ui,
        CASE WHEN ${stable} THEN component_id_at_execution END AS target_component,
        CASE WHEN ${legacy} THEN endpoint_name_at_execution END AS target_legacy FROM source
    ), ranked AS (
      SELECT *, COUNT(*) OVER (PARTITION BY ${partition}) AS total_runs,
        ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${latest}) AS position,
        MIN(metadata_valid) OVER (PARTITION BY ${partition}) AS group_valid,
        ${labels
          .map(
            (field) => `FIRST_VALUE(${field}) OVER (PARTITION BY ${partition}
          ORDER BY CASE WHEN ${field} IS NULL THEN 1 ELSE 0 END, ${latest}) AS latest_${field}`,
          )
          .join(', ')}
      FROM targets WHERE target_surface = ? OR metadata_valid <> 1
    ) SELECT recording_id, workflow_id, source_project_name, created_at, run_kind, status, duration_ms,
      endpoint_name_at_execution,
      CASE WHEN target_surface = 'web_app' THEN 'web_app_action' ELSE 'workflow_endpoint' END AS execution_surface,
      target_ui AS ui_graph_id_at_execution, target_component AS component_id_at_execution,
      ${labels.map((field) => `latest_${field} AS ${field}`).join(', ')},
      group_valid AS metadata_valid, total_runs FROM ranked WHERE position = 1`,
      dialect,
    ),
    values: [surface],
  };
}

export function statisticsSqlRow(
  row: RecordingStatisticsSqlRow,
): WorkflowRecordingStatisticsRow & { totalRuns?: number } {
  if (row.metadata_valid !== 1 || !Number.isFinite(row.duration_ms) || row.duration_ms < 0)
    throw new Error('Recording statistics metadata is inconsistent.');
  const totalRuns = row.total_runs === undefined ? undefined : Number(row.total_runs);
  if (totalRuns !== undefined && (!Number.isSafeInteger(totalRuns) || totalRuns < 1))
    throw new Error('Recording statistics count is invalid.');
  return {
    workflowId: row.workflow_id,
    sourceProjectName: row.source_project_name,
    createdAt: new Date(row.created_at).toISOString(),
    runKind: row.run_kind,
    status: row.status,
    durationMs: row.duration_ms,
    endpointNameAtExecution: row.endpoint_name_at_execution,
    executionIdentity: row.execution_surface
      ? {
          surface: row.execution_surface,
          uiGraphId: row.ui_graph_id_at_execution ?? undefined,
          componentId: row.component_id_at_execution ?? undefined,
          uiGraphName: row.ui_graph_name_at_execution ?? undefined,
          componentType: row.component_type_at_execution ?? undefined,
          componentLabel: row.component_label_at_execution ?? undefined,
        }
      : undefined,
    totalRuns,
  };
}
