import { randomUUID } from 'node:crypto';
import { assertLegacyEndpointCanBeRestored } from '../endpoint-release-graphs.js';
import { downloadEndpointRelease } from './endpoint-release-download.js';
import {
  loadEndpointReleaseArtifacts,
  readEndpointReleasePreviewArtifact,
  readEndpointRelease,
} from './endpoint-release-reader.js';
import { endpointReleaseWritesEnabled } from './endpoint-release-selection.js';
import {
  hashPreparedEndpointReleases,
  prepareEndpointRelease,
  storeEndpointRelease,
  validatePreparedEndpointReleases,
  type PreparedEndpointRelease,
} from './endpoint-releases.js';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';
import { listSavedLatestSubgraphProjectIds } from '../subgraph-publication-dependencies.js';

import type {
  WorkflowDraftPublicationPreconditions,
  WorkflowEndpointReleaseReview,
  WorkflowHistoryPreview,
  WorkflowProjectSettingsDraft,
  WorkflowEndpointAccess,
  WorkflowPublicationPreconditions,
  WorkflowProjectItem,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionPreviewResponse,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
  WorkflowPublishedVersionsResponse,
} from '../../../../../studio-server-shared/workflow-types.js';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../../../../studio-server-shared/workflow-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import { hasProjectMainGraph, requireProjectMainGraphForEndpoint } from '../main-graph.js';
import {
  assertPublicationPreconditions,
  createEndpointPublication,
  assertEndpointAccess,
} from '../publication-policy.js';
import type { WorkflowPublicationCommandKind } from '../publication-command.js';
import { normalizeWebAppAccessDrafts, normalizeWebAppPublicationDrafts } from '../web-app-publication-drafts.js';
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
  const context = options.context;
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
    queueWorkflowInvalidation: options.context.executionInvalidationController.queueWorkflowInvalidation.bind(
      options.context.executionInvalidationController,
    ),
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
      throw badRequest(
        `Published version comment must be ${WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH} characters or fewer`,
      );
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
    coverage: row.release_id ? 'frozen' : 'project-only',
    ...(row.restored_from ? { restoredFrom: row.restored_from } : {}),
    isStarred: row.is_starred === true,
    comment: normalizePublishedVersionCommentForStorage(row.comment),
  });

  const getUiGraphsFromProject = (
    project: ReturnType<typeof loadProjectFromString>,
  ): Array<{ uiGraphId: string; name: string }> => {
    return Object.entries(project.uiGraphs ?? {}).map(([uiGraphId, uiGraph]) => ({
      uiGraphId,
      name: typeof uiGraph?.name === 'string' && uiGraph.name.trim() ? uiGraph.name.trim() : uiGraphId,
    }));
  };

  const listWebAppPublicationRows = async (
    client: ManagedWorkflowDbClient,
    workflowId: string,
  ): Promise<WebAppPublicationRow[]> =>
    deps.queryRows<WebAppPublicationRow>(
      client,
      `
      SELECT app_id, workflow_id, revision_id, ui_graph_id, slug, slug_lookup_name, allowed_emails, published_at
      FROM workflow_web_apps
      WHERE workflow_id = $1
      ORDER BY published_at DESC, app_id DESC
    `,
      [workflowId],
    );

  const assertManagedPublicationPreconditions = (
    workflow: WorkflowRow,
    preconditions: WorkflowPublicationPreconditions,
    kind: WorkflowPublicationCommandKind,
  ): void =>
    assertPublicationPreconditions(
      preconditions,
      {
        projectId: workflow.workflow_id,
        draftRevisionId: workflow.current_draft_revision_id,
        publicationVersion: workflow.publication_version ?? '0',
        endpointPublished: workflow.published_revision_id != null,
      },
      kind,
    );

  const bumpPublicationVersion = async (client: ManagedWorkflowDbClient, workflow: WorkflowRow): Promise<void> => {
    const result = await client.query<{ publication_version: string }>(
      'UPDATE workflows SET publication_version = publication_version + 1 WHERE workflow_id = $1 RETURNING publication_version',
      [workflow.workflow_id],
    );
    if (!result.rows[0]) throw createHttpError(500, 'Publication version could not be updated');
    workflow.publication_version = result.rows[0].publication_version;
  };

  // Keep the complete artifact integrity check, but never hold a workflow row
  // lock (or a leased connection) while waiting for object storage or parsing.
  const prepareDraftPublication = async (
    relativePath: string,
    preconditions: WorkflowDraftPublicationPreconditions,
    kind: 'publish-endpoint' | 'publish-web-apps',
  ) => {
    await deps.initialize();
    const workflow = await deps.getWorkflowByRelativePath(deps.pool, relativePath);
    if (!workflow) throw createHttpError(404, 'Project not found');
    assertManagedPublicationPreconditions(workflow, preconditions, kind);
    const revision = await deps.getRevision(deps.pool, workflow.current_draft_revision_id);
    if (!revision) throw createHttpError(500, 'Current workflow revision could not be loaded');
    if (revision.workflow_id !== workflow.workflow_id || revision.revision_id !== workflow.current_draft_revision_id)
      throw createHttpError(500, 'Current workflow revision has a mismatched identity');
    const contents = await deps.readRevisionContents(revision);
    const project = loadProjectFromString(contents.contents);
    if (project.metadata.id !== revision.workflow_id)
      throw createHttpError(500, 'Current workflow artifact has a mismatched project identity');
    return { revision, project, workflow };
  };

  const prepareReleasePublication = async (workflow: WorkflowRow, revisionId: string) => {
    const version = workflow.published_version_id
      ? await deps.queryOne<Pick<PublishedVersionRow, 'release_id'>>(deps.pool,
          'SELECT release_id FROM workflow_published_versions WHERE workflow_id = $1 AND version_id = $2',
          [workflow.workflow_id, workflow.published_version_id])
      : null;
    if (!endpointReleaseWritesEnabled()) {
      const hasProtectedHistory = version?.release_id || await deps.queryOne(deps.pool,
        'SELECT release_id FROM workflow_endpoint_releases WHERE workflow_id = $1 LIMIT 1',
        [workflow.workflow_id]);
      if (hasProtectedHistory) throw conflict('Enable frozen endpoint publication before publishing this project again.');
      return null;
    }
    const next = await prepareEndpointRelease(context, workflow.workflow_id, revisionId, 'latest');
    let baseline: PreparedEndpointRelease | null = null;
    let missingRollback = false;
    if (workflow.published_revision_id && !version?.release_id) {
      try {
        baseline = await prepareEndpointRelease(context, workflow.workflow_id, workflow.published_revision_id, 'published');
      } catch (error) {
        // A missing graph or an invalid reference can block capture of an old
        // release. Availability failures still stop publication.
        if (!(error instanceof Error) || !('status' in error) || ![400, 404, 409].includes(Number(error.status)))
          throw error;
        missingRollback = true;
      }
    }
    const prepared = baseline ? [baseline, next] : [next];
    return { next, baseline, missingRollback, prepared, token: hashPreparedEndpointReleases(prepared, missingRollback) };
  };

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
    ownerId?: string,
  ): Promise<{ projectName: string; publishedAt: string; endpointName: string; revision: RevisionRow; releaseId?: string }> => {
    const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
    const normalizedVersionId = typeof versionId === 'string' ? versionId.trim() : '';
    if (!normalizedVersionId) {
      throw badRequest('Missing versionId');
    }

    await deps.initialize();
    const workflow = ownerId
      ? await context.queries.getWorkflowById(deps.pool, ownerId)
      : await deps.getWorkflowByRelativePath(deps.pool, normalizedRelativePath);
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
          pv.release_id,
          r.project_blob_key,
          r.dataset_blob_key,
          r.stats_graph_count,
          r.stats_total_node_count,
          r.stats_web_app_count,
          r.created_at
        FROM workflow_published_versions pv
        JOIN workflow_revisions r ON r.revision_id = pv.revision_id AND r.workflow_id = pv.workflow_id
        WHERE pv.workflow_id = $1 AND pv.version_id = $2
      `,
      [workflow.workflow_id, normalizedVersionId],
    );
    if (row) {
      return {
        projectName: workflow.name,
        publishedAt: toIsoString(row.published_at) ?? new Date().toISOString(),
        revision: row,
        endpointName: row.endpoint_name,
        releaseId: row.release_id ?? undefined,
      };
    }

    if (
      !workflow.published_version_id &&
      workflow.published_revision_id &&
      normalizedVersionId === workflow.published_revision_id
    ) {
      const revision = await deps.getRevision(deps.pool, workflow.published_revision_id);
      if (revision?.workflow_id !== workflow.workflow_id) {
        throw createHttpError(404, 'Published version not found');
      }

      return {
        projectName: workflow.name,
        publishedAt:
          toIsoString(workflow.last_published_at) ?? toIsoString(revision.created_at) ?? new Date().toISOString(),
        revision,
        endpointName: workflow.published_endpoint_name || workflow.endpoint_name,
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
          SELECT version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
          FROM workflow_published_versions
          WHERE workflow_id = $1
          ORDER BY published_at DESC, version_id DESC
        `,
        [workflow.workflow_id],
      );
      const versions: WorkflowPublishedVersionSummary[] = rows.map((row) =>
        mapPublishedVersionRowToSummary(workflow, row),
      );

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

    async readWorkflowPublishedVersionDownload(
      relativePath: unknown,
      versionId: unknown,
    ): Promise<{ contents: string | Buffer; fileName: string }> {
      const { projectName, publishedAt, revision, releaseId, endpointName } = await resolvePublishedVersionRevision(relativePath, versionId);
      if (releaseId) {
        const release = await readEndpointRelease(deps.pool, releaseId, revision.workflow_id, revision.revision_id);
        if (release.manifest.projects.length > 1 || release.pins.get(revision.revision_id)?.dataset_blob_key) {
          return {
            contents: await downloadEndpointRelease(context, release, endpointName, publishedAt),
            fileName: getPublishedVersionDownloadFileName(projectName, publishedAt).replace(/\.rivet-project$/, '.zip'),
          };
        }
      }
      return {
        contents: await deps.readRevisionProjectContents(revision),
        fileName: getPublishedVersionDownloadFileName(projectName, publishedAt),
      };
    },

    async readWorkflowPublishedVersionPreview(
      relativePath: unknown, versionId: unknown, artifactId?: string, ownerId?: string,
    ): Promise<WorkflowPublishedVersionPreviewResponse> {
      const { revision, releaseId } = await resolvePublishedVersionRevision(relativePath, versionId, ownerId);
      if (releaseId) {
        const release = await readEndpointRelease(deps.pool, releaseId, revision.workflow_id, revision.revision_id);
        return readEndpointReleasePreviewArtifact(context, release, artifactId ?? revision.revision_id);
      }
      if (artifactId && artifactId !== revision.revision_id && artifactId !== versionId)
        throw createHttpError(404, 'This project was not captured in the endpoint revision.');
      return deps.readRevisionContents(revision);
    },

    async readWorkflowHistoryPreview(relativePath: string, versionId: string, ownerId?: string): Promise<WorkflowHistoryPreview> {
      const { revision, releaseId, endpointName, publishedAt, projectName } =
        await resolvePublishedVersionRevision(relativePath, versionId, ownerId);
      if (releaseId) {
        const release = await readEndpointRelease(deps.pool, releaseId, revision.workflow_id, revision.revision_id);
        const { rootArtifactId, projects, references } = release.manifest;
        return { rootArtifactId, projects, references, coverage: 'frozen', endpointName, publishedAt, capturedAt: release.capturedAt };
      }
      return {
        coverage: 'project-only', endpointName, publishedAt, rootArtifactId: revision.revision_id,
        projects: [{
          artifactId: revision.revision_id, projectId: revision.workflow_id, name: projectName,
          relativePath, savedAt: toIsoString(revision.created_at) ?? publishedAt,
        }],
        references: [],
      };
    },

    async reviewEndpointRelease(relativePath: string, preconditions: WorkflowDraftPublicationPreconditions): Promise<WorkflowEndpointReleaseReview | null> {
      if (!endpointReleaseWritesEnabled()) return null;
      const prepared = await prepareDraftPublication(relativePath, preconditions, 'publish-endpoint');
      const review = await prepareReleasePublication(prepared.workflow, prepared.revision.revision_id);
      if (!review) return null;
      return {
        token: review.token,
        projects: review.next.manifest.projects.map((project) => ({
          ...project,
          fromDraft: review.next.selections.some((selection) =>
            selection.projectId === project.projectId && selection.revisionId === project.artifactId &&
            selection.fromDraft),
        })),
        missingRollback: review.missingRollback,
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
          RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
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
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
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
          RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
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
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
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
      relativePath: unknown, versionId: unknown, preconditions: WorkflowPublicationPreconditions,
    ): Promise<WorkflowPublishedVersionRestoreResponse> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const source = await resolvePublishedVersionRevision(normalizedRelativePath, versionId);
      const revisionId = source.revision.revision_id;
      if (source.revision.workflow_id !== preconditions.expectedProjectId)
        throw conflict('The project at this path changed. Review the publication again.');
      if (source.releaseId) {
        const release = await readEndpointRelease(deps.pool, source.releaseId, source.revision.workflow_id, revisionId);
        await loadEndpointReleaseArtifacts(context, release);
      } else {
        const contents = await deps.readRevisionContents(source.revision);
        const project = loadProjectFromString(contents.contents);
        if (project.metadata.id !== source.revision.workflow_id)
          throw conflict('The historical project has a different saved identity.');
        assertLegacyEndpointCanBeRestored(project, contents.datasetsContents);
      }
      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) throw createHttpError(404, 'Project not found');
        assertManagedPublicationPreconditions(workflow, preconditions, 'restore-version');
        const endpointName = workflow.published_endpoint_name || workflow.endpoint_name;
        if (!endpointName) throw badRequest('Configure an endpoint name before restoring.');
        const restoredVersionId = randomUUID();
        await backfillLegacyPublishedVersion(client, workflow);
        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: workflow.endpoint_name,
          publishedEndpointName: endpointName,
        });
        const restoredVersion = await deps.queryOne<PublishedVersionRow>(
          client,
          `
            INSERT INTO workflow_published_versions
              (version_id, workflow_id, revision_id, endpoint_name, published_at, release_id, restored_from)
            VALUES ($1, $2, $3, $4, NOW(), $5, $6)
            RETURNING version_id, workflow_id, revision_id, endpoint_name, published_at, is_starred, comment, release_id, restored_from
          `,
          [restoredVersionId, workflow.workflow_id, revisionId, endpointName, source.releaseId ?? null, String(versionId).trim()],
        );
        if (!restoredVersion) throw createHttpError(500, 'Restored revision could not be recorded.');
        await client.query(`
          UPDATE workflows SET published_revision_id = $2, published_version_id = $3,
            published_endpoint_name = $4, last_published_at = NOW(), publication_version = publication_version + 1
          WHERE workflow_id = $1
        `, [workflow.workflow_id, revisionId, restoredVersionId, endpointName]);
        const restoredWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!restoredWorkflow) throw createHttpError(500, 'Restored workflow could not be loaded');
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return {
          project: deps.mapWorkflowRowToProjectItem(restoredWorkflow),
          version: mapPublishedVersionRowToSummary(restoredWorkflow, restoredVersion),
        };
      });
    },

    async listWorkflowProjectWebApps(relativePath: unknown): Promise<WorkflowProjectWebAppsResponse> {
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      // Capture the row and its published apps under one lock, then release the
      // lock before fetching immutable revision contents from blob storage.
      const { workflow, revision, publishedRows } = await deps.withTransaction(async (client) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const revision = await deps.getRevision(client, workflow.current_draft_revision_id);
        if (!revision) {
          throw createHttpError(500, 'Current workflow revision could not be loaded');
        }

        const publishedRows = await listWebAppPublicationRows(client, workflow.workflow_id);
        return { workflow, revision, publishedRows };
      });

      const contents = await deps.readRevisionProjectContents(revision);
      const currentProject = loadProjectFromString(contents);
      const currentUiGraphs = getUiGraphsFromProject(currentProject);
      const currentUiGraphIds = new Set(currentUiGraphs.map((uiGraph) => uiGraph.uiGraphId));
      const publishedByUiGraphId = new Map(publishedRows.map((row) => [row.ui_graph_id, row]));

      return {
        project: deps.mapWorkflowRowToProjectItem(workflow, { webAppRows: publishedRows }),
        projectId: workflow.workflow_id,
        draftRevisionId: workflow.current_draft_revision_id,
        publicationVersion: workflow.publication_version ?? '0',
        hasMainGraph: hasProjectMainGraph(currentProject),
        savedLatestSubgraphProjectIds: listSavedLatestSubgraphProjectIds(currentProject),
        webApps: [
          ...currentUiGraphs.map((uiGraph) => {
            const published = publishedByUiGraphId.get(uiGraph.uiGraphId);
            const status: WorkflowProjectWebAppsResponse['webApps'][number]['status'] = published
              ? published.revision_id === workflow.current_draft_revision_id
                ? 'published'
                : 'unpublished_changes'
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
      preconditions: WorkflowDraftPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedPublications = normalizeWebAppPublicationDrafts(publications);

      const prepared = await prepareDraftPublication(normalizedRelativePath, preconditions, 'publish-web-apps');
      const uiGraphsById = new Map(getUiGraphsFromProject(prepared.project).map((graph) => [graph.uiGraphId, graph]));
      for (const publication of normalizedPublications) {
        if (!uiGraphsById.has(publication.uiGraphId)) throw createHttpError(404, 'Web app not found');
      }

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        assertManagedPublicationPreconditions(workflow, preconditions, 'publish-web-apps');

        const currentDraftRevision = prepared.revision;

        const uiGraphIds = normalizedPublications.map((publication) => publication.uiGraphId);
        const previousRows = await listWebAppPublicationRows(client, workflow.workflow_id);
        const previousByUiGraphId = new Map(previousRows.map((row) => [row.ui_graph_id, row]));
        await client.query('DELETE FROM workflow_web_apps WHERE workflow_id = $1 AND ui_graph_id = ANY($2::text[])', [
          workflow.workflow_id,
          uiGraphIds,
        ]);

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
                previousByUiGraphId.get(publication.uiGraphId)?.app_id ?? randomUUID(),
                workflow.workflow_id,
                currentDraftRevision.revision_id,
                publication.uiGraphId,
                publication.slug,
                normalizeWorkflowEndpointLookupName(publication.slug),
                publication.allowedEmails ?? previousByUiGraphId.get(publication.uiGraphId)?.allowed_emails ?? [],
              ],
            );
          } catch (error) {
            if (
              typeof error === 'object' &&
              error != null &&
              'code' in error &&
              String((error as { code?: unknown }).code ?? '') === '23505'
            ) {
              throw conflict('Web app URL slug is already used by another workflow');
            }

            throw error;
          }
        }

        await bumpPublicationVersion(client, workflow);
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
      });
    },

    async updateWorkflowProjectWebAppAccess(
      relativePath: unknown,
      accessUpdates: unknown,
      preconditions: WorkflowPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const normalizedAccessUpdates = normalizeWebAppAccessDrafts(accessUpdates);

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        assertManagedPublicationPreconditions(workflow, preconditions, 'set-web-app-access');

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

        await bumpPublicationVersion(client, workflow);
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
      });
    },

    async unpublishWorkflowProjectWebApp(
      relativePath: unknown,
      uiGraphId: unknown,
      preconditions: WorkflowPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
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

        assertManagedPublicationPreconditions(workflow, preconditions, 'unpublish-web-app');

        const deleteResult = await client.query(
          'DELETE FROM workflow_web_apps WHERE workflow_id = $1 AND ui_graph_id = $2 RETURNING app_id',
          [workflow.workflow_id, normalizedUiGraphId],
        );
        if (deleteResult.rows.length === 0) {
          throw createHttpError(404, 'Published web app not found');
        }

        await bumpPublicationVersion(client, workflow);
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(workflow, {
          webAppRows: await listWebAppPublicationRows(client, workflow.workflow_id),
        });
      });
    },

    async updateWorkflowEndpointAccess(
      relativePath: unknown,
      access: WorkflowEndpointAccess,
      preconditions: WorkflowPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) throw createHttpError(404, 'Project not found');
        assertManagedPublicationPreconditions(workflow, preconditions, 'set-endpoint-access');
        assertEndpointAccess(access);

        await client.query(
          'UPDATE workflows SET endpoint_access = $2, publication_version = publication_version + 1 WHERE workflow_id = $1',
          [workflow.workflow_id, access],
        );
        const updated = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!updated) throw createHttpError(500, 'Updated workflow could not be loaded');
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        return deps.mapWorkflowRowToProjectItem(updated);
      });
    },

    async publishWorkflowProjectItem(
      relativePath: unknown,
      settings: WorkflowProjectSettingsDraft,
      preconditions: WorkflowDraftPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const publication = createEndpointPublication(settings);
      const normalizedSettings = { endpointName: publication.endpointName };

      const prepared = await prepareDraftPublication(normalizedRelativePath, preconditions, 'publish-endpoint');
      requireProjectMainGraphForEndpoint(prepared.project);
      const release = await prepareReleasePublication(prepared.workflow, prepared.revision.revision_id);
      if (settings.releaseReviewToken && release?.token !== settings.releaseReviewToken)
        throw conflict('The reviewed endpoint dependencies changed. Review the release again.');
      if (release?.missingRollback && (!settings.releaseReviewToken || !settings.acknowledgeMissingRollback))
        throw conflict('The current endpoint cannot be captured for rollback. Review the release before replacing it.');

      return deps.withTransaction(async (client, hooks) => {
        await validatePreparedEndpointReleases(client, release?.prepared ?? []);
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        assertManagedPublicationPreconditions(workflow, preconditions, 'publish-endpoint');
        const currentDraftRevision = prepared.revision;

        const publishedVersionId = publication.versionId;
        await backfillLegacyPublishedVersion(client, workflow);
        if (release?.baseline) {
          await storeEndpointRelease(client, workflow.workflow_id, release.baseline);
          await client.query(
            'UPDATE workflow_published_versions SET release_id = $1 WHERE workflow_id = $2 AND version_id = $3',
            [release.baseline.releaseId, workflow.workflow_id, workflow.published_version_id ?? workflow.published_revision_id],
          );
        }
        if (release) await storeEndpointRelease(client, workflow.workflow_id, release.next);

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: normalizedSettings.endpointName,
          publishedEndpointName: normalizedSettings.endpointName,
        });

        await client.query(
          `
            INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at, release_id)
            VALUES ($1, $2, $3, $4, NOW(), $5)
          `,
          [publishedVersionId, workflow.workflow_id, currentDraftRevision.revision_id, normalizedSettings.endpointName, release?.next.releaseId ?? null],
        );

        await client.query(
          `
            UPDATE workflows
            SET endpoint_name = $2,
                published_endpoint_name = $2,
                published_revision_id = current_draft_revision_id,
                published_version_id = $3,
                last_published_at = NOW(),
                publication_version = publication_version + 1,
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id, normalizedSettings.endpointName, publishedVersionId],
        );

        const publishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, {
          forUpdate: true,
        });
        if (!publishedWorkflow) {
          throw createHttpError(500, 'Published workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(publishedWorkflow);
      });
    },

    async unpublishWorkflowProjectItem(
      relativePath: unknown,
      preconditions: WorkflowPublicationPreconditions,
    ): Promise<WorkflowProjectItem> {
      preconditions = { ...preconditions };
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        assertManagedPublicationPreconditions(workflow, preconditions, 'unpublish-endpoint');

        await backfillLegacyPublishedVersion(client, workflow);

        await client.query(
          `
            UPDATE workflows
            SET published_revision_id = NULL,
                published_version_id = NULL,
                published_endpoint_name = '',
                publication_version = publication_version + 1,
                updated_at = NOW()
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id],
        );

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName: workflow.endpoint_name,
          publishedEndpointName: '',
        });

        const unpublishedWorkflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, {
          forUpdate: true,
        });
        if (!unpublishedWorkflow) {
          throw createHttpError(500, 'Unpublished workflow could not be loaded');
        }

        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

        return deps.mapWorkflowRowToProjectItem(unpublishedWorkflow);
      });
    },
  };
}
