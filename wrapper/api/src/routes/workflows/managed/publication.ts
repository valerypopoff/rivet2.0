import { randomUUID } from 'node:crypto';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';

import type {
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../shared/workflow-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../../shared/workflow-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import { normalizeEmailList } from '../publication.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowDbClient } from './db.js';
import { toIsoString } from './mappers.js';
import type { PublishedVersionRow, RevisionRow, WebAppPublicationRow, WorkflowRow } from './types.js';

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

  const getUiGraphsFromProjectContents = (contents: string): Array<{ uiGraphId: string; name: string }> => {
    const project = loadProjectFromString(contents);
    return Object.entries(project.uiGraphs ?? {}).map(([uiGraphId, uiGraph]) => ({
      uiGraphId,
      name: typeof uiGraph?.name === 'string' && uiGraph.name.trim()
        ? uiGraph.name.trim()
        : uiGraphId,
    }));
  };

  const normalizeWebAppPublicationDrafts = (value: unknown): WorkflowProjectWebAppPublicationDraft[] => {
    if (!Array.isArray(value)) {
      throw badRequest('Web app publications must be an array');
    }

    const normalized = value.map((item) => {
      const raw = (item ?? {}) as Record<string, unknown>;
      const allowedEmails = Object.prototype.hasOwnProperty.call(raw, 'allowedEmails')
        ? normalizeEmailList(raw.allowedEmails)
        : undefined;
      if (allowedEmails) {
        validateAllowedEmailList(allowedEmails);
      }
      return {
        uiGraphId: typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '',
        slug: normalizeStoredEndpointName(typeof raw.slug === 'string' ? raw.slug : ''),
        allowedEmails,
      };
    });

    if (normalized.length === 0) {
      throw badRequest('At least one web app must be selected');
    }

    const seenUiGraphIds = new Set<string>();
    const seenSlugLookupNames = new Set<string>();
    for (const publication of normalized) {
      if (!publication.uiGraphId) {
        throw badRequest('Web app selection is required');
      }

      if (!publication.slug) {
        throw badRequest('Web app URL slug is required');
      }
      assertUsableWebAppSlug(publication.slug);

      const slugLookupName = normalizeWorkflowEndpointLookupName(publication.slug);
      if (seenUiGraphIds.has(publication.uiGraphId)) {
        throw badRequest('Each web app can only be published once per request');
      }

      if (seenSlugLookupNames.has(slugLookupName)) {
        throw badRequest('Each web app URL slug must be unique');
      }

      seenUiGraphIds.add(publication.uiGraphId);
      seenSlugLookupNames.add(slugLookupName);
    }

    return normalized;
  };

  const validateAllowedEmailList = (allowedEmails: readonly string[]): void => {
    for (const email of allowedEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw badRequest(`Invalid allowed email: ${email}`);
      }
    }
  };

  const assertUsableWebAppSlug = (slug: string): void => {
    if (slug.toLowerCase() === 'auth') {
      throw badRequest('Web app URL slug "auth" is reserved');
    }
  };

  const normalizeWebAppAccessDrafts = (value: unknown): WorkflowProjectWebAppAccessDraft[] => {
    if (!Array.isArray(value)) {
      throw badRequest('Web app access updates must be an array');
    }

    const normalized = value.map((item) => {
      const raw = (item ?? {}) as Record<string, unknown>;
      const allowedEmails = normalizeEmailList(raw.allowedEmails);
      validateAllowedEmailList(allowedEmails);
      return {
        uiGraphId: typeof raw.uiGraphId === 'string' ? raw.uiGraphId.trim() : '',
        allowedEmails,
      };
    });

    if (normalized.length === 0) {
      throw badRequest('At least one web app access update is required');
    }

    const seenUiGraphIds = new Set<string>();
    for (const access of normalized) {
      if (!access.uiGraphId) {
        throw badRequest('Web app selection is required');
      }

      if (seenUiGraphIds.has(access.uiGraphId)) {
        throw badRequest('Each web app access policy can only be updated once per request');
      }

      seenUiGraphIds.add(access.uiGraphId);
    }

    return normalized;
  };

  const listWebAppPublicationRows = async (
    client: ManagedWorkflowDbClient,
    workflowId: string,
  ): Promise<WebAppPublicationRow[]> => deps.queryRows<WebAppPublicationRow>(
    client,
    `
      SELECT app_id, workflow_id, revision_id, ui_graph_id, slug, slug_lookup_name, allowed_emails, published_at
      FROM workflow_web_apps
      WHERE workflow_id = $1
      ORDER BY published_at DESC, app_id DESC
    `,
    [workflowId],
  );

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
          r.stats_web_app_count,
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

    async listWorkflowProjectWebApps(relativePath: unknown): Promise<WorkflowProjectWebAppsResponse> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      await deps.initialize();
      const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const revision = await deps.getRevision(deps.pool, workflow.current_draft_revision_id);
      if (!revision) {
        throw createHttpError(500, 'Current workflow revision could not be loaded');
      }

      const [contents, publishedRows] = await Promise.all([
        deps.readRevisionContents(revision),
        listWebAppPublicationRows(deps.pool, workflow.workflow_id),
      ]);
      const currentUiGraphs = getUiGraphsFromProjectContents(contents.contents);
      const currentUiGraphIds = new Set(currentUiGraphs.map((uiGraph) => uiGraph.uiGraphId));
      const publishedByUiGraphId = new Map(publishedRows.map((row) => [row.ui_graph_id, row]));

      return {
        webApps: [
          ...currentUiGraphs.map((uiGraph) => {
            const published = publishedByUiGraphId.get(uiGraph.uiGraphId);
            const status: WorkflowProjectWebAppsResponse['webApps'][number]['status'] = published
              ? (published.revision_id === workflow.current_draft_revision_id ? 'published' : 'unpublished_changes')
              : 'unpublished';
            return {
              uiGraphId: uiGraph.uiGraphId,
              name: uiGraph.name,
              publishedSlug: published?.slug ?? null,
              publishedAt: toIsoString(published?.published_at) ?? null,
              allowedEmails: published?.allowed_emails ?? [],
              status,
              isMissingFromProject: false,
            };
          }),
          ...publishedRows
            .filter((webApp) => !currentUiGraphIds.has(webApp.ui_graph_id))
            .map((webApp) => ({
              uiGraphId: webApp.ui_graph_id,
              name: webApp.slug || webApp.ui_graph_id,
              publishedSlug: webApp.slug,
              publishedAt: toIsoString(webApp.published_at) ?? null,
              allowedEmails: webApp.allowed_emails ?? [],
              status: 'unpublished_changes' as const,
              isMissingFromProject: true,
            })),
        ],
      };
    },

    async publishWorkflowProjectWebApps(
      relativePath: unknown,
      publications: unknown,
    ): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedPublications = normalizeWebAppPublicationDrafts(publications);

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const currentDraftRevision = await deps.getRevision(client, workflow.current_draft_revision_id);
        if (!currentDraftRevision) {
          throw createHttpError(500, 'Current workflow revision could not be loaded');
        }

        const currentDraftContents = await deps.readRevisionContents(currentDraftRevision);
        const uiGraphsById = new Map(getUiGraphsFromProjectContents(currentDraftContents.contents).map((uiGraph) => [uiGraph.uiGraphId, uiGraph]));

        for (const publication of normalizedPublications) {
          if (!uiGraphsById.has(publication.uiGraphId)) {
            throw createHttpError(404, 'Web app not found');
          }
        }

        const uiGraphIds = normalizedPublications.map((publication) => publication.uiGraphId);
        const previousRows = await listWebAppPublicationRows(client, workflow.workflow_id);
        const previousByUiGraphId = new Map(previousRows.map((row) => [row.ui_graph_id, row]));
        await client.query(
          'DELETE FROM workflow_web_apps WHERE workflow_id = $1 AND ui_graph_id = ANY($2::text[])',
          [workflow.workflow_id, uiGraphIds],
        );

        for (const publication of normalizedPublications) {
          try {
            await client.query(
              `
                INSERT INTO workflow_web_apps (
                  app_id, workflow_id, revision_id, ui_graph_id, slug, slug_lookup_name, allowed_emails, published_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW())
              `,
              [
                randomUUID(),
                workflow.workflow_id,
                currentDraftRevision.revision_id,
                publication.uiGraphId,
                publication.slug,
                normalizeWorkflowEndpointLookupName(publication.slug),
                publication.allowedEmails ?? previousByUiGraphId.get(publication.uiGraphId)?.allowed_emails ?? [],
              ],
            );
          } catch (error) {
            if (typeof error === 'object' && error != null && 'code' in error && String((error as { code?: unknown }).code ?? '') === '23505') {
              throw conflict('Web app URL slug is already used by another workflow');
            }

            throw error;
          }
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
      });
    },

    async updateWorkflowProjectWebAppAccess(
      relativePath: unknown,
      accessUpdates: unknown,
    ): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedAccessUpdates = normalizeWebAppAccessDrafts(accessUpdates);

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        for (const access of normalizedAccessUpdates) {
          const updateResult = await client.query(
            `
              UPDATE workflow_web_apps
              SET allowed_emails = $3::text[]
              WHERE workflow_id = $1 AND ui_graph_id = $2
            `,
            [workflow.workflow_id, access.uiGraphId, access.allowedEmails],
          );
          if (updateResult.rowCount === 0) {
            throw createHttpError(404, 'Published web app not found');
          }
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
      });
    },

    async unpublishWorkflowProjectWebApp(relativePath: unknown, uiGraphId: unknown): Promise<WorkflowProjectItem> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedUiGraphId = typeof uiGraphId === 'string' ? uiGraphId.trim() : '';
      if (!normalizedUiGraphId) {
        throw badRequest('Web app selection is required');
      }

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const deleteResult = await client.query(
          'DELETE FROM workflow_web_apps WHERE workflow_id = $1 AND ui_graph_id = $2 RETURNING app_id',
          [workflow.workflow_id, normalizedUiGraphId],
        );
        if (deleteResult.rows.length === 0) {
          throw createHttpError(404, 'Published web app not found');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
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
