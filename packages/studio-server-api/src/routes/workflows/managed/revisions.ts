import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { serializeProject } from '@valerypopoff/rivet2-node';
import { type Pool, type PoolClient } from 'pg';

import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../studio-server-shared/workflow-types.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeHostedProjectTitle } from '../hosted-project-contents.js';
import { normalizeStoredEndpointName, normalizeWorkflowEndpointLookupName } from '../endpoint-names.js';
import { normalizeEmailList } from '../publication.js';
import {
  getManagedWorkflowProjectVirtualPath,
  normalizeManagedWorkflowRelativePath,
  parseManagedWorkflowProjectVirtualPath,
} from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import { resolveManagedHostedProjectSaveTarget } from './revision-factory.js';
import type {
  ImportManagedWorkflowOptions,
  LoadHostedProjectResult,
  ManagedRevisionContents,
  RevisionRow,
  SaveHostedProjectResult,
  TransactionHooks,
  WorkflowRow,
} from './types.js';

type ManagedWorkflowRevisionServiceDependencies = {
  context: ManagedWorkflowContext;
};

function getManagedRevisionContentsKey(contents: string, datasetsContents: string | null): string {
  return JSON.stringify([contents, datasetsContents]);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' &&
    error != null &&
    'code' in error &&
    String((error as { code?: unknown }).code ?? '') === '23505';
}

export function createManagedWorkflowRevisionService(options: ManagedWorkflowRevisionServiceDependencies) {
  const deps = {
    pool: options.context.pool,
    initialize: options.context.initialize,
    withTransaction: options.context.withTransaction,
    ensureFolderChain: options.context.queries.ensureFolderChain,
    getWorkflowByRelativePath: options.context.queries.getWorkflowByRelativePath,
    getWorkflowById: options.context.queries.getWorkflowById,
    getRevision: options.context.queries.getRevision,
    getCurrentDraftWorkflowRevision: options.context.queries.getCurrentDraftWorkflowRevision,
    readRevisionContents: options.context.revisions.readRevisionContents,
    createRevision: options.context.revisions.createRevision,
    scheduleRevisionBlobCleanup: options.context.revisions.scheduleRevisionBlobCleanup,
    insertRevision: options.context.revisions.insertRevision,
    syncWorkflowEndpointRows: options.context.endpointSync.syncWorkflowEndpointRows,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    resolveManagedHostedProjectSaveTarget,
    queueWorkflowInvalidation: options.context.executionInvalidationController.queueWorkflowInvalidation.bind(options.context.executionInvalidationController),
  };

  const shouldInvalidateExecutionCacheAfterDraftChange = async (
    client: Pool | PoolClient,
    workflow: WorkflowRow,
  ): Promise<boolean> => {
    if (workflow.published_endpoint_name) {
      return true;
    }

    const publishedWebAppResult = await client.query(
      'SELECT 1 FROM workflow_web_apps WHERE workflow_id = $1 LIMIT 1',
      [workflow.workflow_id],
    );
    return publishedWebAppResult.rows.length > 0;
  };

  return {
    async loadHostedProject(projectPath: string): Promise<LoadHostedProjectResult> {
      await deps.initialize();
      const relativePath = parseManagedWorkflowProjectVirtualPath(projectPath);
      const loaded = await deps.getCurrentDraftWorkflowRevision(deps.pool, relativePath);
      if (!loaded) {
        throw createHttpError(404, 'Project revision not found');
      }

      const contents = await deps.readRevisionContents(loaded.revision);
      return {
        ...contents,
        revisionId: loaded.revision.revision_id,
      };
    },

    async saveHostedProject(options: {
      projectPath: string;
      contents: string;
      datasetsContents: string | null;
      expectedRevisionId?: string | null;
    }): Promise<SaveHostedProjectResult> {
      const relativePath = parseManagedWorkflowProjectVirtualPath(options.projectPath);
      const projectName = path.posix.basename(relativePath, WORKFLOW_PROJECT_EXTENSION);
      const folderRelativePath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
      const normalizedContents = normalizeHostedProjectTitle(
        options.contents,
        projectName,
        'Could not save project',
      );
      const { project: sourceProject, attachedData } = normalizedContents;

      return deps.withTransaction(async (client, hooks) => {
        await deps.ensureFolderChain(client, folderRelativePath);

        let workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        let contents = normalizedContents.contents;
        let created = false;
        let workflowId = sourceProject.metadata.id ?? (randomUUID() as typeof sourceProject.metadata.id);

        if (workflow) {
          workflowId = workflow.workflow_id as typeof sourceProject.metadata.id;
          if (options.expectedRevisionId && options.expectedRevisionId !== workflow.current_draft_revision_id) {
            throw conflict('Project has changed since it was opened. Reload it before saving again.');
          }

          if (sourceProject.metadata.id !== workflowId) {
            throw conflict('The save target belongs to a different project. Choose a new path or reopen the target.');
          }

          const currentDraftRevision = await deps.getRevision(client, workflow.current_draft_revision_id);
          if (!currentDraftRevision) {
            throw createHttpError(500, 'Current workflow revision could not be loaded');
          }

          const currentDraftContents = await deps.readRevisionContents(currentDraftRevision);
          let publishedContents: ManagedRevisionContents | null = null;

          if (workflow.published_revision_id) {
            if (workflow.published_revision_id === currentDraftRevision.revision_id) {
              publishedContents = currentDraftContents;
            } else {
              const publishedRevision = await deps.getRevision(client, workflow.published_revision_id);
              if (!publishedRevision) {
                throw createHttpError(500, 'Published workflow revision could not be loaded');
              }

              publishedContents = await deps.readRevisionContents(publishedRevision);
            }
          }

          const saveTarget = deps.resolveManagedHostedProjectSaveTarget({
            nextContents: {
              contents,
              datasetsContents: options.datasetsContents,
            },
            currentDraftContents,
            publishedContents,
            draftEndpointName: workflow.endpoint_name,
            publishedEndpointName: workflow.published_endpoint_name,
          });

          if (saveTarget === 'current-draft') {
            return {
              path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
              revisionId: currentDraftRevision.revision_id,
              project: deps.mapWorkflowRowToProjectItem(workflow),
              created,
            };
          }

          if (saveTarget === 'published-revision') {
            const publishedRevisionId = workflow.published_revision_id ?? currentDraftRevision.revision_id;
            if (workflow.current_draft_revision_id !== publishedRevisionId) {
              await client.query(
                `
                  UPDATE workflows
                  SET current_draft_revision_id = $2
                  WHERE workflow_id = $1
                `,
                [workflow.workflow_id, publishedRevisionId],
              );

              workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
              if (!workflow) {
                throw createHttpError(500, 'Saved workflow could not be loaded');
              }

              if (await shouldInvalidateExecutionCacheAfterDraftChange(client, workflow)) {
                await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
              }
            }

            return {
              path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
              revisionId: publishedRevisionId,
              project: deps.mapWorkflowRowToProjectItem(workflow),
              created,
            };
          }
        } else {
          const existingIdOwner = await deps.getWorkflowById(client, workflowId);
          if (existingIdOwner) {
            sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;
            workflowId = sourceProject.metadata.id;
            const rewritten = serializeProject(sourceProject, attachedData);
            if (typeof rewritten !== 'string') {
              throw createHttpError(400, 'Could not save project');
            }
            contents = rewritten;
          }

          created = true;
        }

        const revision = await deps.createRevision(workflowId, contents, options.datasetsContents);
        deps.scheduleRevisionBlobCleanup(hooks, revision);

        if (workflow) {
          await deps.insertRevision(client, revision);
          await client.query(
            `
              UPDATE workflows
              SET name = $2,
                  file_name = $3,
                  folder_relative_path = $4,
                  current_draft_revision_id = $5,
                  updated_at = NOW()
              WHERE workflow_id = $1
            `,
            [
              workflow.workflow_id,
              projectName,
              `${projectName}${WORKFLOW_PROJECT_EXTENSION}`,
              folderRelativePath,
              revision.revision_id,
            ],
          );

          workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        } else {
          await client.query(
            `
              INSERT INTO workflows (
                workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
                current_draft_revision_id, published_revision_id, published_version_id, endpoint_name, published_endpoint_name, last_published_at
              )
              VALUES ($1, $2, $3, $4, $5, NOW(), $6, NULL, NULL, '', '', NULL)
            `,
            [
              workflowId,
              projectName,
              `${projectName}${WORKFLOW_PROJECT_EXTENSION}`,
              relativePath,
              folderRelativePath,
              revision.revision_id,
            ],
          );
          await deps.insertRevision(client, revision);

          workflow = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        }

        if (!workflow) {
          throw createHttpError(500, 'Saved workflow could not be loaded');
        }

        if (!created && await shouldInvalidateExecutionCacheAfterDraftChange(client, workflow)) {
          await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        }

        return {
          path: getManagedWorkflowProjectVirtualPath(workflow.relative_path),
          revisionId: revision.revision_id,
          project: deps.mapWorkflowRowToProjectItem(workflow),
          created,
        };
      });
    },

    async importWorkflow(options: ImportManagedWorkflowOptions) {
      const relativePath = normalizeManagedWorkflowRelativePath(options.relativePath, { allowProjectFile: true });
      const folderRelativePath = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
      const fileName = options.fileName?.trim() || path.posix.basename(relativePath);
      const workflowName = options.name.trim() || path.posix.basename(relativePath, WORKFLOW_PROJECT_EXTENSION);
      const draftEndpointName = normalizeStoredEndpointName(options.endpointName);
      const publishedEndpointName = normalizeStoredEndpointName(options.publishedEndpointName);
      const updatedAt = options.updatedAt?.trim() || new Date().toISOString();
      const lastPublishedAt = options.lastPublishedAt?.trim() || null;
      const importedWebApps = options.publishedWebApps ?? [];

      return deps.withTransaction(async (client, hooks) => {
        await deps.ensureFolderChain(client, folderRelativePath);

        const existingByPath = await deps.getWorkflowByRelativePath(client, relativePath, { forUpdate: true });
        if (existingByPath) {
          throw conflict(`Managed workflow already exists at ${relativePath}`);
        }

        const existingById = await deps.getWorkflowById(client, options.workflowId);
        if (existingById) {
          throw conflict(`Managed workflow id already exists: ${options.workflowId}`);
        }

        const draftRevision = await deps.createRevision(options.workflowId, options.contents, options.datasetsContents);
        deps.scheduleRevisionBlobCleanup(hooks, draftRevision);

        let publishedRevision: RevisionRow | null = null;
        let publishedRevisionId: string | null = null;
        let publishedVersionId: string | null = null;
        const shouldCreateSeparatePublishedRevision = publishedEndpointName &&
          (options.publishedContents != null || options.publishedDatasetsContents != null) &&
          (options.publishedContents !== options.contents || options.publishedDatasetsContents !== options.datasetsContents);

        if (publishedEndpointName) {
          if (shouldCreateSeparatePublishedRevision) {
            publishedRevision = await deps.createRevision(
              options.workflowId,
              options.publishedContents ?? options.contents,
              options.publishedDatasetsContents ?? options.datasetsContents,
            );
            deps.scheduleRevisionBlobCleanup(hooks, publishedRevision);
            publishedRevisionId = publishedRevision.revision_id;
          } else {
            publishedRevisionId = draftRevision.revision_id;
          }

          publishedVersionId = randomUUID();
        }

        const revisionIdsByContents = new Map<string, string>([
          [getManagedRevisionContentsKey(options.contents, options.datasetsContents), draftRevision.revision_id],
        ]);
        if (publishedRevisionId) {
          revisionIdsByContents.set(
            getManagedRevisionContentsKey(
              options.publishedContents ?? options.contents,
              options.publishedDatasetsContents ?? options.datasetsContents,
            ),
            publishedRevisionId,
          );
        }

        const importedWebAppRevisions: RevisionRow[] = [];
        const importedWebAppRows: Array<{
          uiGraphId: string;
          slug: string;
          publishedAt: string;
          revisionId: string;
          allowedEmails: string[];
        }> = [];
        for (const webApp of importedWebApps) {
          const revisionContentsKey = getManagedRevisionContentsKey(webApp.contents, webApp.datasetsContents);
          let revisionId = revisionIdsByContents.get(revisionContentsKey);
          if (!revisionId) {
            const revision = await deps.createRevision(options.workflowId, webApp.contents, webApp.datasetsContents);
            deps.scheduleRevisionBlobCleanup(hooks, revision);
            importedWebAppRevisions.push(revision);
            revisionId = revision.revision_id;
            revisionIdsByContents.set(revisionContentsKey, revisionId);
          }

          const slug = normalizeStoredEndpointName(webApp.slug);
          if (!webApp.uiGraphId || !slug) {
            continue;
          }

          importedWebAppRows.push({
            uiGraphId: webApp.uiGraphId,
            slug,
            publishedAt: webApp.publishedAt.trim() || updatedAt,
            revisionId,
            allowedEmails: normalizeEmailList(webApp.allowedEmails),
          });
        }

        await client.query(
          `
            INSERT INTO workflows (
              workflow_id, name, file_name, relative_path, folder_relative_path, updated_at,
              current_draft_revision_id, published_revision_id, published_version_id, endpoint_name, published_endpoint_name, last_published_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12::timestamptz)
          `,
          [
            options.workflowId,
            workflowName,
            fileName,
            relativePath,
            folderRelativePath,
            updatedAt,
            draftRevision.revision_id,
            publishedRevisionId,
            publishedVersionId,
            draftEndpointName,
            publishedEndpointName,
            lastPublishedAt,
          ],
        );
        await deps.insertRevision(client, draftRevision);
        if (publishedRevision) {
          await deps.insertRevision(client, publishedRevision);
        }
        for (const revision of importedWebAppRevisions) {
          await deps.insertRevision(client, revision);
        }
        if (publishedVersionId && publishedRevisionId) {
          await client.query(
            `
              INSERT INTO workflow_published_versions (version_id, workflow_id, revision_id, endpoint_name, published_at)
              VALUES ($1, $2, $3, $4, $5::timestamptz)
            `,
            [publishedVersionId, options.workflowId, publishedRevisionId, publishedEndpointName, lastPublishedAt ?? updatedAt],
          );
        }
        for (const webApp of importedWebAppRows) {
          try {
            await client.query(
              `
                INSERT INTO workflow_web_apps (
                  app_id, workflow_id, revision_id, ui_graph_id, slug, slug_lookup_name, allowed_emails, published_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::timestamptz)
              `,
              [
                randomUUID(),
                options.workflowId,
                webApp.revisionId,
                webApp.uiGraphId,
                webApp.slug,
                normalizeWorkflowEndpointLookupName(webApp.slug),
                webApp.allowedEmails,
                webApp.publishedAt,
              ],
            );
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw conflict(`Managed workflow web app slug already exists: ${webApp.slug}`);
            }

            throw error;
          }
        }

        const workflow = await deps.getWorkflowById(client, options.workflowId);
        if (!workflow) {
          throw createHttpError(500, 'Imported workflow could not be loaded');
        }

        await deps.syncWorkflowEndpointRows(client, workflow, {
          draftEndpointName,
          publishedEndpointName,
        });

        if (publishedEndpointName || importedWebAppRows.length > 0) {
          await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        }

        return deps.mapWorkflowRowToProjectItem(workflow);
      });
    },
  };
}
