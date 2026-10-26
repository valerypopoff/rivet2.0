import type { PoolClient } from 'pg';
import { conflict } from '../../../utils/httpError.js';
import type { ManagedWorkflowContext } from './context.js';
import type { RecordingRow, RevisionRow, TransactionHooks, WorkflowRow } from './types.js';

/** Caller holds the topology lease and the workflow row FOR UPDATE. */
export async function deleteManagedWorkflowProject(
  context: Pick<ManagedWorkflowContext, 'db' | 'mappers' | 'maintenance' | 'executionInvalidationController'>,
  client: PoolClient,
  hooks: TransactionHooks,
  workflow: WorkflowRow,
) {
  const publishedWebApps = await client.query('SELECT 1 FROM workflow_web_apps WHERE workflow_id = $1 LIMIT 1', [
    workflow.workflow_id,
  ]);
  if (
    workflow.published_revision_id ||
    workflow.published_version_id ||
    workflow.published_endpoint_name ||
    publishedWebApps.rows.length > 0
  )
    throw conflict(`Unpublish the workflow endpoint and web apps before deleting the project: ${workflow.name}`);
  const revisions = await context.db.queryRows<RevisionRow>(
    client,
    `
    SELECT revision_id, workflow_id, project_blob_key, dataset_blob_key, stats_graph_count, stats_total_node_count, stats_web_app_count, created_at
    FROM workflow_revisions WHERE workflow_id = $1
  `,
    [workflow.workflow_id],
  );
  const recordings = await context.db.queryRows<RecordingRow>(
    client,
    `
    SELECT ${context.mappers.RECORDING_COLUMNS} FROM workflow_recordings WHERE workflow_id = $1
  `,
    [workflow.workflow_id],
  );
  await client.query('DELETE FROM llm_profile_health WHERE project_id = $1', [workflow.workflow_id]);
  await client.query('DELETE FROM workflows WHERE workflow_id = $1', [workflow.workflow_id]);
  // Recordings outlive their source project. GC keeps referenced replay artifacts
  // until normal recording retention releases them.
  await context.maintenance.enqueueObjectDeletions(client, 'workflow-project-deletion', [
    ...revisions.flatMap((revision) => [revision.project_blob_key, revision.dataset_blob_key]),
    ...recordings.flatMap((recording) => [
      recording.recording_blob_key,
      recording.replay_project_blob_key,
      recording.replay_dataset_blob_key,
    ]),
  ]);
  await context.executionInvalidationController.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
}
