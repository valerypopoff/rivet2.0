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
}) {
  const deleteBlobKeys = async (keys: Array<string | null | undefined>): Promise<void> => {
    await Promise.all(keys.map((key) => options.blobStore.delete(key)));
  };

  const deleteBlobKeysBestEffort = async (context: string, keys: Array<string | null | undefined>): Promise<void> => {
    const deletions = await Promise.allSettled([deleteBlobKeys(keys)]);
    const rejected = deletions.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      console.error(`[managed-workflows] Failed to clean up blob objects after ${context}:`, rejected.reason);
    }
  };

  const scheduleRevisionBlobCleanup = (
    hooks: TransactionHooks,
    revision: Pick<RevisionRow, 'project_blob_key' | 'dataset_blob_key'>,
  ): void => {
    hooks.onRollback(() => deleteBlobKeysBestEffort('transaction rollback', [
      revision.project_blob_key,
      revision.dataset_blob_key,
    ]));
  };

  const readRevisionProjectContents = async (revision: Pick<RevisionRow, 'project_blob_key'>): Promise<string> => {
    return options.blobStore.getText(revision.project_blob_key);
  };

  return {
    deleteBlobKeysBestEffort,
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
      const datasetBlobKey = datasetsContents != null
        ? createRevisionBlobKey(workflowId, revisionId, 'dataset')
        : null;
      const stats = getWorkflowProjectStatsFromContents(contents);

      await options.blobStore.putText(projectBlobKey, contents, 'application/x-yaml; charset=utf-8');
      try {
        if (datasetBlobKey && datasetsContents != null) {
          await options.blobStore.putText(datasetBlobKey, datasetsContents, 'text/plain; charset=utf-8');
        }
      } catch (error) {
        await deleteBlobKeysBestEffort('revision upload rollback', [projectBlobKey, datasetBlobKey]);
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
      const replayDatasetBlobKey = artifacts.replayDataset != null
        ? createRecordingBlobKey(workflowId, recordingId, 'replay-dataset')
        : null;

      try {
        await Promise.all([
          options.blobStore.putText(recordingBlobKey, artifacts.recording, 'text/plain; charset=utf-8'),
          options.blobStore.putText(replayProjectBlobKey, artifacts.replayProject, 'application/x-yaml; charset=utf-8'),
          replayDatasetBlobKey != null && artifacts.replayDataset != null
            ? options.blobStore.putText(replayDatasetBlobKey, artifacts.replayDataset, 'text/plain; charset=utf-8')
            : Promise.resolve(),
        ]);
      } catch (error) {
        await deleteBlobKeysBestEffort(cleanupContext, [
          recordingBlobKey,
          replayProjectBlobKey,
          replayDatasetBlobKey,
        ]);
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
      const valuesClause = options.timestampMode === 'provided'
        ? 'VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)'
        : 'VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)';
      const params = options.timestampMode === 'provided'
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
        await deleteBlobKeysBestEffort(options.cleanupContext, [
          row.recordingBlobKey,
          row.replayProjectBlobKey,
          row.replayDatasetBlobKey,
        ]);
        throw error;
      }
    },
  };
}
