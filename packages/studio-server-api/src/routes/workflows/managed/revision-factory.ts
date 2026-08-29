import { Pool, type PoolClient } from 'pg';

import {
  createManagedRevisionId,
  createRecordingBlobKey,
  createRevisionBlobKey,
  type ManagedWorkflowBlobStore,
} from './blob-store.js';
import { withManagedDbRetry, type ManagedWorkflowDbClient } from './db.js';
import { RECORDING_COLUMNS } from './mappers.js';
import { resolveManagedHostedProjectSaveTarget } from './save-target.js';
import { getWorkflowProjectStatsFromContents } from '../project-stats.js';
import type {
  ManagedRevisionContents,
  RecordingBlobArtifacts,
  RecordingBlobKeys,
  RecordingInsertRowData,
  RevisionRow,
  TransactionHooks,
} from './types.js';

export { resolveManagedHostedProjectSaveTarget };

export function createManagedWorkflowRevisionFactory(options: {
  blobStore: ManagedWorkflowBlobStore;
  /**
   * Used only for objects that this request created but failed to attach to
   * durable metadata. The maintenance worker rechecks references before it
   * deletes, so an unexpected duplicate-key error cannot erase a live blob.
   */
  queueObjectDeletions: (domain: string, keys: Array<string | null | undefined>) => Promise<void>;
}) {
  const queueKnownBlobCleanup = async (context: string, keys: Array<string | null | undefined>): Promise<void> => {
    const objectKeys = [
      ...new Set(
        keys.flatMap((key) => {
          const normalized = key?.trim();
          return normalized ? [normalized] : [];
        }),
      ),
    ];
    if (objectKeys.length === 0) return;

    try {
      // Never fall back to an unchecked direct delete when PostgreSQL is
      // unavailable. Keeping a rare orphan is safer than deleting an object
      // that a concurrent or duplicate row may already reference;
      // reconciliation can inventory the former.
      await options.queueObjectDeletions('workflow-precommit-blob-cleanup', objectKeys);
    } catch (error) {
      console.error(
        `[managed-workflows] Failed to durably queue pre-commit blob cleanup after ${context}; leaving the objects untouched for reconciliation:`,
        error,
      );
    }
  };

  const scheduleRevisionBlobCleanup = (
    hooks: TransactionHooks,
    revision: Pick<RevisionRow, 'project_blob_key' | 'dataset_blob_key'>,
  ): void => {
    hooks.onRollback(() =>
      queueKnownBlobCleanup('transaction rollback', [revision.project_blob_key, revision.dataset_blob_key]),
    );
  };

  const readRevisionProjectContents = async (revision: Pick<RevisionRow, 'project_blob_key'>): Promise<string> => {
    return options.blobStore.getText(revision.project_blob_key);
  };

  return {
    scheduleRevisionBlobCleanup,

    readRevisionProjectContents,

    async readRevisionContents(revision: RevisionRow): Promise<ManagedRevisionContents> {
      const [contents, datasetsContents] = await Promise.all([
        readRevisionProjectContents(revision),
        revision.dataset_blob_key ? options.blobStore.getText(revision.dataset_blob_key) : Promise.resolve(null),
      ]);

      return {
        contents,
        datasetsContents,
      };
    },

    async createRevision(workflowId: string, contents: string, datasetsContents: string | null): Promise<RevisionRow> {
      const revisionId = createManagedRevisionId();
      const projectBlobKey = createRevisionBlobKey(workflowId, revisionId, 'project');
      const datasetBlobKey = datasetsContents != null ? createRevisionBlobKey(workflowId, revisionId, 'dataset') : null;
      const stats = getWorkflowProjectStatsFromContents(contents);

      await options.blobStore.putText(projectBlobKey, contents, 'application/x-yaml; charset=utf-8');
      try {
        if (datasetBlobKey && datasetsContents != null) {
          await options.blobStore.putText(datasetBlobKey, datasetsContents, 'text/plain; charset=utf-8');
        }
      } catch (error) {
        await queueKnownBlobCleanup('revision upload rollback', [projectBlobKey, datasetBlobKey]);
        throw error;
      }

      return {
        revision_id: revisionId,
        workflow_id: workflowId,
        project_blob_key: projectBlobKey,
        dataset_blob_key: datasetBlobKey,
        stats_graph_count: stats.graphCount,
        stats_total_node_count: stats.totalNodeCount,
        stats_web_app_count: stats.webAppCount,
        created_at: new Date(),
      };
    },

    async insertRevision(client: PoolClient, revision: RevisionRow): Promise<void> {
      await client.query(
        `
          INSERT INTO workflow_revisions (
            revision_id, workflow_id, project_blob_key, dataset_blob_key,
            stats_graph_count, stats_total_node_count, stats_web_app_count, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `,
        [
          revision.revision_id,
          revision.workflow_id,
          revision.project_blob_key,
          revision.dataset_blob_key,
          revision.stats_graph_count,
          revision.stats_total_node_count,
          revision.stats_web_app_count,
        ],
      );
    },

    async uploadRecordingBlobs(
      workflowId: string,
      recordingId: string,
      artifacts: RecordingBlobArtifacts,
      cleanupContext: string,
    ): Promise<RecordingBlobKeys> {
      const recordingBlobKey = createRecordingBlobKey(workflowId, recordingId, 'recording');
      const replayProjectBlobKey = createRecordingBlobKey(workflowId, recordingId, 'replay-project');
      const replayDatasetBlobKey =
        artifacts.replayDataset != null ? createRecordingBlobKey(workflowId, recordingId, 'replay-dataset') : null;

      try {
        await Promise.all([
          options.blobStore.putText(recordingBlobKey, artifacts.recording, 'text/plain; charset=utf-8'),
          options.blobStore.putText(replayProjectBlobKey, artifacts.replayProject, 'application/x-yaml; charset=utf-8'),
          replayDatasetBlobKey != null && artifacts.replayDataset != null
            ? options.blobStore.putText(replayDatasetBlobKey, artifacts.replayDataset, 'text/plain; charset=utf-8')
            : Promise.resolve(),
        ]);
      } catch (error) {
        await queueKnownBlobCleanup(cleanupContext, [recordingBlobKey, replayProjectBlobKey, replayDatasetBlobKey]);
        throw error;
      }

      return {
        recordingBlobKey,
        replayProjectBlobKey,
        replayDatasetBlobKey,
      };
    },

    async insertRecordingRow(
      client: ManagedWorkflowDbClient,
      row: RecordingInsertRowData,
      options: {
        timestampMode: 'provided' | 'now';
        createdAt?: string;
        onConflict: 'ignore' | 'fail';
        cleanupContext: string;
      },
    ): Promise<void> {
      const identity = row.executionIdentity;
      const valuesClause =
        options.timestampMode === 'provided'
          ? 'VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)'
          : 'VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)';
      const params =
        options.timestampMode === 'provided'
          ? [
              row.recordingId,
              row.workflowId,
              row.sourceProjectName,
              row.sourceProjectRelativePath,
              options.createdAt,
              row.runKind,
              row.status,
              row.durationMs,
              row.endpointNameAtExecution,
              identity?.surface ?? null,
              identity?.graphId ?? null,
              identity?.graphName ?? null,
              identity?.revisionKey ?? null,
              identity?.uiGraphId ?? null,
              identity?.uiGraphName ?? null,
              identity?.webAppSlug ?? null,
              identity?.componentId ?? null,
              identity?.componentType ?? null,
              identity?.componentLabel ?? null,
              row.errorMessage,
              row.recordingBlobKey,
              row.replayProjectBlobKey,
              row.replayDatasetBlobKey,
              row.hasReplayDataset,
              row.recordingCompressedBytes,
              row.recordingUncompressedBytes,
              row.projectCompressedBytes,
              row.projectUncompressedBytes,
              row.datasetCompressedBytes,
              row.datasetUncompressedBytes,
            ]
          : [
              row.recordingId,
              row.workflowId,
              row.sourceProjectName,
              row.sourceProjectRelativePath,
              row.runKind,
              row.status,
              row.durationMs,
              row.endpointNameAtExecution,
              identity?.surface ?? null,
              identity?.graphId ?? null,
              identity?.graphName ?? null,
              identity?.revisionKey ?? null,
              identity?.uiGraphId ?? null,
              identity?.uiGraphName ?? null,
              identity?.webAppSlug ?? null,
              identity?.componentId ?? null,
              identity?.componentType ?? null,
              identity?.componentLabel ?? null,
              row.errorMessage,
              row.recordingBlobKey,
              row.replayProjectBlobKey,
              row.replayDatasetBlobKey,
              row.hasReplayDataset,
              row.recordingCompressedBytes,
              row.recordingUncompressedBytes,
              row.projectCompressedBytes,
              row.projectUncompressedBytes,
              row.datasetCompressedBytes,
              row.datasetUncompressedBytes,
            ];
      const sql = `
        INSERT INTO workflow_recordings (${RECORDING_COLUMNS})
        ${valuesClause}
        ${options.onConflict === 'ignore' ? 'ON CONFLICT (recording_id) DO NOTHING' : ''}
      `;

      try {
        if (client instanceof Pool) {
          await withManagedDbRetry('recording insert', () => client.query(sql, params));
        } else {
          await client.query(sql, params);
        }
      } catch (error) {
        await queueKnownBlobCleanup(options.cleanupContext, [
          row.recordingBlobKey,
          row.replayProjectBlobKey,
          row.replayDatasetBlobKey,
        ]);
        throw error;
      }
    },
  };
}
