import { randomUUID } from 'node:crypto';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectStats,
} from '../../../../../studio-server-shared/workflow-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { captureOperation } from './namespace-receipts.js';
import { createManagedProject } from './project-creation.js';
import type { StructuralMutation } from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import { structuralTransaction, assertFolderIdentity, withCatalogTransaction } from './structural-admission.js';
import { createManagedCatalogMutations } from './catalog-mutations.js';
import type { WorkflowNamespaceCommand } from '../../../../../studio-server-shared/workflow-namespace-types.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { getWorkflowProjectStatsFromContents } from '../project-stats.js';
import { getWorkflowDownloadFileName } from '../workflow-project-naming.js';
import type { WorkflowProjectReferenceSnapshot } from '../project-reference-snapshots.js';
import {
  getManagedWorkflowFolderVirtualPath,
  getManagedWorkflowProjectVirtualPath,
  getManagedWorkflowVirtualRoot,
  getProjectRelativePathFromDatasetVirtualPath,
  isManagedWorkflowDatasetVirtualPath,
  normalizeManagedWorkflowRelativePath,
  parseManagedWorkflowProjectVirtualPath,
  resolveManagedWorkflowRelativeReference,
} from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import type { RevisionRow, WebAppPublicationRow, WorkflowRow } from './types.js';

type ManagedWorkflowCatalogServiceDependencies = {
  context: ManagedWorkflowContext;
};

type WorkflowTreeRow = WorkflowRow & {
  draft_revision_id: string | null;
  draft_project_blob_key: string | null;
  stats_graph_count: number | null;
  stats_total_node_count: number | null;
  stats_web_app_count: number | null;
};

export function createManagedWorkflowCatalogService(options: ManagedWorkflowCatalogServiceDependencies) {
  const deps = {
    pool: options.context.pool,
    initialize: options.context.initialize,
    withTransaction: options.context.withTransaction,
    queryOne: options.context.db.queryOne,
    queryRows: options.context.db.queryRows,
    listFolderRows: options.context.queries.listFolderRows,
    listWorkflowRows: options.context.queries.listWorkflowRows,
    getWorkflowByRelativePath: options.context.queries.getWorkflowByRelativePath,
    getCurrentDraftWorkflowRevision: options.context.queries.getCurrentDraftWorkflowRevision,
    getRevision: options.context.queries.getRevision,
    readRevisionProjectContents: options.context.revisions.readRevisionProjectContents,
    assertFolderExists: options.context.queries.assertFolderExists,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    mapFolderRowToFolderItem: options.context.mappers.mapFolderRowToFolderItem,
    getWorkflowStatus: options.context.mappers.getWorkflowStatus,
    blobStore: options.context.blobStore,
    queueCatalogInvalidation: options.context.executionInvalidationController.queueCatalogInvalidation.bind(
      options.context.executionInvalidationController,
    ),
    workflowColumnsQualified: options.context.mappers.WORKFLOW_COLUMNS_QUALIFIED,
    getWorkflowProjectStatsFromContents,
  };
  const emptyProjectStats = {
    graphCount: 0,
    totalNodeCount: 0,
    webAppCount: 0,
  } as const;

  const getRevisionStats = async (
    revision: Pick<
      RevisionRow,
      'revision_id' | 'project_blob_key' | 'stats_graph_count' | 'stats_total_node_count' | 'stats_web_app_count'
    >,
  ): Promise<WorkflowProjectStats> => {
    if (
      revision.stats_graph_count != null &&
      revision.stats_total_node_count != null &&
      revision.stats_web_app_count != null
    ) {
      return {
        graphCount: revision.stats_graph_count,
        totalNodeCount: revision.stats_total_node_count,
        webAppCount: revision.stats_web_app_count,
      };
    }

    try {
      const stats = deps.getWorkflowProjectStatsFromContents(await deps.readRevisionProjectContents(revision));
      await deps
        .queryRows(
          deps.pool,
          `
          UPDATE workflow_revisions
          SET stats_graph_count = $2,
              stats_total_node_count = $3,
              stats_web_app_count = $4
          WHERE revision_id = $1
            AND (stats_graph_count IS NULL OR stats_total_node_count IS NULL OR stats_web_app_count IS NULL)
        `,
          [revision.revision_id, stats.graphCount, stats.totalNodeCount, stats.webAppCount],
        )
        .catch(() => {});

      return stats;
    } catch {
      return emptyProjectStats;
    }
  };

  const operations = createManagedCatalogMutations(options.context);
  const folderPath = (value: unknown, allowEmpty = false) =>
    normalizeManagedWorkflowRelativePath(value, { allowProjectFile: false, allowEmpty });
  const projectPath = (value: unknown) => normalizeManagedWorkflowRelativePath(value, { allowProjectFile: true });
  const execute = (command: WorkflowNamespaceCommand) =>
    withCatalogTransaction(options.context, (tx) => operations(tx, command));

  return {
    async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
      await deps.initialize();
      // Folder paths, project membership and publication headers must describe
      // one committed state. Separate pool queries can straddle an atomic move
      // and incorrectly detach its projects. Release this read-only snapshot
      // before projecting rows or backfilling legacy stats from object storage.
      const [folderRows, workflowRows, webAppRows] = await deps.withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const folderRows = await deps.listFolderRows(client);
        const workflowRows = await deps.queryRows<WorkflowTreeRow>(
          client,
          `
          SELECT ${deps.workflowColumnsQualified}, r.revision_id AS draft_revision_id,
            r.project_blob_key AS draft_project_blob_key,
            r.stats_graph_count, r.stats_total_node_count, r.stats_web_app_count
          FROM workflows w LEFT JOIN workflow_revisions r
            ON r.revision_id = w.current_draft_revision_id AND r.workflow_id = w.workflow_id
          ORDER BY w.relative_path ASC`,
          [],
        );
        const webAppRows = await deps.queryRows<WebAppPublicationRow>(
          client,
          `
            SELECT app_id, workflow_id, revision_id, ui_graph_id, slug, slug_lookup_name, published_at
            FROM workflow_web_apps
          `,
          [],
        );
        return [folderRows, workflowRows, webAppRows] as const;
      });
      const webAppRowsByWorkflowId = new Map<string, WebAppPublicationRow[]>();
      for (const row of webAppRows) {
        const rows = webAppRowsByWorkflowId.get(row.workflow_id);
        if (rows) {
          rows.push(row);
        } else {
          webAppRowsByWorkflowId.set(row.workflow_id, [row]);
        }
      }

      const folderMap = new Map<string, WorkflowFolderItem>();
      const bundleByFolder = new Map<string, string | null>();
      for (const row of folderRows) {
        folderMap.set(row.relative_path, deps.mapFolderRowToFolderItem(row));
        bundleByFolder.set(row.relative_path, row.bundle_id ?? bundleByFolder.get(row.parent_relative_path) ?? null);
      }

      const rootFolders: WorkflowFolderItem[] = [];
      const rootProjects: WorkflowProjectItem[] = [];

      for (const row of folderRows) {
        const folder = folderMap.get(row.relative_path)!;
        const parent = row.parent_relative_path ? folderMap.get(row.parent_relative_path) : null;
        if (parent) {
          parent.folders.push(folder);
        } else {
          rootFolders.push(folder);
        }
      }

      const workflowProjects: Array<{ row: WorkflowTreeRow; project: WorkflowProjectItem }> = [];
      // Current rows need no object reads. Bound compatibility backfills for old
      // revisions rather than launching one S3 download per project at once.
      for (let start = 0; start < workflowRows.length; start += 4) {
        workflowProjects.push(
          ...(await Promise.all(
            workflowRows.slice(start, start + 4).map(async (row) => {
              const project = deps.mapWorkflowRowToProjectItem(row, {
                webAppRows: webAppRowsByWorkflowId.get(row.workflow_id) ?? [],
              });
              if (!row.draft_revision_id || !row.draft_project_blob_key) {
                return {
                  row,
                  project: {
                    ...project,
                    stats: emptyProjectStats,
                  },
                };
              }

              return {
                row,
                project: {
                  ...project,
                  stats: await getRevisionStats({
                    revision_id: row.draft_revision_id,
                    project_blob_key: row.draft_project_blob_key,
                    stats_graph_count: row.stats_graph_count,
                    stats_total_node_count: row.stats_total_node_count,
                    stats_web_app_count: row.stats_web_app_count,
                  }),
                },
              };
            }),
          )),
        );
      }

      for (const { row, project } of workflowProjects) {
        project.bundleId = bundleByFolder.get(row.folder_relative_path) ?? null;
        const parent = row.folder_relative_path ? folderMap.get(row.folder_relative_path) : null;
        if (parent) {
          parent.projects.push(project);
        } else {
          rootProjects.push(project);
        }
      }

      const sortFolder = (folder: WorkflowFolderItem) => {
        folder.folders.sort((left, right) => left.name.localeCompare(right.name));
        folder.projects.sort((left, right) => left.name.localeCompare(right.name));
        for (const childFolder of folder.folders) {
          sortFolder(childFolder);
        }
      };

      rootFolders.sort((left, right) => left.name.localeCompare(right.name));
      rootProjects.sort((left, right) => left.name.localeCompare(right.name));
      for (const folder of rootFolders) {
        sortFolder(folder);
      }

      return {
        root: getManagedWorkflowVirtualRoot(),
        folders: rootFolders,
        projects: rootProjects,
      };
    },

    async listProjectPathsForHostedIo(): Promise<string[]> {
      await deps.initialize();
      const rows = await deps.queryRows<{ relative_path: string }>(
        deps.pool,
        'SELECT relative_path FROM workflows ORDER BY relative_path ASC',
        [],
      );
      return rows.map((row) => getManagedWorkflowProjectVirtualPath(row.relative_path));
    },

    async readHostedText(filePath: string): Promise<string> {
      if (isManagedWorkflowDatasetVirtualPath(filePath)) {
        const projectRelativePath = getProjectRelativePathFromDatasetVirtualPath(filePath);
        const loaded = await deps.getCurrentDraftWorkflowRevision(deps.pool, projectRelativePath);
        if (!loaded?.revision.dataset_blob_key) {
          throw createHttpError(404, 'Dataset not found');
        }

        return deps.blobStore.getText(loaded.revision.dataset_blob_key);
      }

      const project = await deps.getCurrentDraftWorkflowRevision(
        deps.pool,
        parseManagedWorkflowProjectVirtualPath(filePath),
      );
      if (!project) {
        throw createHttpError(404, 'Project revision not found');
      }

      return deps.blobStore.getText(project.revision.project_blob_key);
    },

    async hostedPathExists(filePath: string): Promise<boolean> {
      try {
        if (isManagedWorkflowDatasetVirtualPath(filePath)) {
          const projectRelativePath = getProjectRelativePathFromDatasetVirtualPath(filePath);
          const loaded = await deps.getCurrentDraftWorkflowRevision(deps.pool, projectRelativePath);
          return Boolean(loaded?.revision.dataset_blob_key);
        }

        const relativePath = parseManagedWorkflowProjectVirtualPath(filePath);
        return Boolean(await deps.getCurrentDraftWorkflowRevision(deps.pool, relativePath));
      } catch {
        return false;
      }
    },

    async resolveManagedRelativeProjectText(relativeFrom: string, projectFilePath: string): Promise<string> {
      const resolvedRelativePath = resolveManagedWorkflowRelativeReference(relativeFrom, projectFilePath);
      const loaded = await deps.getCurrentDraftWorkflowRevision(deps.pool, resolvedRelativePath);
      if (!loaded) {
        throw createHttpError(404, 'Project revision not found');
      }

      return deps.blobStore.getText(loaded.revision.project_blob_key);
    },

    async createWorkflowFolderItem(name: unknown, parentRelativePath: unknown, mutation?: StructuralMutation) {
      const captured = captureOperation(
        { name, parentRelativePath, mutation },
        (input) => input.mutation,
        (input) => ({
          operation: 'create-folder',
          input: { name: input.name, parentRelativePath: input.parentRelativePath },
        }),
      );
      ({ name, parentRelativePath, mutation } = captured.input);
      const folderName = sanitizeWorkflowName(name, 'folder name');
      const parentPath = normalizeManagedWorkflowRelativePath(parentRelativePath, {
        allowProjectFile: false,
        allowEmpty: true,
      });
      const folderRelativePath = normalizeManagedWorkflowRelativePath(
        parentPath ? `${parentPath}/${folderName}` : folderName,
        {
          allowProjectFile: false,
        },
      );

      const result = await structuralTransaction(options.context, captured.admission, async (client) => {
        if (
          await deps.queryOne(client, 'SELECT relative_path FROM workflow_folders WHERE relative_path = $1', [
            folderRelativePath,
          ])
        ) {
          throw conflict(`Folder already exists: ${folderName}`);
        }

        await deps.assertFolderExists(client, parentPath);
        if (mutation) await assertFolderIdentity(client, parentPath, mutation.expectedDestinationId);
        const namespaceId = randomUUID();
        await client.query(
          `
            INSERT INTO workflow_folders (relative_path, name, parent_relative_path, namespace_id, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
          `,
          [folderRelativePath, folderName, parentPath, namespaceId],
        );
        await deps.queueCatalogInvalidation(client);

        return {
          folder: deps.mapFolderRowToFolderItem({
            relative_path: folderRelativePath,
            name: folderName,
            parent_relative_path: parentPath,
            namespace_id: namespaceId,
            updated_at: new Date(),
          }),
        };
      });
      return result.folder;
    },

    async renameWorkflowFolderItem(relativePath: unknown, newName: unknown) {
      const result = await execute({
        kind: 'rename',
        itemType: 'folder',
        relativePath: folderPath(relativePath),
        name: sanitizeWorkflowName(newName, 'new name'),
      });
      if (!result.folder || !result.movedProjectPaths) throw new Error('Invalid folder mutation result');
      return { folder: result.folder, movedProjectPaths: result.movedProjectPaths };
    },
    async moveWorkflowFolder(sourceRelativePath: unknown, destinationFolderRelativePath: unknown) {
      const result = await execute({
        kind: 'move',
        itemType: 'folder',
        relativePath: folderPath(sourceRelativePath),
        destinationRelativePath: folderPath(destinationFolderRelativePath, true),
      });
      if (!result.folder || !result.movedProjectPaths) throw new Error('Invalid folder mutation result');
      return { folder: result.folder, movedProjectPaths: result.movedProjectPaths };
    },
    async deleteWorkflowFolderItem(relativePath: unknown): Promise<void> {
      await execute({ kind: 'delete', itemType: 'folder', relativePath: folderPath(relativePath) });
    },

    async createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem> {
      return createManagedProject(options.context, {
        operation: 'create-project',
        input: {
          parentRelativePath: folderPath(folderRelativePath, true),
          name: sanitizeWorkflowName(name, 'project name'),
        },
      });
    },

    async renameWorkflowProjectItem(relativePath: unknown, newName: unknown) {
      const result = await execute({
        kind: 'rename',
        itemType: 'project',
        relativePath: projectPath(relativePath),
        name: sanitizeWorkflowName(newName, 'new name'),
      });
      if (!result.project || !result.movedProjectPaths) throw new Error('Invalid project mutation result');
      return { project: result.project, movedProjectPaths: result.movedProjectPaths };
    },
    async moveWorkflowProject(sourceRelativePath: unknown, destinationFolderRelativePath: unknown) {
      const result = await execute({
        kind: 'move',
        itemType: 'project',
        relativePath: projectPath(sourceRelativePath),
        destinationRelativePath: folderPath(destinationFolderRelativePath, true),
      });
      if (!result.project || !result.movedProjectPaths) throw new Error('Invalid project mutation result');
      return { project: result.project, movedProjectPaths: result.movedProjectPaths };
    },

    async duplicateWorkflowProjectItem(
      relativePath: unknown,
      version: WorkflowProjectDownloadVersion = 'live',
    ): Promise<WorkflowProjectItem> {
      return createManagedProject(options.context, {
        operation: 'copy-project',
        input: { relativePath: projectPath(relativePath), version },
      });
    },

    async uploadWorkflowProjectItem(
      folderRelativePath: unknown,
      fileName: unknown,
      contents: unknown,
    ): Promise<WorkflowProjectItem> {
      if (typeof fileName !== 'string' || typeof contents !== 'string')
        throw badRequest('Missing project file name or contents.');
      return createManagedProject(options.context, {
        operation: 'upload-project',
        input: { parentRelativePath: folderPath(folderRelativePath, true), fileName, contents },
      });
    },

    async listWorkflowProjectReferenceCatalog() {
      await deps.initialize();
      const [workflows, apps] = await Promise.all([
        deps.listWorkflowRows(),
        deps.queryRows<WebAppPublicationRow>(deps.pool, 'SELECT * FROM workflow_web_apps ORDER BY app_id', []),
      ]);
      const byWorkflow = new Map<string, WebAppPublicationRow[]>();
      for (const app of apps) {
        const entries = byWorkflow.get(app.workflow_id) ?? [];
        entries.push(app);
        byWorkflow.set(app.workflow_id, entries);
      }
      return workflows.map((workflow) => ({
        name: workflow.name,
        relativePath: workflow.relative_path,
        projectMetadataId: workflow.workflow_id,
        identity: JSON.stringify([workflow, byWorkflow.get(workflow.workflow_id) ?? []]),
      }));
    },

    async readWorkflowProjectReferenceSnapshots(relativePath: unknown): Promise<WorkflowProjectReferenceSnapshot[]> {
      const workflow = await deps.getWorkflowByRelativePath(
        deps.pool,
        normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true }),
      );
      if (!workflow) throw createHttpError(404, 'Project not found');
      const apps = await deps.queryRows<WebAppPublicationRow>(
        deps.pool,
        'SELECT * FROM workflow_web_apps WHERE workflow_id = $1 ORDER BY slug',
        [workflow.workflow_id],
      );
      const snapshots: WorkflowProjectReferenceSnapshot[] = [];
      const contents = new Map<string, string>();
      const read = async (revisionId: string) => {
        const cached = contents.get(revisionId);
        if (cached !== undefined) return cached;
        const revision = await deps.getRevision(deps.pool, revisionId);
        if (!revision || revision.workflow_id !== workflow.workflow_id)
          throw createHttpError(409, 'Project revision is unavailable.');
        const text = await deps.readRevisionProjectContents(revision);
        contents.set(revisionId, text);
        return text;
      };
      snapshots.push({ source: { kind: 'saved-latest' }, contents: await read(workflow.current_draft_revision_id) });
      if (workflow.published_revision_id)
        snapshots.push({
          source: { kind: 'published-endpoint', label: workflow.published_endpoint_name ?? workflow.endpoint_name },
          contents: await read(workflow.published_revision_id),
        });
      for (const app of apps)
        snapshots.push({
          source: { kind: 'published-web-app', label: app.slug },
          contents: await read(app.revision_id),
        });
      return snapshots;
    },

    async readWorkflowProjectDownload(
      relativePath: unknown,
      version: WorkflowProjectDownloadVersion,
    ): Promise<{ contents: string; fileName: string }> {
      const workflow = await deps.getWorkflowByRelativePath(
        deps.pool,
        normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true }),
      );
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      const revisionId = version === 'published' ? workflow.published_revision_id : workflow.current_draft_revision_id;
      if (version === 'published' && !revisionId) {
        throw conflict('Published version is not available for this project');
      }

      const revision = await deps.getRevision(deps.pool, revisionId);
      if (!revision) {
        throw createHttpError(404, 'Project revision not found');
      }

      const contents = await deps.blobStore.getText(revision.project_blob_key);
      return {
        contents,
        fileName: getWorkflowDownloadFileName(workflow.name, version, deps.getWorkflowStatus(workflow)),
      };
    },

    async deleteWorkflowProjectItem(relativePath: unknown): Promise<string | null> {
      const result = await execute({ kind: 'delete', itemType: 'project', relativePath: projectPath(relativePath) });
      return result.projectId ?? null;
    },
  };
}
