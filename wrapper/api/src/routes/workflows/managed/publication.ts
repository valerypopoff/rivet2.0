import { randomUUID } from 'node:crypto';

import type {
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../shared/workflow-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../../shared/workflow-types.js';
import { badRequest, createHttpError } from '../../../utils/httpError.js';
import { normalizeStoredEndpointName } from '../endpoint-names.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowDbClient } from './db.js';
import { toIsoString } from './mappers.js';
import type { PublishedVersionRow, RevisionRow, WorkflowRow } from './types.js';

type ManagedWorkflowPublicationServiceDependencies = {
  context: ManagedWorkflowContext;
};

function getPublishedVersionDownloadFileName(projectName: string, publishedAt: string): string {
  const timestamp = publishedAt
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-');

  return `${projectName} [published ${timestamp}].rivet-project`;
}

export function createManagedWorkflowPublicationService(options: ManagedWorkflowPublicationServiceDependencies) {
  const deps = {
    pool: options.context.pool,
    initialize: options.context.initialize,
    withTransaction: options.context.withTransaction,
    queryRows: options.context.db.queryRows,
    queryOne: options.context.db.queryOne,
    getWorkflowByRelativePath: options.context.queries.getWorkflowByRelativePath,
    getRevision: options.context.queries.getRevision,
    readRevisionContents: options.context.revisions.readRevisionContents,
    readRevisionProjectContents: options.context.revisions.readRevisionProjectContents,
    syncWorkflowEndpointRows: options.context.endpointSync.syncWorkflowEndpointRows,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    queueWorkflowInvalidation: options.context.executionInvalidationController.queueWorkflowInvalidation.bind(options.context.executionInvalidationController),
  };

  const isCurrentPublishedVersion = (workflow: WorkflowRow, versionId: string): boolean =>
    versionId === workflow.published_version_id ||
    (!workflow.published_version_id && versionId === workflow.published_revision_id);

  const normalizePublishedVersionCommentForStorage = (value: unknown): string => {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim().slice(0, WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH);
  };

  const normalizePublishedVersionCommentInput = (value: unknown): string => {
    if (typeof value !== 'string') {
      throw badRequest('Missing comment');
    }

    if (value.length > WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH) {
      throw badRequest(`Published version comment must be ${WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH} characters or fewer`);
    }

    return value.trim();
  };

  const mapPublishedVersionRowToSummary = (
    workflow: WorkflowRow,
    row: PublishedVersionRow,
  ): WorkflowPublishedVersionSummary => ({
    id: row.version_id,
    projectId: workflow.workflow_id,
    projectName: workflow.name,
    endpointName: row.endpoint_name,
    publishedAt: toIsoString(row.published_at) ?? new Date().toISOString(),
    isCurrent: isCurrentPublishedVersion(workflow, row.version_id),
    isStarred: row.is_starred === true,
    comment: normalizePublishedVersionCommentForStorage(row.comment),
  });

  const backfillLegacyPublishedVersion = async (
    client: ManagedWorkflowDbClient,
    workflow: WorkflowRow,
  ): Promise<void> => {
    if (workflow.published_version_id || !workflow.published_revision_id) {
      return;
    }

    await client.query(
      `
        INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at)
        VALUES ($1, $2, $3, $4, $5::timestamptz)
        ON CONFLICT (version_id) DO NOTHING
      `,
      [
        workflow.published_revision_id,
        workflow.workflow_id,
        workflow.published_revision_id,
        workflow.published_endpoint_name || workflow.endpoint_name,
        toIsoString(workflow.last_published_at) ?? new Date().toISOString(),
      ],
    );
  };

  const resolvePublishedVersionRevision = async (
    relativePath: unknown,
    versionId: unknown,
  ): Promise<{ projectName: string; publishedAt: string; revision: RevisionRow }> => {
    const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
    const normalizedVersionId = typeof versionId === 'string' ? versionId.trim() : '';
    if (!normalizedVersionId) {
      throw badRequest('Missing versionId');
    }

    await deps.initialize();
    const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
    if (!workflow) {
      throw createHttpError(404, 'Project not found');
    }

    const row = await deps.queryOne<PublishedVersionRow & RevisionRow>(
      deps.pool,
      `
        SELECT
          pv.version_id,
          pv.workflow_id,
          pv.revision_id,
          pv.endpoint_name,
          pv.published_at,
          pv.is_starred,
          pv.comment,
          r.project_blob_key,
          r.dataset_blob_key,
          r.stats_graph_count,
          r.stats_total_node_count,
          r.created_at
        FROM workflow_published_versions pv
        JOIN workflow_revisions r ON r.revision_id = pv.revision_id
        WHERE pv.workflow_id = $1 AND pv.version_id = $2
      `,
      [workflow.workflow_id, normalizedVersionId],
    );
    if (row) {
      return {
        projectName: workflow.name,
        publishedAt: toIsoString(row.published_at) ?? new Date().toISOString(),
        revision: row,
      };
    }

    if (
      !workflow.published_version_id &&
      workflow.published_revision_id &&
      normalizedVersionId === workflow.published_revision_id
    ) {
      const revision = await deps.getRevision(deps.pool, workflow.published_revision_id);
      if (!revision) {
        throw createHttpError(404, 'Published version not found');
      }

      return {
        projectName: workflow.name,
        publishedAt: toIsoString(workflow.last_published_at) ??
          toIsoString(revision.created_at) ??
          new Date().toISOString(),
        revision,
      };
    }

    throw createHttpError(404, 'Published version not found');
  };

  return {
    async listWorkflowPublishedVersions(relativePath: unknown): Promise<WorkflowPublishedVersionsResponse> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      await deps.initialize();

      const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const rows = await deps.queryRows<PublishedVersionRow>(
        deps.pool,
        `
          SELECT version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
          FROM workflow_published_versions
          WHERE workflow_id = $1
          ORDER BY published_at DESC, version_id DESC
        `,
        [workflow.workflow_id],
      );
      const versions: WorkflowPublishedVersionSummary[] = rows.map((row) =>
        mapPublishedVersionRowToSummary(workflow, row));

      if (
        !workflow.published_version_id &&
        workflow.published_revision_id &&
        !versions.some((version) => version.id === workflow.published_revision_id)
      ) {
        versions.unshift({
          id: workflow.published_revision_id,
          projectId: workflow.workflow_id,
          projectName: workflow.name,
          endpointName: workflow.published_endpoint_name || workflow.endpoint_name,
          publishedAt: toIsoString(workflow.last_published_at) ?? new Date().toISOString(),
          isCurrent: true,
          isStarred: false,
          comment: '',
        });
      }

      return {
        versions,
      };
    },

    async readWorkflowPublishedVersionDownload(relativePath: unknown, versionId: unknown): Promise<{ contents: string; fileName: string }> {
      const { projectName, publishedAt, revision } = await resolvePublishedVersionRevision(relativePath, versionId);
      return {
        contents: await deps.readRevisionProjectContents(revision),
        fileName: getPublishedVersionDownloadFileName(projectName, publishedAt),
      };
    },

    async readWorkflowPublishedVersionPreview(
      relativePath: unknown,
      versionId: unknown,
    ): Promise<WorkflowPublishedVersionPreviewResponse> {
      const { revision } = await resolvePublishedVersionRevision(relativePath, versionId);
      const contents = await deps.readRevisionContents(revision);
      return {
        contents: contents.contents,
        datasetsContents: contents.datasetsContents,
      };
    },

    async setWorkflowPublishedVersionStar(
      relativePath: unknown,
      versionId: unknown,
      isStarred: unknown,
    ): Promise<WorkflowPublishedVersionSummary> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedVersionId = typeof versionId === 'string' ? versionId.trim() : '';
      if (!normalizedVersionId) {
        throw badRequest('Missing versionId');
      }

      if (typeof isStarred !== 'boolean') {
        throw badRequest('Missing isStarred');
      }

      await deps.initialize();
      const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const updatedRow = await deps.queryOne<PublishedVersionRow>(
        deps.pool,
        `
          UPDATE workflow_published_versions
          SET is_starred = $3
          WHERE workflow_id = $1 AND version_id = $2
          RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
        `,
        [workflow.workflow_id, normalizedVersionId, isStarred],
      );

      if (updatedRow) {
        return mapPublishedVersionRowToSummary(workflow, updatedRow);
      }

      if (
        !workflow.published_version_id &&
        workflow.published_revision_id &&
        normalizedVersionId === workflow.published_revision_id
      ) {
        const revision = await deps.getRevision(deps.pool, workflow.published_revision_id);
        if (!revision) {
          throw createHttpError(404, 'Published version not found');
        }

        const insertedRow = await deps.queryOne<PublishedVersionRow>(
          deps.pool,
          `
            INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred)
            VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
            ON CONFLICT (version_id) DO UPDATE
              SET is_starred = EXCLUDED.is_starred
              WHERE workflow_published_versions.workflow_id = EXCLUDED.workflow_id
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
          `,
          [
            workflow.published_revision_id,
            workflow.workflow_id,
            revision.revision_id,
            workflow.published_endpoint_name || workflow.endpoint_name,
            toIsoString(workflow.last_published_at) ?? toIsoString(revision.created_at) ?? new Date().toISOString(),
            isStarred,
          ],
        );

        if (insertedRow) {
          return mapPublishedVersionRowToSummary(workflow, insertedRow);
        }
      }

      throw createHttpError(404, 'Published version not found');
    },

    async setWorkflowPublishedVersionComment(
      relativePath: unknown,
      versionId: unknown,
      comment: unknown,
    ): Promise<WorkflowPublishedVersionSummary> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedVersionId = typeof versionId === 'string' ? versionId.trim() : '';
      if (!normalizedVersionId) {
        throw badRequest('Missing versionId');
      }

      const normalizedComment = normalizePublishedVersionCommentInput(comment);

      await deps.initialize();
      const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const updatedRow = await deps.queryOne<PublishedVersionRow>(
        deps.pool,
        `
          UPDATE workflow_published_versions
          SET comment = $3
          WHERE workflow_id = $1 AND version_id = $2
          RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
        `,
        [workflow.workflow_id, normalizedVersionId, normalizedComment],
      );

      if (updatedRow) {
        return mapPublishedVersionRowToSummary(workflow, updatedRow);
      }

      if (
        !workflow.published_version_id &&
        workflow.published_revision_id &&
        normalizedVersionId === workflow.published_revision_id
      ) {
        const revision = await deps.getRevision(deps.pool, workflow.published_revision_id);
        if (!revision) {
          throw createHttpError(404, 'Published version not found');
        }

        const insertedRow = await deps.queryOne<PublishedVersionRow>(
          deps.pool,
          `
            INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at, comment)
            VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
            ON CONFLICT (version_id) DO UPDATE
              SET comment = EXCLUDED.comment
              WHERE workflow_published_versions.workflow_id = EXCLUDED.workflow_id
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
          `,
          [
            workflow.published_revision_id,
            workflow.workflow_id,
            revision.revision_id,
            workflow.published_endpoint_name || workflow.endpoint_name,
            toIsoString(workflow.last_published_at) ?? toIsoString(revision.created_at) ?? new Date().toISOString(),
            normalizedComment,
          ],
        );

        if (insertedRow) {
          return mapPublishedVersionRowToSummary(workflow, insertedRow);
        }
      }

      throw createHttpError(404, 'Published version not found');
    },

    async restoreWorkflowPublishedVersion(
      relativePath: unknown,
      versionId: unknown,
    ): Promise<WorkflowPublishedVersionRestoreResponse> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedVersionId = typeof versionId === 'string' ? versionId.trim() : '';
      if (!normalizedVersionId) {
        throw badRequest('Missing versionId');
      }

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const versionRow = await deps.queryOne<PublishedVersionRow>(
          client,
          `
            SELECT version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
            FROM workflow_published_versions
            WHERE workflow_id = $1 AND version_id = $2
          `,
          [workflow.workflow_id, normalizedVersionId],
        );

        let revisionId = versionRow?.revision_id ?? null;
        let endpointName = versionRow?.endpoint_name ?? '';

        if (!revisionId) {
          if (
            !workflow.published_version_id &&
            workflow.published_revision_id &&
            normalizedVersionId === workflow.published_revision_id
          ) {
            const legacyRevision = await deps.getRevision(client, workflow.published_revision_id);
            if (!legacyRevision) {
              throw createHttpError(404, 'Published version not found');
            }

            revisionId = legacyRevision.revision_id;
            endpointName = workflow.published_endpoint_name || workflow.endpoint_name;
          } else {
            throw createHttpError(404, 'Published version not found');
          }
        }

        if (!endpointName) {
          throw createHttpError(400, 'Published version does not have an endpoint name');
        }

        const restoredVersionId = randomUUID();
        await backfillLegacyPublishedVersion(client, workflow);

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: endpointName,
          publishedEndpointName: endpointName,
        });

        const restoredVersion = await deps.queryOne<PublishedVersionRow>(
          client,
          `
            INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment
          `,
          [restoredVersionId, workflow.workflow_id, revisionId, endpointName],
        );
        if (!restoredVersion) {
          throw createHttpError(500, 'Restored published version could not be created');
        }

        await client.query(
          `
            UPDATE workflows
            SET current_draft_revision_id = $2,
                published_revision_id = $2,
                published_version_id = $3,
                endpoint_name = $4,
                published_endpoint_name = $4,
                last_published_at = NOW(),
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id, revisionId, restoredVersionId, endpointName],
        );

        const restoredWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!restoredWorkflow) {
          throw createHttpError(500, 'Restored workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return {
          project: deps.mapWorkflowRowToProjectItem(restoredWorkflow),
          version: mapPublishedVersionRowToSummary(restoredWorkflow, restoredVersion),
        };
      });
    },

    async publishWorkflowProjectItem(relativePath: unknown, settings: unknown): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedSettings = (() => {
        const raw = (settings ?? {}) as WorkflowProjectSettingsDraft;
        return {
          endpointName: normalizeStoredEndpointName(String(raw.endpointName ?? '')),
        };
      })();

      if (!normalizedSettings.endpointName) {
        throw badRequest('Endpoint name is required');
      }

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const publishedVersionId = randomUUID();
        await backfillLegacyPublishedVersion(client, workflow);

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: normalizedSettings.endpointName,
          publishedEndpointName: normalizedSettings.endpointName,
        });

        const currentDraftRevision = await deps.getRevision(client, workflow.current_draft_revision_id);
        if (!currentDraftRevision) {
          throw createHttpError(500, 'Current workflow revision could not be loaded');
        }

        await client.query(
          `
            INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at)
            VALUES ($1, $2, $3, $4, NOW())
          `,
          [
            publishedVersionId,
            workflow.workflow_id,
            currentDraftRevision.revision_id,
            normalizedSettings.endpointName,
          ],
        );

        await client.query(
          `
            UPDATE workflows
            SET endpoint_name = $2,
                published_endpoint_name = $2,
                published_revision_id = current_draft_revision_id,
                published_version_id = $3,
                last_published_at = NOW(),
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id, normalizedSettings.endpointName, publishedVersionId],
        );

        const publishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!publishedWorkflow) {
          throw createHttpError(500, 'Published workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(publishedWorkflow);
      });
    },

    async unpublishWorkflowProjectItem(relativePath: unknown): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        await backfillLegacyPublishedVersion(client, workflow);

        await client.query(
          `
            UPDATE workflows
            SET published_revision_id = NULL,
                published_version_id = NULL,
                published_endpoint_name = '',
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id],
        );

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: workflow.endpoint_name,
          publishedEndpointName: '',
        });

        const unpublishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!unpublishedWorkflow) {
          throw createHttpError(500, 'Unpublished workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(unpublishedWorkflow);
      });
    },
  };
}
